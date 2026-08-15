import { describe, expect, test } from "bun:test";
import { SystemResolver } from "../../src/probe/resolver.ts";

describe("SystemResolver", () => {
  test("handles IPv4 and bracketed IPv6 literals without DNS", async () => {
    const resolver = new SystemResolver();

    await expect(resolver.resolve("8.8.8.8")).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
    await expect(resolver.resolve("[2606:4700:4700::1111]")).resolves.toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });
});
