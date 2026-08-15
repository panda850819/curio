import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { migrate } from "./db/migrations.ts";
import { ItemRepository, SubscriptionRepository } from "./db/repositories.ts";
import { handleRequest } from "./http.ts";
import { SafeHttpClient, SystemResolver } from "./probe/index.ts";
import { PollCoordinator, PollScheduler } from "./scheduler.ts";
import { RssSourceAdapter } from "./sources/rss/index.ts";

const config = loadConfig();
const database = openDatabase(config.databasePath);
const migrationsPath = process.env.MIGRATIONS_PATH || resolve(import.meta.dir, "../migrations");
const appliedMigrations = migrate(database, migrationsPath);
const subscriptions = new SubscriptionRepository(database);
const items = new ItemRepository(database);
const adapter = new RssSourceAdapter(
  new SafeHttpClient(new SystemResolver()),
  subscriptions,
  items,
);
const coordinator = new PollCoordinator(adapter);
const scheduler = new PollScheduler(subscriptions, coordinator);
const schedulerAbort = new AbortController();
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
  await scheduler.stop();
  await schedulerRun;
  await server.stop(false);
  database.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
