export type ProbeErrorCode =
  | "invalid_url"
  | "unsupported_scheme"
  | "url_credentials"
  | "dns_failed"
  | "blocked_address"
  | "request_failed"
  | "request_timeout"
  | "http_status"
  | "redirect_invalid"
  | "redirect_loop"
  | "redirect_limit"
  | "body_limit"
  | "invalid_feed"
  | "youtube_channel_unresolved";

export class ProbeError extends Error {
  constructor(
    readonly code: ProbeErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProbeError";
  }
}
