import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { AttentionList } from "../../packages/core/src/index.js";
import { textIn, tt, type Locale } from "./helpers/i18n.js";

let fixture: { projectId: string; knowledgeId: string; root: string };

async function seed(request: APIRequestContext) {
  const root = mkdtempSync(join(tmpdir(), "attention-browser-fictional-"));
  const response = await request.post("/api/projects", { data: { name: "Attention Orchard", rootPath: root } });
  expect(response.ok()).toBeTruthy();
  const project = (await response.json()) as { id: string };
  expect((await request.patch(`/api/projects/${project.id}`, { data: { status: "tracked" } })).ok()).toBeTruthy();
  let knowledgeId = "";
  for (const [key, body] of [
    ["original", "First fictional rule"],
    ["duplicate-title", "Second fictional rule"],
  ]) {
    const saved = await request.post("/api/knowledge", {
      data: {
        projectRoot: root,
        idempotencyKey: `rule-${key}`,
        kind: "gotcha",
        title: "Shared fictional title",
        body,
        appliesTo: ["src/fictional.ts"],
      },
    });
    expect(saved.ok()).toBeTruthy();
    if (key === "original") knowledgeId = ((await saved.json()) as { knowledge: { id: string } }).knowledge.id;
  }
  for (let i = 0; i < 2; i++) {
    const saved = await request.post("/api/work/finalize", {
      data: {
        projectRoot: root,
        idempotencyKey: `source-${root}-${i}`,
        title: `Fictional source ${i}`,
        summary: "Fictional source evidence.",
        changedFiles: ["src/fictional.ts"],
        verification: { status: "passed" },
        contradictedKnowledgeIds: i === 0 ? [knowledgeId] : [],
        workSummary: {
          outcomes: [],
          scope: [],
          decisions: Array.from({ length: 20 }, (_, j) => ({
            text: `Orchard decision ${i}-${j} with a deliberately long source title to exercise responsive wrapping`,
            origin: "agent_autonomous",
          })),
          verification: [],
          nextSteps: [],
        },
      },
    });
    expect(saved.ok()).toBeTruthy();
  }
  return { projectId: project.id, knowledgeId, root };
}

test.beforeAll(async ({ request }) => {
  fixture = await seed(request);
});
test.afterAll(() => {
  if (fixture) rmSync(fixture.root, { recursive: true, force: true });
});

for (const locale of ["zh-TW", "en-US"] as const) {
  for (const theme of ["dark", "light"] as const) {
    for (const width of [1440, 960, 375]) {
      test(`attention wraps, scrolls and preserves scope ${locale} ${theme} ${width} @cross-browser`, async ({
        page,
      }, testInfo) => {
        await page.addInitScript(
          ({ locale, theme }: { locale: Locale; theme: string }) => {
            localStorage.setItem("work-intelligence:locale", locale);
            localStorage.setItem("work-intelligence:theme", theme);
          },
          { locale, theme },
        );
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/dashboard?attentionProject=${fixture.projectId}&attentionKind=decision&attentionSize=50`);
        const box = page.getByTestId("attention-box");
        const list = box.getByRole("list", { name: textIn(locale, "attention.list") });
        await expect(list).toBeVisible();
        await expect(box).toContainText("40");
        await expect(list).toHaveAttribute("tabindex", "0");
        await expect(list).toHaveCSS("overflow-y", "auto");
        expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
        await list.scrollIntoViewIfNeeded();
        const main = page.locator("#main");
        const before = await main.evaluate((el) => el.scrollTop);
        await list.focus();
        await page.keyboard.press("PageDown");
        await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await expect(main).toHaveJSProperty("scrollTop", before);
        await list.evaluate((el) => {
          el.scrollTop = 0;
        });
        await list.hover();
        await expect(async () => {
          await page.mouse.wheel(0, 180);
          await expect.poll(() => list.evaluate((el) => el.scrollTop), { timeout: 1000 }).toBeGreaterThan(0);
        }).toPass({ timeout: 8000 });
        await expect(main).toHaveJSProperty("scrollTop", before);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const bounds = await box.boundingBox();
        expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1).toBeTruthy();
        const accessibility = await new AxeBuilder({ page }).include('[data-testid="attention-box"]').analyze();
        expect(accessibility.violations).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath("attention.png"), fullPage: true });
        await page.reload();
        await expect(box).toContainText("40");
        await expect(page).toHaveURL(new RegExp(`attentionProject=${fixture.projectId}`));
      });
    }
  }
}

test("keeps the reading position on a background refresh and resets it for a different scope @cross-browser", async ({
  page,
}) => {
  await page.goto(`/dashboard?attentionProject=${fixture.projectId}&attentionKind=decision&attentionSize=50`);
  const box = page.getByTestId("attention-box");
  const list = box.getByRole("list", { name: tt("attention.list") });
  await expect(box).toContainText("40");
  await list.evaluate((element) => {
    element.scrollTop = 300;
  });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const before = await list.evaluate((element) => element.scrollTop);
  const refreshed = page.waitForResponse((response) => response.url().includes("/api/attention?") && response.ok());
  await page.getByRole("button", { name: tt("common.refresh"), exact: true }).click();
  await refreshed;
  await expect(list).toHaveJSProperty("scrollTop", before);
  await page.goto(`/dashboard?attentionProject=${fixture.projectId}&attentionKind=knowledge`);
  await expect(list).toHaveJSProperty("scrollTop", 0);
});

test("opens the exact Knowledge source despite duplicate titles, then restores navigation @cross-browser", async ({
  page,
}) => {
  await page.goto(`/dashboard?attentionProject=${fixture.projectId}&attentionKind=knowledge`);
  const box = page.getByTestId("attention-box");
  // The source ID, rather than title or row position, determines the destination.
  await box.locator(`a[href*="knowledge=${fixture.knowledgeId}"]`).click();
  const panel = page.getByRole("dialog", { name: tt("knowledge.knowledgeChangeHistory") });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("First fictional rule");
  await expect(panel).not.toContainText("Second fictional rule");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page).not.toHaveURL(/knowledge=/);
  await page.goBack();
  await expect(box).toBeVisible();
});

test("failed or partial coverage never renders a healthy empty queue @cross-browser", async ({ page, request }) => {
  const response = await request.get(`/api/attention?projectId=${fixture.projectId}`);
  const body = (await response.json()) as AttentionList;
  await page.route("**/api/attention?*", (route) =>
    route.fulfill({
      json: {
        ...body,
        items: [],
        total: null,
        minimumTotal: 0,
        pageInfo: { ...body.pageInfo, total: 0 },
        groups: [
          { kind: "knowledge", state: "partial", total: null, examined: 200, available: 201 },
          { kind: "cleanup", state: "failed", total: null, examined: 0, available: 0 },
        ],
      },
    }),
  );
  await page.goto(`/dashboard?attentionProject=${fixture.projectId}`);
  const box = page.getByTestId("attention-box");
  await expect(box).toContainText(tt("attention.unknownEmpty"));
  await expect(box).not.toContainText(tt("attention.empty"));
  await expect(box.getByRole("button", { name: tt("common.retry") })).toHaveCount(2);
});

for (const locale of ["zh-TW", "en-US"] as const) {
  for (const theme of ["dark", "light"] as const) {
    for (const width of [1440, 960, 375]) {
      test(`reminder display is reversible and never resolves sources ${locale} ${theme} ${width} @cross-browser`, async ({
        page,
        request,
      }, testInfo) => {
        await page.addInitScript(
          ({ locale, theme }) => {
            localStorage.setItem("work-intelligence:locale", locale);
            localStorage.setItem("work-intelligence:theme", theme);
          },
          { locale, theme },
        );
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/dashboard?attentionProject=${fixture.projectId}&attentionKind=decision&attentionSize=50`);
        const box = page.getByTestId("attention-box");
        const list = box.getByRole("list", { name: textIn(locale, "attention.list") });
        await expect(box).toContainText("40");
        await list.scrollIntoViewIfNeeded();
        await box
          .getByRole("button", { name: textIn(locale, "attention.preferenceActions") })
          .first()
          .click();
        await page.getByRole("menuitem", { name: textIn(locale, "attention.hide"), exact: true }).click();
        await expect(box).toContainText(textIn(locale, "attention.suppressedCount", { count: 1 }));
        await page.reload();
        await expect(box).toContainText(textIn(locale, "attention.suppressedCount", { count: 1 }));
        const source = (await (
          await request.get(`/api/attention?projectId=${fixture.projectId}&kind=decision`)
        ).json()) as AttentionList;
        expect(source.total).toBe(40);
        expect(source.items.length).toBe(20);
        await box.getByRole("button", { name: new RegExp(textIn(locale, "attention.view")) }).click();
        await page
          .getByRole("menuitemradio", { name: textIn(locale, "attention.suppressedView"), exact: true })
          .click();
        await expect(page).toHaveURL(/attentionView=suppressed/);
        await expect(box.getByRole("button", { name: textIn(locale, "attention.restore"), exact: true })).toHaveCount(
          1,
        );
        expect((await new AxeBuilder({ page }).include('[data-testid="attention-box"]').analyze()).violations).toEqual(
          [],
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await box.scrollIntoViewIfNeeded();
        await box.screenshot({ path: testInfo.outputPath("preferences.png") });
        await box.getByRole("button", { name: textIn(locale, "attention.restore"), exact: true }).click();
        await expect(box).toContainText(textIn(locale, "attention.noSuppressed"));
        await box.getByRole("button", { name: new RegExp(textIn(locale, "attention.view")) }).click();
        await page.getByRole("menuitemradio", { name: textIn(locale, "attention.visibleView"), exact: true }).click();
        await box
          .getByRole("button", { name: textIn(locale, "attention.preferenceActions") })
          .first()
          .click();
        await page.getByRole("menuitem", { name: textIn(locale, "attention.snooze"), exact: true }).click();
        await expect(box).toContainText(textIn(locale, "attention.suppressedCount", { count: 1 }));
        await box.getByRole("button", { name: new RegExp(textIn(locale, "attention.view")) }).click();
        await page
          .getByRole("menuitemradio", { name: textIn(locale, "attention.suppressedView"), exact: true })
          .click();
        const hidden = (await (
          await request.get(`/api/attention?projectId=${fixture.projectId}&kind=decision&view=suppressed`)
        ).json()) as AttentionList;
        expect(hidden.items[0]?.preference?.state).toBe("snoozed");
        expect(Date.parse(hidden.items[0]!.preference!.snoozedUntil!) - Date.now()).toBeGreaterThan(6 * 86400000);
        await box.getByRole("button", { name: textIn(locale, "attention.restore"), exact: true }).click();
        await expect(box).toContainText(textIn(locale, "attention.noSuppressed"));
      });
    }
  }
}

test("stale reminder save keeps the row and exposes refresh @cross-browser", async ({ page }) => {
  await page.route("**/api/attention/preferences", (route) =>
    route.fulfill({ status: 409, json: { code: "conflict", error: "Source changed. Refresh before saving." } }),
  );
  await page.goto(`/dashboard?attentionProject=${fixture.projectId}&attentionKind=decision`);
  const box = page.getByTestId("attention-box");
  await box
    .getByRole("button", { name: tt("attention.preferenceActions") })
    .first()
    .click();
  await page.getByRole("menuitem", { name: tt("attention.hide"), exact: true }).click();
  await expect(box.getByRole("alert")).toBeVisible();
  await expect(box).toContainText(tt("format.theDataChangedRefreshAnd"));
  await expect(box.getByRole("button", { name: tt("attention.preferenceActions") }).first()).toBeVisible();
  await expect(box.getByRole("button", { name: tt("common.refresh"), exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
});
