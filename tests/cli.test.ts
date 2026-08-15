import { describe, expect, test } from "bun:test";
import { formatHumanResult, runCli } from "../src/cli.ts";
import { ProbeError } from "../src/probe/errors.ts";
import type { ProbeResult } from "../src/probe/types.ts";

const emptyResult: ProbeResult = {
  inputUrl: "https://example.com",
  finalUrl: "https://example.com/",
  candidates: [],
  warnings: [],
};

function harness(probeUrl: () => Promise<ProbeResult>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    dependencies: {
      probeUrl,
      io: {
        stdout: (message: string) => stdout.push(message),
        stderr: (message: string) => stderr.push(message),
      },
    },
  };
}

describe("Curio CLI", () => {
  test("prints stable JSON without diagnostics on stdout", async () => {
    const testHarness = harness(async () => emptyResult);

    const exitCode = await runCli(
      ["probe", "https://example.com", "--json"],
      testHarness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(testHarness.stdout).toEqual([JSON.stringify(emptyResult)]);
    expect(testHarness.stderr).toEqual([]);
    expect(JSON.parse(testHarness.stdout[0] as string)).toEqual(emptyResult);
  });

  test("treats zero candidates as a human-readable success", async () => {
    const testHarness = harness(async () => emptyResult);

    expect(await runCli(["probe", "https://example.com"], testHarness.dependencies)).toBe(0);
    expect(testHarness.stdout[0]).toContain("No subscription candidates found.");
    expect(testHarness.stderr).toEqual([]);
  });

  test("keeps failures on stderr and returns non-zero", async () => {
    const testHarness = harness(async () => {
      throw new ProbeError("blocked_address", "Address is private");
    });

    expect(await runCli(["probe", "http://localhost", "--json"], testHarness.dependencies)).toBe(1);
    expect(testHarness.stdout).toEqual([]);
    expect(testHarness.stderr).toEqual(["blocked_address: Address is private"]);
  });

  test("rejects invalid command shapes", async () => {
    const testHarness = harness(async () => emptyResult);

    expect(await runCli(["probe"], testHarness.dependencies)).toBe(2);
    expect(await runCli(["unknown"], testHarness.dependencies)).toBe(2);
    expect(testHarness.stdout).toEqual([]);
  });

  test("removes terminal control characters from human output", () => {
    expect(
      formatHumanResult({
        ...emptyResult,
        warnings: [{ code: "candidate_failed", message: "bad\u001b[31mfeed" }],
      }),
    ).not.toContain("\u001b");
  });

  test("formats candidates for humans", () => {
    expect(
      formatHumanResult({
        ...emptyResult,
        candidates: [
          {
            adapter: "rss",
            format: "atom",
            sourceUrl: "https://example.com/feed",
            sourceKey: "https://example.com/feed",
            title: "Example",
            discoveredVia: "html-link",
          },
        ],
      }),
    ).toContain("[atom] Example");
  });
});
