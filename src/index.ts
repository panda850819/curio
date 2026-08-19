import { resolve } from "node:path";
import { createApp } from "./app/create-app.ts";
import { FetchTelegramBotApi } from "./bot/api.ts";
import { loadTelegramBotSettings } from "./bot/config.ts";
import { TelegramControlService } from "./bot/control.ts";
import { createTelegramWebhookHandler, type TelegramWebhookHandler } from "./bot/webhook.ts";
import { loadConfig } from "./config.ts";
import { TelegramDestinationAdapter } from "./delivery/telegram.ts";
import { DeliveryWorker } from "./delivery/worker.ts";
import { createHttpHandler } from "./http.ts";
import { createEmailWebhookHandler, type EmailWebhookHandler } from "./sources/email/index.ts";
import { createUiHandler } from "./ui/handler.ts";

const config = loadConfig();
const botSettings = loadTelegramBotSettings();
const migrationsPath = process.env.MIGRATIONS_PATH || resolve(import.meta.dir, "../migrations");
const app = createApp({
  databasePath: config.databasePath,
  migrationsPath,
  x: config.x,
  telegram: config.telegram,
  email: config.email,
  github: config.github,
});
let telegramWebhook: TelegramWebhookHandler | undefined;
let emailWebhook: EmailWebhookHandler | undefined;
const webhookSecret = botSettings.webhookSecret;
if (config.telegram && webhookSecret) {
  const botApi = new FetchTelegramBotApi(config.telegram.botToken);
  const control = new TelegramControlService(
    app.services,
    app.telegramBotRepository,
    botApi,
    botSettings,
    Date.now,
    undefined,
    app.telegramSource,
  );
  telegramWebhook = createTelegramWebhookHandler(webhookSecret, control);
}
if (config.email && app.emailSource) {
  emailWebhook = createEmailWebhookHandler(config.email.webhookSecret, app.emailSource);
}

const ui = createUiHandler(app);

const schedulerAbort = new AbortController();
const deliveryAbort = new AbortController();
let deliveryWorker: DeliveryWorker | null = null;
let deliveryRun: Promise<void> | null = null;

if (config.telegram) {
  app.deliveryRepository.syncTelegramDestination(config.telegram.chatId);
  deliveryWorker = new DeliveryWorker(
    app.deliveryRepository,
    new TelegramDestinationAdapter(config.telegram.botToken),
  );
  deliveryRun = deliveryWorker.run(deliveryAbort.signal);
} else {
  app.deliveryRepository.disableTelegramDestination();
}

const schedulerRun = app.scheduler.run(schedulerAbort.signal);
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createHttpHandler({
    services: app.services,
    telegramWebhook,
    emailWebhook,
    ui,
    log: (event) => console.log(JSON.stringify(event)),
  }),
});

console.log(
  JSON.stringify({
    level: "info",
    message: "curio_started",
    url: server.url.toString(),
    appliedMigrations: app.appliedMigrations,
  }),
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", message: "curio_stopping", signal }));

  schedulerAbort.abort();
  deliveryAbort.abort();
  await app.scheduler.stop();
  await deliveryWorker?.stop();
  await schedulerRun;
  await deliveryRun;
  await server.stop(false);
  app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
