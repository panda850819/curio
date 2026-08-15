import ipaddr from "ipaddr.js";
import { ProbeError } from "./errors.ts";
import type { ResolvedAddress } from "./types.ts";

export function assertPublicAddress(address: string): void {
  if (!ipaddr.isValid(address)) {
    throw new ProbeError("dns_failed", `DNS returned an invalid address: ${address}`);
  }

  const parsed = ipaddr.process(address);
  if (parsed.range() !== "unicast") {
    throw new ProbeError("blocked_address", `Address is not public unicast: ${address}`);
  }
}

export function assertPublicResolution(hostname: string, addresses: ResolvedAddress[]): void {
  if (addresses.length === 0) {
    throw new ProbeError("dns_failed", `DNS returned no addresses for ${hostname}`);
  }

  for (const result of addresses) {
    assertPublicAddress(result.address);
  }
}
