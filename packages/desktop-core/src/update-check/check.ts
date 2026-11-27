import {
  GITHUB_API_ORIGIN,
  RELEASE_REPO_SLUG,
  UPDATE_MAX_RESPONSE_BYTES,
  UPDATE_REQUEST_HEADERS,
  UPDATE_TIMEOUT_MS,
  releasesApiUrl,
} from "./constants.js";
import { evaluateReleases, releaseListSchema, type UpdateOutcome } from "./releases.js";
import type { UpdateCheckResult, UpdateErrorReason } from "./result.js";

export interface UpdateRequestInit {
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly credentials: "omit";
  readonly cache: "no-store";
  readonly redirect: "error";
  readonly signal: AbortSignal;
}

export interface UpdateResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

export type UpdateFetch = (url: string, init: UpdateRequestInit) => Promise<UpdateResponse>;

export interface CheckForUpdatesInputs {
  readonly fetch: UpdateFetch;
  readonly currentVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly apiOrigin?: string;
  readonly slug?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

const NO_LINKS = { asset: null, page: null } as const;

function failure(result: UpdateCheckResult): UpdateOutcome {
  return { result, links: NO_LINKS };
}

function failed(reason: UpdateErrorReason): UpdateOutcome {
  return failure({ kind: "error", reason });
}

function seconds(value: string | null): number | undefined {
  if (value === null || !/^\d{1,10}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

function resetTime(headers: UpdateResponse["headers"], now: number): string | null {
  const wait = seconds(headers.get("retry-after"));
  const epoch = seconds(headers.get("x-ratelimit-reset"));
  const at = wait === undefined ? (epoch === undefined ? undefined : epoch * 1000) : now + wait * 1000;
  return at === undefined ? null : new Date(at).toISOString();
}

function isRateLimited(response: UpdateResponse): boolean {
  if (response.status === 429) return true;
  return response.status === 403 && response.headers.get("x-ratelimit-remaining")?.trim() === "0";
}

const NET_ERROR_CODE = /net::(ERR_[A-Z0-9_]+)/;
const TLS_NET_ERROR = /^ERR_(?:CERT_|SSL_|BAD_SSL_|INSECURE_RESPONSE|TLS_)/;
const TLS_TEXT = /certificate|(?<![a-z0-9])(?:ssl|tls)(?![a-z0-9])|self[- ]signed|unable to verify|handshake/i;

function describe(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return "";
  const { code, cause } = error as Error & { code?: unknown; cause?: unknown };
  const nested = cause === undefined || depth >= 3 ? "" : describe(cause, depth + 1);
  return [error.name, error.message, typeof code === "string" ? code : "", nested].join(" ");
}

function thrownOutcome(error: unknown, signal: AbortSignal): UpdateOutcome {
  if (signal.aborted) return failure({ kind: "offline", timedOut: true });
  const text = describe(error);
  if (/redirect/i.test(text)) return failed("redirect");
  const code = NET_ERROR_CODE.exec(text)?.[1];
  if (code !== undefined ? TLS_NET_ERROR.test(code) : TLS_TEXT.test(text)) return failed("tls");
  return failure({ kind: "offline", timedOut: false });
}

class ResponseTooLarge extends Error {}

function discard(stream: { cancel(): Promise<void> } | null): void {
  try {
    stream?.cancel().catch(() => undefined);
  } catch {
    // Nothing is left to release.
  }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function readLimited(response: UpdateResponse, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = seconds(response.headers.get("content-length"));
  if (declared !== undefined && declared > maxBytes) {
    discard(response.body);
    throw new ResponseTooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ResponseTooLarge();
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    discard(reader);
    throw error;
  }
  return text + decoder.decode();
}

export async function checkForUpdates(inputs: CheckForUpdatesInputs): Promise<UpdateOutcome> {
  const now = inputs.now ?? Date.now;
  const maxBytes = inputs.maxBytes ?? UPDATE_MAX_RESPONSE_BYTES;
  const signal = AbortSignal.timeout(inputs.timeoutMs ?? UPDATE_TIMEOUT_MS);
  const url = releasesApiUrl(inputs.slug ?? RELEASE_REPO_SLUG, inputs.apiOrigin ?? GITHUB_API_ORIGIN);
  let response: UpdateResponse;
  let text: string;
  try {
    response = await untilAborted(
      inputs.fetch(url, {
        method: "GET",
        headers: { ...UPDATE_REQUEST_HEADERS },
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal,
      }),
      signal,
    );
    if (isRateLimited(response)) {
      discard(response.body);
      return failure({ kind: "rate-limited", resetAt: resetTime(response.headers, now()) });
    }
    if (response.status !== 200) {
      discard(response.body);
      if (response.status >= 400 && response.status < 500) return failed("client-error");
      return failed(response.status >= 500 ? "server-error" : "unexpected-status");
    }
    text = await readLimited(response, maxBytes, signal);
  } catch (error) {
    return error instanceof ResponseTooLarge ? failed("too-large") : thrownOutcome(error, signal);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return failed("not-json");
  }
  const parsed = releaseListSchema.safeParse(json);
  if (!parsed.success) return failed("bad-shape");
  return evaluateReleases(parsed.data, {
    currentVersion: inputs.currentVersion,
    platform: inputs.platform,
    arch: inputs.arch,
    ...(inputs.slug === undefined ? {} : { slug: inputs.slug }),
  });
}
