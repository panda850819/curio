import { describe, expect, test } from "bun:test";
import { type CliDependencies, formatHumanResult, runCli } from "../src/cli.ts";
import type { Subscription } from "../src/domain/types.ts";
import { ProbeError } from "../src/probe/errors.ts";
import type { ProbeResult } from "../src/probe/types.ts";

const emptyResult: ProbeResult = {
  inputUrl: "https://example.com",
  finalUrl: "https://example.com/",
  candidates: [],
  warnings: [],
};

function candidate(key: string) {
  return {
    adapter: "rss" as const,
    format: "rss" as const,
    sourceUrl: `https://example.com/feed-${key}`,
    sourceKey: key,
    title: `Feed ${key}`,
    discoveredVia: "html-link" as const,
  };
}

function exampleSubscription(): Subscription {
  return {
    id: "subscription-1",
    adapter: "rss",
    sourceKey: "one",
    sourceUrl: "https://example.com/feed-one",
    title: "Feed one",
    enabled: true,
    cursor: null,
    metadata: {},
    lastPolledAt: null,
    lastSuccessAt: null,
    nextPollAt: 0,
    pollIntervalMinutes: 60,
    consecutiveFailures: 0,
    lastError: null,
    lastFailedAt: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };
}

function subscriptionHarness(result: ProbeResult) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const followed: Array<{ sourceKey: string; interval: number }> = [];
  const actions: string[] = [];
  const subscription = exampleSubscription();
  const dependencies: CliDependencies = {
    probeUrl: async () => result,
    follow: (selected, interval) => {
      followed.push({ sourceKey: selected.sourceKey, interval });
      return subscription;
    },
    list: () => [subscription],
    resolveSubscription: (target) => {
      actions.push(`resolve:${target}`);
      return subscription;
    },
    setEnabled: (_id, enabled) => {
      actions.push(`enabled:${enabled}`);
      return { ...subscription, enabled };
    },
    remove: (id) => actions.push(`remove:${id}`),
    poll: async (id) => {
      actions.push(`poll:${id}`);
      return {
        status: "not_modified",
        insertedItems: 0,
        duplicateItems: 0,
        warnings: [],
        cursor: {},
      };
    },
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
  return { stdout, stderr, followed, actions, dependencies };
}

function harness(probeUrl: () => Promise<ProbeResult>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    dependencies: {
      probeUrl,
      follow: () => {
        throw new Error("unexpected follow");
      },
      list: () => [],
      resolveSubscription: () => {
        throw new Error("unexpected resolve");
      },
      setEnabled: () => {
        throw new Error("unexpected setEnabled");
      },
      remove: () => {
        throw new Error("unexpected remove");
      },
      poll: async () => {
        throw new Error("unexpected poll");
      },
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

  test("redacts URL credentials and query secrets from diagnostics", async () => {
    const testHarness = harness(async () => {
      throw new Error("failed https://user:password@example.com/feed?token=secret");
    });

    expect(await runCli(["probe", "https://example.com"], testHarness.dependencies)).toBe(1);
    expect(testHarness.stderr[0]).not.toContain("password");
    expect(testHarness.stderr[0]).not.toContain("secret");
    expect(testHarness.stderr[0]).toContain("credentials-redacted");
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

  test("follows one candidate and validates interval bounds", async () => {
    const testHarness = subscriptionHarness({
      ...emptyResult,
      candidates: [candidate("one")],
    });

    expect(
      await runCli(
        ["follow", "https://example.com", "--interval-minutes", "120", "--json"],
        testHarness.dependencies,
      ),
    ).toBe(0);
    expect(testHarness.followed).toEqual([{ sourceKey: "one", interval: 120 }]);
    expect(JSON.parse(testHarness.stdout[0] as string)).toMatchObject({
      ok: true,
      command: "follow",
      data: { id: "subscription-1" },
    });

    expect(
      await runCli(
        ["follow", "https://example.com", "--interval-minutes", "4"],
        testHarness.dependencies,
      ),
    ).toBe(2);
    expect(testHarness.followed).toHaveLength(1);
  });

  test("requires one-based selection for multiple candidates without writing", async () => {
    const testHarness = subscriptionHarness({
      ...emptyResult,
      candidates: [candidate("one"), candidate("two")],
    });

    expect(
      await runCli(["follow", "https://example.com", "--json"], testHarness.dependencies),
    ).toBe(1);
    expect(testHarness.followed).toEqual([]);
    expect(JSON.parse(testHarness.stdout[0] as string)).toMatchObject({
      ok: false,
      error: { code: "candidate_required" },
    });

    expect(
      await runCli(["follow", "https://example.com", "--candidate", "2"], testHarness.dependencies),
    ).toBe(0);
    expect(testHarness.followed).toEqual([{ sourceKey: "two", interval: 60 }]);

    expect(
      await runCli(["follow", "https://example.com", "--candidate", "3"], testHarness.dependencies),
    ).toBe(1);
    expect(testHarness.followed).toHaveLength(1);
  });

  test("routes lifecycle and manual poll commands through resolved subscriptions", async () => {
    const testHarness = subscriptionHarness(emptyResult);

    expect(await runCli(["pause", "subscription-1"], testHarness.dependencies)).toBe(0);
    expect(await runCli(["resume", "https://example.com/feed-one"], testHarness.dependencies)).toBe(
      0,
    );
    expect(await runCli(["poll", "subscription-1"], testHarness.dependencies)).toBe(0);
    expect(await runCli(["remove", "subscription-1"], testHarness.dependencies)).toBe(0);

    expect(testHarness.actions).toEqual([
      "resolve:subscription-1",
      "enabled:false",
      "resolve:https://example.com/feed-one",
      "enabled:true",
      "resolve:subscription-1",
      "poll:subscription-1",
      "resolve:subscription-1",
      "remove:subscription-1",
    ]);
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
