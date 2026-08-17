#!/usr/bin/env bun
import { loadConfig } from "../config.ts";
import { FetchTelegramBotApi } from "./api.ts";
import { loadTelegramBotSettings } from "./config.ts";

const config = loadConfig();
const settings = loadTelegramBotSettings();
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim() || "";
if (!config.telegram) throw new Error("Telegram bot credentials are not configured");
if (!settings.webhookSecret) throw new Error("TELEGRAM_WEBHOOK_SECRET is not configured");
if (!webhookUrl) throw new Error("TELEGRAM_WEBHOOK_URL is not configured");

await new FetchTelegramBotApi(config.telegram.botToken).setWebhook(
  webhookUrl,
  settings.webhookSecret,
);
console.log(JSON.stringify({ status: "ok", message: "telegram_webhook_configured" }));
