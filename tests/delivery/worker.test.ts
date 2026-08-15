import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migrate } from "../../src/db/migrations.ts";
import { SubscriptionRepository } from "../../src/db/repositories.ts";
import { DeliveryRepository } from "../../src/delivery/repository.ts";
import type {
  TelegramDestinationAdapter,
  TelegramSendResult,
} from "../../src/delivery/telegram.ts";
import { DeliveryWorker } from "../../src/delivery/worker.ts";

const migrationsPath = resolve(import.meta.dir, "../../migrations");
function sequence(prefix: string) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
function setup(result: TelegramSendResult | Promise<TelegramSendResult>) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  let now = 1_000;
  const subscriptions = new SubscriptionRepository(database, sequence("subscription"), () => now);
  const deliveries = new DeliveryRepository(database, sequence("delivery"), () => now);
  const subscription = subscriptions.create({
    adapter: "rss",
    sourceKey: "feed",
    sourceUrl: "https://example.com/feed",
  });
  deliveries.syncTelegramDestination("@channel");
  subscriptions.recordFailure(subscription.id, "failure", now);
  let sends = 0;
  const adapter = {
    send: async () => {
      sends += 1;
      return await result;
    },
  } as unknown as TelegramDestinationAdapter;
  const worker = new DeliveryWorker(
    deliveries,
    adapter,
    () => now,
    undefined,
    () => {},
  );
  return {
    database,
    deliveries,
    worker,
    setNow: (value: number) => {
      now = value;
    },
    sends: () => sends,
  };
}

describe("DeliveryWorker", () => {
  test("persists acknowledgements and never reclaims delivered records", async () => {
    const context = setup({ outcome: "delivered", messageId: 77, httpStatus: 200 });
    expect(await context.worker.tick()).toBe(1);
    expect(context.deliveries.list()[0]).toMatchObject({
      status: "delivered",
      telegramMessageId: 77,
    });
    expect(await context.worker.tick()).toBe(0);
    expect(context.sends()).toBe(1);
    context.database.close();
  });

  test("marks an acknowledged send uncertain when delivered persistence fails", async () => {
    const context = setup({ outcome: "delivered", messageId: 77, httpStatus: 200 });
    context.database.exec(`CREATE TRIGGER block_delivered_status BEFORE UPDATE ON deliveries
      WHEN NEW.status = 'delivered' BEGIN SELECT RAISE(ABORT, 'delivered blocked'); END;`);

    expect(await context.worker.tick()).toBe(1);
    expect(context.deliveries.list()[0]?.status).toBe("uncertain");
    const delivery = context.deliveries.list()[0];
    if (!delivery) throw new Error("Expected uncertain delivery");
    expect(context.deliveries.listAttempts(delivery.id)).toMatchObject([{ outcome: "uncertain" }]);
    context.database.close();
  });

  test("honors retry_after and stops automatic retries after five attempts", async () => {
    const context = setup({
      outcome: "retry",
      error: "rate limited",
      httpStatus: 429,
      retryAfterSeconds: 17,
    });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await context.worker.tick()).toBe(1);
      const delivery = context.deliveries.list()[0];
      if (!delivery) throw new Error("Expected delivery");
      if (attempt < 5) {
        expect(delivery).toMatchObject({
          status: "retry_scheduled",
          nextAttemptAt: 1_000 + attempt * 17_000,
        });
        context.setNow(1_000 + attempt * 17_000);
      } else {
        expect(delivery.status).toBe("permanent_failure");
      }
    }
    const delivery = context.deliveries.list()[0];
    if (!delivery) throw new Error("Expected delivery");
    expect(context.deliveries.listAttempts(delivery.id)).toHaveLength(5);
    context.database.close();
  });

  test("uses bounded backoff for server failures", async () => {
    const context = setup({ outcome: "retry", error: "server failed", httpStatus: 503 });
    const expectedDelays = [60_000, 300_000, 1_800_000, 7_200_000];
    let now = 1_000;
    for (const delay of expectedDelays) {
      expect(await context.worker.tick()).toBe(1);
      const delivery = context.deliveries.list()[0];
      expect(delivery?.nextAttemptAt).toBe(now + delay);
      now += delay;
      context.setNow(now);
    }
    expect(await context.worker.tick()).toBe(1);
    expect(context.deliveries.list()[0]?.status).toBe("permanent_failure");
    context.database.close();
  });

  test("does not leave invalid payloads stuck in processing", async () => {
    const context = setup({ outcome: "delivered", messageId: 1, httpStatus: 200 });
    context.database.query("UPDATE destinations SET config_json = '{}'").run();
    expect(await context.worker.tick()).toBe(1);
    expect(context.deliveries.list()[0]?.status).toBe("permanent_failure");
    context.database.close();
  });

  test("stops claiming and waits for an in-flight send", async () => {
    let resolveSend!: (result: TelegramSendResult) => void;
    const send = new Promise<TelegramSendResult>((resolve) => {
      resolveSend = resolve;
    });
    const context = setup(send);
    const tick = context.worker.tick();
    await Bun.sleep(0);
    let stopped = false;
    const stopping = context.worker.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(0);
    expect(stopped).toBe(false);

    resolveSend({ outcome: "delivered", messageId: 9, httpStatus: 200 });
    await tick;
    await stopping;
    expect(await context.worker.tick()).toBe(0);
    expect(context.deliveries.list()[0]?.status).toBe("delivered");
    context.database.close();
  });

  test("marks malformed or timed-out outcomes uncertain without retry", async () => {
    const context = setup({ outcome: "uncertain", error: "ambiguous", httpStatus: null });
    expect(await context.worker.tick()).toBe(1);
    expect(context.deliveries.list()[0]?.status).toBe("uncertain");
    expect(await context.worker.tick()).toBe(0);
    context.database.close();
  });
});
