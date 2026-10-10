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
