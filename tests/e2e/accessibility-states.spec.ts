import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { LANGUAGE_NAMES, textIn, type Locale, type MessageKey } from "./helpers/i18n.js";

// Unique per module load: a failed test restarts the worker and re-runs beforeAll against the same server, so fixed
// names would be seeded twice and role locators would match several elements.
const runId = randomUUID().slice(0, 8);
const projectName = `Accessibility States Orchard ${runId}`;
const sessionTitle = `Accessibility states fictional pruning work ${runId}`;
const knowledgeTitle = `Accessibility states fictional rule ${runId}`;
const locales: readonly Locale[] = ["zh-TW", "en-US"];
const pages: ReadonlyArray<readonly [string, MessageKey]> = [
  ["/dashboard", "nav.workOverview"],
  ["/sessions", "common.workHistory"],
  ["/knowledge", "common.workKnowledge"],
  ["/reports", "nav.workReports"],
  ["/graph", "nav.workGraph"],
  ["/projects", "common.project"],
  ["/system-status", "nav.systemStatus"],
];

let root = "";
let sessionId = "";

/** Every critical or serious axe violation on the current page, formatted like the page-level scans. */
async function seriousViolations(page: Page, label: string): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const failures: string[] = [];
  for (const violation of violations) {
    if (violation.impact !== "critical" && violation.impact !== "serious") continue;

    const selectors = violation.nodes.map((node) => node.target.join(" ")).join("; ");
    failures.push(`${label}: ${violation.id} — ${violation.help}${selectors ? ` (${selectors})` : ""}`);
  }
  return failures;
}

async function expectNoSeriousViolations(page: Page, label: string): Promise<void> {
  const failures = await seriousViolations(page, label);
  expect(failures, `axe found critical or serious accessibility issues:\n${failures.join("\n")}`).toEqual([]);
}

async function useLocale(page: Page, locale: Locale): Promise<void> {
  await page.addInitScript((value) => {
    window.localStorage.setItem("work-intelligence:locale", value);
    window.localStorage.setItem("work-intelligence:theme", "dark");
  }, locale);
}

test.beforeAll(async ({ request }) => {
  root = mkdtempSync(join(tmpdir(), "a11y-states-fictional-"));
  const project = await request.post("/api/projects", { data: { name: projectName, rootPath: root } });
  expect(project.ok()).toBeTruthy();
  const projectId = ((await project.json()) as { id: string }).id;
  expect((await request.patch(`/api/projects/${projectId}`, { data: { status: "tracked" } })).ok()).toBeTruthy();

  const knowledge = await request.post("/api/knowledge", {
    data: {
      projectRoot: root,
      idempotencyKey: `a11y-states-knowledge-${root}`,
      kind: "gotcha",
      title: knowledgeTitle,
      body: "Prune the fictional orchard before the first frost.",
      appliesTo: ["src/orchard.ts"],
    },
  });
  expect(knowledge.ok()).toBeTruthy();

  for (const [index, title] of [sessionTitle, `Accessibility states fictional irrigation work ${runId}`].entries()) {
    const finalized = await request.post("/api/work/finalize", {
      data: {
        projectRoot: root,
        idempotencyKey: `a11y-states-session-${root}-${index}`,
        title,
        summary: "Fictional evidence for the accessibility state scans.",
        changedFiles: ["src/orchard.ts", "src/irrigation/schedule.ts", "docs/orchard-notes.md"],
        verification: { status: "passed", summary: "Fictional checks passed." },
        workSummary: {
          outcomes: ["The fictional orchard is pruned."],
          scope: ["Orchard scheduling."],
          decisions: ["Keep the schedule in one module."],
          verification: ["Fictional checks passed."],
          nextSteps: ["Plan the next fictional harvest."],
        },
      },
    });
    expect(finalized.ok()).toBeTruthy();
    if (index === 0) sessionId = ((await finalized.json()) as { session: { id: string } }).session.id;
  }
});

test.afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("has no critical or serious axe violations on primary pages in English @accessibility", async ({ page }) => {
  test.setTimeout(90_000);
  await useLocale(page, "en-US");
  const failures: string[] = [];

  for (const [path, heading] of pages) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: textIn("en-US", heading) }).first()).toBeVisible();
    failures.push(...(await seriousViolations(page, `en-US ${path}`)));
  }

  expect(failures, `axe found critical or serious accessibility issues:\n${failures.join("\n")}`).toEqual([]);
});

for (const locale of locales) {
  test.describe(`interactive states in ${locale}`, () => {
    test.beforeEach(async ({ page }) => {
      await useLocale(page, locale);
    });

    test(`has no critical or serious axe violations in the command palette ${locale} @accessibility`, async ({
      page,
    }) => {
      await page.goto("/dashboard");
      const searchName = textIn(locale, "layout.searchSessionsKnowledgeOrJump");
      await page.getByRole("button", { name: searchName }).click();
      // Scoped to the palette dialog: the Sessions "per page" select is a combobox too.
      const palette = page.getByRole("dialog", { name: textIn(locale, "common.searchOrJumpToA") });
      const input = palette.getByRole("combobox");
      await expect(input).toBeVisible();
      await expectNoSeriousViolations(page, `${locale} palette open`);

      await input.fill("Accessibility states");
      await expect(page.getByRole("option").first()).toBeVisible();
      await expectNoSeriousViolations(page, `${locale} palette with results`);

      await page.keyboard.press("Escape");
      await expect(input).toBeHidden();
      await page.keyboard.press("ControlOrMeta+k");
      await expect(input).toBeVisible();
      await expectNoSeriousViolations(page, `${locale} palette opened by keyboard`);
    });

    test(`has no critical or serious axe violations in the Session side panel ${locale} @accessibility`, async ({
      page,
    }) => {
      await page.goto(`/sessions?session=${sessionId}`);
      const panel = page.getByRole("dialog", { name: textIn(locale, "session.sessionDetails") });
      await expect(panel).toBeVisible();
      await expect(panel.getByText(sessionTitle).first()).toBeVisible();
      await expect(panel.getByText("src/irrigation/schedule.ts").first()).toBeVisible();
      await expectNoSeriousViolations(page, `${locale} Session side panel`);
    });

    test(`has no critical or serious axe violations in the Session editor dialog ${locale} @accessibility`, async ({
      page,
    }) => {
      await page.goto(`/sessions?session=${sessionId}`);
      await page.getByRole("button", { name: textIn(locale, "session.editSession") }).click();
      const close = page.getByRole("button", { name: textIn(locale, "ui.closeDialog") });
      await expect(close).toBeVisible();
      await expectNoSeriousViolations(page, `${locale} Session editor dialog`);
      await close.click();
      await expect(close).toBeHidden();
    });

    test(`has no critical or serious axe violations in the Knowledge editor dialog ${locale} @accessibility`, async ({
      page,
    }) => {
      await page.goto("/knowledge");
      const row = page.getByTestId("knowledge-row").filter({ hasText: knowledgeTitle }).first();
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: textIn(locale, "knowledge.more") }).click();
      await page.getByRole("menuitem", { name: textIn(locale, "knowledge.edit") }).click();
      const dialog = page.getByRole("dialog", { name: textIn(locale, "knowledge.editKnowledge") });
      await expect(dialog).toBeVisible();
      await expectNoSeriousViolations(page, `${locale} Knowledge editor dialog`);
      await dialog.getByRole("button", { name: textIn(locale, "ui.closeDialog") }).click();
      await expect(dialog).toBeHidden();
    });

    test(`has no critical or serious axe violations in the delete-project dialog ${locale} @accessibility`, async ({
      page,
    }) => {
      await page.goto("/projects");
      const trigger = page.getByRole("button", {
        name: textIn(locale, "projects.permanentlyDelete", { name: projectName }),
        exact: true,
      });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: textIn(locale, "projects.permanentlyDeleteProjectData") });
      await expect(dialog).toBeVisible();
      await expectNoSeriousViolations(page, `${locale} delete-project dialog`);
      // Never confirm the destructive action; cancel closes it.
      await dialog.getByRole("button", { name: textIn(locale, "common.cancel") }).click();
      await expect(dialog).toBeHidden();
    });

    test(`has no critical or serious axe violations in open menus ${locale} @accessibility`, async ({ page }) => {
      await page.goto("/dashboard");
      await page.getByRole("banner").getByRole("button", { name: LANGUAGE_NAMES[locale] }).click();
      await expect(page.getByRole("menuitemradio").first()).toBeVisible();
      await expectNoSeriousViolations(page, `${locale} language menu`);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menuitemradio").first()).toBeHidden();

      await page.goto("/sessions");
      const filters = page.getByRole("main");
      await filters.getByRole("button", { name: textIn(locale, "common.project") }).click();
      await expect(page.getByRole("menuitemradio").first()).toBeVisible();
      await expectNoSeriousViolations(page, `${locale} Sessions project filter menu`);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menuitemradio").first()).toBeHidden();

      await filters.locator('button[aria-haspopup="dialog"]').click();
      await expect(page.getByRole("button", { name: textIn(locale, "ui.previousMonth") })).toBeVisible();
      await expectNoSeriousViolations(page, `${locale} Sessions date range menu`);
      await page.keyboard.press("Escape");

      await page.goto("/reports");
      await page.getByTestId("report-period-date-control").getByRole("button").click();
      await expect(page.getByRole("button", { name: textIn(locale, "ui.previousMonth") })).toBeVisible();
      await expectNoSeriousViolations(page, `${locale} Reports date menu`);
    });

    test(`has no critical or serious axe violations in the mobile sidebar drawer ${locale} @accessibility`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto("/dashboard");
      await page.getByRole("button", { name: textIn(locale, "layout.openMainMenu") }).click();
      const navigation = page.getByRole("navigation", { name: textIn(locale, "layout.mainMenu") });
      await expect(navigation).toBeVisible();
      await expectNoSeriousViolations(page, `${locale} mobile sidebar drawer`);
    });
  });
}
