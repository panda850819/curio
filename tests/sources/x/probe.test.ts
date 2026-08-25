import { describe, expect, test } from "bun:test";
import { DefaultProbeService } from "../../../src/app/probe-service.ts";
import type { ProbeHttpClient } from "../../../src/probe/types.ts";
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

  test("canonicalizes supported share parameters without using the generic probe", async () => {
    let requests = 0;
    const client: ProbeHttpClient = {
      get: async () => {
        requests += 1;
        throw new Error("generic probe must not run");
      },
    };
    const result = await new DefaultProbeService(client).probe(
      "https://x.com/YeRuiZhang?t=tracking&s=11",
    );
    expect(result.candidates[0]).toMatchObject({
      adapter: "x",
      sourceUrl: "https://x.com/YeRuiZhang",
      sourceKey: "yeruizhang",
    });
    expect(requests).toBe(0);
  });

  test("rejects posts, credentials, unknown parameters, fragments, and invalid handles", () => {
    expect(xProbeResult("https://x.com/Kay/status/1")).toBeNull();
    expect(xProbeResult("https://user:pass@x.com/Kay")).toBeNull();
    expect(xProbeResult("https://x.com/Kay?secret=1")).toBeNull();
    expect(xProbeResult("https://x.com/Kay#profile")).toBeNull();
    expect(xProbeResult("https://x.com/handle-that-is-too-long")).toBeNull();
  });
});
