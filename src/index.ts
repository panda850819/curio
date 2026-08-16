import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { migrate } from "./db/migrations.ts";
import { ItemRepository, SubscriptionRepository } from "./db/repositories.ts";
import { DeliveryRepository } from "./delivery/repository.ts";
import { TelegramDestinationAdapter } from "./delivery/telegram.ts";
import { DeliveryWorker } from "./delivery/worker.ts";
import { handleRequest } from "./http.ts";
import { SafeHttpClient, SystemResolver } from "./probe/index.ts";
import { PollCoordinator, PollScheduler } from "./scheduler.ts";
import { SourceRouter } from "./sources/router.ts";
import { RssSourceAdapter } from "./sources/rss/index.ts";
import { XSourceAdapter } from "./sources/x/adapter.ts";
import { ProcessXbirdClient } from "./sources/x/client.ts";

const config = loadConfig();
const database = openDatabase(config.databasePath);
const migrationsPath = process.env.MIGRATIONS_PATH || resolve(import.meta.dir, "../migrations");
const appliedMigrations = migrate(database, migrationsPath);
const subscriptions = new SubscriptionRepository(database);
const items = new ItemRepository(database);
const rssAdapter = new RssSourceAdapter(
  new SafeHttpClient(new SystemResolver()),
  subscriptions,
  items,
);
const xClient = config.x
  ? new ProcessXbirdClient(config.x.authToken, config.x.ct0)
  : { userTweets: () => Promise.reject(new Error("X credentials are not configured")) };
const xAdapter = new XSourceAdapter(xClient, subscriptions, items);
const coordinator = new PollCoordinator(
  new SourceRouter(subscriptions, { rss: rssAdapter, x: xAdapter }),
);
const scheduler = new PollScheduler(subscriptions, coordinator);
const schedulerAbort = new AbortController();
const deliveryAbort = new AbortController();
const deliveryRepository = new DeliveryRepository(database);
let deliveryWorker: DeliveryWorker | null = null;
let deliveryRun: Promise<void> | null = null;
if (config.telegram) {
  deliveryRepository.syncTelegramDestination(config.telegram.chatId);
  deliveryWorker = new DeliveryWorker(
    deliveryRepository,
    new TelegramDestinationAdapter(config.telegram.botToken),
  );
  deliveryRun = deliveryWorker.run(deliveryAbort.signal);
} else {
  deliveryRepository.disableTelegramDestination();
}
const schedulerRun = scheduler.run(schedulerAbort.signal);

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: handleRequest,
});

console.log(
  JSON.stringify({
    level: "info",
    message: "curio_started",
    url: server.url.toString(),
    appliedMigrations,
  }),
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", message: "curio_stopping", signal }));

  schedulerAbort.abort();
  deliveryAbort.abort();
  await scheduler.stop();
  await deliveryWorker?.stop();
  await schedulerRun;
  await deliveryRun;
  await server.stop(false);
  database.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
