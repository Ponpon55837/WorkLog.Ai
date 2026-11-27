import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { saveKnowledgePageAfterReading, withAgentStore } from "./helpers/agent-store.js";
import { tt } from "./helpers/i18n.js";

type Fixture = { id: string; name: string; root: string; sourceTitles: string[] };

const NAME_PREFIX = "!Reading fixture";
const PAGE_TITLE = "Mooring notes";
const SECTION_TEXT = ["Tie the bow line first.", "Check the fenders."];
const SOURCE_COUNT = 5;

async function seedProject(request: APIRequestContext, label: string): Promise<Fixture> {
  const name = `${NAME_PREFIX} ${label}`;
  const root = mkdtempSync(join(tmpdir(), "knowledge-reading-fictional-"));
  const created = await request.post("/api/projects", { data: { name, rootPath: root } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };
  expect((await request.patch(`/api/projects/${id}`, { data: { status: "tracked" } })).ok()).toBeTruthy();

  const sourceIds: string[] = [];
  const sourceTitles: string[] = [];
  for (let index = 1; index <= SOURCE_COUNT; index += 1) {
    const title = `Fictional ${label} mooring source ${index}`;
    const finalized = await request.post("/api/work/finalize", {
      data: {
        projectRoot: root,
        idempotencyKey: `knowledge-reading-${id}-${index}`,
        title,
        summary: "Fictional mooring work.",
        // Older than every other spec's Sessions, so these never reach the top of shared lists.
        completedAt: "2024-01-15T00:00:00.000Z",
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed", summary: "Fictional browser verification." },
      },
    });
    expect(finalized.ok()).toBeTruthy();
    sourceIds.push(((await finalized.json()) as { session: { id: string } }).session.id);
    sourceTitles.push(title);
  }

  withAgentStore((store) => {
    store.requestKnowledgePageUpdate({
      projectRoot: root,
      slug: "mooring-notes",
      title: PAGE_TITLE,
      question: "How do we moor the boat?",
    });
    const saved = saveKnowledgePageAfterReading(store, {
      projectRoot: root,
      slug: "mooring-notes",
      idempotencyKey: `knowledge-reading-page-${id}`,
      sections: [
        {
          heading: "Routine",
          content: `${SECTION_TEXT[0]}\n${SECTION_TEXT[1]}\n- Coil the spare rope\n- Lock the hatch`,
          sourceSessionIds: sourceIds,
        },
      ],
    });
    expect(saved).toMatchObject({ outcome: "knowledge_page_saved" });
  });
  return { id, name, root, sourceTitles };
}

function pageRow(page: Page, label: string) {
  return page.getByTestId("knowledge-page-row").filter({ hasText: PAGE_TITLE }).filter({ hasText: label });
}

test.describe("Knowledge reading", () => {
  let harbor: Fixture;
  let orchard: Fixture;

  test.beforeAll(async ({ playwright }) => {
    const baseURL = `http://127.0.0.1:${process.env.WORK_INTELLIGENCE_E2E_WEB_PORT ?? process.env.WORK_INTELLIGENCE_E2E_API_PORT ?? 5967}`;
    const request = await playwright.request.newContext({ baseURL });
    harbor = await seedProject(request, "Harbor");
    orchard = await seedProject(request, "Orchard");
    await request.dispose();
  });

  test.afterAll(() => {
    const databasePath = process.env.WORK_INTELLIGENCE_E2E_DB;
    if (!databasePath) return;
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA foreign_keys = ON");
    try {
      db.prepare("DELETE FROM projects WHERE name LIKE ?").run(`${NAME_PREFIX}%`);
    } finally {
      db.close();
    }
  });

  test("groups same-named pages under their project and leaves the project out of the meta line", async ({ page }) => {
    await page.goto("/knowledge/pages");
    const rows = page.getByTestId("knowledge-page-row").filter({ hasText: PAGE_TITLE });
    await expect(rows).toHaveCount(2);

    const harborLabel = await page.getByText(harbor.name).boundingBox();
    const orchardLabel = await page.getByText(orchard.name).boundingBox();
    const [first, second] = await Promise.all([rows.nth(0).boundingBox(), rows.nth(1).boundingBox()]);
    expect(harborLabel!.y).toBeLessThan(first!.y);
    expect(first!.y).toBeLessThan(orchardLabel!.y);
    expect(orchardLabel!.y).toBeLessThan(second!.y);
    await expect(rows.nth(0)).not.toContainText(harbor.name);
  });

  test("opens the page from its title, with the project, by mouse and keyboard", async ({ page }) => {
    await page.goto("/knowledge/pages");
    const title = page.getByTestId("knowledge-page-row").filter({ hasText: PAGE_TITLE }).first().getByRole("button", {
      name: PAGE_TITLE,
      exact: true,
    });
    await title.click();
    const panel = page.getByRole("dialog", { name: tt("common.knowledgePages") });
    await expect(panel).toContainText(SECTION_TEXT[0]!);
    await expect(panel).toContainText(harbor.name);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    await title.focus();
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
  });

  test("shows a page's lines as separate paragraphs and list items", async ({ page }) => {
    await page.goto(`/knowledge/pages?project=${harbor.id}`);
    await pageRow(page, "").getByRole("button", { name: PAGE_TITLE, exact: true }).click();
    const panel = page.getByRole("dialog", { name: tt("common.knowledgePages") });

    await expect(panel.getByText(SECTION_TEXT[0]!, { exact: true })).toBeVisible();
    await expect(panel.getByText(SECTION_TEXT[1]!, { exact: true })).toBeVisible();
    await expect(panel.getByRole("listitem").filter({ hasText: "Coil the spare rope" })).toBeVisible();
    const paragraph = await panel.getByText(SECTION_TEXT[0]!, { exact: true }).boundingBox();
    expect(paragraph!.width).toBeLessThanOrEqual(72 * 16);
  });

  test("collapses a long source list to three and expands or hides it on demand", async ({ page }) => {
    await page.goto(`/knowledge/pages?project=${harbor.id}`);
    await pageRow(page, "").getByRole("button", { name: PAGE_TITLE, exact: true }).click();
    const panel = page.getByRole("dialog", { name: tt("common.knowledgePages") });
    const summary = panel.getByText(tt("knowledge.sourcesCount", { count: SOURCE_COUNT }), { exact: true });
    const source = (index: number) => panel.getByRole("button", { name: harbor.sourceTitles[index]! });
    const toggle = panel.getByRole("button", { name: tt("knowledge.showAllSources", { count: SOURCE_COUNT }) });

    await expect(summary).toBeVisible();
    await expect(source(2)).toBeVisible();
    await expect(source(3)).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();
    await expect(source(4)).toBeVisible();
    const fewer = panel.getByRole("button", { name: tt("knowledge.showFewerSources", { count: 3 }) });
    await expect(fewer).toHaveAttribute("aria-expanded", "true");

    await summary.click();
    await expect(source(0)).toBeHidden();
    await summary.click();
    await expect(source(0)).toBeVisible();
    await source(0).click();
    await expect(page.getByRole("dialog", { name: tt("session.sessionDetails") })).toContainText(
      harbor.sourceTitles[0]!,
    );
  });

  test("keeps tags and applies-to paths inside the row until it is expanded", async ({ page }) => {
    const title = `Fictional mooring habit ${harbor.id.slice(0, 6)}`;
    withAgentStore((store) => {
      const recorded = store.recordKnowledge({
        projectRoot: harbor.root,
        idempotencyKey: `knowledge-reading-item-${harbor.id}`,
        kind: "pattern",
        title,
        body: "Coil the spare rope on the port side before leaving the pier and lock the hatch.",
        tags: ["mooring"],
        appliesTo: ["docks/pier-*.md"],
      });
      expect(recorded.outcome).toBe("knowledge_recorded");
    });

    await page.goto(`/knowledge/list?q=${encodeURIComponent(title)}`);
    const row = page.getByTestId("knowledge-row").filter({ hasText: title });
    const toggle = row.getByRole("button", { name: tt("knowledge.showDetails") });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText("#mooring");
    await expect(row).not.toContainText("docks/pier-*.md");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(row).toContainText("#mooring");
    await expect(row).toContainText(tt("knowledge.appliesTo", { pattern: "docks/pier-*.md" }));
    const collapse = row.getByRole("button", { name: tt("knowledge.collapse") });
    await expect(collapse).toHaveAttribute("aria-expanded", "true");

    await collapse.click();
    await expect(row).not.toContainText("#mooring");
  });

  test("creates a custom page in a project chosen inside the dialog", async ({ page, request }) => {
    await page.goto("/knowledge/pages");
    const create = page.getByRole("button", { name: tt("knowledge.customKnowledgePage") });
    await expect(create).toBeEnabled();
    await create.click();
    const dialog = page.getByRole("dialog", { name: tt("knowledge.customKnowledgePage") });
    const projectSelect = dialog.getByLabel(tt("knowledge.createInProject"));
    await expect(projectSelect).toHaveValue("");

    await dialog.getByLabel(tt("knowledge.title"), { exact: true }).fill("Fictional night watch");
    await dialog.getByLabel(tt("knowledge.slug")).fill("night-watch");
    await dialog.getByLabel(tt("knowledge.theQuestionThisPageAnswers")).fill("Who keeps watch at night?");
    await dialog.getByRole("button", { name: tt("knowledge.createAndRequestWriting") }).click();
    await expect(dialog.getByRole("alert")).toHaveText(tt("outstanding.chooseAProjectFirst"));

    await projectSelect.selectOption(orchard.id);
    await dialog.getByRole("button", { name: tt("knowledge.createAndRequestWriting") }).click();
    await expect(dialog).toBeHidden();
    const listed = await request.get("/api/knowledge-pages", { params: { projectRoot: orchard.root } });
    expect(JSON.stringify(await listed.json())).toContain("night-watch");
  });
});
