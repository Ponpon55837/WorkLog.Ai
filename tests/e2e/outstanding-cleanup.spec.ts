import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { OutstandingCleanupContextResult } from "../../packages/core/src/index.js";
import { tt } from "./helpers/i18n.js";

async function seed(request: APIRequestContext, count = 12): Promise<{ projectId: string; evidenceId: string }> {
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
  return { projectId: project.id, evidenceId: ((await evidence.json()) as { session: { id: string } }).session.id };
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

test("reviews cleanup proposals individually and in a batch, preserves rejected items, and opens evidence", async ({
  page,
  request,
}) => {
  const fixture = await seed(request, 4);
  const requestId = await createViaWeb(page, fixture.projectId);
  await submit(request, requestId, fixture.evidenceId);
  const panel = page.getByRole("dialog", { name: tt("outstanding.tidyOpenItems"), exact: true });
  await panel.getByRole("button", { name: tt("common.refresh"), exact: true }).click();
  await expect(panel.getByRole("button", { name: tt("outstanding.acceptSuggestion"), exact: true })).toHaveCount(4);
  expect(await countStatus(request, fixture.projectId, "pending")).toBe(4);
  await panel
    .getByRole("button", { name: tt("outstanding.rejectSuggestion"), exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog", { name: tt("outstanding.rejectSuggestions") })
    .getByRole("button", { name: tt("outstanding.confirmRejection") })
    .click();
  await expect(panel.getByRole("button", { name: tt("outstanding.acceptSuggestion"), exact: true })).toHaveCount(3);
  expect(await countStatus(request, fixture.projectId, "pending")).toBe(4);
  await panel
    .getByRole("button", { name: tt("outstanding.acceptSuggestion"), exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog", { name: tt("outstanding.acceptSuggestions") })
    .getByRole("button", { name: tt("outstanding.confirmAcceptance") })
    .click();
  await expect(panel.getByRole("button", { name: tt("outstanding.acceptSuggestion"), exact: true })).toHaveCount(2);
  await panel.getByRole("checkbox", { name: tt("outstanding.selectAllSuggestionsOnThis"), exact: true }).check();
  await page.route("**/api/outstanding-cleanup/requests/*/proposals?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { proposals: Array<{ reason: string }> };
    for (const proposal of body.proposals) proposal.reason = "Verified background refresh";
    await route.fulfill({ response, json: body });
  });
  await panel.getByRole("button", { name: tt("common.refresh"), exact: true }).click();
  await expect(panel.getByText("Verified background refresh", { exact: true }).first()).toBeVisible();
  await expect(
    panel.getByRole("checkbox", { name: tt("outstanding.selectAllSuggestionsOnThis"), exact: true }),
  ).toBeChecked();
  await page.unroute("**/api/outstanding-cleanup/requests/*/proposals?*");
  await panel.getByRole("button", { name: tt("outstanding.acceptSelected"), exact: true }).click();
  await page
    .getByRole("dialog", { name: tt("outstanding.acceptSuggestions") })
    .getByRole("button", { name: tt("outstanding.confirmAcceptance") })
    .click();
  await expect(panel.getByText(tt("status.cleanupFinished"), { exact: true }).first()).toBeVisible();
  expect(await countStatus(request, fixture.projectId, "completed")).toBe(3);
  expect(await countStatus(request, fixture.projectId, "pending")).toBe(1);
  await panel.getByRole("button", { name: tt("outstanding.reviewStatus"), exact: true }).click();
  await page.getByRole("menuitemradio", { name: tt("status.accepted"), exact: true }).click();
  await expect(panel.getByRole("button", { name: tt("outstanding.evidence", { value: 1 }), exact: true })).toHaveCount(
    3,
  );
  await page.reload();
  await expect(page).toHaveURL(/cleanupReview=accepted/);
  await panel
    .getByRole("button", { name: tt("outstanding.evidence", { value: 1 }), exact: true })
    .first()
    .click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("dialog", { name: tt("session.sessionDetails") })).toContainText(
    "Cleanup verified evidence",
  );
});

test("bounds cleanup review lists and keeps focus, accessibility, and mobile overflow usable", async ({
  page,
  request,
}, testInfo) => {
  const fixture = await seed(request, 12);
  const requestId = await createViaWeb(page, fixture.projectId);
  await submit(request, requestId, fixture.evidenceId);
  const panel = page.getByRole("dialog", { name: tt("outstanding.tidyOpenItems"), exact: true });
  await panel.getByRole("button", { name: tt("common.refresh"), exact: true }).click();
  await panel.getByRole("button", { name: tt("ui.nextPage"), exact: true }).click();
  await expect(page).toHaveURL(/cleanupPage=2/);
  await page.reload();
  await expect(page).toHaveURL(/cleanupPage=2/);
  await expect(panel.getByRole("button", { name: tt("outstanding.acceptSuggestion"), exact: true })).toHaveCount(2);
  await panel.getByRole("button", { name: tt("ui.previousPage"), exact: true }).click();
  for (const width of [1440, 960, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const list = panel.getByRole("list", { name: tt("outstanding.suggestionList") });
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
    await page.keyboard.press("PageDown");
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
  await panel.getByRole("button", { name: tt("common.refresh"), exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: tt("outstanding.tidyOpenItems"), exact: true })).toBeFocused();
});

test("disables stale acceptance and keeps cancelled proposals as read-only history", async ({ page, request }) => {
  const fixture = await seed(request, 2);
  const requestId = await createViaWeb(page, fixture.projectId);
  await submit(request, requestId, fixture.evidenceId);
  const listed = await request.get(`/api/outstanding-cleanup/requests/${requestId}/proposals`);
  const proposals = (await listed.json()) as { proposals: Array<{ itemId: string }> };
  const first = proposals.proposals[0];
  if (!first) throw new Error("Expected a fictional proposal.");
  expect(
    (await request.patch(`/api/outstanding-items/${first.itemId}`, { data: { status: "not_needed" } })).ok(),
  ).toBeTruthy();
  const panel = page.getByRole("dialog", { name: tt("outstanding.tidyOpenItems"), exact: true });
  await panel.getByRole("button", { name: tt("common.refresh"), exact: true }).click();
  await expect(panel.getByText(tt("outstanding.itemsSourcesOrEvidenceChanged"), { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: tt("outstanding.acceptSuggestion"), exact: true }).first(),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: tt("outstanding.rejectSuggestion"), exact: true }).first(),
  ).toBeEnabled();
  await panel.getByRole("checkbox", { name: tt("outstanding.selectAllSuggestionsOnThis"), exact: true }).check();
  await panel.getByRole("button", { name: tt("outstanding.cancelRequest"), exact: true }).click();
  await page
    .getByRole("dialog", { name: tt("outstanding.cancelThisRequest") })
    .getByRole("button", { name: tt("outstanding.cancelRequest"), exact: true })
    .click();
  await expect(
    panel.getByText(tt("outstanding.theRequestWasCancelledExisting"), { exact: true }).first(),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: tt("outstanding.rejectSuggestion"), exact: true }).first(),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: tt("outstanding.acceptSuggestion"), exact: true }).first(),
  ).toBeDisabled();
  await expect(
    panel.getByRole("checkbox", { name: tt("outstanding.selectAllSuggestionsOnThis"), exact: true }),
  ).not.toBeChecked();
  await expect(panel.getByText(tt("outstanding.selected", { length: 0 }), { exact: true })).toBeVisible();
  expect(await countStatus(request, fixture.projectId, "pending")).toBe(1);
  expect(await countStatus(request, fixture.projectId, "not_needed")).toBe(1);
  await expect(panel.getByRole("button", { name: tt("outstanding.createRequest"), exact: true })).toBeEnabled();
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
    await panel.getByRole("button", { name: tt("common.refresh"), exact: true }).click();
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
