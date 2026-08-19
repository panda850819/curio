import {
  EmailInboxUnavailableError,
  EmailRecipientMismatchError,
  type EmailSourceAdapter,
} from "./adapter.ts";
import { EmailPayloadError, parseInboundEmail } from "./normalize.ts";

const MAX_WEBHOOK_BODY_BYTES = 1 * 1024 * 1024;
const SECRET_HEADER = "x-curio-email-secret";

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function readBody(request: Request): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > MAX_WEBHOOK_BODY_BYTES
  ) {
    throw new Error("Email webhook body is too large");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value) continue;
      total += part.value.byteLength;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Email webhook body is too large");
      }
      chunks.push(part.value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export type EmailWebhookHandler = (request: Request) => Promise<Response>;

export function createEmailWebhookHandler(
  secret: string,
  source: EmailSourceAdapter,
): EmailWebhookHandler {
  return async (request) => {
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    const suppliedSecret = request.headers.get(SECRET_HEADER) ?? "";
    if (!constantTimeEqual(suppliedSecret, secret)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return Response.json({ error: "invalid_content_type" }, { status: 400 });
    }
    try {
      const body = await readBody(request);
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      const result = source.receive(parseInboundEmail(value));
      return Response.json({
        ok: true,
        status: result.insertedItems > 0 ? "inserted" : "duplicate",
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Email webhook body is too large") {
        return Response.json({ error: "body_too_large" }, { status: 413 });
      }
      if (error instanceof SyntaxError || error instanceof TypeError) {
        return Response.json({ error: "malformed_json" }, { status: 400 });
      }
      if (error instanceof EmailPayloadError || error instanceof EmailRecipientMismatchError) {
        return Response.json({ error: "invalid_email" }, { status: 400 });
      }
      if (error instanceof EmailInboxUnavailableError) {
        return Response.json({ error: "email_inbox_unavailable" }, { status: 409 });
      }
      return Response.json({ error: "email_webhook_failed" }, { status: 500 });
    }
  };
}
