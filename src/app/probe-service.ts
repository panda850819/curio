import { probe } from "../probe/index.ts";
import type { ProbeHttpClient, ProbeResult } from "../probe/types.ts";
import { xProbeResult } from "../sources/x/probe.ts";
import { youtubeProbeResult } from "../sources/youtube/probe.ts";
import type { ProbeService } from "./types.ts";

export class DefaultProbeService implements ProbeService {
  constructor(private readonly client: ProbeHttpClient) {}

  async probe(inputUrl: string): Promise<ProbeResult> {
    const xResult = xProbeResult(inputUrl);
    if (xResult) return xResult;
    const youtubeResult = await youtubeProbeResult(inputUrl, this.client);
    return youtubeResult ?? probe(inputUrl, this.client);
  }
}
