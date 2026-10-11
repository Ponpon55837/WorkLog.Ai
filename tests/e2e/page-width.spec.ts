import { expect, test } from "@playwright/test";
import { textIn } from "./helpers/i18n.js";

const destinations = ["sessions", "reports", "knowledge", "projects", "system-status", "dashboard"] as const;

for (const locale of ["zh-TW", "en-US"] as const) {
  for (const theme of ["dark", "light"] as const) {
    for (const width of [1920, 1440, 960, 375]) {
      test(`page widths stay aligned during navigation ${locale} ${theme} ${width} @cross-browser`, async ({
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
        await page.goto("/graph");
        await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
        const main = page.getByRole("main");
        const dimensions = () =>
          main.evaluate((element) => {
            const content = element.firstElementChild!;
            const bounds = content.getBoundingClientRect();
            return {
              x: bounds.x,
              right: bounds.right,
              width: bounds.width,
              available: element.clientWidth,
              overflow: element.scrollWidth - element.clientWidth,
            };
          });
        const graph = await dimensions();
        expect(Math.abs(graph.width - graph.available)).toBeLessThanOrEqual(1);
        if (width === 1920) expect(graph.width).toBeGreaterThan(1280);
        for (const destination of destinations) {
          for (const name of [destination, "graph"]) {
            if (width < 640) await page.getByRole("button", { name: textIn(locale, "layout.openMainMenu") }).click();
            await page.getByTestId(`nav-${name}`).click();
            await expect(page).toHaveURL(new RegExp(`/${name}(?:/|$)`));
            await expect(page.getByTestId("page-view")).toHaveAttribute("data-page", name);
            await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
            await expect
              .poll(async () => {
                const current = await dimensions();
                return Math.max(
                  Math.abs(current.x - graph.x),
                  Math.abs(current.right - graph.right),
                  Math.abs(current.width - current.available),
                );
              })
              .toBeLessThanOrEqual(1);
            expect((await dimensions()).overflow).toBeLessThanOrEqual(1);
          }
        }
        await page.screenshot({ path: testInfo.outputPath("aligned-page-width.png") });
      });
    }
  }
}
