import { describe, expect, test } from "bun:test";
import { xProbeResult } from "../../../src/sources/x/probe.ts";

describe("xProbeResult", () => {
  test("recognizes canonical X and legacy Twitter profile URLs", () => {
    expect(xProbeResult("https://x.com/Kay2289123")?.candidates[0]).toEqual({
      adapter: "x",
      format: "x",
      sourceUrl: "https://x.com/Kay2289123",
      sourceKey: "kay2289123",
      title: "@Kay2289123",
      discoveredVia: "direct",
    });
    expect(xProbeResult("https://twitter.com/@kay_1/")?.candidates[0]?.sourceKey).toBe("kay_1");
  });

  test("rejects posts, credentials, query strings, and invalid handles", () => {
    expect(xProbeResult("https://x.com/Kay/status/1")).toBeNull();
    expect(xProbeResult("https://user:pass@x.com/Kay")).toBeNull();
    expect(xProbeResult("https://x.com/Kay?secret=1")).toBeNull();
    expect(xProbeResult("https://x.com/handle-that-is-too-long")).toBeNull();
  });
});
