export interface Config {
  host: string;
  port: number;
  databasePath: string;
  telegram: { botToken: string; chatId: string } | null;
  x: { authToken: string; ct0: string } | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const host = env.HOST?.trim() || "127.0.0.1";
  const rawPort = env.PORT?.trim() || "3000";
  const port = Number(rawPort);
  const rawDatabasePath = env.DATABASE_PATH;
  const databasePath = rawDatabasePath === undefined ? "./data/curio.db" : rawDatabasePath.trim();

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535; received ${rawPort}`);
  }

  if (!databasePath) {
    throw new Error("DATABASE_PATH must not be empty");
  }

  const botToken = env.TELEGRAM_BOT_TOKEN?.trim() || "";
  const chatId = env.TELEGRAM_CHAT_ID?.trim() || "";
  if (Boolean(botToken) !== Boolean(chatId)) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured together");
  }

  const xAuthToken = env.X_AUTH_TOKEN?.trim() || "";
  const xCt0 = env.X_CT0?.trim() || "";
  if (Boolean(xAuthToken) !== Boolean(xCt0)) {
    throw new Error("X_AUTH_TOKEN and X_CT0 must be configured together");
  }

  return {
    host,
    port,
    databasePath,
    telegram: botToken ? { botToken, chatId } : null,
    x: xAuthToken ? { authToken: xAuthToken, ct0: xCt0 } : null,
  };
}
