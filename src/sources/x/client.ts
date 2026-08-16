import { resolve } from "node:path";
import type { XbirdResult, XbirdTimelineClient, XTweet } from "./types.ts";

const MAXIMUM_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAXIMUM_STDERR_BYTES = 64 * 1024;

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return output + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("X source output exceeded limit");
    }
    output += decoder.decode(value, { stream: true });
  }
}

function safeErrorCode(result: XbirdResult): string {
  const code = typeof result.error === "object" ? result.error?.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "XBIRD_ERROR";
}

export class ProcessXbirdClient implements XbirdTimelineClient {
  constructor(
    private readonly authToken: string,
    private readonly ct0: string,
    private readonly binaryPath = resolve(import.meta.dir, "../../../node_modules/.bin/xbird"),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    if (!authToken || !ct0) throw new Error("X credentials are not configured");
  }

  async userTweets(handle: string, count: number): Promise<XTweet[]> {
    const process = Bun.spawn(
      [
        "bun",
        "--no-env-file",
        this.binaryPath,
        "user-tweets",
        handle,
        "--count",
        String(count),
        "--max-pages",
        "1",
        "--json",
      ],
      {
        env: {
          AUTH_TOKEN: this.authToken,
          CT0: this.ct0,
          HOME: "/tmp/curio-xbird",
          LANG: "C.UTF-8",
          NO_COLOR: "1",
          PATH: processEnvPath(),
          XBIRD_DISABLE_LIVE_WRITES: "1",
          XBIRD_QUOTE_DEPTH: "1",
          XBIRD_TIMEOUT_MS: String(this.timeoutMs),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, this.timeoutMs + 1_000);
    try {
      const [stdout, exitCode] = await Promise.all([
        readBounded(process.stdout, MAXIMUM_OUTPUT_BYTES),
        process.exited,
        readBounded(process.stderr, MAXIMUM_STDERR_BYTES),
      ]).then(([output, code]) => [output, code] as const);
      if (timedOut) throw new Error("X source request timed out");
      let result: XbirdResult;
      try {
        result = JSON.parse(stdout) as XbirdResult;
      } catch {
        if (exitCode !== 0) throw new Error(`X source command failed (${exitCode})`);
        throw new Error("X source returned malformed JSON");
      }
      const tweets = Array.isArray(result.data) ? result.data : result.data?.tweets;
      if (exitCode !== 0 || result.ok !== true || !Array.isArray(tweets)) {
        throw new Error(`X source request failed (${safeErrorCode(result)})`);
      }
      return tweets;
    } catch (error) {
      process.kill();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function processEnvPath(): string {
  return process.env.PATH?.trim() || "/usr/local/bin:/usr/bin:/bin";
}
