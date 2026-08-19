import type { CanonicalItem, JsonValue } from "../../domain/types.ts";
import type { InboundEmail } from "./types.ts";

const MAX_TEXT_LENGTH = 128 * 1024;
const MAX_SUBJECT_LENGTH = 240;
const MAX_AUTHOR_LENGTH = 512;
const MAX_HEADER_LENGTH = 1_024;
const MAX_URL_LENGTH = 2_048;
const SUMMARY_LENGTH = 320;

export class EmailPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanHeaderValue(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function textValue(value: unknown, field: string, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new EmailPayloadError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new EmailPayloadError(`${field} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw new EmailPayloadError(`${field} is required`);
  return normalized || null;
}

function bounded(value: string | null, maximum: number): string | null {
  if (value === null) return null;
  return [...value].slice(0, maximum).join("");
}

function parseHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new EmailPayloadError("headers must be an object");
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[\x20-\x7e]{1,128}$/u.test(key)) continue;
    const headerValue = Array.isArray(raw) ? raw.find((item) => typeof item === "string") : raw;
    if (typeof headerValue !== "string") continue;
    headers[key.toLowerCase()] = bounded(cleanHeaderValue(headerValue), MAX_HEADER_LENGTH) ?? "";
  }
  return headers;
}

export function parseInboundEmail(value: unknown): InboundEmail {
  if (!isRecord(value)) throw new EmailPayloadError("Email payload must be an object");
  const recipient = bounded(
    cleanHeaderValue(textValue(value.recipient ?? value.to, "recipient", true) as string),
    320,
  );
  const from = bounded(
    cleanHeaderValue(textValue(value.from, "from", true) as string),
    MAX_AUTHOR_LENGTH,
  );
  const messageId = bounded(
    cleanHeaderValue(textValue(value.messageId, "messageId") ?? ""),
    MAX_HEADER_LENGTH,
  );
  const subject = bounded(
    cleanHeaderValue(textValue(value.subject, "subject") ?? ""),
    MAX_SUBJECT_LENGTH,
  );
  const date = bounded(cleanHeaderValue(textValue(value.date, "date") ?? ""), 128);
  const text = bounded(textValue(value.text, "text"), MAX_TEXT_LENGTH);
  const html = bounded(textValue(value.html, "html"), MAX_TEXT_LENGTH * 2);
  const url = bounded(cleanHeaderValue(textValue(value.url, "url") ?? ""), MAX_URL_LENGTH);
  if (!text && !html && !subject) {
    throw new EmailPayloadError("Email must contain a subject or body");
  }
  return {
    recipient: recipient as string,
    messageId,
    from: from as string,
    subject,
    date,
    text,
    html,
    url,
    headers: parseHeaders(value.headers),
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(x[\da-f]{1,6}|\d{1,7});/giu, (_match, raw: string) => {
      const radix = raw.toLowerCase().startsWith("x") ? 16 : 10;
      const number = Number.parseInt(raw.replace(/^x/iu, ""), radix);
      return Number.isSafeInteger(number) && number >= 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : " ";
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/giu, (_match, name: string) => {
      return (
        {
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
          nbsp: " ",
        }[name.toLowerCase()] ?? " "
      );
    });
}

function htmlToText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<(script|style|head|noscript)[^>]*>[\s\S]*?<\/\1>/giu, " ")
      .replace(/<br\s*\/?\s*>/giu, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])\s*>/giu, "\n")
      .replace(/<[^>]*>/gu, " "),
  );
}

function normalizeContent(input: InboundEmail): string {
  const text = input.text?.trim() || (input.html ? htmlToText(input.html) : "");
  return (
    bounded(
      text
        .replace(/\r\n?/gu, "\n")
        .replace(/[ \t]+/gu, " ")
        .replace(/\n{3,}/gu, "\n\n")
        .trim(),
      MAX_TEXT_LENGTH,
    ) ?? ""
  );
}

function parsePublishedAt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function firstHeader(headers: Record<string, string>, name: string): string | null {
  const normalizedName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName);
  const value = entry?.[1] ? cleanHeaderValue(entry[1]) : undefined;
  return value ? bounded(value, MAX_HEADER_LENGTH) : null;
}

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString().slice(0, MAX_URL_LENGTH);
  } catch {
    return null;
  }
}

function firstUrl(value: string): string | null {
  const candidate = value.match(/https?:\/\/[^\s<>"']+/iu)?.[0];
  if (!candidate) return null;
  return safeUrl(candidate.replace(/[),.;!?]+$/gu, ""));
}

function summaryFor(value: string): string | null {
  if (!value) return null;
  const summary = [...value].slice(0, SUMMARY_LENGTH).join("");
  return summary.length < value.length ? `${summary}…` : summary;
}

export function normalizeEmail(input: InboundEmail, eventAt: number): CanonicalItem {
  const contentText = normalizeContent(input);
  const listId = firstHeader(input.headers, "list-id");
  const from = cleanHeaderValue(input.from);
  const recipient = cleanHeaderValue(input.recipient);
  const subject = input.subject ? cleanHeaderValue(input.subject) : null;
  const messageId = input.messageId ? cleanHeaderValue(input.messageId) : null;
  const date = input.date ? cleanHeaderValue(input.date) : null;
  const publishedAt = parsePublishedAt(date, eventAt);
  const title =
    bounded(subject || contentText.split("\n", 1)[0]?.trim() || "電子報", MAX_SUBJECT_LENGTH) ||
    "電子報";
  const identity = messageId
    ? `message-id:${messageId.toLowerCase()}`
    : JSON.stringify({
        from: from.toLowerCase(),
        subject,
        date,
        contentText,
      });
  const metadata: Record<string, JsonValue> = {
    email: {
      recipient,
      from: bounded(from, MAX_AUTHOR_LENGTH) ?? from,
      ...(messageId ? { messageId } : {}),
      ...(listId ? { listId } : {}),
    },
  };
  return {
    externalId: `email-sha256:${digest(identity)}`,
    url: safeUrl(input.url) ?? firstUrl(contentText),
    title,
    summary: summaryFor(contentText) ?? title,
    contentText: contentText || null,
    contentHtml: null,
    author: bounded(from, MAX_AUTHOR_LENGTH),
    publishedAt,
    sourceUpdatedAt: publishedAt,
    metadata,
  };
}
