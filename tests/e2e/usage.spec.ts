import { expect, test, type Page } from "@playwright/test";
import { textIn } from "./helpers/i18n.js";
import { USAGE_PROJECTS, usageScanFixture } from "./helpers/usage-fixture.js";

/** Serves synthetic usage data so the page does not read any real Agent log. */
async function mockUsage(page: Page, scan: "ok" | "error"): Promise<void> {
  await page.route("**/api/usage/projects", (route) => route.fulfill({ json: USAGE_PROJECTS }));
  await page.route("**/api/usage/scan", (route) =>
    scan === "ok"
      ? route.fulfill({ json: usageScanFixture() })
      : route.fulfill({ status: 500, json: { code: "usage_failed", error: "internal detail" } }),
  );
}

for (const width of [1440, 375]) {
  test(`usage page shows headline tokens, composition, trend, models and the 5-hour block at ${width}`, async ({
    page,
  }) => {
    await mockUsage(page, "ok");
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/usage");

    const summary = page.getByTestId("usage-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(textIn("zh-TW", "usage.summaryHeadline"));
    await expect(summary).toContainText("2.1M");
    await expect(summary).toContainText("38.4M");
    await expect(summary).not.toContainText(/費用|額度|成本/);

    const composition = page.getByTestId("usage-composition");
    await expect(composition).toContainText(textIn("zh-TW", "usage.compositionCounted"));
    await expect(composition).toContainText(textIn("zh-TW", "usage.compositionCache"));
    await expect(composition).toContainText(textIn("zh-TW", "usage.cacheReadMultiple", { multiple: "18.3" }));

    await expect(page.getByRole("img", { name: textIn("zh-TW", "usage.trendLabel") })).toBeVisible();
    const blocks = page.getByTestId("usage-blocks");
    await expect(blocks).toContainText(textIn("zh-TW", "usage.blockTimeLeft"));
    await expect(page.getByTestId("usage-models")).toContainText(textIn("zh-TW", "usage.modelUnlabelled"));
    await expect(page.getByTestId("usage-models").getByRole("row")).toHaveCount(4);
    await expect(page.getByTestId("usage-sessions").getByRole("row")).toHaveCount(3);

    // The page never scrolls sideways, even with the wide tables, and only <main> scrolls vertically.
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - window.innerWidth,
      y: document.documentElement.scrollHeight - window.innerHeight,
    }));
    expect(overflow.x).toBeLessThanOrEqual(0);
    expect(overflow.y).toBeLessThanOrEqual(0);

    if (width >= 1440) {
      await page.locator("main").evaluate((main) => main.scrollTo(0, main.scrollHeight));
      await expect(page.getByTestId("usage-controls")).toBeInViewport();
    }
  });
}

test("projects that share a folder are grouped, selectable as a whole, and show their unallocated conversations", async ({
  page,
}) => {
  await mockUsage(page, "ok");
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/usage");

  const group = page.getByTestId("usage-group");
  await expect(group).toContainText("Fictional Barn, Fictional Mill");
  await group.getByRole("button", { name: textIn("zh-TW", "usage.groupSelect") }).click();
  await expect(page.getByRole("checkbox", { name: "Fictional Barn" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Fictional Mill" })).toBeChecked();
  await expect(group.getByRole("button", { name: textIn("zh-TW", "usage.groupClear") })).toBeVisible();

  const shared = page.getByTestId("usage-shared");
  await expect(shared).toContainText(
    textIn("zh-TW", "usage.sharedUnallocated", { projects: "Fictional Barn, Fictional Mill" }),
  );
  await expect(shared.getByTestId("usage-allocated")).toHaveCount(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the range and the scan button stay on screen however many projects are tracked", async ({ page }) => {
  const items = Array.from({ length: 30 }, (_, index) => ({
    id: `usage-many-${index}`,
    name: `Fictional Field ${index + 1}`,
    current: false,
    sources: { claudeFolders: 1, codexFiles: 0 },
  }));
  await page.route("**/api/usage/projects", (route) => route.fulfill({ json: { items, groups: [] } }));
  await page.route("**/api/usage/scan", (route) => route.fulfill({ json: usageScanFixture() }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/usage");

  const controls = page.getByTestId("usage-controls");
  await expect(controls.getByTestId("usage-project")).toHaveCount(30);
  await expect(controls.getByRole("button", { name: textIn("zh-TW", "usage.scan") })).toBeInViewport({ ratio: 1 });
  await expect(controls.getByRole("radiogroup", { name: textIn("zh-TW", "usage.range") })).toBeInViewport({ ratio: 1 });

  // The last project is reached by scrolling the list, not the page.
  await controls.getByTestId("usage-project").last().scrollIntoViewIfNeeded();
  await expect(controls.getByRole("checkbox", { name: "Fictional Field 30" })).toBeInViewport();
  await expect(controls.getByRole("button", { name: textIn("zh-TW", "usage.scan") })).toBeInViewport({ ratio: 1 });
});

test("the controls fill the side column and cards in one row end on the same line", async ({ page }) => {
  await mockUsage(page, "ok");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/usage");
  await expect(page.getByTestId("usage-summary")).toBeVisible();

  const edges = async (testId: string) => {
    const box = await page.getByTestId(testId).boundingBox();
    if (!box) throw new Error(`${testId} is not rendered`);
    return { top: Math.round(box.y), bottom: Math.round(box.y + box.height) };
  };
  // Polled, because the cards settle a few pixels after their entrance.
  await expect(async () => {
    const controls = await edges("usage-controls");
    expect(controls.bottom).toBeGreaterThan(900 - 48);
    expect(controls.bottom).toBeLessThanOrEqual(900);
    expect(await edges("usage-blocks")).toEqual(await edges("usage-summary-main"));
    expect(await edges("usage-composition")).toEqual(await edges("usage-trend"));
  }).toPass();
});

test("a failed scan shows an error with a retry that loads the result", async ({ page }) => {
  await mockUsage(page, "error");
  await page.goto("/usage");
  const error = page.getByTestId("usage-error");
  await expect(error).toBeVisible();
  await expect(error).not.toContainText("internal detail");

  await page.unroute("**/api/usage/scan");
  await page.route("**/api/usage/scan", (route) => route.fulfill({ json: usageScanFixture() }));
  await error.getByRole("button", { name: textIn("zh-TW", "common.retry") }).click();
  await expect(page.getByTestId("usage-summary")).toBeVisible();
});
