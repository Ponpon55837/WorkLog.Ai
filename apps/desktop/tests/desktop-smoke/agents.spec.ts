import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { maskHome } from "@work-intelligence/desktop-core";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { setupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  expectTabShown,
  launchApp,
  markPage,
  pageMarker,
  readMainLog,
  readSnapshot,
  removeSandbox,
  runToExit,
  shellText,
  tabButton,
  waitForManagedSnapshot,
  waitForSnapshot,
  windowCount,
  type Sandbox,
} from "./helpers.js";

/**
 * The Agent page ("設定 Agent…"): nothing is written by looking or previewing, "套用變更" writes exactly the previewed
 * plan into the Agents' files under the (sandbox) home, the self-test talks MCP through the fixed launcher, and "復原上次
 * 變更" puts every file back. Synthetic data only: the home is the sandbox's and holds, before the App starts, only the
 * synthetic Agent files seeded below, so apply has real files to back up and undo has real files to restore.
 */

const JOURNAL_FILE = ".work-intelligence-agent-setup.journal.json";
const MANIFEST_FILE = ".work-intelligence-agent-setup.json";
const BACKUP_MARK = ".work-intelligence.backup-";

/** Pre-existing Agent files with an entry that is not ours; the bytes are compared after apply and after undo. */
const SEEDS: Readonly<Record<string, string>> = {
  ".claude.json": `${JSON.stringify(
    { numStartups: 3, mcpServers: { other: { command: "synthetic-other", args: ["serve"] } } },
    null,
    2,
  )}\n`,
  ".codex/config.toml": 'model = "synthetic-model"\n\n[mcp_servers.other]\ncommand = "synthetic-other"\n',
};

function seedHome(home: string): void {
  for (const [name, content] of Object.entries(SEEDS)) {
    const path = join(home, ...name.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
}

/** The App's own data under the sandbox home: its database and backups. Logs live under the data folder, outside home. */
function isAppData(key: string): boolean {
  const path = key.replaceAll("\\", "/");
  return [".work-intelligence/data", ".work-intelligence/backups"].some(
    (folder) => path === folder || path.startsWith(`${folder}/`),
  );
}

const posix = (key: string): string => key.replaceAll("\\", "/");

let sandbox: Sandbox | undefined;
let app: ElectronApplication | undefined;

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (sandbox) attachLog(testInfo, sandbox);
  await closeQuietly(app);
  app = undefined;
  if (sandbox) removeSandbox(sandbox);
  sandbox = undefined;
});

/** Every file under `directory` with a hash of its bytes, so a test sees any write, create or delete. */
function tree(directory: string, skip: (path: string) => boolean): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const key = relative(directory, path);
      if (skip(key)) continue;
      if (statSync(path).isDirectory()) walk(path);
      else files[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(directory);
  return files;
}

interface PageAgentsState {
  launcherReady: boolean;
  selfTest: { outcome: string };
  undoAvailable: boolean;
  preview: {
    files: {
      display: string;
      change: "create" | "update" | "delete";
      tooLarge: boolean;
      hunks: { lines: { type: "context" | "add" | "remove" | "note"; text: string }[] }[];
    }[];
    conflicts: unknown[];
  } | null;
}

function agentsState(window: Page): Promise<PageAgentsState> {
  return window.evaluate(() =>
    (
      globalThis as unknown as { workIntelligenceRepair: { agentsGetState(): Promise<unknown> } }
    ).workIntelligenceRepair.agentsGetState(),
  ) as Promise<PageAgentsState>;
}

async function pageText(window: Page) {
  const lang = await window.evaluate(() => document.documentElement.lang);
  return setupMessages(lang === "zh-Hant" ? "zh-TW" : "en");
}

test("the Agent page previews, applies exactly the preview, passes the self-test and undoes it all", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const home = sandbox.home;
  seedHome(home);
  const skip = isAppData;
  app = await launchApp(sandbox, {}, ["--open-agent-setup"]);
  await waitForManagedSnapshot(app);

  const window = await app.firstWindow({ timeout: 45_000 });
  // The Agent page is the Agent tab of the one window (it has no heading of its own any more: the tab names it).
  await expectTabShown(window, "agent");
  await expect(tabButton(window, "agent")).toContainText((await shellText(window)).tabLabels.agent);
  await expect(window.locator("[data-agent]")).toHaveCount(2);
  expect((await readSnapshot(app)).tab).toBe("agent");
  expect((await agentsState(window)).launcherReady).toBe(true);
  const before = tree(home, skip);

  await window.locator('[data-id="preview"]').click();
  await expect(window.locator("#agents-preview")).toBeVisible();
  const previewed = await agentsState(window);
  expect(previewed.preview?.conflicts).toEqual([]);
  expect(previewed.preview?.files.length).toBeGreaterThan(0);
  // Previewing writes nothing.
  expect(tree(home, skip)).toEqual(before);
  // The diff shows `~`, never the real home.
  expect(await window.locator("#agents-preview").innerText()).not.toContain(home);

  // Wall time of a user-facing apply and undo of the two-Agent plan, printed for the release notes (polled every 25 ms).
  const applyStarted = Date.now();
  await window.locator('[data-id="apply"]').click();
  await expect
    .poll(async () => (await agentsState(window)).undoAvailable, { timeout: 15_000, intervals: [25] })
    .toBe(true);
  const applyMs = Date.now() - applyStarted;
  const applied = tree(home, skip);
  expect(applied).not.toEqual(before);
  expect(Object.keys(applied).some((path) => path.endsWith("SKILL.md"))).toBe(true);

  // Exactly the preview: the files written (created or changed, apart from the journal and the backups) are the files
  // the preview listed, nothing was deleted, and every added line of the preview is what the file now holds.
  const isBookkeeping = (key: string) => posix(key) === JOURNAL_FILE || key.includes(BACKUP_MARK);
  expect(Object.keys(before).filter((key) => !(key in applied))).toEqual([]);
  const written = Object.keys(applied)
    .filter((key) => applied[key] !== before[key] && !isBookkeeping(key))
    .map(posix)
    .sort();
  const previewedFiles = previewed.preview?.files ?? [];
  const previewedPaths = previewedFiles.map((file) =>
    file.display.replace(/^~/, "").replaceAll("\\", "/").replace(/^\/+/, ""),
  );
  expect(written).toEqual([...previewedPaths].sort());
  expect(written).toContain(MANIFEST_FILE);
  for (const file of previewedFiles) {
    expect(file.tooLarge).toBe(false);
    const key = file.display.replace(/^~/, "").replaceAll("\\", "/").replace(/^\/+/, "");
    const lines = maskHome(readFileSync(join(home, ...key.split("/")), "utf8"), home, process.platform)
      .split(/\r?\n/)
      .filter((line, index, all) => !(index === all.length - 1 && line === ""));
    // A secret-looking value is masked as `***` in the preview; those lines cannot be compared.
    const added = file.hunks.flatMap((hunk) =>
      hunk.lines.filter((line) => line.type === "add").map((line) => line.text),
    );
    const comparable = added.filter((line) => !line.includes("***"));
    if (file.change === "create") {
      // A created file is entirely the preview's added lines.
      expect(lines.length).toBe(added.length);
      expect(lines.filter((_, index) => !added[index]?.includes("***"))).toEqual(comparable);
    } else {
      // An updated file holds every added line, in the preview's order.
      let from = 0;
      for (const line of comparable) {
        const found = lines.indexOf(line, from);
        expect(found, `added line missing from ${key}: ${line}`).toBeGreaterThanOrEqual(from);
        from = found + 1;
      }
    }
  }

  // The seeded files were backed up byte for byte and keep the entries that are not ours.
  for (const [name, content] of Object.entries(SEEDS)) {
    const backups = Object.keys(applied).filter((key) => posix(key).startsWith(`${name}${BACKUP_MARK}`));
    expect(backups, `a backup of ${name}`).toHaveLength(1);
    expect(applied[backups[0] as string]).toBe(before[name.split("/").join(sep)]);
    expect(readFileSync(join(home, ...(backups[0] as string).split(/[\\/]/)), "utf8")).toBe(content);
  }
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.other).toEqual({
    command: "synthetic-other",
    args: ["serve"],
  });
  expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.other]");
  expect(JSON.parse(readFileSync(join(home, JOURNAL_FILE), "utf8")).state).toBe("committed");

  await window.locator('[data-id="self-test"]').click();
  await expect.poll(async () => (await agentsState(window)).selfTest.outcome, { timeout: 30_000 }).toBe("ok");

  const undoStarted = Date.now();
  await window.locator('[data-id="undo"]').click();
  // Undo puts everything back, the manifest, the backups and the created files included; only the journal stays, as the
  // record of what was undone, and says so.
  await expect
    .poll(() => tree(home, skip), { timeout: 15_000, intervals: [25] })
    .toEqual({ ...before, [JOURNAL_FILE]: expect.any(String) });
  const undoMs = Date.now() - undoStarted;
  console.log(
    `[agent setup timing] ${JSON.stringify({ platform: process.platform, files: previewedFiles.length, applyMs, undoMs })}`,
  );
  expect(JSON.parse(readFileSync(join(home, JOURNAL_FILE), "utf8")).state).toBe("compensated");
  for (const [name, content] of Object.entries(SEEDS)) {
    expect(readFileSync(join(home, ...name.split("/")), "utf8")).toBe(content);
  }
  expect(readMainLog(sandbox)).toMatch(/\[shell\] agent setup /);
});

test("a checkout on another database is not taken over, and 「改用這份資料庫」 previews that database on the Data tab", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const home = sandbox.home;
  // A hand-written Claude MCP entry of a synthetic checkout that names its own (synthetic) database.
  const checkout = join(sandbox.root, "synthetic checkout");
  const otherDatabase = join(checkout, "data", "other.sqlite");
  mkdirSync(join(otherDatabase, ".."), { recursive: true });
  new WorkIntelligenceStore(otherDatabase).close();
  const claudeJson = {
    mcpServers: {
      "work-intelligence": {
        command: "node",
        args: [join(checkout, "apps", "mcp", "dist", "index.js")],
        env: { WORK_INTELLIGENCE_DB: otherDatabase },
      },
    },
  };
  writeFileSync(join(home, ".claude.json"), `${JSON.stringify(claudeJson, null, 2)}\n`);
  app = await launchApp(sandbox, {}, ["--open-agent-setup"]);
  await waitForManagedSnapshot(app);

  const window = await app.firstWindow({ timeout: 45_000 });
  const text = await pageText(window);
  await expectTabShown(window, "agent");
  const marker = await markPage(window);
  const card = window.locator('[data-agent="claude-code"]');
  await expect(card).toContainText(text.agentsUseOtherDatabase);
  // Not offered for take-over, and the database is named the way the page names paths.
  await expect(window.locator('[data-id="preview-adopt"]')).toHaveCount(0);
  expect(await card.innerText()).not.toContain(sandbox.home);
  const before = readFileSync(join(home, ".claude.json"), "utf8");

  await window.locator('[data-id="use-database-claude-code"]').click();
  // Main selects the Data tab in the same window: the page is not navigated or reloaded, so the candidate is shown once
  // main has previewed it and the tab changed.
  await waitForSnapshot(app, (state) => state.repairWindowOpen && state.tab === "data");
  await expectTabShown(window, "data");
  const shown = maskHome(otherDatabase, home, process.platform);
  await expect(window.locator(".path", { hasText: shown })).toBeVisible({ timeout: 30_000 });
  expect(await pageMarker(window)).toBe(marker);
  expect(await windowCount(app)).toBe(1);
  const repair = (await window.evaluate(() =>
    (
      globalThis as unknown as { workIntelligenceRepair: { getState(): Promise<unknown> } }
    ).workIntelligenceRepair.getState(),
  )) as { database: { display: string | null }; candidates: { display: string; status: string }[] };
  expect(repair.candidates.map((candidate) => [candidate.display, candidate.status])).toContainEqual([shown, "ok"]);
  // Nothing switched and the Agent file is untouched: switching still needs the user's confirm.
  expect(repair.database.display).toBe(maskHome(sandbox.databasePath, home, process.platform));
  expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before);
});

test("a second launch with --open-agent-setup shows the Agent page in the running App", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox, {}, ["--background"]);
  await waitForManagedSnapshot(app);
  expect((await readSnapshot(app)).repairWindowOpen).toBe(false);

  const second = await runToExit(sandbox, {}, 20_000, ["--open-agent-setup"]);
  expect(second.code).toBe(0);
  const shown = await waitForSnapshot(app, (state) => state.repairWindowOpen && state.tab === "agent");
  expect(shown.backend).not.toBeNull();
  const window = await app.firstWindow({ timeout: 45_000 });
  await expectTabShown(window, "agent");
  expect(await windowCount(app)).toBe(1);
});
