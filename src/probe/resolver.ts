import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ProbeError } from "./errors.ts";
import type { ProbeResolver, ResolvedAddress } from "./types.ts";

export class SystemResolver implements ProbeResolver {
  async resolve(hostname: string): Promise<ResolvedAddress[]> {
    const normalizedHostname =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    const literalFamily = isIP(normalizedHostname);
    if (literalFamily === 4 || literalFamily === 6) {
      return [{ address: normalizedHostname, family: literalFamily }];
    }

    try {
      const results = await lookup(normalizedHostname, { all: true, verbatim: true });
      return results.map((result) => {
        if (result.family !== 4 && result.family !== 6) {
          throw new ProbeError(
            "dns_failed",
            `DNS returned an unknown address family: ${result.family}`,
          );
        }
        return { address: result.address, family: result.family };
      });
    } catch (error) {
      throw new ProbeError("dns_failed", `DNS lookup failed for ${normalizedHostname}`, error);
    }
  }
}
