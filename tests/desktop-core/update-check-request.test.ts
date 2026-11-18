import { describe, expect, it } from "vitest";
import {
  checkForUpdates,
  UPDATE_MAX_RESPONSE_BYTES,
  UPDATE_REQUEST_HEADERS,
  UPDATE_TIMEOUT_MS,
  type UpdateFetch,
  type UpdateRequestInit,
  type UpdateResponse,
} from "../../packages/desktop-core/src/index.js";

const SLUG = "Ponpon55837/WorkLog.Ai";
const BASE = `https://github.com/${SLUG}/releases`;
const NOW = Date.UTC(2030, 0, 1, 0, 0, 0);

const goodRelease = {
  tag_name: "v1.6.53",
  draft: false,
  prerelease: false,
  published_at: "2030-01-01T00:00:00Z",
  body: "Synthetic notes",
  html_url: `${BASE}/tag/v1.6.53`,
  assets: [
    {
      name: "Work-Intelligence-1.6.53-win-x64-setup.exe",
      browser_download_url: `${BASE}/download/v1.6.53/Work-Intelligence-1.6.53-win-x64-setup.exe`,
    },
  ],
  unrelated: { nested: true },
};

interface Call {
  url: string;
  init: UpdateRequestInit;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

function respond(
  status: number,
  body: string | Uint8Array[] | null,
  headers: Record<string, string> = {},
): UpdateResponse {
  const bytes = typeof body === "string" ? [new TextEncoder().encode(body)] : body;
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: bytes === null ? null : streamOf(bytes),
  };
}

function run(
  fetch: UpdateFetch,
  extra: Partial<Parameters<typeof checkForUpdates>[0]> = {},
): ReturnType<typeof checkForUpdates> {
  return checkForUpdates({
    fetch,
    currentVersion: "1.6.52",
    platform: "win32",
    arch: "x64",
    now: () => NOW,
    ...extra,
  });
}

const answering =
  (response: UpdateResponse): UpdateFetch =>
  async () =>
    response;
const json = (value: unknown, headers: Record<string, string> = {}): UpdateResponse =>
  respond(200, JSON.stringify(value), headers);

/** A fetch that never answers until its signal aborts, like a server that does not reply. */
const hanging: UpdateFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });

describe("the request", () => {
  it("sends one GET to the fixed endpoint with exactly the three headers and the fixed options", async () => {
    const calls: Call[] = [];
    const outcome = await run(async (url, init) => {
      calls.push({ url, init });
      return json([goodRelease]);
    });
    expect(outcome.result.kind).toBe("newer");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.github.com/repos/${SLUG}/releases?per_page=20`);
    expect(calls[0]?.init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store", redirect: "error" });
    expect(calls[0]?.init.headers).toEqual({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "WorkIntelligence-UpdateCheck",
    });
    expect(Object.keys(calls[0]?.init.headers ?? {})).toHaveLength(3);
    expect(UPDATE_REQUEST_HEADERS["User-Agent"]).toBe("WorkIntelligence-UpdateCheck");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(UPDATE_TIMEOUT_MS).toBe(10_000);
    expect(UPDATE_MAX_RESPONSE_BYTES).toBe(1024 * 1024);
  });

  it("uses the API origin a test build gives and nothing else changes", async () => {
    const calls: Call[] = [];
    await run(
      async (url, init) => {
        calls.push({ url, init });
        return json([]);
      },
      { apiOrigin: "http://127.0.0.1:4567" },
    );
    expect(calls[0]?.url).toBe(`http://127.0.0.1:4567/repos/${SLUG}/releases?per_page=20`);
  });

  it("answers with the decision for a good response, ignoring fields it does not need", async () => {
    const outcome = await run(answering(json([goodRelease])));
    expect(outcome.result).toMatchObject({ kind: "newer", version: "1.6.53", asset: { platform: "windows" } });
    expect(outcome.links.asset).toBe(goodRelease.assets[0]?.browser_download_url);
    expect((await run(answering(json([{ ...goodRelease, tag_name: "v1.6.52" }])))).result).toEqual({
      kind: "up-to-date",
      current: "1.6.52",
    });
    expect((await run(answering(json([])))).result).toEqual({ kind: "error", reason: "no-release" });
  });

  it("reads a body that arrives in several chunks, including a multi-byte character cut in two", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify([{ ...goodRelease, body: "更新內容" }]));
    const cut = bytes.indexOf(0xe6) + 1;
    const outcome = await run(answering(respond(200, [bytes.slice(0, cut), bytes.slice(cut)])));
    expect(outcome.result).toMatchObject({ kind: "newer", notes: "更新內容" });
  });

  it("treats a response without a body as not JSON", async () => {
    expect((await run(answering(respond(200, null)))).result).toEqual({ kind: "error", reason: "not-json" });
  });
});

describe("rate limits", () => {
  it("recognizes 403 with no requests remaining and reads the reset time (epoch seconds)", async () => {
    const reset = String(NOW / 1000 + 600);
    const outcome = await run(
      answering(respond(403, "{}", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset })),
    );
    expect(outcome.result).toEqual({ kind: "rate-limited", resetAt: "2030-01-01T00:10:00.000Z" });
    expect(outcome.links).toEqual({ asset: null, page: null });
  });

  it("does not treat another 403 as a rate limit", async () => {
    for (const headers of [
      {} as Record<string, string>,
      { "x-ratelimit-remaining": "42" },
      { "x-ratelimit-remaining": "" },
    ]) {
      expect((await run(answering(respond(403, "{}", headers)))).result).toEqual({
        kind: "error",
        reason: "client-error",
      });
    }
  });

  it("recognizes 429 and reads retry-after (seconds), preferring it to the reset header", async () => {
    const withBoth = await run(answering(respond(429, "", { "retry-after": "90", "x-ratelimit-reset": "1" })));
    expect(withBoth.result).toEqual({ kind: "rate-limited", resetAt: "2030-01-01T00:01:30.000Z" });
    const withReset = await run(answering(respond(429, "", { "x-ratelimit-reset": String(NOW / 1000 + 5) })));
    expect(withReset.result).toEqual({ kind: "rate-limited", resetAt: "2030-01-01T00:00:05.000Z" });
  });

  it("gives no reset time when the headers are missing or not numbers", async () => {
    for (const headers of [
      {} as Record<string, string>,
      { "retry-after": "Wed, 21 Oct 2030 07:28:00 GMT" },
      { "x-ratelimit-reset": "soon" },
    ]) {
      expect((await run(answering(respond(429, null, headers)))).result).toEqual({
        kind: "rate-limited",
        resetAt: null,
      });
    }
  });
});

describe("errors", () => {
  it("classifies other statuses by class only", async () => {
    const cases: [number, string][] = [
      [404, "client-error"],
      [401, "client-error"],
      [500, "server-error"],
      [503, "server-error"],
      [204, "unexpected-status"],
      [302, "unexpected-status"],
    ];
    for (const [status, reason] of cases) {
      const outcome = await run(answering(respond(status, "SECRET-BODY-TEXT", { "retry-after": "1" })));
      expect(outcome.result).toEqual({ kind: "error", reason });
      expect(JSON.stringify(outcome)).not.toContain("SECRET-BODY-TEXT");
    }
  });

  it("refuses a body that is not JSON and one that does not have the shape", async () => {
    expect((await run(answering(respond(200, "<html>nope</html>")))).result).toEqual({
      kind: "error",
      reason: "not-json",
    });
    for (const value of [
      {},
      [{}],
      [{ ...goodRelease, tag_name: 7 }],
      [{ ...goodRelease, assets: "none" }],
      "text",
      null,
    ]) {
      expect((await run(answering(json(value)))).result).toEqual({ kind: "error", reason: "bad-shape" });
    }
  });

  it("refuses a body over the cap, whether it is declared or only found while reading", async () => {
    const declared = respond(200, [new Uint8Array(10)], { "content-length": "2000000" });
    expect((await run(answering(declared))).result).toEqual({ kind: "error", reason: "too-large" });
    let pulled = 0;
    const endless: UpdateResponse = {
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      }),
    };
    expect((await run(answering(endless), { maxBytes: 200 * 1024 })).result).toEqual({
      kind: "error",
      reason: "too-large",
    });
    // The read stopped soon after the cap: it did not drain the stream.
    expect(pulled).toBeLessThan(10);
    const small = respond(200, JSON.stringify([{ ...goodRelease, tag_name: "v1.6.52" }]), { "content-length": "2" });
    expect((await run(answering(small))).result.kind).toBe("up-to-date");
  });

  it("calls a refused redirect a redirect, not an outage", async () => {
    const fetch: UpdateFetch = async () => {
      throw new TypeError("net::ERR_FAILED (redirect was refused)");
    };
    expect((await run(fetch)).result).toEqual({ kind: "error", reason: "redirect" });
  });

  it("never carries a message, a header or a body in the answer", async () => {
    const outcome = await run(answering(respond(500, "stack trace at /home/synthetic/secret", { "x-secret": "hdr" })));
    expect(JSON.stringify(outcome)).not.toMatch(/secret|stack|hdr/);
  });
});

describe("being offline", () => {
  it("calls every connection failure offline", async () => {
    for (const message of [
      "net::ERR_NAME_NOT_RESOLVED",
      "net::ERR_CONNECTION_REFUSED",
      "net::ERR_INTERNET_DISCONNECTED",
      "net::ERR_CONNECTION_TIMED_OUT",
      "fetch failed",
    ]) {
      const fetch: UpdateFetch = async () => {
        throw new TypeError(message);
      };
      expect((await run(fetch)).result, message).toEqual({ kind: "offline", timedOut: false });
    }
    const notAnError: UpdateFetch = async () => {
      throw "plain string";
    };
    expect((await run(notAnError)).result).toEqual({ kind: "offline", timedOut: false });
  });

  it("calls a request that does not answer in time a timeout", async () => {
    expect((await run(hanging, { timeoutMs: 30 })).result).toEqual({ kind: "offline", timedOut: true });
  });

  it("calls a body that stalls after the headers a timeout too", async () => {
    const stalled: UpdateFetch = async (_url, init) => ({
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        pull: () =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason));
          }),
      }),
    });
    expect((await run(stalled, { timeoutMs: 30 })).result).toEqual({ kind: "offline", timedOut: true });
  });

  it("ends at the timeout even when neither the body nor the transport reacts to the abort", async () => {
    let cancelled = 0;
    // The body never produces a chunk, never errors and ignores both the signal and `cancel()`'s completion.
    const deaf: UpdateFetch = async () => ({
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel: () => {
          cancelled += 1;
          return new Promise<void>(() => undefined);
        },
      }),
    });
    const started = Date.now();
    expect((await run(deaf, { timeoutMs: 50 })).result).toEqual({ kind: "offline", timedOut: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    // The reader is released rather than left open.
    expect(cancelled).toBe(1);
  });

  it("ends at the timeout when the transport never answers and ignores the abort", async () => {
    const deafFetch: UpdateFetch = () => new Promise<UpdateResponse>(() => undefined);
    expect((await run(deafFetch, { timeoutMs: 50 })).result).toEqual({ kind: "offline", timedOut: true });
  });

  it("is not hurt by a body whose cancel fails, whether it rejects or throws", async () => {
    const rejecting = new ReadableStream<Uint8Array>({ cancel: () => Promise.reject(new Error("synthetic")) });
    const throwing = {
      cancel: () => {
        throw new Error("synthetic");
      },
    } as unknown as ReadableStream<Uint8Array>;
    for (const body of [rejecting, throwing]) {
      const response: UpdateResponse = { status: 502, headers: { get: () => null }, body };
      expect((await run(answering(response))).result).toEqual({ kind: "error", reason: "server-error" });
    }
  });

  it("does not wait for a body it refuses to be cancelled", async () => {
    const stuck: UpdateResponse = {
      status: 503,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => undefined) }),
    };
    expect((await run(answering(stuck))).result).toEqual({ kind: "error", reason: "server-error" });
  });
});

describe("a failed secure connection", () => {
  const throwing =
    (error: unknown): UpdateFetch =>
    async () => {
      throw error;
    };
  const tls = { kind: "error", reason: "tls" };

  it("is told apart from an outage by Electron's net error code", async () => {
    for (const code of [
      "ERR_CERT_AUTHORITY_INVALID",
      "ERR_CERT_COMMON_NAME_INVALID",
      "ERR_CERT_DATE_INVALID",
      "ERR_CERT_REVOKED",
      "ERR_SSL_PROTOCOL_ERROR",
      "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
      "ERR_BAD_SSL_CLIENT_AUTH_CERT",
      "ERR_INSECURE_RESPONSE",
    ]) {
      expect((await run(throwing(new TypeError(`net::${code}`)))).result, code).toEqual(tls);
    }
  });

  it("trusts the code over the words: a connection error that mentions TLS in text is still an outage", async () => {
    const error = new TypeError("net::ERR_CONNECTION_RESET while reading the tls handshake certificate");
    expect((await run(throwing(error))).result).toEqual({ kind: "offline", timedOut: false });
  });

  it("falls back to the words when the transport gives no net error code, including a nested cause", async () => {
    const cause = Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    for (const error of [
      new TypeError("fetch failed", { cause }),
      new Error("self-signed certificate in certificate chain"),
      new Error("SSL handshake failed"),
      Object.assign(new Error("request failed"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }),
    ]) {
      expect((await run(throwing(error))).result).toEqual(tls);
    }
  });

  it("is never confused with a refused redirect, and a timeout still wins", async () => {
    const redirect = new TypeError("net::ERR_CERT_DATE_INVALID after redirect was refused");
    expect((await run(throwing(redirect))).result).toEqual({ kind: "error", reason: "redirect" });
    const slowTls: UpdateFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new TypeError("net::ERR_CERT_DATE_INVALID")));
      });
    expect((await run(slowTls, { timeoutMs: 30 })).result).toEqual({ kind: "offline", timedOut: true });
  });

  it("carries no message in the answer", async () => {
    const outcome = await run(throwing(new TypeError("net::ERR_CERT_AUTHORITY_INVALID synthetic-detail")));
    expect(JSON.stringify(outcome)).not.toContain("synthetic-detail");
  });
});
