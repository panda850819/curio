import { describe, expect, test } from "bun:test";
import { deriveExternalId } from "../src/sources/external-id.ts";

describe("deriveExternalId", () => {
  test("preserves a stable source ID", () => {
    expect(
      deriveExternalId({
        externalId: "  post-123  ",
        canonicalUrl: "https://example.com/ignored",
      }),
    ).toBe("post-123");
  });

  test("derives the same ID from equivalent canonical URLs", () => {
    const first = deriveExternalId({
      canonicalUrl: "https://EXAMPLE.com/article?b=2&a=1#comments",
    });
    const second = deriveExternalId({
      canonicalUrl: "https://example.com/article?a=1&b=2",
    });

    expect(first).toMatch(/^url-sha256:[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  test("derives stable content IDs when no URL exists", () => {
    const item = {
      title: "  A Curiosity  ",
      author: "Panda",
      publishedAt: 1_755_216_000_000,
      contentText: "Something worth keeping",
    };

    const first = deriveExternalId(item);
    const second = deriveExternalId({ ...item });

    expect(first).toMatch(/^content-sha256:[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(deriveExternalId({ ...item, contentText: "Changed" })).not.toBe(first);
  });

  test("rejects invalid canonical URLs and empty identity", () => {
    expect(() => deriveExternalId({ canonicalUrl: "relative/path" })).toThrow(
      "must be an absolute URL",
    );
    expect(() => deriveExternalId({ title: " ", contentText: null })).toThrow(
      "Cannot derive external ID",
    );
    expect(() => deriveExternalId({ title: "Item", publishedAt: Number.NaN })).toThrow(
      "must be a safe Unix millisecond integer",
    );
  });
});
