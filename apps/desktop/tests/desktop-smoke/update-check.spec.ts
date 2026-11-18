import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { updateMessages, type UpdateMessages } from "@work-intelligence/desktop-core";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  launchApp,
  readSnapshot,
  removeSandbox,
  waitForManagedSnapshot,
  type Sandbox,
} from "./helpers.js";

/**
 * 「檢查更新」: the manual update check. A local HTTP server stands in for the GitHub API (the test build's override, which
 * only changes the API origin: the release and installer links in its answers are still github.com links, and are only
 * recorded, never opened). Synthetic releases only.
 */

const SLUG = "Ponpon55837/WorkLog.Ai";
const BASE = `https://github.com/${SLUG}/releases`;
const ORIGIN_VARIABLE = "WORK_INTELLIGENCE_DESKTOP_TEST_UPDATE_API_ORIGIN";
const PLATFORM_VARIABLE = "WORK_INTELLIGENCE_DESKTOP_TEST_UPDATE_PLATFORM";

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

type Handler = (response: ServerResponse) => void;

let sandbox: Sandbox | undefined;
let app: ElectronApplication | undefined;
let server: Server | undefined;
let requests: Recorded[] = [];
let handler: Handler = (response) => {
  response.writeHead(500).end();
};

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (sandbox) attachLog(testInfo, sandbox);
  await closeQuietly(app);
  app = undefined;
  // A request the test left unanswered holds its connection open: drop it, or close() waits for it.
  server?.closeAllConnections();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
  if (sandbox) removeSandbox(sandbox);
  sandbox = undefined;
});

function assets(tag: string): { name: string; browser_download_url: string }[] {
  const version = tag.slice(1);
  return [
    `Work-Intelligence-${version}-win-x64-setup.exe`,
    `Work-Intelligence-${version}-mac-arm64.dmg`,
    `Work-Intelligence-${version}-mac-x64.dmg`,
    "SHA256SUMS.txt",
  ].map((name) => ({ name, browser_download_url: `${BASE}/download/${tag}/${name}` }));
}

function releaseJson(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: "2030-03-04T05:06:07Z",
    body: "Synthetic release notes\r\n- first change\r\n- second change",
    html_url: `${BASE}/tag/${tag}`,
    assets: assets(tag),
    ...extra,
  };
}

function sendJson(response: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(typeof value === "string" ? value : JSON.stringify(value));
}

async function startServer(): Promise<string> {
  requests = [];
  server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    handler(response);
  });
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Launches the App against the fake server; `platform` is the `<platform>/<arch>` the check reports. */
async function launch(platform = "win32/x64"): Promise<{ running: ElectronApplication; version: string }> {
  sandbox = await createSandbox({ withDatabase: true });
  const origin = await startServer();
  app = await launchApp(sandbox, { [ORIGIN_VARIABLE]: origin, [PLATFORM_VARIABLE]: platform });
  await waitForManagedSnapshot(app);
  const version = await app.evaluate(({ app: electron }) => electron.getVersion());
  return { running: app, version };
}

/** The version one patch above the running one, as the tag of a newer release. */
function newerTag(version: string): string {
  const [major = "0", minor = "0", patch = "0"] = version.split(/[.-]/);
  return `v${major}.${minor}.${Number(patch) + 1}`;
}

async function openRepairPage(running: ElectronApplication): Promise<Page> {
  await running.evaluate(() =>
    (
      globalThis as unknown as { __workIntelligenceDesktopTest: { openRepair(): void } }
    ).__workIntelligenceDesktopTest.openRepair(),
  );
  const window = await running.firstWindow({ timeout: 45_000 });
  await expect(window.locator("#update-section")).toBeVisible({ timeout: 30_000 });
  return window;
}

/** The page's own language decides which copy it shows; the test compares with the same catalogue. */
async function textOf(window: Page): Promise<UpdateMessages> {
  const lang = await window.evaluate(() => document.documentElement.lang);
  return updateMessages(lang === "zh-Hant" ? "zh-TW" : "en");
}

async function checkNow(window: Page): Promise<void> {
  await window.locator('[data-id="update-check"]').click();
}

async function lastOpened(running: ElectronApplication): Promise<string | undefined> {
  return (await readSnapshot(running)).openedExternal.at(-1);
}

test("nothing is requested at launch or while the page sits open and idle", async () => {
  const { running, version } = await launch();
  const window = await openRepairPage(running);
  await expect(window.locator("#update-section")).toContainText(version);
  await expect(window.locator('[data-id="update-check"]')).toBeEnabled();
  // The repair page polls every 4 s; wait past two polls.
  await window.waitForTimeout(9_000);
  expect(requests).toHaveLength(0);
});

test("a newer release shows its details, and each button records exactly the expected link", async () => {
  const { running, version } = await launch("win32/x64");
  const tag = newerTag(version);
  handler = (response) =>
    sendJson(response, [releaseJson(tag), releaseJson("v0.0.1"), releaseJson("v99.0.0", { prerelease: true })]);
  const window = await openRepairPage(running);
  await checkNow(window);

  const card = window.locator("#update-section");
  await expect(card).toContainText(tag.slice(1));
  await expect(card).toContainText("2030");
  await expect(card.locator(".update-notes")).toContainText("- first change");
  expect(
    await card.locator(".update-notes").evaluate((node) => node.textContent?.includes(String.fromCharCode(13))),
  ).toBe(false);
  const text = await textOf(window);
  await expect(card.locator('[data-id="update-asset"]')).toHaveText(text.downloadAsset.windows);
  await expect(card.locator('[data-id="update-page"]')).toHaveText(text.openPage);
  await expect(card).toContainText("SHA256SUMS.txt");
  await expect(card).toContainText("Gatekeeper");
  await expect(card).toContainText("SmartScreen");
  await expect(card.locator('[data-id="update-check"]')).toBeEnabled();

  await card.locator('[data-id="update-asset"]').click();
  await expect
    .poll(() => lastOpened(running))
    .toBe(`${BASE}/download/${tag}/Work-Intelligence-${tag.slice(1)}-win-x64-setup.exe`);
  await card.locator('[data-id="update-page"]').click();
  await expect.poll(() => lastOpened(running)).toBe(`${BASE}/tag/${tag}`);

  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("GET");
  expect(requests[0]?.url).toBe(`/repos/${SLUG}/releases?per_page=20`);
});

test("the request carries exactly the three headers, no cookie and no credentials", async () => {
  const { running } = await launch();
  handler = (response) => sendJson(response, []);
  const window = await openRepairPage(running);
  await checkNow(window);
  await expect(window.locator("#update-section .update-current")).toHaveText((await textOf(window)).upToDate);
  expect(requests).toHaveLength(1);
  const headers = requests[0]?.headers ?? {};
  expect(headers.accept).toBe("application/vnd.github+json");
  expect(headers["x-github-api-version"]).toBe("2022-11-28");
  expect(headers["user-agent"]).toBe("WorkIntelligence-UpdateCheck");
  for (const forbidden of ["cookie", "authorization", "referer", "origin", "proxy-authorization"]) {
    expect(headers, forbidden).not.toHaveProperty(forbidden);
  }
  // Everything else is the transport's own.
  const transport = new Set([
    "host",
    "connection",
    "accept-encoding",
    "accept-language",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
  ]);
  const unexpected = Object.keys(headers).filter(
    (name) => !["accept", "x-github-api-version", "user-agent"].includes(name) && !transport.has(name),
  );
  expect(unexpected).toEqual([]);
});

test("the running version or an older release is up to date", async () => {
  const { running, version } = await launch();
  handler = (response) => sendJson(response, [releaseJson(`v${version.split("-")[0]}`)]);
  const window = await openRepairPage(running);
  await checkNow(window);
  await expect(window.locator("#update-section .update-current")).toHaveText((await textOf(window)).upToDate);
  await expect(window.locator('[data-id="update-asset"]')).toHaveCount(0);
  await expect(window.locator('[data-id="update-page"]')).toHaveCount(0);
});

test("403 with no requests left shows the reset time and offers no link", async () => {
  const { running } = await launch();
  const reset = Math.floor(Date.now() / 1000) + 1800;
  handler = (response) =>
    sendJson(response, { message: "API rate limit exceeded SECRET-BODY" }, 403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(reset),
    });
  const window = await openRepairPage(running);
  await checkNow(window);
  const card = window.locator("#update-section");
  await expect(card).toContainText((await textOf(window)).rateLimitedUntil.split("{time}")[0] ?? "");
  await expect(card).not.toContainText("SECRET-BODY");
  await expect(card.locator('[data-id="update-asset"]')).toHaveCount(0);
});

test("429 with retry-after shows when to try again", async () => {
  const { running } = await launch();
  handler = (response) => sendJson(response, {}, 429, { "retry-after": "120" });
  const window = await openRepairPage(running);
  await checkNow(window);
  await expect(window.locator("#update-section")).toContainText(
    (await textOf(window)).rateLimitedUntil.split("{time}")[0] ?? "",
  );
});

test("another 403 and a server error are errors with a reason code, never the body", async () => {
  const { running } = await launch();
  const window = await openRepairPage(running);
  handler = (response) => sendJson(response, "SECRET-BODY", 403, { "x-ratelimit-remaining": "7" });
  await checkNow(window);
  await expect(window.locator("#update-section")).toContainText("client-error");
  handler = (response) => sendJson(response, "SECRET-BODY", 503);
  await checkNow(window);
  await expect(window.locator("#update-section")).toContainText("server-error");
  await expect(window.locator("#update-section")).not.toContainText("SECRET-BODY");
});

test("malformed JSON and a response of the wrong shape are errors", async () => {
  const { running } = await launch();
  const window = await openRepairPage(running);
  handler = (response) => sendJson(response, "<html>not json</html>");
  await checkNow(window);
  await expect(window.locator("#update-section")).toContainText("not-json");
  handler = (response) => sendJson(response, { not: "a list" });
  await checkNow(window);
  await expect(window.locator("#update-section")).toContainText("bad-shape");
});

test("a response over 1 MiB is refused", async () => {
  const { running } = await launch();
  handler = (response) => sendJson(response, JSON.stringify([releaseJson("v0.0.1", { body: "x".repeat(1_200_000) })]));
  const window = await openRepairPage(running);
  await checkNow(window);
  await expect(window.locator("#update-section")).toContainText("too-large");
});

test("a redirect is refused, not followed", async () => {
  const { running } = await launch();
  handler = (response) => {
    response.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" }).end();
  };
  const window = await openRepairPage(running);
  await checkNow(window);
  await expect(window.locator("#update-section")).toContainText("redirect");
  expect(requests).toHaveLength(1);
});

test("release notes with HTML stay literal text: no element is created", async () => {
  const { running, version } = await launch();
  const tag = newerTag(version);
  const injected = '<img src=x onerror="document.title=\'pwned\'"><script>document.title="pwned"</script>';
  handler = (response) => sendJson(response, [releaseJson(tag, { body: `${injected}\n[link](javascript:alert(1))` })]);
  const window = await openRepairPage(running);
  await checkNow(window);
  const card = window.locator("#update-section");
  await expect(card.locator(".update-notes")).toContainText('<img src=x onerror="document.title=');
  await expect(card.locator(".update-notes")).toContainText("<script>");
  await expect(card.locator("img")).toHaveCount(0);
  await expect(card.locator("script")).toHaveCount(0);
  await expect(card.locator("a")).toHaveCount(0);
  await expect(card.locator(".update-notes *")).toHaveCount(0);
  expect(await window.title()).not.toBe("pwned");
});

test("an asset URL that is not the repository's is not offered; the page link still is", async () => {
  const { running, version } = await launch("win32/x64");
  const tag = newerTag(version);
  const bad = assets(tag).map((asset) =>
    asset.name.endsWith(".exe")
      ? {
          ...asset,
          browser_download_url: `https://github.com.evil.test/${SLUG}/releases/download/${tag}/${asset.name}`,
        }
      : asset,
  );
  handler = (response) => sendJson(response, [releaseJson(tag, { assets: bad })]);
  const window = await openRepairPage(running);
  await checkNow(window);
  const card = window.locator("#update-section");
  await expect(card.locator('[data-id="update-page"]')).toBeVisible();
  await expect(card.locator('[data-id="update-asset"]')).toHaveCount(0);
  await card.locator('[data-id="update-page"]').click();
  await expect.poll(() => lastOpened(running)).toBe(`${BASE}/tag/${tag}`);
});

test("a page link that is not this release's falls back to the releases page", async () => {
  const { running, version } = await launch("darwin/arm64");
  const tag = newerTag(version);
  handler = (response) => sendJson(response, [releaseJson(tag, { html_url: "https://evil.test/phish" })]);
  const window = await openRepairPage(running);
  await checkNow(window);
  const card = window.locator("#update-section");
  await expect(card.locator('[data-id="update-asset"]')).toHaveText((await textOf(window)).downloadAsset.macos);
  await card.locator('[data-id="update-page"]').click();
  await expect.poll(() => lastOpened(running)).toBe(BASE);
  await card.locator('[data-id="update-asset"]').click();
  await expect
    .poll(() => lastOpened(running))
    .toBe(`${BASE}/download/${tag}/Work-Intelligence-${tag.slice(1)}-mac-arm64.dmg`);
});

test("a platform with no installer (Windows on ARM) gets the release page only", async () => {
  const { running, version } = await launch("win32/arm64");
  const tag = newerTag(version);
  handler = (response) => sendJson(response, [releaseJson(tag)]);
  const window = await openRepairPage(running);
  await checkNow(window);
  const card = window.locator("#update-section");
  await expect(card.locator('[data-id="update-asset"]')).toHaveCount(0);
  await expect(card.locator('[data-id="update-page"]')).toBeVisible();
  await expect(card).toContainText((await textOf(window)).noInstaller);
});

test("concurrent clicks make one request and the button is disabled while it runs", async () => {
  const { running, version } = await launch();
  const tag = newerTag(version);
  handler = (response) => {
    setTimeout(() => sendJson(response, [releaseJson(tag)]), 1_500);
  };
  const window = await openRepairPage(running);
  await window.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-id="update-check"]');
    button?.click();
    button?.click();
  });
  await expect(window.locator('[data-id="update-check"]')).toBeDisabled();
  await expect(window.locator('[data-id="update-check"]')).toHaveText((await textOf(window)).checking);
  await expect(window.locator("#update-section")).toContainText(tag.slice(1), { timeout: 15_000 });
  await expect(window.locator('[data-id="update-check"]')).toBeEnabled();
  expect(requests).toHaveLength(1);
});

test("the tray item opens the page and starts the check", async () => {
  const { running, version } = await launch();
  const tag = newerTag(version);
  handler = (response) => sendJson(response, [releaseJson(tag)]);
  await running.evaluate(() =>
    (
      globalThis as unknown as { __workIntelligenceDesktopTest: { openUpdateCheck(): void } }
    ).__workIntelligenceDesktopTest.openUpdateCheck(),
  );
  const window = await running.firstWindow({ timeout: 45_000 });
  await expect(window.locator("#update-section")).toContainText(tag.slice(1), { timeout: 30_000 });
  expect(requests).toHaveLength(1);
  // Opening the page again does not check again.
  await window.reload();
  await expect(window.locator("#update-section")).toBeVisible();
  await window.waitForTimeout(1_000);
  expect(requests).toHaveLength(1);
});

test("a request that never answers times out after 10 seconds", async () => {
  test.setTimeout(60_000);
  const { running } = await launch();
  handler = () => undefined;
  const window = await openRepairPage(running);
  const started = Date.now();
  await checkNow(window);
  await expect(window.locator("#update-section")).toContainText((await textOf(window)).timedOut, {
    timeout: 20_000,
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
  await expect(window.locator('[data-id="update-check"]')).toBeEnabled();
});
