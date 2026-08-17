const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/u;
const TELEGRAM_HOSTS = new Set(["t.me", "www.t.me", "telegram.me", "www.telegram.me"]);

export interface TelegramChannelReference {
  username: string;
  sourceUrl: string;
  sourceKey: string;
}

function normalizedUsername(value: string): string | null {
  const username = value.replace(/^@/u, "").trim().toLowerCase();
  return TELEGRAM_USERNAME_PATTERN.test(username) ? username : null;
}

export function telegramUsernameSourceKey(username: string): string {
  return `telegram:username:${username.replace(/^@/u, "").trim().toLowerCase()}`;
}

export function telegramHtmlSourceKey(username: string): string {
  return `telegram-html:${username.replace(/^@/u, "").trim().toLowerCase()}`;
}

export function telegramChatSourceKey(chatId: string): string {
  return `telegram:chat:${chatId}`;
}

export function telegramSourceUrl(username: string): string {
  return `https://t.me/${username.replace(/^@/u, "").trim().toLowerCase()}`;
}

export function telegramHtmlSourceUrl(username: string): string {
  return `https://t.me/s/${username.replace(/^@/u, "").trim().toLowerCase()}`;
}

export function parsePublicTelegramUrl(inputUrl: string): TelegramChannelReference | null {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/u.test(url.protocol) || !TELEGRAM_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const usernameSegment = segments[0]?.toLowerCase() === "s" ? segments[1] : segments[0];
  if (!usernameSegment || usernameSegment.startsWith("+") || usernameSegment === "joinchat") {
    return null;
  }
  const username = normalizedUsername(usernameSegment);
  if (!username) return null;
  return {
    username,
    sourceUrl: telegramHtmlSourceUrl(username),
    sourceKey: telegramHtmlSourceKey(username),
  };
}

export function telegramMessageUrl(username: string | null, messageId: number): string | null {
  if (!username) return null;
  return `${telegramSourceUrl(username)}/${messageId}`;
}
