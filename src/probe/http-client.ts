import type { Socket } from "node:net";
import { connect as connectTcp } from "node:net";
import type { TLSSocket } from "node:tls";
import { connect as connectTls } from "node:tls";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { ProbeError } from "./errors.ts";
import { assertPublicResolution } from "./ip-policy.ts";
import type {
  HttpHeaders,
  HttpResponse,
  ProbeHttpClient,
  ProbeResolver,
  ResolvedAddress,
} from "./types.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAXIMUM_HEADER_BYTES = 64 * 1024;

export interface ConnectionOptions {
  address: string;
  family: 4 | 6;
  port: number;
  tls: boolean;
  servername: string;
}

export type ConnectionFactory = (options: ConnectionOptions) => Socket | TLSSocket;

const defaultConnectionFactory: ConnectionFactory = (options) => {
  if (options.tls) {
    return connectTls({
      host: options.address,
      port: options.port,
      servername: options.servername,
      ALPNProtocols: ["http/1.1"],
    });
  }
  return connectTcp({ host: options.address, family: options.family, port: options.port });
};

class ResponseHeaders implements HttpHeaders {
  constructor(private readonly headers: Map<string, string>) {}
  get(name: string): string | null {
    return this.headers.get(name.toLowerCase()) ?? null;
  }
}

function validateUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new ProbeError("invalid_url", `Invalid URL: ${input}`, error);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProbeError("unsupported_scheme", `Unsupported URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new ProbeError("url_credentials", "URLs containing credentials are not allowed");
  }
  return url;
}

function canonicalRequestUrl(url: URL): string {
  url.hash = "";
  return url.toString();
}

function requestHeaderLines(headers: Readonly<Record<string, string>>): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new ProbeError("request_failed", `Invalid request header name: ${name}`);
    }
    const normalizedName = name.toLowerCase();
    if (!["if-none-match", "if-modified-since"].includes(normalizedName)) {
      throw new ProbeError("request_failed", `Unsupported conditional request header: ${name}`);
    }
    if (
      [...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 32 || codePoint === 127;
      })
    ) {
      throw new ProbeError(
        "request_failed",
        `Invalid control character in request header: ${name}`,
      );
    }
    lines.push(`${name}: ${value}\r\n`);
  }
  return lines.join("");
}

function decodeChunked(body: Buffer, maximumBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  let size = 0;

  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) throw new ProbeError("request_failed", "Malformed chunked response");
    const sizeText = body.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0]?.trim();
    const chunkSize = Number.parseInt(sizeText ?? "", 16);
    if (!Number.isFinite(chunkSize) || chunkSize < 0) {
      throw new ProbeError("request_failed", "Malformed chunk size");
    }
    offset = lineEnd + 2;
    if (chunkSize === 0) return Buffer.concat(chunks, size);
    if (offset + chunkSize + 2 > body.length) {
      throw new ProbeError("request_failed", "Truncated chunked response");
    }

    size += chunkSize;
    if (size > maximumBytes) {
      throw new ProbeError("body_limit", `Compressed response body exceeds ${maximumBytes} bytes`);
    }
    chunks.push(body.subarray(offset, offset + chunkSize));
    offset += chunkSize;
    if (body.toString("ascii", offset, offset + 2) !== "\r\n") {
      throw new ProbeError("request_failed", "Malformed chunk terminator");
    }
    offset += 2;
  }

  throw new ProbeError("request_failed", "Chunked response has no terminating chunk");
}

function decompress(body: Buffer, encoding: string | null, maximumBytes: number): Uint8Array {
  const normalized = encoding?.toLowerCase().trim();
  try {
    let result: Buffer;
    if (!normalized || normalized === "identity") result = body;
    else if (normalized === "gzip" || normalized === "x-gzip") {
      result = gunzipSync(body, { maxOutputLength: maximumBytes + 1 });
    } else if (normalized === "deflate") {
      result = inflateSync(body, { maxOutputLength: maximumBytes + 1 });
    } else if (normalized === "br") {
      result = brotliDecompressSync(body, { maxOutputLength: maximumBytes + 1 });
    } else {
      throw new ProbeError("request_failed", `Unsupported content encoding: ${normalized}`);
    }

    if (result.byteLength > maximumBytes) {
      throw new ProbeError(
        "body_limit",
        `Decompressed response body exceeds ${maximumBytes} bytes`,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_BUFFER_TOO_LARGE") {
      throw new ProbeError(
        "body_limit",
        `Decompressed response body exceeds ${maximumBytes} bytes`,
        error,
      );
    }
    throw new ProbeError("request_failed", "Failed to decompress response body", error);
  }
}

function parseResponse(
  raw: Buffer,
  url: string,
  maximumBytes: (contentType: string | null) => number,
): HttpResponse {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1 || headerEnd > MAXIMUM_HEADER_BYTES) {
    throw new ProbeError("request_failed", "Invalid or oversized HTTP response headers");
  }

  const headerLines = raw.subarray(0, headerEnd).toString("latin1").split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(headerLines.shift() ?? "");
  if (!statusMatch?.[1]) throw new ProbeError("request_failed", "Invalid HTTP status line");
  const status = Number(statusMatch[1]);
  const headerMap = new Map<string, string>();
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new ProbeError("request_failed", "Malformed HTTP response header");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headerMap.set(name, headerMap.has(name) ? `${headerMap.get(name)}, ${value}` : value);
  }
  const headers = new ResponseHeaders(headerMap);

  if (REDIRECT_STATUSES.has(status)) {
    return { url, status, headers, body: new Uint8Array() };
  }

  const limit = maximumBytes(headers.get("content-type"));
  const encodedBody = raw.subarray(headerEnd + 4);
  const transferEncoding = headers.get("transfer-encoding")?.toLowerCase();
  let body: Buffer;
  if (transferEncoding?.includes("chunked")) {
    body = decodeChunked(encodedBody, limit);
  } else {
    const contentLength = headers.get("content-length");
    if (contentLength !== null) {
      const expected = Number(contentLength);
      if (!Number.isSafeInteger(expected) || expected < 0) {
        throw new ProbeError("request_failed", "Invalid Content-Length");
      }
      if (expected > limit) {
        throw new ProbeError("body_limit", `Response body exceeds ${limit} bytes`);
      }
      if (encodedBody.byteLength < expected) {
        throw new ProbeError("request_failed", "Truncated HTTP response body");
      }
      body = encodedBody.subarray(0, expected);
    } else {
      body = encodedBody;
    }
    if (body.byteLength > limit) {
      throw new ProbeError("body_limit", `Response body exceeds ${limit} bytes`);
    }
  }

  return {
    url,
    status,
    headers,
    body: decompress(body, headers.get("content-encoding"), limit),
  };
}

export class SafeHttpClient implements ProbeHttpClient {
  constructor(
    private readonly resolver: ProbeResolver,
    private readonly connectionFactory: ConnectionFactory = defaultConnectionFactory,
    private readonly timeoutMilliseconds = 10_000,
    private readonly maximumRedirects = 5,
  ) {}

  async get(
    input: string,
    maximumBytes: (contentType: string | null) => number,
    requestHeaders: Readonly<Record<string, string>> = {},
  ): Promise<HttpResponse> {
    let current = validateUrl(input);
    let currentHeaders = requestHeaders;
    const visited = new Set<string>();

    for (let redirects = 0; ; redirects += 1) {
      const currentUrl = canonicalRequestUrl(current);
      if (visited.has(currentUrl)) {
        throw new ProbeError("redirect_loop", `Redirect loop detected at ${currentUrl}`);
      }
      visited.add(currentUrl);

      const addresses = await this.resolveWithTimeout(current.hostname);
      assertPublicResolution(current.hostname, addresses);
      const response = await this.requestSingle(
        current,
        addresses[0] as ResolvedAddress,
        maximumBytes,
        currentHeaders,
      );
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      if (redirects >= this.maximumRedirects) {
        throw new ProbeError("redirect_limit", `Redirect limit exceeded for ${input}`);
      }

      const location = response.headers.get("location");
      if (!location) {
        throw new ProbeError(
          "redirect_invalid",
          `Redirect response has no Location: ${currentUrl}`,
        );
      }
      try {
        const redirected = validateUrl(new URL(location, current).toString());
        if (redirected.origin !== current.origin) currentHeaders = {};
        current = redirected;
      } catch (error) {
        if (error instanceof ProbeError) throw error;
        throw new ProbeError("redirect_invalid", `Invalid redirect target: ${location}`, error);
      }
    }
  }

  private resolveWithTimeout(hostname: string): Promise<ResolvedAddress[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new ProbeError(
            "request_timeout",
            `DNS lookup timed out after ${this.timeoutMilliseconds}ms`,
          ),
        );
      }, this.timeoutMilliseconds);
      timeout.unref();

      this.resolver.resolve(hostname).then(
        (addresses) => {
          clearTimeout(timeout);
          resolve(addresses);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  private requestSingle(
    url: URL,
    address: ResolvedAddress,
    maximumBytes: (contentType: string | null) => number,
    requestHeaders: Readonly<Record<string, string>>,
  ): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const customHeaderLines = requestHeaderLines(requestHeaders);
      const tls = url.protocol === "https:";
      const port = Number(url.port || (tls ? 443 : 80));
      let settled = false;
      let rawSize = 0;
      const chunks: Buffer[] = [];
      const socket = this.connectionFactory({
        address: address.address,
        family: address.family,
        port,
        tls,
        servername: url.hostname,
      });
      const timeout = setTimeout(() => {
        finish(
          new ProbeError(
            "request_timeout",
            `Request timed out after ${this.timeoutMilliseconds}ms`,
          ),
        );
      }, this.timeoutMilliseconds);
      timeout.unref();

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
      };

      const sendRequest = (): void => {
        const path = `${url.pathname}${url.search}`;
        socket.write(
          `GET ${path} HTTP/1.1\r\n` +
            `Host: ${url.host}\r\n` +
            "Accept: application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.1\r\n" +
            "Accept-Encoding: gzip, deflate, br\r\n" +
            "User-Agent: Curio/0.1 (+https://github.com/panda850819/curio)\r\n" +
            customHeaderLines +
            "Connection: close\r\n\r\n",
        );
      };

      socket.once(tls ? "secureConnect" : "connect", sendRequest);
      socket.on("data", (chunk: Buffer) => {
        rawSize += chunk.byteLength;
        if (rawSize > MAXIMUM_HEADER_BYTES + 5 * 1024 * 1024) {
          finish(new ProbeError("body_limit", "HTTP response exceeds the absolute size limit"));
          return;
        }
        chunks.push(chunk);
      });
      socket.once("end", () => {
        if (settled) return;
        try {
          const response = parseResponse(
            Buffer.concat(chunks, rawSize),
            canonicalRequestUrl(url),
            maximumBytes,
          );
          settled = true;
          clearTimeout(timeout);
          resolve(response);
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new ProbeError("request_failed", "Unknown HTTP response error", error),
          );
        }
      });
      socket.once("error", (error) => {
        finish(new ProbeError("request_failed", `Request failed for ${url.toString()}`, error));
      });
    });
  }
}
