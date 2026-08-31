import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const validator = join(import.meta.dir, "../deploy/validate-utc-timestamp.sh");
const releaseValues = join(import.meta.dir, "../deploy/release-values.sh");
const legacyReleaseValues = join(import.meta.dir, "../deploy/legacy-release-values.sh");
const tempDirectories: string[] = [];

function run(command: string[], environment?: Record<string, string>) {
  return Bun.spawnSync({
    cmd: command,
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function createManifest(buildTime: string) {
  const root = await mkdtemp(join(tmpdir(), "curio-deployment-contract-"));
  tempDirectories.push(root);
  await writeFile(
    join(root, ".env"),
    "TELEGRAM_BOT_TOKEN=fixture\nTELEGRAM_CHAT_ID=123\nCURIO_IMAGE=curio/server:test\nCURIO_HEALTH_CONTRACT=health-v1\n",
    { mode: 0o600 },
  );
  const manifest = join(root, "release-manifest.env");
  await writeFile(
    manifest,
    `manifest_version=1\nimage=curio/server:test\nimage_id=sha256:${"a".repeat(64)}\nrevision=${"b".repeat(40)}\nbuild_time=${buildTime}\ncontract_generation=health-v1\n`,
    { mode: 0o600 },
  );
  await chmod(manifest, 0o600);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("deployment timestamp and manifest contracts", () => {
  test("accepts only real canonical UTC timestamps", () => {
    for (const value of ["2026-08-31T16:02:13Z", "2024-02-29T00:00:00Z"]) {
      expect(run(["bash", validator, value]).exitCode).toBe(0);
    }
    for (const value of [
      "2023-02-29T00:00:00Z",
      "2026-04-31T16:02:13Z",
      "2026-08-31T24:00:00Z",
      "2026-08-31T16:02:13+00:00",
      "unknown",
    ]) {
      expect(run(["bash", validator, value]).exitCode).not.toBe(0);
    }
  });

  test("release-values rejects a malformed or non-root manifest and a non-canonical build time", async () => {
    const root = await createManifest("2026-08-31T16:02:13Z");
    const fakeBin = await mkdtemp(join(tmpdir(), "curio-manifest-stat-"));
    tempDirectories.push(fakeBin);
    const fakeStat = join(fakeBin, "stat");
    await writeFile(
      fakeStat,
      `#!/usr/bin/env bash
if [[ "$*" == *"%u"* ]]; then printf '0\\n'; else /usr/bin/stat "$@"; fi
`,
      { mode: 0o700 },
    );
    await chmod(fakeStat, 0o700);

    const environment = { PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}` };
    const accepted = run(["bash", releaseValues, root], environment);
    expect(accepted.exitCode).toBe(0);
    expect(new TextDecoder().decode(accepted.stdout)).toContain("2026-08-31T16:02:13Z");

    await writeFile(join(root, "release-manifest.env"), "manifest_version=1\ninvalid\n", {
      mode: 0o600,
    });
    expect(run(["bash", releaseValues, root], environment).exitCode).not.toBe(0);

    await writeFile(
      join(root, "release-manifest.env"),
      `manifest_version=1\nimage=curio/server:test\nimage_id=sha256:${"a".repeat(64)}\nrevision=${"b".repeat(40)}\nbuild_time=2026-02-29T16:02:13Z\ncontract_generation=health-v1\n`,
      { mode: 0o600 },
    );
    expect(run(["bash", releaseValues, root], environment).exitCode).not.toBe(0);

    await writeFile(
      join(root, "release-manifest.env"),
      `manifest_version=1\nimage=curio/server:test\nimage_id=sha256:${"a".repeat(64)}\nrevision=${"b".repeat(40)}\nbuild_time=2026-08-31T16:02:13Z\ncontract_generation=health-v1\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(root, ".env"),
      "TELEGRAM_BOT_TOKEN=fixture\nTELEGRAM_CHAT_ID=123\nCURIO_IMAGE=curio/server:stale\nCURIO_HEALTH_CONTRACT=health-v1\n",
      { mode: 0o600 },
    );
    expect(run(["bash", releaseValues, root], environment).exitCode).not.toBe(0);

    await writeFile(
      join(root, ".env"),
      "TELEGRAM_BOT_TOKEN=fixture\nTELEGRAM_CHAT_ID=123\nCURIO_IMAGE=curio/server:test\nCURIO_HEALTH_CONTRACT=health-v1\n",
      { mode: 0o600 },
    );
    const nonRootStat = join(fakeBin, "stat");
    await writeFile(
      nonRootStat,
      `#!/usr/bin/env bash
if [[ "$*" == *"%u"* ]]; then printf '501\\n'; else /usr/bin/stat "$@"; fi
`,
      { mode: 0o700 },
    );
    expect(run(["bash", releaseValues, root], environment).exitCode).not.toBe(0);
  });

  test("legacy manifest parsing stays pinned to the accepted rollback artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "curio-legacy-manifest-"));
    tempDirectories.push(root);
    const manifest = join(root, "legacy-release-manifest.env");
    await writeFile(
      manifest,
      `manifest_version=1\nimage=curio/server:rollback-94ee0ff\nimage_id=sha256:${"a".repeat(64)}\nrevision=94ee0ff070fa0c7984f1bdfa6a7cc78661ec5bfa\ncontract_generation=legacy-v0\n`,
      { mode: 0o600 },
    );
    const fakeBin = await mkdtemp(join(tmpdir(), "curio-legacy-stat-"));
    tempDirectories.push(fakeBin);
    await writeFile(
      join(fakeBin, "stat"),
      `#!/usr/bin/env bash
if [[ "$*" == *"%u"* ]]; then printf '0\\n'; else /usr/bin/stat "$@"; fi
`,
      { mode: 0o700 },
    );
    const result = run(["bash", legacyReleaseValues, root], {
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("legacy-v0");
  });
});
