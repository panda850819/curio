import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("uses safe local defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      databasePath: "./data/curio.db",
      telegram: null,
      x: null,
    });
  });

  test("loads Telegram only when both values are configured", () => {
    expect(
      loadConfig({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_CHAT_ID: "@channel" }).telegram,
    ).toEqual({
      botToken: "token",
      chatId: "@channel",
    });
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "token" })).toThrow("configured together");
    expect(() => loadConfig({ TELEGRAM_CHAT_ID: "@channel" })).toThrow("configured together");
  });

  test("loads X only when both cookie values are configured", () => {
    expect(loadConfig({ X_AUTH_TOKEN: "auth", X_CT0: "csrf" }).x).toEqual({
      authToken: "auth",
      ct0: "csrf",
    });
    expect(() => loadConfig({ X_AUTH_TOKEN: "auth" })).toThrow("configured together");
    expect(() => loadConfig({ X_CT0: "csrf" })).toThrow("configured together");
  });

  test("rejects invalid ports", () => {
    expect(() => loadConfig({ PORT: "0" })).toThrow("PORT must be an integer");
    expect(() => loadConfig({ PORT: "not-a-number" })).toThrow("PORT must be an integer");
  });

  test("rejects an explicitly empty database path", () => {
    expect(() => loadConfig({ DATABASE_PATH: "  " })).toThrow("DATABASE_PATH must not be empty");
  });
});
