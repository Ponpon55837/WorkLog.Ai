import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { textIn } from "./helpers/i18n.js";

let root = "";
let projectId = "";
let summaryId = "";
test.beforeAll(async ({ request }) => {
  root = mkdtempSync(join(tmpdir(), "wi-e2e-presentation-"));
  const project = await (
    await request.post("/api/projects", { data: { name: "Fictional report presentation", rootPath: root } })
  ).json();
  projectId = project.id;
  await request.patch(`/api/projects/${projectId}`, { data: { status: "tracked" } });
  const source = (
    await (
      await request.post("/api/work/finalize", {
        data: {
          projectRoot: root,
          idempotencyKey: `presentation-source-${root}`,
          title: "Fictional source",
          summary: "Fictional completed work.",
          completedAt: "2026-09-10T12:00:00Z",
          changedFiles: [],
          verification: { status: "passed" },
        },
      })
    ).json()
  ).session;
  const created = (
    await (
      await request.post("/api/reports/synthesis-requests", { data: { period: "week", date: "2026-09-10", projectId } })
    ).json()
  ).request;
  await request.get(`/api/reports/synthesis-requests/${created.id}/context`);
  const block = {
    title: "Fictional report block with a long descriptive title",
    detail: "Original fictional evidence. <script>fixture</script>",
    sourceSessionIds: [source.id],
  };
  const result = await request.post("/api/reports/summaries", {
    data: {
      requestId: created.id,
      title: "Fictional weekly report",
      executiveSummary: "Original executive summary.",
      themes: [block],
      highlights: [block],
      verification: [block],
      risks: [block],
      decisions: [],
      nextSteps: [],
      sourceSessionIds: [source.id],
      generatedByAgent: "fixture",
      promptVersion: "fixture-v1",
    },
  });
  expect(result.ok()).toBeTruthy();
  summaryId = (await result.json()).summary.id;
});
test.afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
for (const locale of ["zh-TW", "en-US"] as const)
  for (const theme of ["dark", "light"] as const)
    for (const width of [1440, 960, 375]) {
      test(`report projection and editor ${locale} ${theme} ${width} @cross-browser`, async ({
        page,
        request,
      }, testInfo) => {
        const current = await (await request.get(`/api/reports/summaries/${summaryId}/presentation`)).json();
        await request.patch(`/api/reports/summaries/${summaryId}/presentation`, {
          data: { expectedRevision: current.revision, state: { pinned: [], hidden: [], overrides: [] } },
        });
        await page.addInitScript(
          ({ locale, theme }) => {
            localStorage.setItem("work-intelligence:locale", locale);
            localStorage.setItem("work-intelligence:theme", theme);
          },
          { locale, theme },
        );
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/reports?period=week&date=2026-09-10&project=${projectId}`);
        const box = page.getByTestId("synthesis-presentation");
        await expect(box.getByTestId("synthesis-block")).toHaveCount(4);
        const highlights = box.locator('[data-section="highlights"]');
        await highlights.getByRole("button", { name: textIn(locale, "presentation.actions"), exact: true }).click();
        await page.getByRole("menuitem", { name: textIn(locale, "presentation.pin"), exact: true }).click();
        await expect(box.getByTestId("synthesis-block").first()).toHaveAttribute("data-section", "highlights");
        await highlights.getByRole("button", { name: textIn(locale, "presentation.actions"), exact: true }).click();
        await page.getByRole("menuitem", { name: textIn(locale, "presentation.unpin"), exact: true }).click();
        await expect(box.getByTestId("synthesis-block").first()).toHaveAttribute("data-section", "themes");
        await highlights.getByRole("button", { name: textIn(locale, "presentation.actions"), exact: true }).click();
        await page.getByRole("menuitem", { name: textIn(locale, "presentation.hide"), exact: true }).click();
        await expect(box.getByTestId("synthesis-block")).toHaveCount(3);
        await box
          .getByRole("button", {
            name: textIn(locale, "presentation.restore", { title: textIn(locale, "reports.keyOutcomes") }),
            exact: true,
          })
          .click();
        await expect(highlights).toBeVisible();
        await highlights
          .getByRole("button", {
            name: textIn(locale, "presentation.edit", {
              title: "Fictional report block with a long descriptive title",
            }),
            exact: true,
          })
          .click();
        const dialog = page.getByRole("dialog", { name: textIn(locale, "presentation.editTitle"), exact: true });
        await dialog
          .getByRole("textbox", { name: textIn(locale, "presentation.blockTitle"), exact: true })
          .fill("Manually revised fictional outcome");
        await dialog.getByRole("button", { name: textIn(locale, "common.saveChanges"), exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(highlights).toContainText("Manually revised fictional outcome");
        await expect(highlights).toContainText(textIn(locale, "presentation.edited"));
        expect(
          (await new AxeBuilder({ page }).include('[data-testid="synthesis-presentation"]').analyze()).violations,
        ).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await box.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("presentation.png") });
      });
    }
test("keeps draft on 409 and requires an explicit comparison before applying @cross-browser", async ({
  page,
  request,
}) => {
  await page.goto(`/reports?period=week&date=2026-09-10&project=${projectId}`);
  const box = page.getByTestId("synthesis-presentation");
  await expect(box.getByTestId("synthesis-block")).toHaveCount(4);
  await box
    .getByRole("button", {
      name: textIn("zh-TW", "presentation.edit", { title: "Fictional report block with a long descriptive title" }),
      exact: true,
    })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: textIn("zh-TW", "presentation.editTitle"), exact: true });
  await dialog
    .getByRole("textbox", { name: textIn("zh-TW", "presentation.blockTitle"), exact: true })
    .fill("Preserved draft");
  const current = await (await request.get(`/api/reports/summaries/${summaryId}/presentation`)).json();
  await request.patch(`/api/reports/summaries/${summaryId}/presentation`, {
    data: { expectedRevision: current.revision, state: { ...current.state, pinned: ["risks"] } },
  });
  await dialog.getByRole("button", { name: textIn("zh-TW", "common.saveChanges"), exact: true }).click();
  await expect(dialog).toContainText(textIn("zh-TW", "presentation.conflict"));
  await expect(
    dialog.getByRole("textbox", { name: textIn("zh-TW", "presentation.blockTitle"), exact: true }),
  ).toHaveValue("Preserved draft");
  await dialog.getByRole("button", { name: textIn("zh-TW", "presentation.latest"), exact: true }).click();
  await dialog.getByRole("button", { name: textIn("zh-TW", "presentation.applyLatest"), exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(box).toContainText("Preserved draft");
});
