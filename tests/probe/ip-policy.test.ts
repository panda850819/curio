import { describe, expect, test } from "bun:test";
import { assertPublicAddress, assertPublicResolution } from "../../src/probe/ip-policy.ts";

const blocked = [
  "0.0.0.0",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.168.1.1",
  "224.0.0.1",
  "::",
  "::1",
  "fe80::1",
  "fc00::1",
  "ff02::1",
  "::ffff:127.0.0.1",
  "2001:db8::1",
];

describe("public IP policy", () => {
  test.each(blocked)("blocks %s", (address) => {
    expect(() => assertPublicAddress(address)).toThrow("not public unicast");
  });

  test("allows public IPv4 and IPv6", () => {
    expect(() => assertPublicAddress("8.8.8.8")).not.toThrow();
    expect(() => assertPublicAddress("2606:4700:4700::1111")).not.toThrow();
  });

  test("rejects an empty DNS response", () => {
    expect(() => assertPublicResolution("empty.test", [])).toThrow("no addresses");
  });
});
