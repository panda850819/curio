import type { PageCursor } from "../domain/types.ts";
import { AppError } from "./errors.ts";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64(value: string): string {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    throw new AppError("validation", "invalid_cursor", "cursor is invalid");
  }
}

export function encodeCursor(cursor: PageCursor): string {
  return encodeBase64(JSON.stringify(cursor));
}

export function decodeCursor(value: string | null): PageCursor | undefined {
  if (value === null || value === "") return undefined;
  const decoded = decodeBase64(value);
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof (parsed as { timestamp?: unknown }).timestamp !== "number" ||
      !Number.isSafeInteger((parsed as { timestamp: number }).timestamp) ||
      typeof (parsed as { id?: unknown }).id !== "string" ||
      !(parsed as { id: string }).id
    ) {
      throw new Error("invalid cursor");
    }
    return {
      timestamp: (parsed as { timestamp: number }).timestamp,
      id: (parsed as { id: string }).id,
    };
  } catch {
    throw new AppError("validation", "invalid_cursor", "cursor is invalid");
  }
}

export function pageResult<T>(
  items: T[],
  hasMore: boolean,
  cursorFor: (item: T) => PageCursor,
): Page<T> {
  const visibleItems = items;
  const last = visibleItems.at(-1);
  return {
    items: visibleItems,
    nextCursor: hasMore && last ? encodeCursor(cursorFor(last)) : null,
  };
}
