import { probe } from "../probe/index.ts";
import type { ProbeHttpClient, ProbeResult } from "../probe/types.ts";
import { githubAtomProbeResult } from "../sources/github/atom-probe.ts";
import { githubProbeResult } from "../sources/github/probe.ts";
import { xProbeResult } from "../sources/x/probe.ts";
import { youtubeProbeResult } from "../sources/youtube/probe.ts";
import type { ProbeService } from "./types.ts";

export class DefaultProbeService implements ProbeService {
  constructor(
    private readonly client: ProbeHttpClient,
    private readonly githubToken?: string,
  ) {}

  async probe(inputUrl: string): Promise<ProbeResult> {
    const xResult = xProbeResult(inputUrl);
    if (xResult) return xResult;
    const githubResult = await githubProbeResult(inputUrl, this.client, this.githubToken);
    if (githubResult) return githubResult;
    const githubAtomResult = await githubAtomProbeResult(inputUrl, this.client);
    if (githubAtomResult) return githubAtomResult;
    const youtubeResult = await youtubeProbeResult(inputUrl, this.client);
    return youtubeResult ?? probe(inputUrl, this.client);
  }
}
