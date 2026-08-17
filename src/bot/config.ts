export interface TelegramBotSettings {
  webhookSecret: string | null;
  allowedUserIds: readonly string[];
  allowedChatIds: readonly string[];
}

function parseIdList(raw: string | undefined, variable: string, allowNegative: boolean): string[] {
  if (!raw?.trim()) return [];
  const values = raw
    .split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const pattern = allowNegative ? /^-?\d+$/u : /^\d+$/u;
  if (values.some((value) => !pattern.test(value))) {
    throw new Error(`${variable} must contain numeric Telegram IDs`);
  }
  return [...new Set(values)];
}

export function loadTelegramBotSettings(
  env: Record<string, string | undefined> = process.env,
): TelegramBotSettings {
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() || null;
  if (webhookSecret && (webhookSecret.length < 1 || webhookSecret.length > 256)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must be between 1 and 256 characters");
  }
  const allowedUserIds = parseIdList(
    env.TELEGRAM_ALLOWED_USER_IDS,
    "TELEGRAM_ALLOWED_USER_IDS",
    false,
  );
  const allowedChatIds = parseIdList(
    env.TELEGRAM_ALLOWED_CHAT_IDS,
    "TELEGRAM_ALLOWED_CHAT_IDS",
    true,
  );
  if (webhookSecret && allowedUserIds.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must be configured for the Telegram webhook");
  }
  return { webhookSecret, allowedUserIds, allowedChatIds };
}
