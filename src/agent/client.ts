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

export class CurioAgentResponse<T> {
  constructor(
    readonly data: T,
    readonly requestId?: string,
  ) {}
}

export class CurioAgentApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
    readonly requestId?: string,
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
    return (await this.getResponse<T>(path, query)).data;
  }

  async getResponse<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<CurioAgentResponse<T>> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.request<T>(url);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return (await this.postResponse<T>(path, body)).data;
  }

  async postResponse<T>(path: string, body?: unknown): Promise<CurioAgentResponse<T>> {
    return this.request<T>(new URL(path, this.baseUrl), {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return (await this.patchResponse<T>(path, body)).data;
  }

  async patchResponse<T>(path: string, body: unknown): Promise<CurioAgentResponse<T>> {
    return this.request<T>(new URL(path, this.baseUrl), {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async delete<T>(path: string): Promise<T> {
    return (await this.deleteResponse<T>(path)).data;
  }

  async deleteResponse<T>(path: string): Promise<CurioAgentResponse<T>> {
    return this.request<T>(new URL(path, this.baseUrl), { method: "DELETE" });
  }

  private async request<T>(url: URL, init: RequestInit = {}): Promise<CurioAgentResponse<T>> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers });
    } catch (error) {
      throw new CurioAgentApiError("transport_error", sanitizeErrorMessage(error), 0);
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;
    const text = await response.text();
    let body: CurioApiResponse;
    try {
      body = text ? (JSON.parse(text) as CurioApiResponse) : {};
    } catch {
      throw new CurioAgentApiError(
        "invalid_response",
        `Curio returned a non-JSON response (${response.status})`,
        response.status,
        undefined,
        requestId,
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
        requestId,
      );
    }
    return new CurioAgentResponse(("data" in body ? body.data : body) as T, requestId);
  }
}
