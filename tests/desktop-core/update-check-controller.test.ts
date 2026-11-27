/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateApiOriginOverride, updateTarget } from "../../apps/desktop/src/main/config.js";
import { createUpdateController } from "../../apps/desktop/src/main/update-check.js";
import type { UpdateFetch, UpdateResponse } from "../../packages/desktop-core/src/index.js";

const ORIGIN_VARIABLE = "WORK_INTELLIGENCE_DESKTOP_TEST_UPDATE_API_ORIGIN";
const PLATFORM_VARIABLE = "WORK_INTELLIGENCE_DESKTOP_TEST_UPDATE_PLATFORM";
const BASE = "https://github.com/Ponpon55837/WorkLog.Ai/releases";
const ASSET = `${BASE}/download/v1.6.53/Work-Intelligence-1.6.53-mac-arm64.dmg`;

afterEach(() => {
  vi.unstubAllGlobals();
});

function listResponse(overrides: Record<string, unknown> = {}): UpdateResponse {
  const body = JSON.stringify([
    {
      tag_name: "v1.6.53",
      draft: false,
      prerelease: false,
      published_at: "2030-01-01T00:00:00Z",
      body: "Synthetic notes",
      html_url: `${BASE}/tag/v1.6.53`,
      assets: [{ name: "Work-Intelligence-1.6.53-mac-arm64.dmg", browser_download_url: ASSET }],
      ...overrides,
    },
  ]);
  return {
    status: 200,
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  };
}

function setup(fetch: UpdateFetch, openResult: () => Promise<boolean> = async () => true) {
  const opened: string[] = [];
  const shown: string[] = [];
  const logs: string[] = [];
  const changes: string[] = [];
  const controller = createUpdateController({
    currentVersion: "1.6.52",
    fetch,
    platform: "darwin",
    arch: "arm64",
    openExternal: (url) => {
      opened.push(url);
      return openResult();
    },
    showSection: () => shown.push("shown"),
    changed: () => changes.push(controller.section().checking ? "started" : "finished"),
    log: (line) => logs.push(line),
  });
  return { controller, opened, shown, logs, changes };
}

function gated() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn<UpdateFetch>(async () => {
    await gate;
    return listResponse();
  });
  return { fetch, release: () => release() };
}

describe("the test-only update overrides", () => {
  it("takes the fake server's origin only in a test build that is not packaged", () => {
    vi.stubGlobal("__WI_TEST_BUILD__", true);
    const environment = { [ORIGIN_VARIABLE]: "http://127.0.0.1:45678" };
    expect(updateApiOriginOverride({ isPackaged: false, environment })).toBe("http://127.0.0.1:45678");
    expect(updateApiOriginOverride({ isPackaged: true, environment })).toBeUndefined();
    vi.stubGlobal("__WI_TEST_BUILD__", false);
    for (const isPackaged of [true, false]) {
      expect(updateApiOriginOverride({ isPackaged, environment })).toBeUndefined();
    }
  });

  it("accepts only a loopback http origin with a port", () => {
    vi.stubGlobal("__WI_TEST_BUILD__", true);
    for (const value of [
      "",
      "not a url",
      "https://127.0.0.1:45678",
      "http://127.0.0.1",
      "http://localhost:45678",
      "http://192.168.0.1:45678",
      "http://api.github.com:45678",
      "http://127.0.0.1:45678/extra",
      "http://user@127.0.0.1:45678",
      "http://127.0.0.1:45678/?x=1",
      "http://127.0.0.1:45678/#x",
    ]) {
      expect(
        updateApiOriginOverride({ isPackaged: false, environment: { [ORIGIN_VARIABLE]: value } }),
        value,
      ).toBeUndefined();
    }
    expect(updateApiOriginOverride({ isPackaged: false, environment: {} })).toBeUndefined();
  });

  it("takes the platform override only in a test build that is not packaged", () => {
    const real = { platform: "linux", arch: "x64" };
    const environment = { [PLATFORM_VARIABLE]: "darwin/arm64" };
    vi.stubGlobal("__WI_TEST_BUILD__", true);
    expect(updateTarget({ isPackaged: false, environment }, real)).toEqual({ platform: "darwin", arch: "arm64" });
    expect(updateTarget({ isPackaged: true, environment }, real)).toEqual(real);
    for (const value of ["", "darwin", "darwin/", "/arm64", "darwin/arm64/x", "Darwin/arm64", "dar win/arm64"]) {
      expect(updateTarget({ isPackaged: false, environment: { [PLATFORM_VARIABLE]: value } }, real), value).toEqual(
        real,
      );
    }
    vi.stubGlobal("__WI_TEST_BUILD__", false);
    for (const isPackaged of [true, false]) expect(updateTarget({ isPackaged, environment }, real)).toEqual(real);
  });
});

describe("the update controller", () => {
  it("makes no request until a check is asked for, and never by itself", async () => {
    const fetch = vi.fn<UpdateFetch>(async () => listResponse());
    const { controller, changes } = setup(fetch);
    for (let read = 0; read < 3; read += 1) {
      expect(controller.section()).toEqual({ currentVersion: "1.6.52", checking: false, result: null });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });

  it("starts the check itself when the tray item is clicked, and shows the page", async () => {
    const { fetch, release } = gated();
    const { controller, shown, changes } = setup(fetch);
    controller.requestFromTray();
    expect(shown).toEqual(["shown"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(controller.section()).toEqual({ currentVersion: "1.6.52", checking: true, result: null });
    release();
    await vi.waitFor(() => expect(controller.section().checking).toBe(false));
    expect(controller.section().result).toMatchObject({ kind: "newer", version: "1.6.53" });
    expect(changes).toEqual(["started", "finished"]);
  });

  it("leaves nothing behind for a page that opens later: reading the state never starts a request", async () => {
    const fetch = vi.fn<UpdateFetch>(async () => listResponse());
    const { controller } = setup(fetch);
    controller.requestFromTray();
    await vi.waitFor(() => expect(controller.section().checking).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(1);
    for (let read = 0; read < 5; read += 1) expect(controller.section().result).toMatchObject({ kind: "newer" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("joins a tray click and a button click into one request", async () => {
    const { fetch, release } = gated();
    const { controller, changes } = setup(fetch);
    controller.requestFromTray();
    const pressed = controller.check();
    controller.requestFromTray();
    release();
    await pressed;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(changes).toEqual(["started", "finished"]);
  });

  it("joins concurrent checks into one request and allows a new one afterwards", async () => {
    const { fetch, release } = gated();
    const { controller } = setup(fetch);
    const first = controller.check();
    const second = controller.check();
    expect(second).toBe(first);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(fetch).toHaveBeenCalledTimes(1);
    await controller.check();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("hides the previous answer while a new check runs", async () => {
    let answer: UpdateResponse = listResponse();
    let release: () => void = () => undefined;
    const { controller } = setup(async () => {
      if (answer.status !== 200) await new Promise<void>((resolve) => (release = resolve));
      return answer;
    });
    await controller.check();
    expect(controller.section().result?.kind).toBe("newer");
    answer = { status: 503, headers: { get: () => null }, body: null };
    const next = controller.check();
    expect(controller.section()).toMatchObject({ checking: true, result: null });
    release();
    await next;
    expect(controller.section()).toMatchObject({ checking: false, result: { kind: "error", reason: "server-error" } });
  });

  it("answers newer without any URL, then opens only the links it kept", async () => {
    const { controller, opened } = setup(async () => listResponse());
    expect(await controller.openLink("asset")).toBe(false);
    const result = await controller.check();
    expect(result).toMatchObject({ kind: "newer", version: "1.6.53", asset: { platform: "macos" } });
    expect(JSON.stringify(result)).not.toContain("github.com");
    expect(JSON.stringify(controller.section())).not.toContain("github.com");
    expect(await controller.openLink("asset")).toBe(true);
    expect(await controller.openLink("page")).toBe(true);
    expect(opened).toEqual([ASSET, `${BASE}/tag/v1.6.53`]);
  });

  it("reports a link the system refused or failed to open as not opened", async () => {
    for (const failure of [async () => false, () => Promise.reject(new Error("synthetic"))]) {
      const { controller, opened, logs } = setup(async () => listResponse(), failure);
      await controller.check();
      await expect(controller.openLink("page").catch(() => "rejected")).resolves.toBe(false);
      expect(opened).toHaveLength(1);
      expect(logs).not.toContain("[shell] update link opened: page");
    }
  });

  it("opens nothing after an answer that has no link, or when the new check failed", async () => {
    let answer: UpdateResponse = listResponse();
    const { controller, opened } = setup(async () => answer);
    await controller.check();
    answer = { status: 503, headers: { get: () => null }, body: null };
    expect(await controller.check()).toEqual({ kind: "error", reason: "server-error" });
    expect(await controller.openLink("asset")).toBe(false);
    expect(await controller.openLink("page")).toBe(false);
    expect(opened).toEqual([]);
  });

  it("offers the releases page after an answer without any stable release", async () => {
    const { controller, opened } = setup(async () => ({
      status: 200,
      headers: { get: () => null },
      body: new Response("[]").body,
    }));
    expect(await controller.check()).toEqual({ kind: "error", reason: "no-release" });
    expect(await controller.openLink("asset")).toBe(false);
    expect(await controller.openLink("page")).toBe(true);
    expect(opened).toEqual([BASE]);
  });

  it("offers only the page when the asset URL is not the repository's, and never opens that URL", async () => {
    const assets = [
      {
        name: "Work-Intelligence-1.6.53-mac-arm64.dmg",
        browser_download_url: "https://github.com.evil.test/Ponpon55837/WorkLog.Ai/releases/download/v1.6.53/x.dmg",
      },
    ];
    const { controller, opened } = setup(async () => listResponse({ assets }));
    expect(await controller.check()).toMatchObject({ kind: "newer", asset: null });
    expect(await controller.openLink("asset")).toBe(false);
    expect(await controller.openLink("page")).toBe(true);
    expect(opened).toEqual([`${BASE}/tag/v1.6.53`]);
  });

  it("treats a fetch that throws as offline instead of throwing", async () => {
    const { controller } = setup(() => {
      throw new Error("synthetic failure");
    });
    expect((await controller.check()).kind).toBe("offline");
  });

  it("logs the kind of the answer and never a URL", async () => {
    const { controller, logs } = setup(async () => listResponse());
    await controller.check();
    await controller.openLink("asset");
    expect(logs).toEqual(["[shell] update check finished: newer", "[shell] update link opened: asset"]);
  });

  it("logs a link that could not be opened as failed, without the URL", async () => {
    const { controller, logs } = setup(
      async () => listResponse(),
      async () => false,
    );
    await controller.check();
    expect(await controller.openLink("asset")).toBe(false);
    expect(logs.at(-1)).toBe("[shell] update link failed: asset");
    expect(logs.join("\n")).not.toContain("github.com");
  });
});
