import { sanitizeErrorMessage } from "../security/redaction.ts";

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramBotApi {
  sendMessage(chatId: string, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  setWebhook(url: string, secretToken: string): Promise<void>;
}

interface TelegramApiResponse {
  status: number;
  body: string;
}

function parsedBody(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class FetchTelegramBotApi implements TelegramBotApi {
  constructor(
    private readonly token: string,
    private readonly timeoutMilliseconds = 10_000,
    private readonly apiBaseUrl = "https://api.telegram.org",
  ) {
    if (!token.trim()) throw new Error("Telegram bot token must not be empty");
  }

  private safeError(value: unknown): Error {
    return new Error(sanitizeErrorMessage(value).split(this.token).join("[bot-token-redacted]"));
  }

  private async request(method: string, body: Readonly<Record<string, unknown>>): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
      try {
        const response = await fetch(`${this.apiBaseUrl}/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const apiResponse: TelegramApiResponse = {
          status: response.status,
          body: await response.text(),
        };
        const parsed = parsedBody(apiResponse.body);
        if (apiResponse.status === 429 && attempt === 0) {
          const parameters =
            parsed?.parameters !== null &&
            typeof parsed?.parameters === "object" &&
            !Array.isArray(parsed.parameters)
              ? (parsed.parameters as Record<string, unknown>)
              : null;
          const retryAfter =
            typeof parameters?.retry_after === "number" &&
            Number.isFinite(parameters.retry_after) &&
            parameters.retry_after >= 0
              ? parameters.retry_after
              : null;
          if (retryAfter !== null && retryAfter <= 5) {
            await new Promise((resolve) => setTimeout(resolve, retryAfter * 1_000));
            continue;
          }
        }
        if (apiResponse.status < 200 || apiResponse.status >= 300 || parsed?.ok !== true) {
          const description = typeof parsed?.description === "string" ? parsed.description : method;
          throw new Error(`Telegram ${method} failed: ${description}`);
        }
        return;
      } catch (error) {
        if (controller.signal.aborted) throw this.safeError(`Telegram ${method} timed out`);
        throw this.safeError(error);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  sendMessage(chatId: string, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
    return this.request("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    return this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  setWebhook(url: string, secretToken: string): Promise<void> {
    return this.request("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query", "channel_post", "edited_channel_post"],
      max_connections: 1,
    });
  }
}
