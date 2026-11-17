import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { WorkIntelligenceStore } from "../../packages/storage/dist/index.js";
import { tt, ttPattern } from "./helpers/i18n.js";

const MIB = 1024 * 1024;
// The Web UI used to refuse anything over 50 MiB; the file below is larger than that and stays under the 256 MiB cap.
const OLD_UI_LIMIT_BYTES = 50 * MIB;
const SESSION_COUNT = 56;
const SUMMARY_BYTES = MIB;
const projectName = `Large Import Fixture ${process.pid}`;

/** Builds a synthetic project export (one project, many Sessions with long synthetic summaries) as JSON text. */
function writeLargeExport(directory: string, projectRoot: string): { filePath: string; projectId: string } {
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
    return { filePath, projectId: project.id };
  } finally {
    fixture.close();
  }
}

test.describe("large project import", () => {
  test("imports an export over the old 50 MiB limit through the staged upload", async ({ page, request }) => {
    test.setTimeout(240_000);
    const directory = mkdtempSync(join(tmpdir(), "work-intelligence-e2e-large-import-"));
    const projectRoot = mkdtempSync(join(directory, "project-"));
    const { filePath, projectId } = writeLargeExport(directory, projectRoot);
    try {
      expect(statSync(filePath).size).toBeGreaterThan(OLD_UI_LIMIT_BYTES);

      await page.goto("/projects/backup");
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

      await page.goto("/projects");
      await expect(page.getByText(projectName).first()).toBeVisible();
    } finally {
      // Remove the fixture so later specs see the database they expect.
      await request
        .delete(`/api/projects/${projectId}`, { data: { confirmationName: projectName } })
        .catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
