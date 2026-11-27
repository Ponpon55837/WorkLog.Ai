import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { expect, test } from "@playwright/test";
import { WorkIntelligenceStore } from "../../packages/storage/dist/index.js";
import { tt, ttPattern } from "./helpers/i18n.js";

const MIB = 1024 * 1024;
// The Web UI used to refuse anything over 50 MiB; the file below is larger than that and stays under the 256 MiB cap.
const OLD_UI_LIMIT_BYTES = 50 * MIB;
const SESSION_COUNT = 56;
const SUMMARY_BYTES = MIB;
const projectName = `Large Import Fixture ${process.pid}`;

// Runs its own API server and database: the import adds a project, and deleting it afterwards would leave a deletion audit other specs do not expect.
let server: ChildProcess | undefined;
let serverRoot = "";
let baseUrl = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The isolated API server exited with ${child.exitCode}.`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // Not listening yet; keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the isolated API server.");
}

test.beforeAll(async () => {
  serverRoot = mkdtempSync(join(tmpdir(), "work-intelligence-e2e-large-import-server-"));
  const home = join(serverRoot, "home");
  mkdirSync(home);
  const port = await freePort();
  server = spawn(process.execPath, ["tests/e2e/server.mjs"], {
    stdio: "ignore",
    env: {
      ...process.env,
      WORK_INTELLIGENCE_PORT: String(port),
      WORK_INTELLIGENCE_DB: join(serverRoot, "work-intelligence.sqlite"),
      WORK_INTELLIGENCE_BACKUP: "off",
      WORK_INTELLIGENCE_BACKUP_DIR: join(serverRoot, "backups"),
      WORK_INTELLIGENCE_ALLOWED_ORIGINS: "",
      WORK_INTELLIGENCE_CONFIG_DIR: join(home, ".work-intelligence"),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    },
  });
  baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, server);
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server?.once("exit", resolve));
    server.kill();
    await exited;
  }
  rmSync(serverRoot, { recursive: true, force: true });
});

function writeLargeExport(directory: string, projectRoot: string): string {
  const fixture = new WorkIntelligenceStore(":memory:");
  try {
    const project = fixture.addProject(projectName, projectRoot);
    fixture.updateProject(project.id, { status: "tracked" });
    const saved = fixture.finalizeSession({
      projectRoot,
      idempotencyKey: `large-import-source-${process.pid}`,
      title: "Large import source Session",
      summary: "Synthetic Session used to size the export.",
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (saved.outcome !== "finalized") throw new Error("Expected fixture Session");
    const bundle = fixture.exportProjectData({ type: "project", projectId: project.id });
    const template = bundle.tables.sessions[0];
    if (!template) throw new Error("Expected an exported Session");
    const filler = "Synthetic summary text for the large import check. "
      .repeat(Math.ceil(SUMMARY_BYTES / 51))
      .slice(0, SUMMARY_BYTES);
    bundle.tables.work_events = [];
    bundle.tables.sessions = Array.from({ length: SESSION_COUNT }, (_, index) => ({
      ...template,
      id: `large-import-session-${index}`,
      idempotency_key: `large-import-session-${index}`,
      title: `Large import Session ${index}`,
      summary: `${index} ${filler}`,
    }));
    const filePath = join(directory, "large-export.json");
    writeFileSync(filePath, JSON.stringify(bundle));
    return filePath;
  } finally {
    fixture.close();
  }
}

test.describe("large project import", () => {
  test("imports an export over the old 50 MiB limit through the staged upload", async ({ page }) => {
    test.setTimeout(240_000);
    const directory = mkdtempSync(join(tmpdir(), "work-intelligence-e2e-large-import-"));
    const projectRoot = mkdtempSync(join(directory, "project-"));
    const filePath = writeLargeExport(directory, projectRoot);
    try {
      expect(statSync(filePath).size).toBeGreaterThan(OLD_UI_LIMIT_BYTES);

      await page.goto(`${baseUrl}/projects/backup`);
      const backups = page.getByRole("tabpanel", { name: tt("projects.dataBackup") });
      await backups.getByLabel(tt("projects.importFile")).setInputFiles(filePath);

      const preview = backups.getByTestId("project-import-preview");
      await expect(preview).toBeVisible({ timeout: 120_000 });
      await expect(preview).toContainText(projectName);
      await expect(preview.getByTestId("project-import-additions")).toContainText(String(SESSION_COUNT + 1));

      await preview.getByRole("button", { name: tt("projects.confirmAndImport") }).click();
      const confirmation = page.getByRole("dialog", { name: tt("projects.confirmProjectDataImport") });
      await confirmation.getByRole("button", { name: tt("projects.import"), exact: true }).click();
      await expect(page.getByText(ttPattern("projects.importFinishedAddedSkippedIn"))).toBeVisible({
        timeout: 120_000,
      });

      await page.goto(`${baseUrl}/projects`);
      await expect(page.getByText(projectName).first()).toBeVisible();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
