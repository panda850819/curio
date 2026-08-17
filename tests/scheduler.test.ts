import { describe, expect, test } from "bun:test";
import type { SubscriptionRepository } from "../src/db/repositories.ts";
import type { Subscription } from "../src/domain/types.ts";
import {
  PollAlreadyRunningError,
  PollCoordinator,
  PollScheduler,
  type SourcePoller,
} from "../src/scheduler.ts";
import type { RssPollResult } from "../src/sources/rss/types.ts";

function subscription(id: string, adapter = "rss"): Subscription {
  return {
    id,
    adapter,
    sourceKey: id,
    sourceUrl: `https://example.com/${id}`,
    title: null,
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
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
}

function successfulResult(): RssPollResult {
  return {
    status: "not_modified",
    insertedItems: 0,
    duplicateItems: 0,
    warnings: [],
    cursor: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeRepository(items: Subscription[]): SubscriptionRepository {
  return {
    listDue: (_timestamp: number, limit: number) => items.slice(0, limit),
  } as unknown as SubscriptionRepository;
}

describe("PollCoordinator", () => {
  test("rejects overlapping polls for the same subscription", async () => {
    const operation = deferred<RssPollResult>();
    const coordinator = new PollCoordinator({ poll: () => operation.promise });

    const first = coordinator.poll("subscription-1");
    await expect(coordinator.poll("subscription-1")).rejects.toBeInstanceOf(
      PollAlreadyRunningError,
    );
    operation.resolve(successfulResult());
    await first;
    expect(coordinator.isPolling("subscription-1")).toBe(false);
  });
});

describe("PollScheduler", () => {
  test("runs at most four polls concurrently and isolates failures", async () => {
    const due = Array.from({ length: 6 }, (_, index) => subscription(`subscription-${index + 1}`));
    const operations = new Map<string, ReturnType<typeof deferred<RssPollResult>>>();
    let active = 0;
    let maximumActive = 0;
    const poller: SourcePoller = {
      poll: (id) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const operation = deferred<RssPollResult>();
        operations.set(id, operation);
        return operation.promise.finally(() => {
          active -= 1;
        });
      },
    };
    const events: unknown[] = [];
    const scheduler = new PollScheduler(
      fakeRepository(due),
      new PollCoordinator(poller),
      () => 1_000,
      undefined,
      (event) => events.push(event),
    );

    const tick = scheduler.tick();
    await Bun.sleep(0);
    expect(operations.size).toBe(4);
    expect(maximumActive).toBe(4);
    operations.get("subscription-1")?.reject(new Error("one failed"));
    for (const [id, operation] of operations) {
      if (id !== "subscription-1") operation.resolve(successfulResult());
    }

    expect(await tick).toBe(4);
    expect(events).toMatchObject([
      { level: "error", message: "subscription_poll_failed", subscriptionId: "subscription-1" },
    ]);
  });

  test("does not schedule event-driven Telegram subscriptions", async () => {
    const due = [subscription("telegram-1", "telegram"), subscription("rss-1")];
    const polled: string[] = [];
    const scheduler = new PollScheduler(
      fakeRepository(due),
      new PollCoordinator({
        poll: async (id) => {
          polled.push(id);
          return successfulResult();
        },
      }),
    );

    expect(await scheduler.tick()).toBe(1);
    expect(polled).toEqual(["rss-1"]);
  });

  test("stop waits for in-flight work and prevents another tick", async () => {
    const operation = deferred<RssPollResult>();
    let polls = 0;
    const coordinator = new PollCoordinator({
      poll: () => {
        polls += 1;
        return operation.promise;
      },
    });
    const scheduler = new PollScheduler(
      fakeRepository([subscription("subscription-1")]),
      coordinator,
    );

    const tick = scheduler.tick();
    await Bun.sleep(0);
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(0);
    expect(stopped).toBe(false);

    operation.resolve(successfulResult());
    await tick;
    await stopping;
    expect(await scheduler.tick()).toBe(0);
    await expect(coordinator.poll("subscription-2")).rejects.toThrow("stopping");
    expect(polls).toBe(1);
  });
});
