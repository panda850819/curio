import { redactSensitiveUrls, sanitizeErrorMessage } from "../security/redaction.ts";
import type { DeliveryPayload } from "./types.ts";

export interface TelegramHttpResponse {
  status: number;
  body: string;
}

export interface TelegramTransport {
  send(token: string, body: Readonly<Record<string, unknown>>): Promise<TelegramHttpResponse>;
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

function plainExcerpt(payload: DeliveryPayload): string {
  const item = payload.item;
  if (!item) return "No item content available.";
  const raw = item.contentText ?? item.summary ?? item.contentHtml?.replace(/<[^>]*>/g, " ") ?? "";
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact || "No preview available.";
}

export function renderTelegramMessage(payload: DeliveryPayload): string {
  if (payload.item) {
    const title = escapedWithin(payload.item.title?.trim() || "Untitled item", 400);
    const source = escapedWithin(
      payload.subscription.title?.trim() || redactSensitiveUrls(payload.subscription.sourceUrl),
      600,
    );
    const excerpt = escapedWithin([...plainExcerpt(payload)].slice(0, 800).join(""), 1_800);
    const lines = [`<b>${title}</b>`, `<i>${source}</i>`, "", excerpt];
    if (payload.item.url) {
      const link = escapedWithin(payload.item.url, 1_000);
      lines.push("", `<a href="${link}">Read original</a>`);
    } else {
      lines.push("", "No canonical link available.");
    }
    return lines.join("\n").slice(0, 4_096);
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

  async send(payload: DeliveryPayload): Promise<TelegramSendResult> {
    try {
      const response = await this.transport.send(this.token, {
        chat_id: payload.chatId,
        text: renderTelegramMessage(payload),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
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
