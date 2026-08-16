import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessXbirdClient } from "../../../src/sources/x/client.ts";

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeXbird(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "curio-xbird-"));
  paths.push(directory);
  const executable = join(directory, "xbird");
  await writeFile(executable, `#!/usr/bin/env bun\n${body}\n`);
  await chmod(executable, 0o700);
  return executable;
}

describe("ProcessXbirdClient", () => {
  test("uses fixed argv and an allowlisted environment", async () => {
    const executable = await fakeXbird(`
      const visible = {
        args: process.argv.slice(2),
        auth: process.env.AUTH_TOKEN,
        ct0: process.env.CT0,
        writes: process.env.XBIRD_DISABLE_LIVE_WRITES,
        telegram: process.env.TELEGRAM_BOT_TOKEN ?? null,
      };
      console.log(JSON.stringify({ ok: true, data: { tweets: [{ id: "1", text: JSON.stringify(visible), author: { username: "Kay", name: "Kay" } }], nextCursor: "cursor" } }));
    `);
    process.env.TELEGRAM_BOT_TOKEN = "must-not-leak";
    const [result] = await new ProcessXbirdClient(
      "auth-secret",
      "ct0-secret",
      executable,
    ).userTweets("Kay", 20);
    const visible = JSON.parse(result?.text ?? "{}") as Record<string, unknown>;
    expect(visible).toMatchObject({
      args: ["user-tweets", "Kay", "--count", "20", "--max-pages", "1", "--json"],
      auth: "auth-secret",
      ct0: "ct0-secret",
      writes: "1",
      telegram: null,
    });
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  test("does not surface stderr or credentials when xbird fails", async () => {
    const executable = await fakeXbird(`
      console.error("auth-secret ct0-secret");
      console.log(JSON.stringify({ ok: false, error: { code: "AUTH_FAILED", message: "auth-secret" } }));
      process.exit(1);
    `);
    await expect(
      new ProcessXbirdClient("auth-secret", "ct0-secret", executable).userTweets("Kay", 20),
    ).rejects.toThrow("X source request failed (AUTH_FAILED)");
  });

  test("kills a command that exceeds the bounded timeout", async () => {
    const executable = await fakeXbird(`await Bun.sleep(5_000)`);
    await expect(
      new ProcessXbirdClient("auth", "ct0", executable, 1).userTweets("Kay", 20),
    ).rejects.toThrow("timed out");
  });

  test("rejects malformed successful output", async () => {
    const executable = await fakeXbird(`console.log("not-json")`);
    await expect(
      new ProcessXbirdClient("auth", "ct0", executable).userTweets("Kay", 20),
    ).rejects.toThrow("malformed JSON");
  });
});
