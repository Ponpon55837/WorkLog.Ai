import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { textIn } from "./helpers/i18n.js";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

for (const locale of ["zh-TW", "en-US"] as const)
  for (const theme of ["dark", "light"] as const)
    for (const width of [1440, 960, 375]) {
      test(`weekly insights ${locale} ${theme} ${width} @cross-browser`, async ({ page }, testInfo) => {
        await page.addInitScript(
          ({ locale, theme }) => {
            localStorage.setItem("work-intelligence:locale", locale);
            localStorage.setItem("work-intelligence:theme", theme);
          },
          { locale, theme },
        );
        await page.setViewportSize({ width, height: 900 });
        await page.route("**/api/reports?**", async (route) => {
          const base = await (await route.fetch()).json();
          await route.fulfill({
            json: {
              ...base,
              outcome: "report",
              range: { from: "2026-10-05", to: "2026-10-11" },
              timezone: "Asia/Taipei",
              totals: {
                ...base.totals,
                sessions: 500,
                verification: { passed: 489, failed: 1, in_progress: 10, not_run: 0, not_supplied: 0 },
              },
              comparison: { ...base.comparison, sessions: { current: 500, previous: 0, delta: 500, direction: "up" } },
              projects: [
                {
                  projectId: "fixture-alpha",
                  projectName: "A <script> & long project name",
                  sessionCount: 300,
                  eventCount: 0,
                  sourceSessionIds: [],
                },
              ],
              sessions: [],
              trends: [],
            },
          });
        });
        await page.goto("/");
        const box = page.getByTestId("dashboard-insights");
        await expect(box).toContainText("500");
        await expect(box).toContainText("60%");
        await expect(box).toContainText("Asia/Taipei");
        await expect(box).toContainText(textIn(locale, "insights.noPrevious"));
        await expect(box).toContainText(textIn(locale, "insights.failed", { count: 1 }));
        await expect(box.getByRole("link", { name: textIn(locale, "insights.projectReport") })).toHaveAttribute(
          "href",
          /period=week.*date=2026-10-05.*project=fixture-alpha/,
        );
        expect(
          (await new AxeBuilder({ page }).include('[data-testid="dashboard-insights"]').analyze()).violations,
        ).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await box.screenshot({ path: testInfo.outputPath("weekly-insights.png") });
      });
    }
test("weekly insights distinguish loading, failure and empty @cross-browser", async ({ page }) => {
  let mode = "loading";
  await page.route("**/api/reports?**", async (route) => {
    if (mode === "loading") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ status: 500, json: { error: "fixture", code: "internal_error" } });
    } else if (mode === "failure")
      await route.fulfill({ status: 500, json: { error: "fixture", code: "internal_error" } });
    else {
      const base = await (await route.fetch()).json();
      await route.fulfill({ json: { ...base, totals: { ...base.totals, sessions: 0 } } });
    }
  });
  await page.goto("/");
  const box = page.getByTestId("dashboard-insights");
  await expect(box).toContainText(textIn("zh-TW", "insights.loading"));
  await expect(box).toContainText(textIn("zh-TW", "insights.failedToLoad"));
  await expect(box).not.toContainText(textIn("zh-TW", "insights.empty"));
  mode = "empty";
  await box.getByRole("button", { name: textIn("zh-TW", "common.retry") }).click();
  await expect(box).toContainText(textIn("zh-TW", "insights.empty"));
});
