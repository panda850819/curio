import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("uses safe local defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      databasePath: "./data/curio.db",
      telegram: null,
      email: null,
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

  test("loads the shared email inbox only when address and webhook secret are configured", () => {
    expect(
      loadConfig({
        EMAIL_INBOUND_ADDRESS: "Reader@Inbox.Example.com",
        EMAIL_INBOUND_WEBHOOK_SECRET: "email-secret",
      }).email,
    ).toEqual({ address: "reader@inbox.example.com", webhookSecret: "email-secret" });
    expect(() => loadConfig({ EMAIL_INBOUND_ADDRESS: "reader@example.com" })).toThrow(
      "configured together",
    );
    expect(() => loadConfig({ EMAIL_INBOUND_WEBHOOK_SECRET: "email-secret" })).toThrow(
      "configured together",
    );
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
