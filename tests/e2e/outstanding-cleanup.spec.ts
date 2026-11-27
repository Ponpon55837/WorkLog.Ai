import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { OutstandingCleanupContextResult } from "../../packages/core/src/index.js";
import { tt, ttPattern } from "./helpers/i18n.js";

/** The panel has no refresh button; returning to the tab invalidates active queries like an SSE change. */
async function refreshInBackground(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

async function seed(
  request: APIRequestContext,
  count = 12,
): Promise<{ projectId: string; evidenceId: string; sourceId: string }> {
  const root = mkdtempSync(join(tmpdir(), "cleanup-browser-fictional-"));
  const projectResponse = await request.post("/api/projects", {
    data: { name: "Cleanup Browser Fixture", rootPath: root },
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = (await projectResponse.json()) as { id: string };
  expect((await request.patch(`/api/projects/${project.id}`, { data: { status: "tracked" } })).ok()).toBeTruthy();
  const base = {
    projectRoot: root,
    changedFiles: [],
    verification: { status: "passed", summary: "Fictional browser verification." },
  };
  const source = await request.post("/api/work/finalize", {
    data: {
      ...base,
      idempotencyKey: `source-${project.id}`,
      title: "Cleanup source",
      summary: "Fictional outstanding obligations.",
      completedAt: new Date(Date.now() - 60_000).toISOString(),
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: Array.from(
          { length: count },
          (_, i) => `Fictional cleanup obligation ${String(i + 1).padStart(2, "0")}`,
        ),
      },
    },
  });
  expect(source.ok()).toBeTruthy();
  const evidence = await request.post("/api/work/finalize", {
    data: {
      ...base,
      idempotencyKey: `evidence-${project.id}`,
      title: "Cleanup verified evidence",
      summary: "The fictional obligations were completed and verified.",
      completedAt: new Date(Date.now() - 30_000).toISOString(),
      workSummary: {
        outcomes: ["All fictional cleanup obligations completed and verified."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [],
      },
    },
  });
  expect(evidence.ok()).toBeTruthy();
  return {
    projectId: project.id,
    sourceId: ((await source.json()) as { session: { id: string } }).session.id,
    evidenceId: ((await evidence.json()) as { session: { id: string } }).session.id,
  };
}
async function createViaWeb(page: Page, projectId: string): Promise<string> {
  await page.goto(`/sessions/outstanding?itemProject=${projectId}`);
  await page.getByRole("button", { name: tt("outstanding.tidyOpenItems"), exact: true }).click();
  const panel = page.getByRole("dialog", { name: tt("outstanding.tidyOpenItems"), exact: true });
  await panel.getByRole("button", { name: tt("outstanding.createRequest"), exact: true }).click();
  await page
    .getByRole("dialog", { name: tt("outstanding.createARequestToTidy") })
    .getByRole("button", { name: tt("outstanding.createRequest"), exact: true })
    .click();
  await expect(page).toHaveURL(/cleanupRequest=/);
  return new URL(page.url()).searchParams.get("cleanupRequest") ?? "";
}
async function submit(request: APIRequestContext, requestId: string, evidenceId: string): Promise<void> {
  const first = await request.get(`/api/outstanding-cleanup/requests/${requestId}/context`);
  const context = (await first.json()) as Extract<
    OutstandingCleanupContextResult,
    { outcome: "outstanding_cleanup_context" }
  >;
  const ids = context.items.map((item) => item.id);
  for (let page = 2; page <= context.itemPageInfo.totalPages; page++) {
    const next = await request.get(`/api/outstanding-cleanup/requests/${requestId}/context?itemPage=${page}`);
    ids.push(
      ...(
        (await next.json()) as Extract<OutstandingCleanupContextResult, { outcome: "outstanding_cleanup_context" }>
      ).items.map((item) => item.id),
    );
  }
  const response = await request.post(`/api/outstanding-cleanup/requests/${requestId}/proposals`, {
    data: {
      requestId,
      idempotencyKey: `browser-submit-${requestId}`,
      examinedItemIds: ids,
      proposals: ids.map((itemId) => ({
        itemId,
        status: "completed",
        reason: "The cited fictional Session verifies this obligation.",
        evidenceSessionIds: [evidenceId],
      })),
    },
  });
  expect(response.ok()).toBeTruthy();
}
async function countStatus(request: APIRequestContext, projectId: string, status: string): Promise<number> {
  const response = await request.get(`/api/outstanding-items?projectId=${projectId}&status=${status}`);
  return ((await response.json()) as { pageInfo: { total: number } }).pageInfo.total;
}

test("shows applied Agent verdicts, reopens items individually and in a batch, and opens evidence", async ({
  page,
  request,
}) => {
  const fixture = await seed(request, 4);
  const requestId = await createViaWeb(page, fixture.projectId);
  await submit(request, requestId, fixture.evidenceId);
  const panel = page.getByRole("dialog", { name: tt("outstanding.tidyOpenItems"), exact: true });
  await refreshInBackground(page);
  const reopen = panel.getByRole("button", { name: ttPattern("outstanding.reopenItem") });
  await expect(reopen).toHaveCount(4);
  const toolbar = panel.getByTestId("outstanding-cleanup-batch-toolbar");
  await expect(toolbar).toHaveCount(0);
  const rowBox = await panel.getByTestId("outstanding-cleanup-proposal").first().boundingBox();
  expect(rowBox?.height ?? Infinity).toBeLessThan(90);
  expect(await countStatus(request, fixture.projectId, "completed")).toBe(4);
  expect(await countStatus(request, fixture.projectId, "pending")).toBe(0);
  await reopen.first().click();
  await expect(reopen).toHaveCount(3);
  expect(await countStatus(request, fixture.projectId, "pending")).toBe(1);
  await panel.getByRole("checkbox", { name: tt("outstanding.selectAllClosedOnThisPage"), exact: true }).check();
  await expect(toolbar).toContainText(tt("outstanding.selected", { length: 3 }));
  await panel.getByRole("button", { name: tt("outstanding.reopenSelected"), exact: true }).click();
  await expect(reopen).toHaveCount(0);
  await expect(toolbar).toHaveCount(0);
  expect(await countStatus(request, fixture.projectId, "pending")).toBe(4);
  await page.reload();
  await panel
    .getByRole("button", { name: ttPattern("outstanding.openEvidenceOf", { value: 1 }) })
    .first()
    .click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("dialog", { name: tt("session.sessionDetails") })).toContainText(
    "Cleanup verified evidence",
  );
});

test("bounds the closed-item list and keeps focus, accessibility, and mobile overflow usable", async ({
  page,
  request,
}, testInfo) => {
  const fixture = await seed(request, 12);
  const requestId = await createViaWeb(page, fixture.projectId);
  await submit(request, requestId, fixture.evidenceId);
  const panel = page.getByRole("dialog", { name: tt("outstanding.tidyOpenItems"), exact: true });
  await refreshInBackground(page);
  await panel.getByRole("button", { name: tt("ui.nextPage"), exact: true }).click();
  await expect(page).toHaveURL(/cleanupPage=2/);
  await page.reload();
  await expect(page).toHaveURL(/cleanupPage=2/);
  await expect(panel.getByRole("button", { name: ttPattern("outstanding.reopenItem") })).toHaveCount(2);
  await panel.getByRole("button", { name: tt("ui.previousPage"), exact: true }).click();
  for (const width of [1440, 960, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const list = panel.getByRole("list", { name: tt("outstanding.closedItemList") });
    await expect(list).toHaveCSS("overflow-y", "auto");
    expect(await list.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(440);
    expect(await panel.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const pageScroll = await page.evaluate(() => window.scrollY);
    await list.evaluate((element) => (element.scrollTop = 0));
    await list.hover();
    await page.mouse.wheel(0, 320);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
    await list.evaluate((element) => (element.scrollTop = 0));
    await list.focus();
    await list.press("PageDown");
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
    await list.evaluate((element) => (element.scrollTop = 0));
    await page.screenshot({ path: testInfo.outputPath(`cleanup-review-${width}.png`) });
  }
  const results = await new AxeBuilder({ page })
    .include(`[role="dialog"][aria-label="${tt("outstanding.tidyOpenItems")}"]`)
    .analyze();
  expect(results.violations).toEqual([]);
  // Reloaded deep links have no opening trigger; reopen through the button to verify focus restoration.
  await panel.getByRole("button", { name: tt("outstanding.closeOpenItemCleanup"), exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: tt("outstanding.tidyOpenItems"), exact: true }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: tt("outstanding.closeOpenItemCleanup"), exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: tt("outstanding.tidyOpenItems"), exact: true })).toBeFocused();
});

test("keeps a reopened item in the Agent-closed history without a reopen control", async ({ page, request }) => {
  const fixture = await seed(request, 2);
  const requestId = await createViaWeb(page, fixture.projectId);
  await submit(request, requestId, fixture.evidenceId);
  const listed = await request.get(`/api/outstanding-cleanup/requests/${requestId}/proposals`);
  const proposals = (await listed.json()) as { proposals: Array<{ itemId: string }> };
  const first = proposals.proposals[0];
  if (!first) throw new Error("Expected a fictional verdict.");
  expect(
    (await request.patch(`/api/outstanding-items/${first.itemId}`, { data: { status: "pending" } })).ok(),
  ).toBeTruthy();
  const panel = page.getByRole("dialog", { name: tt("outstanding.tidyOpenItems"), exact: true });
  await refreshInBackground(page);
  await expect(panel.getByRole("button", { name: ttPattern("outstanding.reopenItem") })).toHaveCount(1);
  expect(await countStatus(request, fixture.projectId, "pending")).toBe(1);
  expect(await countStatus(request, fixture.projectId, "completed")).toBe(1);
  await expect(panel.getByRole("button", { name: tt("outstanding.createRequest"), exact: true })).toBeEnabled();
});

test("shows the Agent command while a request waits and cancels it from the handoff block", async ({
  page,
  request,
}) => {
  const fixture = await seed(request, 1);
  await createViaWeb(page, fixture.projectId);
  const panel = page.getByRole("dialog", { name: tt("outstanding.tidyOpenItems"), exact: true });
  const handoff = panel.getByRole("region", { name: tt("outstanding.cleanupHandoffMessage") });
  const createButton = panel.getByRole("button", { name: tt("outstanding.createRequest"), exact: true });

  await expect(handoff).toContainText(tt("outstanding.cleanupCommand"));
  await expect(handoff).toContainText(tt("outstanding.cleanupHandoffMessage"));
  await expect(handoff.getByRole("button", { name: tt("common.copyAgentInstruction") })).toBeVisible();
  await expect(createButton).toHaveCount(0);

  await handoff.getByRole("button", { name: tt("outstanding.cancelRequest"), exact: true }).click();
  await page
    .getByRole("dialog", { name: tt("outstanding.cancelThisRequest") })
    .getByRole("button", { name: tt("outstanding.cancelRequest"), exact: true })
    .click();
  await expect(handoff).toHaveCount(0);
  await expect(createButton).toBeEnabled();
});

test("keeps request creation usable during a background list refresh @cross-browser", async ({ page, request }) => {
  const fixture = await seed(request, 1);
  await page.goto(`/sessions/outstanding?itemProject=${fixture.projectId}`);
  await page.getByRole("button", { name: tt("outstanding.tidyOpenItems"), exact: true }).click();
  const panel = page.getByRole("dialog", { name: tt("outstanding.tidyOpenItems"), exact: true });
  const create = panel.getByRole("button", { name: tt("outstanding.createRequest"), exact: true });
  await expect(panel.getByText(tt("outstanding.noRequestsYet"), { exact: true })).toBeVisible();
  await expect(create).toBeEnabled();
  let held = true;
  const releaseReads: Array<() => void> = [];
  let notifyRead: () => void = () => undefined;
  const readStarted = new Promise<void>((resolve) => {
    notifyRead = resolve;
  });
  await page.route("**/api/outstanding-cleanup/requests?*", async (route) => {
    if (held) {
      notifyRead();
      await new Promise<void>((resolve) => {
        releaseReads.push(resolve);
      });
    }
    await route.continue();
  });
  try {
    await refreshInBackground(page);
    await readStarted;
    await expect(create).toBeEnabled();
    await create.click();
    const confirmation = page.getByRole("dialog", { name: tt("outstanding.createARequestToTidy") });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: tt("common.cancel"), exact: true }).click();
    await expect(confirmation).toBeHidden();
  } finally {
    held = false;
    for (const release of releaseReads) release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("preserves outstanding reading position when SSE refreshes the same item IDs @cross-browser", async ({
  page,
  request,
}) => {
  const fixture = await seed(request, 20);
  await page.goto(`/sessions/outstanding?itemProject=${fixture.projectId}&itemSize=100`);
  const list = page.getByRole("list", { name: tt("outstanding.openItemsList") });
  await expect(list.getByRole("listitem").first()).toBeVisible();
  await list.evaluate((element) => {
    element.scrollTop = 240;
  });
  await expect(list).toHaveJSProperty("scrollTop", 240);
  const refreshed = page.waitForResponse(
    (response) => response.url().includes("/api/outstanding-items?") && response.request().method() === "GET",
  );
  const response = await request.patch(`/api/sessions/${fixture.sourceId}/title`, {
    data: { title: "Updated source" },
  });
  expect(response.ok()).toBe(true);
  await refreshed;
  await expect(
    list
      .getByRole("button", {
        name: tt("outstanding.openSourceSession", { sourceSessionTitle: "Updated source" }),
        exact: true,
      })
      .first(),
  ).toBeVisible();
  await expect(list).toHaveJSProperty("scrollTop", 240);
});

test("opens the cleanup panel without a project, lists projects with their pending counts and creates from the chosen one", async ({
  page,
  request,
}) => {
  const fixture = await seed(request, 7);
  await page.goto("/sessions/outstanding");
  const entry = page.getByRole("button", { name: tt("outstanding.tidyOpenItems"), exact: true });
  await expect(entry).toBeEnabled();
  await entry.click();

  const panel = page.getByRole("dialog", { name: tt("outstanding.tidyOpenItems"), exact: true });
  const choose = panel.getByTestId("outstanding-cleanup-projects");
  await expect(choose).toBeVisible();
  const row = choose
    .getByTestId("outstanding-cleanup-project")
    .filter({ hasText: "Cleanup Browser Fixture" })
    .filter({ hasText: new RegExp(`(?<!\\d)${tt("outstanding.cleanupPendingCount", { count: 7 })}`) });
  await expect(row).toHaveCount(1);
  await expect(panel.getByRole("button", { name: tt("outstanding.createRequest"), exact: true })).toHaveCount(0);

  await row.getByRole("button", { name: ttPattern("outstanding.cleanupChooseLabel") }).click();
  await expect(page).toHaveURL(new RegExp(`itemProject=${fixture.projectId}`));
  await expect(choose).toHaveCount(0);
  const create = panel.getByRole("button", { name: tt("outstanding.createRequest"), exact: true });
  await expect(create).toBeEnabled();
  const hintBox = await panel.getByText(tt("outstanding.askTheAgentToTidy"), { exact: true }).boundingBox();
  const createBox = await create.boundingBox();
  expect((createBox?.y ?? 0) - ((hintBox?.y ?? 0) + (hintBox?.height ?? 0))).toBeGreaterThanOrEqual(8);
  await panel.getByRole("button", { name: tt("outstanding.cleanupChangeProject"), exact: true }).click();
  await expect(choose).toBeVisible();
});

test("keeps a project filter that was set before the panel opened", async ({ page, request }) => {
  const fixture = await seed(request, 1);
  await page.goto(`/sessions/outstanding?itemProject=${fixture.projectId}`);
  await page.getByRole("button", { name: tt("outstanding.tidyOpenItems"), exact: true }).click();

  const panel = page.getByRole("dialog", { name: tt("outstanding.tidyOpenItems"), exact: true });
  await expect(panel.getByRole("button", { name: tt("outstanding.createRequest"), exact: true })).toBeEnabled();
  await expect(panel.getByRole("button", { name: tt("outstanding.cleanupChangeProject"), exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`itemProject=${fixture.projectId}`));
});
