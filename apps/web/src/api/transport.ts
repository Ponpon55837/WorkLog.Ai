import type { ApiErrorCode } from "@work-intelligence/core";
import { t } from "../i18n";

type ApiErrorPayload = { error?: string; code?: string };

function errorCodeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return "invalid_input";
    case 403:
      return "origin_not_allowed";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 415:
      return "unsupported_media_type";
    case 421:
      return "host_not_allowed";
    case 503:
      return "service_unavailable";
    default:
      return status >= 500 ? "internal_error" : "invalid_input";
  }
}

function parseApiErrorPayload(text: string): ApiErrorPayload | undefined {
  try {
    const payload: unknown = JSON.parse(text);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    const record = payload as Record<string, unknown>;
    if (!("error" in record) && !("code" in record)) return undefined;
    return {
      ...(typeof record.error === "string" ? { error: record.error } : {}),
      ...(typeof record.code === "string" ? { code: record.code } : {}),
    };
  } catch {
    return undefined;
  }
}

export class ApiError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function appendQuery(path: string, values: Record<string, boolean | string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? path + "?" + encoded : path;
}

function isGatewayFailure(response: Response): boolean {
  return response.status >= 500 && !response.headers.get("content-type")?.toLowerCase().includes("application/json");
}

export class ApiTransport {
  constructor(
    private readonly baseUrl = "",
    private readonly onConnectionChange?: (isOnline: boolean) => void,
  ) {}

  openChangeStream(onChanged: () => void, onReconnected?: () => void): EventSource {
    const source = new EventSource(`${this.baseUrl.replace(/\/$/, "")}/api/events`);
    source.addEventListener("changed", onChanged);
    if (onReconnected) {
      source.addEventListener("open", onReconnected);
    }
    return source;
  }

  private async fetchResponse(path: string, init?: RequestInit): Promise<Response> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, init);
      this.onConnectionChange?.(!isGatewayFailure(response));
      return response;
    } catch (error) {
      if (init?.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw error;
      }
      this.onConnectionChange?.(false);
      throw new ApiError("network_error", 0, t("common.cannotReachTheLocalApi"));
    }
  }

  private async responseError(response: Response, fallback: string): Promise<ApiError> {
    const payload = parseApiErrorPayload(await response.text());
    return new ApiError(
      payload?.code ?? errorCodeForStatus(response.status),
      response.status,
      payload?.error ?? fallback,
    );
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchResponse(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    // While the API restarts, the dev proxy answers 500 with an empty text body; read text first so the
    // user sees the intended message instead of a JSON parse error.
    const text = await response.text();
    let payload: (T & ApiErrorPayload) | undefined = parseApiErrorPayload(text) as (T & ApiErrorPayload) | undefined;
    if (response.ok && payload === undefined) {
      try {
        payload = text ? ((JSON.parse(text) as T & ApiErrorPayload) ?? undefined) : undefined;
      } catch {
        payload = undefined;
      }
    }
    if (!response.ok) {
      throw new ApiError(
        payload?.code ?? errorCodeForStatus(response.status),
        response.status,
        payload?.error ?? t("api.theRequestFailedCheckThat"),
      );
    }
    if (payload === undefined) {
      throw new ApiError("malformed_response", response.status, t("common.theApiResponseWasMalformed"));
    }
    return payload;
  }

  public write<T>(path: string, method: "DELETE" | "PATCH" | "POST", body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method, body: JSON.stringify(body), signal });
  }

  public async download(path: string, body: unknown, fallback: string): Promise<Blob> {
    const response = await this.fetchResponse(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await this.responseError(response, fallback);
    return response.blob();
  }
}
