import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { textIn } from "./helpers/i18n.js";

let root = "";
test.beforeAll(async ({ request }) => {
  root = mkdtempSync(join(tmpdir(), "dashboard-layout-fictional-"));
  const project = await (
    await request.post("/api/projects", { data: { name: "Activity Orchard", rootPath: root } })
  ).json();
  await request.patch(`/api/projects/${project.id}`, { data: { status: "tracked" } });
  expect(
    (
      await request.post("/api/work/finalize", {
        data: {
          projectRoot: root,
          idempotencyKey: `activity-${root}`,
          title: "Fictional activity",
          summary: "Saved fictional work",
          changedFiles: [],
          verification: { status: "passed" },
        },
      })
    ).ok(),
  ).toBe(true);
});
test.afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
for (const locale of ["zh-TW", "en-US"] as const) {
  for (const theme of ["dark", "light"] as const) {
    for (const width of [1440, 960, 375]) {
      test(`activity leads the overview ${locale} ${theme} ${width} @cross-browser`, async ({ page }, testInfo) => {
        await page.addInitScript(
          ({ locale, theme }) => {
            localStorage.setItem("work-intelligence:locale", locale);
            localStorage.setItem("work-intelligence:theme", theme);
          },
          { locale, theme },
        );
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/dashboard");
        const activity = page.getByTestId("dashboard-activity");
        const calendar = activity.getByRole("group", { name: textIn(locale, "dashboard.activityCalendarLabel") });
        await expect(calendar).toBeVisible();
        const bounds = await activity.boundingBox();
        const stats = await page.locator(".dashboard__stats").boundingBox();
        const insights = await page.getByTestId("dashboard-insights").boundingBox();
        const attention = await page.getByTestId("attention-box").boundingBox();
        expect(
          bounds &&
            stats &&
            insights &&
            attention &&
            bounds.y + bounds.height <= stats.y &&
            stats.y < insights.y &&
            insights.y < attention.y,
        ).toBe(true);
        expect(
          bounds &&
            bounds.y >= 0 &&
            bounds.y + bounds.height < 900 &&
            bounds.x >= 0 &&
            bounds.x + bounds.width <= width + 1,
        ).toBe(true);
        const content = await page
          .locator("#main")
          .evaluate((el) => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }));
        expect(content.scrollWidth).toBeLessThanOrEqual(content.width);
        expect(
          (await new AxeBuilder({ page }).include('[data-testid="dashboard-activity"]').analyze()).violations,
        ).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath("activity-first.png") });
        const day = calendar.locator('button[tabindex="0"]');
        const date = await day.getAttribute("data-date");
        await day.click();
        await expect(page).toHaveURL(new RegExp(`period=day.*date=${date}`));
      });
    }
  }
}
