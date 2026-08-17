import { describe, expect, test } from "bun:test";
import {
  renderTelegramMessage,
  TelegramDestinationAdapter,
  TelegramTimeoutError,
  type TelegramTransport,
} from "../../src/delivery/telegram.ts";
import type { DeliveryPayload } from "../../src/delivery/types.ts";

function payload(kind: "item" | "failure" = "item"): DeliveryPayload {
  const subscription = {
    id: "subscription-1",
    adapter: "rss",
    sourceKey: "feed",
    sourceUrl: "https://example.com/feed?secret=x",
    title: "Source & <name>",
    enabled: true,
    cursor: null,
    metadata: {},
    lastPolledAt: null,
    lastSuccessAt: null,
    nextPollAt: null,
    pollIntervalMinutes: 60,
    consecutiveFailures: 1,
    lastError: null,
    lastFailedAt: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };
  const delivery = {
    id: "delivery-1",
    destinationId: "destination-1",
    itemId: kind === "item" ? "item-1" : null,
    failureEventId: kind === "failure" ? "failure-1" : null,
    status: "processing" as const,
    attemptCount: 1,
    nextAttemptAt: null,
    telegramMessageId: null,
    lastError: null,
    claimedAt: 1,
    deliveredAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    delivery,
    chatId: "@channel",
    subscription,
    item:
      kind === "item"
        ? {
            id: "item-1",
            subscriptionId: subscription.id,
            externalId: "external",
            title: "Title <unsafe>",
            url: "https://example.com/item?a=1&b=2",
            summary: `First paragraph with &#21407; &amp; text.\n\n${"x".repeat(1_000)}`,
            author: "Panda",
            publishedAt: Date.UTC(2026, 4, 23),
            discoveredAt: 1,
            createdAt: 1,
            updatedAt: 1,
            metadata: { categories: ["personal notes", "生活"] },
          }
        : null,
    failureEvent:
      kind === "failure"
        ? {
            id: "failure-1",
            subscriptionId: subscription.id,
            attempt: 3,
            error: "bad <error>",
            failedAt: 1_000,
            createdAt: 1_000,
            deliveredAt: null,
          }
        : null,
  };
}

class FakeTransport implements TelegramTransport {
  readonly calls: Array<{ token: string; body: Readonly<Record<string, unknown>> }> = [];
  constructor(private readonly response: { status: number; body: string } | Error) {}
  async send(token: string, body: Readonly<Record<string, unknown>>) {
    this.calls.push({ token, body });
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

describe("Telegram rendering", () => {
  test("renders a compact collection label without repeating preview content", () => {
    const message = renderTelegramMessage(payload());
    expect(message).toBe(
      "<b>拾跡 · Source &amp; &lt;name&gt;</b>\n<i>Panda · 2026年5月23日</i>\n#personal_notes #生活",
    );
    expect(message).not.toContain("Title");
    expect(message).not.toContain("First paragraph");
    expect(message).not.toContain("Substack");
    expect(message).not.toContain("RSS");
  });

  test("uses deterministic fallbacks without broken markup", () => {
    const fallback = payload();
    if (!fallback.item) throw new Error("Expected item payload");
    fallback.item.title = null;
    fallback.item.url = null;
    fallback.item.summary = null;
    fallback.item.contentHtml = null;
    fallback.item.author = null;
    fallback.item.publishedAt = null;
    fallback.item.metadata = {};
    const message = renderTelegramMessage(fallback);
    expect(message).toBe("<b>拾跡 · Source &amp; &lt;name&gt;</b>\n<i>作者未提供 · 日期未提供</i>");
  });

  test("renders failure context safely", () => {
    const failure = payload("failure");
    failure.subscription.title = null;
    const message = renderTelegramMessage(failure);
    expect(message).toContain("Attempt: 3");
    expect(message).toContain("bad &lt;error&gt;");
    expect(message).toContain("1970-01-01T00:00:01.000Z");
    expect(message).not.toContain("secret=x");
  });
});

describe("TelegramDestinationAdapter", () => {
  test("verifies a Telegram chat without exposing the bot token", async () => {
    const calls: Array<{ token: string; body: Readonly<Record<string, unknown>> }> = [];
    const transport: TelegramTransport = {
      send: async () => ({ status: 200, body: "{}" }),
      getChat: async (token, body) => {
        calls.push({ token, body });
        return {
          status: 200,
          body: JSON.stringify({
            ok: true,
            result: { id: -1001, type: "channel", title: "Example", username: "example" },
          }),
        };
      },
    };
    const result = await new TelegramDestinationAdapter("secret-token", transport).verifyChat(
      "@example",
    );
    expect(result).toEqual({
      id: -1001,
      type: "channel",
      title: "Example",
      username: "example",
    });
    expect(calls).toEqual([{ token: "secret-token", body: { chat_id: "@example" } }]);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("accepts a valid Telegram acknowledgement", async () => {
    const transport = new FakeTransport({
      status: 200,
      body: '{"ok":true,"result":{"message_id":42}}',
    });
    const result = await new TelegramDestinationAdapter("secret-token", transport).send(payload());
    expect(result).toEqual({ outcome: "delivered", messageId: 42, httpStatus: 200 });
    expect(transport.calls[0]?.body).toMatchObject({
      chat_id: "@channel",
      parse_mode: "HTML",
      link_preview_options: {
        is_disabled: false,
        url: "https://example.com/item?a=1&b=2",
        prefer_large_media: true,
        show_above_text: true,
      },
    });
  });

  test("classifies malformed success and timeout as uncertain", async () => {
    expect(
      await new TelegramDestinationAdapter(
        "token",
        new FakeTransport({ status: 200, body: "{}" }),
      ).send(payload()),
    ).toMatchObject({ outcome: "uncertain", httpStatus: 200 });
    expect(
      await new TelegramDestinationAdapter(
        "token",
        new FakeTransport(new TelegramTimeoutError()),
      ).send(payload()),
    ).toMatchObject({ outcome: "uncertain", httpStatus: null });
  });

  test("never returns the bot token in errors", async () => {
    const token = "secret-bot-token";
    const result = await new TelegramDestinationAdapter(
      token,
      new FakeTransport({ status: 403, body: JSON.stringify({ description: `invalid ${token}` }) }),
    ).send(payload());
    expect(result).toMatchObject({ outcome: "permanent_failure" });
    expect("error" in result ? result.error : "").not.toContain(token);
  });

  test("honors 429 and classifies 5xx, network, and permanent 4xx", async () => {
    expect(
      await new TelegramDestinationAdapter(
        "token",
        new FakeTransport({ status: 429, body: '{"ok":false,"parameters":{"retry_after":17}}' }),
      ).send(payload()),
    ).toMatchObject({ outcome: "retry", retryAfterSeconds: 17 });
    expect(
      await new TelegramDestinationAdapter(
        "token",
        new FakeTransport({ status: 503, body: "{}" }),
      ).send(payload()),
    ).toMatchObject({ outcome: "retry", httpStatus: 503 });
    expect(
      await new TelegramDestinationAdapter("token", new FakeTransport(new Error("offline"))).send(
        payload(),
      ),
    ).toMatchObject({ outcome: "retry", httpStatus: null });
    expect(
      await new TelegramDestinationAdapter(
        "token",
        new FakeTransport({ status: 403, body: '{"description":"forbidden"}' }),
      ).send(payload()),
    ).toMatchObject({ outcome: "permanent_failure", httpStatus: 403 });
  });
});
