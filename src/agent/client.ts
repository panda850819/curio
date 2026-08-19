import { sanitizeErrorMessage } from "../security/redaction.ts";

interface CurioApiResponse {
  data?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CurioAgentClientOptions {
  fetch?: FetchLike;
}

export class CurioAgentApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CurioAgentApiError";
  }
}

export class CurioAgentApiClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, options: CurioAgentClientOptions = {}) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error("CURIO_AGENT_URL must be a valid HTTP(S) URL");
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("CURIO_AGENT_URL must be an HTTP(S) URL without credentials");
    }
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    this.baseUrl = parsed;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.request<T>(url);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(new URL(path, this.baseUrl), {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(new URL(path, this.baseUrl), {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>(new URL(path, this.baseUrl), { method: "DELETE" });
  }

  private async request<T>(url: URL, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers });
    } catch (error) {
      throw new CurioAgentApiError("transport_error", sanitizeErrorMessage(error), 0);
    }

    const text = await response.text();
    let body: CurioApiResponse;
    try {
      body = text ? (JSON.parse(text) as CurioApiResponse) : {};
    } catch {
      throw new CurioAgentApiError(
        "invalid_response",
        `Curio returned a non-JSON response (${response.status})`,
        response.status,
      );
    }

    if (!response.ok) {
      const error = body.error;
      throw new CurioAgentApiError(
        typeof error?.code === "string" ? error.code : "curio_request_failed",
        typeof error?.message === "string"
          ? sanitizeErrorMessage(error.message)
          : `Curio request failed (${response.status})`,
        response.status,
        error?.details,
      );
    }
    return ("data" in body ? body.data : body) as T;
  }
}
