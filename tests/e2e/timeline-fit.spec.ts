import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { textIn } from "./helpers/i18n.js";

let root = "";

async function expectFitted(viewport: Locator): Promise<void> {
  await expect(viewport).toBeVisible();
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeLessThanOrEqual(1);
}

test.beforeAll(async ({ request }) => {
  root = mkdtempSync(join(tmpdir(), "timeline-fit-fictional-"));
  const response = await request.post("/api/projects", { data: { name: "Timeline Orchard", rootPath: root } });
  expect(response.ok()).toBe(true);
  const project = await response.json();
  expect((await request.patch(`/api/projects/${project.id}`, { data: { status: "tracked" } })).ok()).toBe(true);
  expect(
    (
      await request.post("/api/work/finalize", {
        data: {
          projectRoot: root,
          idempotencyKey: `timeline-${root}`,
          title: "Fictional timeline work",
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
      test(`automatically fits timeline on mount, range, view and resize ${locale} ${theme} ${width} @cross-browser`, async ({
        page,
      }) => {
        await page.addInitScript(
          ({ locale, theme }) => {
            localStorage.setItem("work-intelligence:locale", locale);
            localStorage.setItem("work-intelligence:theme", theme);
          },
          { locale, theme },
        );
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/graph/timeline");
        const timeline = page.getByTestId("graph-timeline");
        const viewport = timeline.getByRole("region", {
          name: textIn(locale, "graph.timelineChartScrollsHorizontallyThe"),
        });
        if (width === 375) {
          await expect(timeline.getByTestId("timeline-list")).toBeVisible();
          await page.setViewportSize({ width: 960, height: 900 });
        }
        await expectFitted(viewport);
        const period = timeline.getByLabel(textIn(locale, "graph.chooseTimelinePeriod"));
        await period.selectOption("365");
        await expectFitted(viewport);
        await page.setViewportSize({ width: width === 1440 ? 960 : 1440, height: 900 });
        await expectFitted(viewport);
        await timeline.getByRole("button", { name: textIn(locale, "graph.zoomTimeline"), exact: true }).click();
        await expect
          .poll(() => viewport.evaluate((element) => element.scrollWidth - element.clientWidth))
          .toBeGreaterThan(100);
        const manualWidth = await viewport.locator("svg").getAttribute("width");
        await page.setViewportSize({ width: 1280, height: 900 });
        await expect(viewport.locator("svg")).toHaveAttribute("width", manualWidth ?? "");
        await timeline.getByRole("radio", { name: textIn(locale, "common.list"), exact: true }).click();
        await expect(timeline.getByTestId("timeline-list")).toBeVisible();
        await timeline.getByRole("radio", { name: textIn(locale, "common.diagram"), exact: true }).click();
        await expectFitted(viewport);
        await period.selectOption("7");
        await expectFitted(viewport);
        await page.reload();
        await expectFitted(viewport);
        expect((await new AxeBuilder({ page }).include('[data-testid="graph-timeline"]').analyze()).violations).toEqual(
          [],
        );
      });
    }
  }
}
