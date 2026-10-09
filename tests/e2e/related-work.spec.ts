import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { textIn } from "./helpers/i18n.js";

let root = "";
let focus = "";
let candidate = "";
test.beforeAll(async ({ request }) => {
  root = mkdtempSync(join(tmpdir(), "related-fictional-"));
  const project = await request.post("/api/projects", { data: { name: "Related Orchard", rootPath: root } });
  const id = ((await project.json()) as { id: string }).id;
  expect((await request.patch(`/api/projects/${id}`, { data: { status: "tracked" } })).ok()).toBeTruthy();
  for (let i = 0; i < 8; i++) {
    const response = await request.post("/api/work/finalize", {
      data: {
        projectRoot: root,
        idempotencyKey: `related-${i}`,
        title: `Related fictional work ${i} with a deliberately long heading to check wrapping`,
        summary: "Fictional evidence.",
        changedFiles: ["src/very-long-directory/one.ts", "src/two.ts"],
        verification: { status: "passed" },
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      },
    });
    expect(response.ok()).toBeTruthy();
    const session = ((await response.json()) as { session: { id: string } }).session;
    if (i === 0) focus = session.id;
    candidate = session.id;
  }
});
test.afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
for (const locale of ["zh-TW", "en-US"] as const)
  for (const theme of ["dark", "light"] as const)
    for (const width of [1440, 960, 375]) {
      test(`related work offers five evidence links ${locale} ${theme} ${width} @cross-browser`, async ({
        page,
      }, testInfo) => {
        await page.addInitScript(
          ({ locale, theme }) => {
            localStorage.setItem("work-intelligence:locale", locale);
            localStorage.setItem("work-intelligence:theme", theme);
          },
          { locale, theme },
        );
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/sessions?session=${focus}`);
        const box = page.getByTestId("related-work");
        await box.scrollIntoViewIfNeeded();
        await expect(box.locator("li")).toHaveCount(5);
        await expect(box).toContainText(textIn(locale, "related.shared", { count: 2 }));
        await expect(box).toContainText("src/very-long-directory/one.ts");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).include('[data-testid="related-work"]').analyze()).violations).toEqual(
          [],
        );
        await page.screenshot({ path: testInfo.outputPath("related.png"), fullPage: false });
        const first = box.getByRole("button", { name: /Related fictional work/ }).first();
        await first.focus();
        await expect(first).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(new RegExp(candidate));
        await page.keyboard.press("Escape");
        await expect(page).not.toHaveURL(/session=/);
      });
    }
test("related work distinguishes loading, failure and partial empty coverage @cross-browser", async ({ page }) => {
  await page.route("**/api/sessions/*/related", (route) =>
    route.fulfill({ status: 503, json: { code: "service_unavailable" } }),
  );
  await page.goto(`/sessions?session=${focus}`);
  const box = page.getByTestId("related-work");
  await box.scrollIntoViewIfNeeded();
  await expect(box.getByRole("button", { name: textIn("zh-TW", "common.retry") })).toBeVisible();
  await expect(box).not.toContainText(textIn("zh-TW", "related.empty"));
  await page.unroute("**/api/sessions/*/related");
  await page.route("**/api/sessions/*/related", (route) =>
    route.fulfill({
      json: {
        outcome: "related_work",
        sessionId: focus,
        state: "ready",
        items: [],
        coverage: { partial: true, postingLimit: 1000, examined: 1000 },
      },
    }),
  );
  await box.getByRole("button", { name: textIn("zh-TW", "common.retry") }).click();
  await expect(box).toContainText(textIn("zh-TW", "related.partial"));
});
