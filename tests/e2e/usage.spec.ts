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

    // The page never scrolls sideways, even with the wide tables.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
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
