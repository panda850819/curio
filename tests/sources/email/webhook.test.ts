import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createApp } from "../../../src/app/create-app.ts";
import { migrate } from "../../../src/db/migrations.ts";
import { createEmailWebhookHandler } from "../../../src/sources/email/webhook.ts";

const migrationsPath = resolve(import.meta.dir, "../../../migrations");

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://curio.test/email/inbound", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function harness() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database, migrationsPath);
  const app = createApp({
    database,
    migrationsPath,
    email: { address: "reader@inbox.example.com", webhookSecret: "email-secret" },
  });
  const webhook = createEmailWebhookHandler(
    "email-secret",
    app.emailSource as NonNullable<typeof app.emailSource>,
  );
  return { app, database, webhook };
}

const payload = {
  to: "reader@inbox.example.com",
  messageId: "<message-1@example.com>",
  from: "Newsletter <news@example.com>",
  subject: "Weekly note",
  date: "2026-01-02T03:04:05Z",
  text: "A short note",
};

describe("email inbound webhook", () => {
  test("requires the webhook secret and accepts duplicate delivery", async () => {
    const context = harness();
    const unauthorized = await context.webhook(request(payload));
    expect(unauthorized.status).toBe(401);

    const accepted = await context.webhook(
      request(payload, { "x-curio-email-secret": "email-secret" }),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, status: "inserted" });

    const duplicate = await context.webhook(
      request(payload, { "x-curio-email-secret": "email-secret" }),
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ok: true, status: "duplicate" });

    context.app.close();
    context.database.close();
  });

  test("rejects malformed payloads and oversized requests", async () => {
    const context = harness();
    const invalid = await context.webhook(
      request(
        { to: "reader@inbox.example.com", from: "news@example.com" },
        { "x-curio-email-secret": "email-secret" },
      ),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_email" });

    const oversized = await context.webhook(
      request(
        { ...payload, text: "x".repeat(1_100_000) },
        { "x-curio-email-secret": "email-secret" },
      ),
    );
    expect(oversized.status).toBe(413);

    context.app.close();
    context.database.close();
  });
});
