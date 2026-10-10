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
        await page.evaluate(() =>
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: () => Promise.reject(new Error("Fictional clipboard denial")) },
          }),
        );
        await box.getByRole("button", { name: textIn(locale, "reportCopy.presentation"), exact: true }).click();
        const copyDialog = page.getByRole("dialog", { name: textIn(locale, "reportCopy.presentation"), exact: true });
        const preview = copyDialog.getByRole("textbox", { name: textIn(locale, "reportCopy.preview"), exact: true });
        await expect(preview).toHaveValue(/Manually revised fictional outcome/);
        await expect(preview).toHaveAttribute("readonly", "");
        await copyDialog.getByRole("button", { name: textIn(locale, "ui.copy"), exact: true }).click();
        await expect(copyDialog).toContainText(textIn(locale, "reportCopy.fallback"));
        await expect(
          copyDialog.getByRole("button", { name: textIn(locale, "reportCopy.copied"), exact: true }),
        ).toHaveCount(0);
        await page.evaluate(() =>
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: (text: string) => {
                Reflect.set(window, "fictionalClipboard", text);
                return Promise.resolve();
              },
            },
          }),
        );
        await copyDialog.getByRole("button", { name: textIn(locale, "ui.copy"), exact: true }).click();
        await expect(
          copyDialog.getByRole("button", { name: textIn(locale, "reportCopy.copied"), exact: true }),
        ).toBeVisible();
        expect(await page.evaluate(() => Reflect.get(window, "fictionalClipboard"))).toBe(await preview.inputValue());
        // Keep the copied action hovered during axe: moving labels must not hide contrast regressions.
        await copyDialog.getByRole("button", { name: textIn(locale, "reportCopy.copied"), exact: true }).hover();
        expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath("copy-preview.png") });
        await copyDialog.getByRole("button", { name: textIn(locale, "common.cancel"), exact: true }).click();
        await expect(copyDialog).toBeHidden();
        await page.getByRole("button", { name: textIn(locale, "reportCopy.basic"), exact: true }).click();
        const basicDialog = page.getByRole("dialog", { name: textIn(locale, "reportCopy.basic"), exact: true });
        await expect(
          basicDialog.getByRole("textbox", { name: textIn(locale, "reportCopy.preview"), exact: true }),
        ).toHaveValue(/2026-09/);
        const downloadEvent = page.waitForEvent("download");
        await basicDialog
          .getByRole("button", { name: textIn(locale, "reports.downloadMarkdown"), exact: true })
          .click();
        expect((await downloadEvent).suggestedFilename()).toMatch(/\.md$/);
        await basicDialog.getByRole("button", { name: textIn(locale, "common.cancel"), exact: true }).click();
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

test("copy preview keeps source failures distinct from empty content @cross-browser", async ({ page }) => {
  await page.goto(`/reports?period=week&date=2026-09-10&project=${projectId}`);
  const box = page.getByTestId("synthesis-presentation");
  await expect(
    box.getByRole("button", { name: textIn("zh-TW", "reportCopy.presentation"), exact: true }),
  ).toBeVisible();
  await page.route("**/presentation/export?**", (route) =>
    route.fulfill({ status: 404, json: { code: "not_found", error: "Fictional source unavailable" } }),
  );
  await box.getByRole("button", { name: textIn("zh-TW", "reportCopy.presentation"), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: textIn("zh-TW", "reportCopy.presentation"), exact: true });
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: textIn("zh-TW", "ui.copy"), exact: true })).toHaveCount(0);
});

test("basic copy stays available while the loaded report refreshes @cross-browser", async ({ page }) => {
  await page.goto(`/reports?period=week&date=2026-09-07&project=${projectId}`);
  const basic = page.getByRole("button", { name: textIn("zh-TW", "reportCopy.basic"), exact: true });
  await expect(basic).toBeEnabled();
  await page.route("**/api/reports?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
  const pending = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/reports");
  await page.getByRole("button", { name: textIn("zh-TW", "reports.refreshReport"), exact: true }).click();
  await pending;
  await expect(basic).toBeEnabled();
  await basic.click();
  const preview = page.getByRole("dialog", { name: textIn("zh-TW", "reportCopy.basic"), exact: true });
  await expect(preview.getByRole("textbox", { name: textIn("zh-TW", "reportCopy.preview"), exact: true })).toHaveValue(
    /2026-09/,
  );
  await page.unrouteAll({ behavior: "wait" });
});
