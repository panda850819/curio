import PostalMime from "postal-mime";
import type { Email } from "postal-mime";

const MAX_RAW_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 128 * 1024;
const MAX_HEADER_LENGTH = 1_024;

interface Env {
  CURIO_INBOUND_URL: string;
  CURIO_INBOUND_SECRET: string;
  CURIO_ACCESS_CLIENT_ID?: string;
  CURIO_ACCESS_CLIENT_SECRET?: string;
}

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream;
  readonly rawSize: number;
  setReject(reason: string): void;
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

function truncate(value: string | null | undefined, maximum: number): string | null {
  if (!value) return null;
  return [...value].slice(0, maximum).join("");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatAddress(value: unknown): string | null {
  const address = record(value);
  if (!address || typeof address.address !== "string" || !address.address.trim()) return null;
  const mailbox = address.address.trim();
  return typeof address.name === "string" && address.name.trim()
    ? `${address.name.trim()} <${mailbox}>`
    : mailbox;
}

function selectedHeaders(email: Email): Record<string, string> {
  const names = new Set(["list-id", "x-mailing-list"]);
  const headers: Record<string, string> = {};
  for (const header of email.headers) {
    const key = header.key.toLowerCase();
    if (!names.has(key) || headers[key]) continue;
    const value = truncate(header.value, MAX_HEADER_LENGTH);
    if (value) headers[key] = value;
  }
  return headers;
}

function textBody(email: Email): { text: string | null; html: string | null } {
  const text = truncate(email.text, MAX_TEXT_LENGTH);
  if (text) return { text, html: null };
  return { text: null, html: truncate(email.html, MAX_TEXT_LENGTH * 2) };
}

function curioPayload(message: ForwardableEmailMessage, email: Email): Record<string, unknown> {
  const body = textBody(email);
  return {
    recipient: message.to,
    messageId: email.messageId ?? message.headers.get("message-id"),
    from: formatAddress(email.from) ?? message.from,
    subject: email.subject ?? message.headers.get("subject"),
    date: email.date ?? message.headers.get("date"),
    text: body.text,
    html: body.html,
    url: null,
    headers: selectedHeaders(email),
  };
}

async function sendToCurio(
  message: ForwardableEmailMessage,
  email: Email,
  env: Env,
): Promise<void> {
  const endpoint = new URL(env.CURIO_INBOUND_URL);
  if (endpoint.protocol !== "https:") throw new Error("Curio inbound URL must use HTTPS");

  const headers = new Headers({
    "content-type": "application/json",
    "x-curio-email-secret": env.CURIO_INBOUND_SECRET,
  });
  if (env.CURIO_ACCESS_CLIENT_ID && env.CURIO_ACCESS_CLIENT_SECRET) {
    headers.set("CF-Access-Client-Id", env.CURIO_ACCESS_CLIENT_ID);
    headers.set("CF-Access-Client-Secret", env.CURIO_ACCESS_CLIENT_SECRET);
  }
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    headers,
    body: JSON.stringify(curioPayload(message, email)),
  });

  if (response.ok) return;
  if (response.status === 400 || response.status === 413) {
    message.setReject("Curio rejected this email payload");
    return;
  }
  throw new Error(`Curio inbound returned HTTP ${response.status}`);
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({ error: "not_found" }, { status: 404 });
  },

  async email(message: ForwardableEmailMessage, env: Env, _ctx: WorkerContext): Promise<void> {
    if (message.rawSize > MAX_RAW_BYTES) {
      message.setReject("Email is too large for Curio");
      return;
    }
    try {
      const email = await PostalMime.parse(message.raw, {
        maxNestingDepth: 32,
        maxHeadersSize: MAX_HEADER_LENGTH * 256,
        maxRfc822NestingDepth: 4,
      });
      const body = textBody(email);
      if (!body.text && !body.html && !email.subject) {
        message.setReject("Email has no readable content");
        return;
      }
      await sendToCurio(message, email, env);
    } catch (error) {
      console.error(
        "curio_email_inbound_failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw error;
    }
  },
};
