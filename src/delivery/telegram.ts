import { redactSensitiveUrls, sanitizeErrorMessage } from "../security/redaction.ts";
import type { DeliveryPayload } from "./types.ts";

export interface TelegramHttpResponse {
  status: number;
  body: string;
}

export interface TelegramTransport {
  send(token: string, body: Readonly<Record<string, unknown>>): Promise<TelegramHttpResponse>;
  getChat?(token: string, body: Readonly<Record<string, unknown>>): Promise<TelegramHttpResponse>;
}

export class TelegramTimeoutError extends Error {
  constructor() {
    super("Telegram request timed out with an unknown send outcome");
    this.name = "TelegramTimeoutError";
  }
}

export class FetchTelegramTransport implements TelegramTransport {
  constructor(
    private readonly timeoutMilliseconds = 10_000,
    private readonly apiBaseUrl = "https://api.telegram.org",
  ) {}

  async send(
    token: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<TelegramHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const response = await fetch(`${this.apiBaseUrl}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      if (controller.signal.aborted) throw new TelegramTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async getChat(
    token: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<TelegramHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const response = await fetch(`${this.apiBaseUrl}/bot${token}/getChat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      if (controller.signal.aborted) throw new TelegramTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function escapedWithin(value: string, maximumOutput: number): string {
  let output = "";
  for (const character of value) {
    const escaped =
      character === "&"
        ? "&amp;"
        : character === "<"
          ? "&lt;"
          : character === ">"
            ? "&gt;"
            : character === '"'
              ? "&quot;"
              : character;
    if (output.length + escaped.length > maximumOutput) break;
    output += escaped;
  }
  return output;
}

function publicationLine(payload: DeliveryPayload): string {
  const details: string[] = [];
  const author = payload.item?.author?.trim();
  if (author) details.push(author);
  const publishedAt = payload.item?.publishedAt;
  const publishedDate =
    publishedAt === null || publishedAt === undefined ? null : new Date(publishedAt);
  if (publishedDate !== null && Number.isFinite(publishedDate.getTime())) {
    details.push(
      new Intl.DateTimeFormat("zh-TW", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "Asia/Taipei",
      }).format(publishedDate),
    );
  }
  return details.join(" · ");
}

function telegramItemContent(payload: DeliveryPayload): string {
  if (
    (payload.subscription.adapter !== "telegram" &&
      payload.subscription.adapter !== "telegram_html") ||
    !payload.item
  )
    return "";
  const content = payload.item.contentText?.trim() || payload.item.summary?.trim() || "";
  return content ? escapedWithin(content, 2_800) : "";
}

function itemTags(payload: DeliveryPayload): string {
  const metadata = payload.item?.metadata;
  const categories =
    metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata.categories
      : undefined;
  const categoryTags = Array.isArray(categories)
    ? categories
        .filter((category): category is string => typeof category === "string")
        .map((category) =>
          category
            .trim()
            .replace(/\s+/g, "_")
            .replace(/[^\p{L}\p{N}_]/gu, ""),
        )
        .filter(Boolean)
        .slice(0, 3)
        .map((category) => `#${category}`)
    : [];
  return categoryTags.join(" ");
}

export function renderTelegramMessage(payload: DeliveryPayload): string {
  if (payload.item) {
    const source = escapedWithin(
      payload.subscription.title?.trim() || redactSensitiveUrls(payload.subscription.sourceUrl),
      400,
    );
    const publication = publicationLine(payload);
    const publicationHtml = publication ? `<i>${escapedWithin(publication, 350)}</i>` : "";
    const content = telegramItemContent(payload);
    const tags = escapedWithin(itemTags(payload), 250);
    return [`<b>拾跡 · ${source}</b>`, publicationHtml, content, tags].filter(Boolean).join("\n");
  }

  const event = payload.failureEvent;
  if (!event) throw new Error("Delivery has no renderable payload");
  const source = escapedWithin(
    payload.subscription.title?.trim() || redactSensitiveUrls(payload.subscription.sourceUrl),
    700,
  );
  const error = escapedWithin(event.error, 1_800);
  const timestamp = new Date(event.failedAt).toISOString();
  return [
    "<b>Curio poll failure</b>",
    `<i>${source}</i>`,
    `Attempt: ${event.attempt}`,
    `Time: ${timestamp}`,
    "",
    error,
  ]
    .join("\n")
    .slice(0, 4_096);
}

export interface TelegramChatMetadata {
  id: number | string;
  type: string;
  title?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export type TelegramSendResult =
  | { outcome: "delivered"; messageId: number; httpStatus: number }
  | { outcome: "retry"; error: string; httpStatus: number | null; retryAfterSeconds?: number }
  | { outcome: "uncertain"; error: string; httpStatus: number | null }
  | { outcome: "permanent_failure"; error: string; httpStatus: number };

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function responseError(parsed: Record<string, unknown> | null, fallback: string): string {
  return sanitizeErrorMessage(
    parsed && typeof parsed.description === "string" ? parsed.description : fallback,
  );
}

export class TelegramDestinationAdapter {
  constructor(
    private readonly token: string,
    private readonly transport: TelegramTransport = new FetchTelegramTransport(),
  ) {
    if (!token.trim()) throw new Error("Telegram bot token must not be empty");
  }

  private safeError(value: unknown): string {
    return sanitizeErrorMessage(value).split(this.token).join("[bot-token-redacted]");
  }

  async verifyChat(chatId: string): Promise<TelegramChatMetadata> {
    const getChat = this.transport.getChat;
    if (!getChat) throw new Error("Telegram transport does not support chat verification");
    try {
      const response = await getChat.call(this.transport, this.token, { chat_id: chatId });
      const parsed = parseJson(response.body);
      if (response.status < 200 || response.status >= 300 || parsed?.ok !== true) {
        throw new Error(responseError(parsed, `Telegram HTTP ${response.status}`));
      }
      const result = parsed.result;
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("Telegram returned malformed chat metadata");
      }
      const value = result as Record<string, unknown>;
      const id = value.id;
      const type = value.type;
      if (
        !(
          (typeof id === "number" && Number.isSafeInteger(id)) ||
          (typeof id === "string" && id.length > 0)
        ) ||
        typeof type !== "string" ||
        !type
      ) {
        throw new Error("Telegram returned malformed chat metadata");
      }
      const metadata: TelegramChatMetadata = { id, type };
      if (typeof value.title === "string") metadata.title = value.title;
      if (typeof value.username === "string") metadata.username = value.username;
      if (typeof value.first_name === "string") metadata.firstName = value.first_name;
      if (typeof value.last_name === "string") metadata.lastName = value.last_name;
      return metadata;
    } catch (error) {
      throw new Error(this.safeError(error));
    }
  }

  async send(payload: DeliveryPayload): Promise<TelegramSendResult> {
    try {
      const request: Record<string, unknown> = {
        chat_id: payload.chatId,
        text: renderTelegramMessage(payload),
        parse_mode: "HTML",
      };
      if (payload.item?.url) {
        request.link_preview_options = {
          is_disabled: false,
          url: payload.item.url,
          prefer_large_media: true,
          show_above_text: true,
        };
      } else {
        request.link_preview_options = { is_disabled: true };
      }
      const response = await this.transport.send(this.token, request);
      const parsed = parseJson(response.body);
      if (response.status >= 200 && response.status < 300) {
        const result = parsed?.result;
        const messageId =
          result !== null && typeof result === "object" && !Array.isArray(result)
            ? (result as Record<string, unknown>).message_id
            : undefined;
        if (
          parsed?.ok === true &&
          typeof messageId === "number" &&
          Number.isSafeInteger(messageId)
        ) {
          return { outcome: "delivered", messageId, httpStatus: response.status };
        }
        return {
          outcome: "uncertain",
          error: "Telegram returned a malformed success response",
          httpStatus: response.status,
        };
      }
      if (response.status === 429) {
        const parameters = parsed?.parameters;
        const retryAfter =
          parameters !== null && typeof parameters === "object" && !Array.isArray(parameters)
            ? (parameters as Record<string, unknown>).retry_after
            : undefined;
        return {
          outcome: "retry",
          error: this.safeError(responseError(parsed, "Telegram rate limit")),
          httpStatus: response.status,
          retryAfterSeconds:
            typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter, 86_400)
              : 60,
        };
      }
      if (response.status >= 500) {
        return {
          outcome: "retry",
          error: this.safeError(responseError(parsed, `Telegram HTTP ${response.status}`)),
          httpStatus: response.status,
        };
      }
      return {
        outcome: "permanent_failure",
        error: this.safeError(responseError(parsed, `Telegram HTTP ${response.status}`)),
        httpStatus: response.status,
      };
    } catch (error) {
      if (error instanceof TelegramTimeoutError) {
        return { outcome: "uncertain", error: error.message, httpStatus: null };
      }
      return { outcome: "retry", error: "Telegram network request failed", httpStatus: null };
    }
  }
}
