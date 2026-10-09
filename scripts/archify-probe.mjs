/* global window */
// window is used only inside Playwright browser callbacks; Node APIs are imported explicitly.
import console from "node:console";
import { Buffer } from "node:buffer";
import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout } from "node:timers";
import process from "node:process";
import os from "node:os";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
async function withDeadline(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = nodeSetTimeout(() => reject(new Error("Font readiness timed out")), milliseconds);
      }),
    ]);
  } finally {
    nodeClearTimeout(timer);
  }
}

const root = path.resolve(process.argv[3] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
if (!process.argv[2]) throw new Error("Usage: pnpm exec node scripts/archify-probe.mjs <upstream-checkout>");
const upstream = path.resolve(process.argv[2]);
const pinnedCommit = "bb990b17b886e83d633e273221615eb259a92c78";
const git = spawnSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" });
const clean = spawnSync("git", ["-C", upstream, "status", "--porcelain"], { encoding: "utf8" });
if (git.status !== 0 || git.stdout.trim() !== pinnedCommit || clean.status !== 0 || clean.stdout.trim())
  throw new Error("Probe requires a clean Archify checkout at the pinned commit.");
const out = await fs.mkdtemp(path.join(os.tmpdir(), "worklog-archify-probe-"));
console.log(`Probe output: ${out}`);
await fs.writeFile(
  path.join(out, "environment.json"),
  JSON.stringify(
    {
      testedAt: new Date().toISOString(),
      upstreamCommit: pinnedCommit,
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      mermaidVersion: JSON.parse(
        await fs.readFile(path.join(root, "apps/web/node_modules/mermaid/package.json"), "utf8"),
      ).version,
    },
    null,
    2,
  ),
);
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild");
const { chromium, firefox, webkit } = require("@playwright/test");
const { applyProductionSecurityHeaders } = await import(
  pathToFileURL(path.join(root, "apps/server/dist/static-files.js")).href
);
await build({
  stdin: {
    contents: `import {renderMermaid} from ${JSON.stringify(path.join(root, "apps/web/src/utils/mermaid.ts"))}; window.probeRender=async(source)=>{const start=performance.now();const {svg,css}=await renderMermaid(source);const host=window.document.querySelector('#host');const shadow=host.shadowRoot??host.attachShadow({mode:'open'});shadow.innerHTML=svg;const sheet=new CSSStyleSheet();sheet.replaceSync(css);shadow.adoptedStyleSheets=[sheet];return {ms:performance.now()-start,bytes:new TextEncoder().encode(svg+css).length,nodes:shadow.querySelectorAll('.node').length};};`,
    resolveDir: root,
  },
  bundle: true,
  format: "esm",
  outfile: path.join(out, "mermaid.js"),
  logLevel: "silent",
});
const counts = [6, 10, 100, 500];
const moduleLabels = ["Web UI", "REST routes", "Input schema", "Store facade", "Diagram service", "SQLite"];
const receipts = [];
for (const count of counts) {
  const data = {
    schema_version: 1,
    diagram_type: "architecture",
    meta: { title: `WorkLog probe ${count}`, output: `archify-${count}.html`, locale: "en", animation: "none" },
    components: Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      type: i === count - 1 ? "database" : "backend",
      label: count === 6 ? moduleLabels[i] : `Node ${i}`,
      pos: [40 + i * 220, 150],
      size: [160, 80],
    })),
    connections: Array.from({ length: count - 1 }, (_, i) => ({ id: `e${i}`, from: `n${i}`, to: `n${i + 1}` })),
  };
  await fs.writeFile(path.join(out, `archify-${count}.json`), JSON.stringify(data));
  const times = [];
  let command;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    command = spawnSync(
      process.execPath,
      [
        path.join(upstream, "archify/bin/archify.mjs"),
        "render",
        "architecture",
        path.join(out, `archify-${count}.json`),
        path.join(out, `archify-${count}.html`),
        "--quality",
        "standard",
      ],
      { cwd: out, encoding: "utf8", timeout: 120000 },
    );
    times.push(performance.now() - start);
    if (command.status !== 0) break;
  }
  receipts.push({
    count,
    jsonBytes: Buffer.byteLength(JSON.stringify(data)),
    generationMs: times,
    status: command.status,
    stderr: command.stderr.slice(-1500),
    htmlBytes: command.status === 0 ? (await fs.stat(path.join(out, `archify-${count}.html`))).size : null,
  });
}
await fs.writeFile(path.join(out, "generation.json"), JSON.stringify(receipts, null, 2));
const localeData = JSON.parse(await fs.readFile(path.join(out, "archify-6.json"), "utf8"));
localeData.meta.locale = "zh-TW";
localeData.meta.output = "archify-zh-TW.html";
await fs.writeFile(path.join(out, "archify-zh-TW.json"), JSON.stringify(localeData));
const localeRun = spawnSync(
  process.execPath,
  [
    path.join(upstream, "archify/bin/archify.mjs"),
    "render",
    "architecture",
    path.join(out, "archify-zh-TW.json"),
    path.join(out, "archify-zh-TW.html"),
    "--quality",
    "standard",
  ],
  { cwd: out, encoding: "utf8", timeout: 120000 },
);
await fs.writeFile(
  path.join(out, "locale.json"),
  JSON.stringify({ requestedLocale: "zh-TW", status: localeRun.status, warning: localeRun.stderr }, null, 2),
);
const shell =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mermaid probe</title></head><body><div id="host"></div><script type="module" src="/mermaid.js"></script></body></html>';
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/csp/")) applyProductionSecurityHeaders(res);
    const filename = path.basename(url.pathname);
    res.setHeader("Content-Type", filename.endsWith(".js") ? "application/javascript" : "text/html");
    res.end(filename === "mermaid.html" ? shell : await fs.readFile(path.join(out, filename)));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const results = [];
async function saveRow(row) {
  results.push(row);
  await fs.writeFile(path.join(out, "browser-results.json"), JSON.stringify(results, null, 2));
  console.log(
    `${row.browser}: ${row.kind} ${row.count ?? "locale"} ${row.requestedTheme ?? ""} CSP=${row.csp ?? false}`,
  );
}
try {
  for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await type.launch();
    try {
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await page.addInitScript(() => {
          window.probeViolations = [];
          window.document.addEventListener("securitypolicyviolation", (e) =>
            window.probeViolations.push({ directive: e.effectiveDirective, blocked: e.blockedURI }),
          );
        });
        for (const count of counts) {
          if (receipts.find((r) => r.count === count).status !== 0) continue;
          for (const blocked of [false, true]) {
            const start = performance.now();
            await page.goto(`${base}/${blocked ? "csp/" : ""}archify-${count}.html?theme=${theme}`);
            if (!blocked) {
              await withDeadline(
                page.evaluate(() => window.document.fonts.ready),
                10_000,
              );
              await page.evaluate(
                () =>
                  new Promise((resolve, reject) => {
                    const deadline = window.setTimeout(() => reject(new Error("Initial paint timed out")), 1000);
                    window.requestAnimationFrame(() =>
                      window.requestAnimationFrame(() => {
                        window.clearTimeout(deadline);
                        resolve();
                      }),
                    );
                  }),
              );
            }
            const before = await page.evaluate(() => ({
              view: typeof window.Archify?.view?.zoomIn === "function",
              theme: window.document.documentElement.dataset.theme,
              lang: window.document.documentElement.lang,
              nodes: window.document.querySelector(".diagram-container > svg").querySelectorAll("[data-node-id]")
                .length,
              totalNodeElements: window.document.querySelectorAll("[data-node-id]").length,
              violations: window.probeViolations,
            }));
            const loadMs = performance.now() - start;
            const interactions = [];
            if (before.view)
              for (let i = 0; i < 10; i++)
                interactions.push(
                  await page.evaluate(async () => {
                    const t = performance.now();
                    window.Archify.view[window.probeToggle ? "zoomOut" : "zoomIn"]();
                    window.probeToggle = !window.probeToggle;
                    await new Promise((resolve, reject) => {
                      const deadline = window.setTimeout(() => reject(new Error("Zoom paint timed out")), 2000);
                      window.requestAnimationFrame(() =>
                        window.requestAnimationFrame(() => {
                          window.clearTimeout(deadline);
                          resolve();
                        }),
                      );
                    });
                    return performance.now() - t;
                  }),
                );
            await saveRow({
              browser: name,
              kind: "archify",
              requestedTheme: theme,
              count,
              csp: blocked,
              loadMs,
              ...before,
              interactionMs: interactions,
            });
          }
        }
        await page.goto(`${base}/csp/mermaid.html`);
        await page.waitForFunction(() => typeof window.probeRender === "function");
        await page.evaluate((theme) => (window.document.documentElement.dataset.theme = theme), theme);
        for (const count of counts) {
          const source =
            "flowchart LR\n" +
            Array.from({ length: count }, (_, i) => `n${i}["${count === 6 ? moduleLabels[i] : `Node ${i}`}"]`).join(
              "\n",
            ) +
            "\n" +
            Array.from({ length: count - 1 }, (_, i) => `n${i}-->n${i + 1}`).join("\n");
          const renders = [];
          for (let i = 0; i < 3; i++) renders.push(await page.evaluate((source) => window.probeRender(source), source));
          const interactionMs = [];
          for (let i = 0; i < 10; i++)
            interactionMs.push(
              await page.evaluate(async () => {
                const svg = window.document.querySelector("#host").shadowRoot.querySelector("svg");
                const { width, height } = svg.viewBox.baseVal;
                const scale = window.probeMermaidToggle ? 1 : 1.25;
                window.probeMermaidToggle = !window.probeMermaidToggle;
                const start = performance.now();
                svg.style.maxWidth = "none";
                svg.style.width = `${width * scale}px`;
                svg.style.height = `${height * scale}px`;
                await new Promise((resolve, reject) => {
                  const deadline = window.setTimeout(() => reject(new Error("Zoom paint timed out")), 2000);
                  window.requestAnimationFrame(() =>
                    window.requestAnimationFrame(() => {
                      window.clearTimeout(deadline);
                      resolve();
                    }),
                  );
                });
                return performance.now() - start;
              }),
            );
          await saveRow({
            browser: name,
            kind: "mermaid",
            requestedTheme: theme,
            count,
            csp: true,
            sourceBytes: Buffer.byteLength(source),
            renders,
            interactionMs,
            violations: await page.evaluate(() => window.probeViolations),
          });
        }
        if (theme === "light" && localeRun.status === 0) {
          await page.goto(`${base}/archify-zh-TW.html`);
          await saveRow({
            browser: name,
            kind: "locale",
            requestedLocale: "zh-TW",
            actualLocale: await page.evaluate(() => window.document.documentElement.lang),
            zoomLabel: await page.locator('[data-view="in"]').getAttribute("aria-label"),
          });
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
  server.closeAllConnections();
  await fs.writeFile(path.join(out, "browser-results.json"), JSON.stringify(results, null, 2));
}
const failures = results.filter((row) =>
  row.kind === "archify"
    ? row.nodes !== row.count ||
      (row.csp
        ? row.view || row.violations.length === 0
        : !row.view || row.violations.length > 0 || row.theme !== row.requestedTheme)
    : row.kind === "mermaid"
      ? row.violations.length > 0 || row.renders.some((render) => render.nodes !== row.count)
      : row.actualLocale !== "en",
);
console.log(JSON.stringify({ output: out, rows: results.length, failures: failures.length }, null, 2));
if (
  receipts.some((receipt) => receipt.status !== 0) ||
  results.length !== counts.length * 3 * 2 * 3 + 3 ||
  failures.length
)
  process.exitCode = 1;
