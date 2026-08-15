export interface Config {
  host: string;
  port: number;
  databasePath: string;
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

  return { host, port, databasePath };
}
