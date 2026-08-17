import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../src/app/create-app.ts";
import type { InlineKeyboardMarkup, TelegramBotApi } from "../src/bot/api.ts";
import type { TelegramBotSettings } from "../src/bot/config.ts";
import { loadTelegramBotSettings } from "../src/bot/config.ts";
import { TelegramControlService } from "../src/bot/control.ts";
import { createTelegramWebhookHandler } from "../src/bot/webhook.ts";
import { migrate } from "../src/db/migrations.ts";
import { createHttpHandler } from "../src/http.ts";
import type { ProbeHttpClient, ProbeResult } from "../src/probe/types.ts";

const migrationsPath = resolve(import.meta.dir, "../migrations");
const candidate = {
  adapter: "rss" as const,
  format: "rss" as const,
  sourceUrl: "https://example.com/feed.xml",
  sourceKey: "https://example.com/feed.xml",
  title: "Example feed",
  discoveredVia: "direct" as const,
};

class FakeBotApi implements TelegramBotApi {
  readonly messages: Array<{ chatId: string; text: string; replyMarkup?: InlineKeyboardMarkup }> =
    [];
  readonly answers: Array<{ id: string; text?: string }> = [];
  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    this.messages.push({ chatId, text, replyMarkup });
  }
  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    this.answers.push({ id, text });
  }
  async setWebhook(): Promise<void> {}
}

function updateMessage(updateId: number, text: string, userId = 123, chatId = -100): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId },
      chat: { id: chatId, type: "private" },
      text,
    },
  };
}

function updateCallback(
  updateId: number,
  callbackData: string,
  userId = 123,
  chatId = -100,
): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: userId },
      message: { message_id: updateId, chat: { id: chatId, type: "private" } },
      data: callbackData,
    },
  };
}

function harness() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  const probeClient: ProbeHttpClient = {
    get: async (url) => ({
      url,
      status: 200,
      headers: { get: (name: string) => (name === "content-type" ? "application/rss+xml" : null) },
      body: new TextEncoder().encode(
        "<rss version='2.0'><channel><title>Example</title></channel></rss>",
      ),
    }),
  };
  const app = createApp({ database, migrationsPath, probeClient });
  const api = new FakeBotApi();
  const settings: TelegramBotSettings = {
    webhookSecret: "webhook-secret",
    allowedUserIds: ["123"],
    allowedChatIds: ["-100"],
  };
  const control = new TelegramControlService(
    app.services,
    app.telegramBotRepository,
    api,
    settings,
    () => 1_000,
  );
  return { database, app, api, control, settings };
}

describe("Telegram bot configuration", () => {
  test("parses numeric allowlists and requires users when webhook is enabled", () => {
    expect(
      loadTelegramBotSettings({
        TELEGRAM_WEBHOOK_SECRET: "secret",
        TELEGRAM_ALLOWED_USER_IDS: "123, 456",
        TELEGRAM_ALLOWED_CHAT_IDS: "-100 200",
      }),
    ).toEqual({
      webhookSecret: "secret",
      allowedUserIds: ["123", "456"],
      allowedChatIds: ["-100", "200"],
    });
    expect(() => loadTelegramBotSettings({ TELEGRAM_WEBHOOK_SECRET: "secret" })).toThrow(
      "TELEGRAM_ALLOWED_USER_IDS",
    );
  });
});

describe("Telegram control plane", () => {
  test("claims updates until completion and releases failed work", () => {
    const context = harness();
    expect(context.app.telegramBotRepository.claimUpdate(900, 1_000)).toBe(true);
    expect(context.app.telegramBotRepository.claimUpdate(900, 1_000)).toBe(false);
    expect(context.app.telegramBotRepository.releaseUpdate(900)).toBe(true);
    expect(context.app.telegramBotRepository.claimUpdate(900, 1_000)).toBe(true);
    expect(context.app.telegramBotRepository.completeUpdate(900, 1_001)).toBe(true);
    expect(context.app.telegramBotRepository.claimUpdate(900, 1_002)).toBe(false);
    context.app.close();
    context.database.close();
  });

  test("runs probe-to-follow-to-route and ignores duplicate update IDs", async () => {
    const context = harness();
    const destination = context.app.services.destinations.create({
      destinationKey: "telegram-bot",
      kind: "telegram",
      config: { chatId: "@bot" },
    });

    await context.control.handleUpdate(updateMessage(1, candidate.sourceUrl));
    expect(context.api.messages).toHaveLength(1);
    const candidateCallback =
      context.api.messages[0]?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
    expect(candidateCallback).toBeString();
    expect(candidateCallback?.length).toBeLessThanOrEqual(64);
    expect(candidateCallback).not.toContain(candidate.sourceUrl);
    await context.control.handleUpdate(updateMessage(1, candidate.sourceUrl));
    expect(context.api.messages).toHaveLength(1);

    await context.control.handleUpdate(updateCallback(2, candidateCallback as string));
    const destinationCallback =
      context.api.messages.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
    await context.control.handleUpdate(updateCallback(3, destinationCallback as string));
    const intervalCallback =
      context.api.messages.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
    await context.control.handleUpdate(updateCallback(4, intervalCallback as string));
    const confirmCallback =
      context.api.messages.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
    await context.control.handleUpdate(updateCallback(5, confirmCallback as string));

    expect(context.app.services.subscriptions.list()).toHaveLength(1);
    const subscription = context.app.services.subscriptions.list()[0];
    expect(subscription).toBeDefined();
    expect(
      context.app.services.routes
        .listPage(20, subscription?.id)
        .items.map((route) => route.destinationId),
    ).toEqual([destination.id]);
    await context.control.handleUpdate(updateCallback(5, confirmCallback as string));
    expect(context.app.services.subscriptions.list()).toHaveLength(1);
    expect(context.app.services.routes.listPage(20).items).toHaveLength(1);
    expect(context.api.answers).toHaveLength(4);

    context.app.close();
    context.database.close();
  });

  test("handles zero and multiple candidates and paginates long subscription lists", async () => {
    const context = harness();
    const noCandidateServices = {
      ...context.app.services,
      probe: {
        probe: async (): Promise<ProbeResult> => ({
          inputUrl: "https://example.com/none",
          finalUrl: "https://example.com/none",
          candidates: [],
          warnings: [],
        }),
      },
    };
    const noCandidateControl = new TelegramControlService(
      noCandidateServices,
      context.app.telegramBotRepository,
      context.api,
      context.settings,
      () => 1_000,
    );
    await noCandidateControl.handleUpdate(updateMessage(20, "https://example.com/none"));
    expect(context.api.messages.at(-1)?.text).toContain("找不到");

    const multipleCandidateServices = {
      ...context.app.services,
      probe: {
        probe: async (): Promise<ProbeResult> => ({
          inputUrl: "https://example.com/multiple",
          finalUrl: "https://example.com/multiple",
          candidates: [candidate, { ...candidate, sourceKey: "https://example.com/other.xml" }],
          warnings: [],
        }),
      },
    };
    const multipleCandidateControl = new TelegramControlService(
      multipleCandidateServices,
      context.app.telegramBotRepository,
      context.api,
      context.settings,
      () => 1_000,
    );
    await multipleCandidateControl.handleUpdate(updateMessage(21, "https://example.com/multiple"));
    expect(context.api.messages.at(-1)?.replyMarkup?.inline_keyboard).toHaveLength(2);
    const expiredCallback =
      context.api.messages.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
    const expiredControl = new TelegramControlService(
      multipleCandidateServices,
      context.app.telegramBotRepository,
      context.api,
      context.settings,
      () => 1_000 + 15 * 60_000 + 1,
    );
    await expiredControl.handleUpdate(updateCallback(24, expiredCallback as string));
    expect(context.api.messages.at(-1)?.text).toContain("過期");

    for (let index = 0; index < 21; index += 1) {
      context.app.services.subscriptions.follow({
        candidate: {
          ...candidate,
          sourceKey: `https://example.com/sub-${index}.xml`,
          sourceUrl: `https://example.com/sub-${index}.xml`,
          title: index === 0 ? "x".repeat(200) : `Subscription ${index}`,
        },
        intervalMinutes: 60,
      });
    }
    await context.control.handleUpdate(updateMessage(22, "/subscriptions"));
    const subscriptionKeyboard = context.api.messages.at(-1)?.replyMarkup?.inline_keyboard;
    expect(subscriptionKeyboard).toHaveLength(21);
    expect(subscriptionKeyboard?.[0]?.[0]?.text.length).toBeLessThanOrEqual(60);
    const nextCallback = subscriptionKeyboard?.at(-1)?.[0]?.callback_data;
    expect(nextCallback).toBeString();
    await context.control.handleUpdate(updateCallback(23, nextCallback as string));
    expect(context.api.messages.at(-1)?.text).toContain("Subscription");
    await context.control.handleUpdate(updateMessage(25, "/status"));
    expect(context.api.messages.at(-1)?.text).toContain("失敗 subscriptions");
    await context.control.handleUpdate(updateMessage(26, "/subscriptions"));
    const pauseCallback =
      context.api.messages.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
    await context.control.handleUpdate(updateCallback(27, pauseCallback as string));
    expect(
      context.app.services.subscriptions.list().some((subscription) => !subscription.enabled),
    ).toBe(true);
    await context.control.handleUpdate(updateMessage(28, "/subscriptions"));
    const resumeCallback =
      context.api.messages.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
    await context.control.handleUpdate(updateCallback(29, resumeCallback as string));
    expect(
      context.app.services.subscriptions.list().some((subscription) => !subscription.enabled),
    ).toBe(false);

    context.app.close();
    context.database.close();
  });

  test("enforces user/chat allowlists and webhook secret/body policy", async () => {
    const context = harness();
    await context.control.handleUpdate(updateMessage(10, "/start", 999, -100));
    await context.control.handleUpdate(updateMessage(11, "/start", 123, -101));
    expect(context.api.messages).toEqual([]);

    const webhook = createTelegramWebhookHandler(
      context.settings.webhookSecret as string,
      context.control,
    );
    const unauthorized = await webhook(
      new Request("http://curio.test/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "bad" },
        body: JSON.stringify(updateMessage(12, "/start")),
      }),
    );
    expect(unauthorized.status).toBe(401);
    const accepted = await webhook(
      new Request("http://curio.test/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "webhook-secret",
        },
        body: JSON.stringify(updateMessage(13, "/start")),
      }),
    );
    expect(accepted.status).toBe(200);
    expect(context.api.messages).toHaveLength(1);
    const http = createHttpHandler({ telegramWebhook: webhook, log: () => undefined });
    const routed = await http(
      new Request("http://curio.test/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "webhook-secret",
        },
        body: JSON.stringify(updateMessage(14, "/start")),
      }),
    );
    expect(routed.status).toBe(200);
    expect(routed.headers.get("x-request-id")).toBeString();
    const duplicate = await webhook(
      new Request("http://curio.test/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "webhook-secret",
        },
        body: JSON.stringify(updateMessage(13, "/start")),
      }),
    );
    expect(duplicate.status).toBe(200);
    expect(context.api.messages).toHaveLength(2);

    context.app.close();
    context.database.close();
  });
});
