import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { ProjectDataExport, SystemAgentConnections } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/dist/index.js";
import { LANGUAGE_NAMES, textIn, tt, ttPattern } from "./helpers/i18n.js";

const projectRoot = process.cwd();
// Report calendar dates follow the host time zone, like the server computing them.
const reportDate = new Date().toLocaleDateString("sv-SE");

type ProjectRecord = { id: string };
type SessionRecord = { id: string };
type ApiResult<T> = T & { outcome?: string; reason?: string };

/** Acts as an Agent on the server's database (MCP-only writes have no REST route). */
function withAgentStore<T>(task: (store: WorkIntelligenceStore) => T): T {
  const databasePath = process.env.WORK_INTELLIGENCE_E2E_DB;
  if (!databasePath) {
    throw new Error("WORK_INTELLIGENCE_E2E_DB is not set; run the suite through playwright.config.ts.");
  }
  const store = new WorkIntelligenceStore(databasePath, { backup: { directory: `${databasePath}-agent-backups` } });
  try {
    return task(store);
  } finally {
    store.close();
  }
}

const pageRoutes: ReadonlyArray<readonly [string, string]> = [
  ["/dashboard", tt("nav.workOverview")],
  ["/sessions", tt("common.workHistory")],
  ["/sessions/outstanding", tt("common.workHistory")],
  ["/reports", tt("nav.workReports")],
  ["/knowledge", tt("common.workKnowledge")],
  ["/graph", tt("nav.workGraph")],
  ["/projects", tt("common.project")],
];
const accessibilityRoutes: ReadonlyArray<readonly [string, string]> = [
  ...pageRoutes,
  ["/system-status", tt("nav.systemStatus")],
  ["/projects/backup", tt("common.project")],
  ["/knowledge/pages", tt("common.workKnowledge")],
  ["/graph/hotspots", tt("nav.workGraph")],
  ["/graph/timeline", tt("nav.workGraph")],
  ["/knowledge/candidates", tt("common.workKnowledge")],
  ["/knowledge/decisions", tt("common.workKnowledge")],
];

async function postJson<T>(request: APIRequestContext, endpoint: string, body: unknown): Promise<ApiResult<T>> {
  const response = await request.post(endpoint, { data: body });
  expect(response.ok(), `${endpoint} returned ${response.status()}`).toBeTruthy();
  return (await response.json()) as ApiResult<T>;
}

async function getOutstandingItemTotal(
  request: APIRequestContext,
  projectId: string,
  status: "pending" | "completed" | "not_needed",
): Promise<number> {
  const response = await request.get("/api/outstanding-items", {
    params: { projectId, status, page: 1, pageSize: 100 },
  });
  expect(response.ok(), `/api/outstanding-items returned ${response.status()}`).toBeTruthy();
  const result = (await response.json()) as { outcome?: string; pageInfo?: { total?: number } };
  expect(result.outcome).toBe("outstanding_items");
  if (typeof result.pageInfo?.total !== "number") {
    throw new Error("Expected the outstanding-items response to include a total count.");
  }
  return result.pageInfo.total;
}

async function submitKnowledgeCandidateForReview(
  page: Page,
  input: { title: string; body: string; rationale: string },
): Promise<string> {
  await page.goto("/knowledge/candidates");
  const candidates = page.getByTestId("knowledge-candidates");
  await candidates.getByRole("button", { name: tt("knowledge.synthesizeCandidates") }).click();
  await page.getByRole("menuitem", { name: "Browser Regression Fixture" }).click();
  await expect(candidates).toContainText(ttPattern("knowledge.hasSessionsWaitingForThe", { value: "" }));

  const candidateId = withAgentStore((store) => {
    const context = store.getKnowledgeCandidateContext({ projectRoot });
    if (context.outcome !== "knowledge_candidate_context") {
      throw new Error(`Expected candidate context, got ${context.outcome}`);
    }
    const sourceSession = context.sessions[0];
    if (!sourceSession) {
      throw new Error("Expected an eligible fixture Session for the Knowledge candidate.");
    }
    const submitted = store.submitKnowledgeCandidates({
      requestId: context.request.id,
      candidates: [
        {
          sourceSessionId: sourceSession.id,
          kind: "gotcha",
          title: input.title,
          body: input.body,
          rationale: input.rationale,
        },
      ],
    });
    if (submitted.outcome !== "knowledge_candidates_submitted") {
      throw new Error(`Expected submitted Knowledge candidates, got ${submitted.outcome}`);
    }
    const candidate = submitted.candidates[0];
    if (!candidate) {
      throw new Error("Expected the Agent to submit one Knowledge candidate.");
    }
    return candidate.id;
  });

  await expect(page.getByTestId("knowledge-candidate").filter({ hasText: input.title })).toBeVisible({
    timeout: 15_000,
  });
  return candidateId;
}

async function expectBoundedVirtualList(page: Page, name: string): Promise<Locator> {
  const list = page.getByRole("list", { name });
  await expect(list).toBeVisible();
  await expect(list).toHaveAttribute("tabindex", "0");
  await expect(list).toHaveCSS("overflow-y", "auto");
  const visibleItems = await list.getByRole("listitem").count();
  expect(visibleItems).toBeGreaterThan(0);
  expect(visibleItems).toBeLessThan(25);
  const dimensions = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  return list;
}

async function expectPanelToFillViewport(list: Locator): Promise<void> {
  await expect
    .poll(() =>
      list.evaluate((element) => {
        const main = document.querySelector<HTMLElement>("#main");
        const panel = element.closest<HTMLElement>(".ui-box");
        const bottomInset = element.classList.contains("virtual-list-fit-viewport-to-panel-shared-fill")
          ? 0
          : Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue("--space-6")) || 24;
        return main && panel
          ? Math.abs(main.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom - bottomInset)
          : NaN;
      }),
    )
    .toBeLessThanOrEqual(2);
}

async function expectListToMeetPagination(list: Locator): Promise<void> {
  await expect
    .poll(() =>
      list.evaluate((element) => {
        const footer = element.closest<HTMLElement>(".ui-box")?.querySelector<HTMLElement>(".ui-box__footer");
        return footer ? Math.abs(footer.getBoundingClientRect().top - element.getBoundingClientRect().bottom) : NaN;
      }),
    )
    .toBeLessThanOrEqual(1);
}

async function expectUserScrollsListInternally(page: Page, name: string): Promise<void> {
  const list = page.getByRole("list", { name });
  const pageScroller = page.locator("#main");
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await list.scrollIntoViewIfNeeded();
  await list.getByRole("listitem").first().hover();
  const pageScrollTop = await pageScroller.evaluate((element) => element.scrollTop);
  // Chromium can drop a wheel sent right after a viewport resize and reload, so send it again until the list scrolls.
  await expect(async () => {
    await page.mouse.wheel(0, 240);
    await expect.poll(() => list.evaluate((element) => element.scrollTop), { timeout: 1000 }).toBeGreaterThan(0);
  }).toPass({ timeout: 8000 });
  await expect(pageScroller).toHaveJSProperty("scrollTop", pageScrollTop);

  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await list.press("PageDown");
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(pageScroller).toHaveJSProperty("scrollTop", pageScrollTop);
}

async function expectPaginationVisibleWithinViewport(page: Page, sizeLabel: string): Promise<void> {
  const selector = page.getByLabel(sizeLabel);
  await expect(selector).toBeVisible();
  const bounds = await selector.evaluate((element) => {
    const footer = element.closest<HTMLElement>(".ui-box__footer");
    const main = element.closest<HTMLElement>("main");
    const pagination = footer?.querySelector<HTMLElement>(".ui-pagination");
    if (!footer || !main) {
      return null;
    }
    const controlBottoms = [
      element.getBoundingClientRect().bottom,
      pagination?.getBoundingClientRect().bottom ?? 0,
      pagination?.querySelector<HTMLElement>(".ui-pagination__pages")?.getBoundingClientRect().bottom ?? 0,
    ];
    return {
      footerTop: footer.getBoundingClientRect().top,
      footerBottom: footer.getBoundingClientRect().bottom,
      controlsBottom: Math.max(...controlBottoms),
      mainTop: main.getBoundingClientRect().top,
      mainBottom: main.getBoundingClientRect().bottom,
    };
  });
  expect(bounds).not.toBeNull();
  if (!bounds) {
    throw new Error("Expected the page-size selector to belong to a visible list footer.");
  }
  expect(bounds.footerTop, JSON.stringify(bounds)).toBeGreaterThanOrEqual(bounds.mainTop - 1);
  expect(bounds.footerBottom, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.mainBottom + 1);
  expect(bounds.controlsBottom, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.mainBottom + 1);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test.describe("Work Intelligence browser regression", () => {
  // This suite shares fixtures created in beforeAll; retrying it recreates and layers those fixtures.
  test.describe.configure({ mode: "serial", retries: 0 });

  let projectId = "";
  let sessionId = "";
  let otherProjectId = "";

  test.beforeAll(async ({ request }) => {
    const project = await postJson<ProjectRecord>(request, "/api/projects", {
      name: "Browser Regression Fixture",
      rootPath: projectRoot,
    });
    projectId = project.id;

    const trackedProject = await request.patch(`/api/projects/${projectId}`, {
      data: { status: "tracked" },
    });
    expect(trackedProject.ok()).toBeTruthy();

    const otherProject = await postJson<ProjectRecord>(request, "/api/projects", {
      name: "Outstanding Filter Fixture",
      rootPath: `${projectRoot}/e2e-outstanding-filter-fixture`,
    });
    otherProjectId = otherProject.id;
    const trackedOtherProject = await request.patch(`/api/projects/${otherProjectId}`, {
      data: { status: "tracked" },
    });
    expect(trackedOtherProject.ok()).toBeTruthy();

    const finalized = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `browser-regression-${process.pid}`,
      title: "Browser regression fixture session",
      summary: "Fixture data used to exercise the Work Intelligence UI.",
      workSummary: {
        outcomes: ["The browser fixture remains readable."],
        scope: ["The primary Work Intelligence views."],
        decisions: [
          "Use one isolated SQLite fixture.",
          { text: "Confirm this Agent choice in the Web review queue.", origin: "agent_autonomous" },
          { text: "Promote this Agent choice into Knowledge.", origin: "agent_autonomous" },
          { text: "Reject this Agent choice in the Web review queue.", origin: "agent_autonomous" },
        ],
        verification: ["Browser regression fixture is deterministic."],
        nextSteps: ["Keep the UI regression suite green."],
      },
      changedFiles: ["README.md"],
      verification: {
        status: "passed",
        summary: "Browser regression fixture is deterministic.",
      },
      events: [{ type: "verification", summary: "Fixture verification completed." }],
      completedAt: new Date().toISOString(),
    });
    sessionId = finalized.session.id;

    const otherFinalized = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
      projectRoot: `${projectRoot}/e2e-outstanding-filter-fixture`,
      idempotencyKey: `browser-regression-outstanding-other-${process.pid}`,
      title: "Outstanding filter fixture session",
      summary: "A second project provides an outstanding-item filter fixture.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [
          "Check the other project filter.",
          ...Array.from(
            { length: 19 },
            (_, index) => `Batch limit fixture item ${String(index + 1).padStart(3, "0")}.`,
          ),
        ],
      },
      changedFiles: [],
      verification: { status: "passed", summary: "Outstanding filter fixture is deterministic." },
      completedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    expect(otherFinalized.session.id).toBeTruthy();

    // Five additional synthetic Sessions bring this project's pending queue to 120 items,
    // allowing the browser test to exercise the 100-item per-page selection cap.
    for (let group = 0; group < 5; group += 1) {
      const firstItemNumber = 20 + group * 20;
      const batchFixture = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
        projectRoot: `${projectRoot}/e2e-outstanding-filter-fixture`,
        idempotencyKey: `browser-regression-outstanding-batch-${process.pid}-${group + 1}`,
        title: `Outstanding batch fixture session ${group + 1}`,
        summary: "Synthetic nextSteps exercise bounded batch selection and undo.",
        workSummary: {
          outcomes: [],
          scope: [],
          decisions: [],
          verification: [],
          nextSteps: Array.from(
            { length: 20 },
            (_, index) => `Batch limit fixture item ${String(firstItemNumber + index + 1).padStart(3, "0")}.`,
          ),
        },
        changedFiles: [],
        verification: { status: "passed", summary: "Outstanding batch fixture is deterministic." },
        completedAt: new Date(Date.now() - (group + 2) * 30_000).toISOString(),
      });
      expect(batchFixture.session.id).toBeTruthy();
    }

    const evidence = await request.post(`/api/sessions/${sessionId}/evidence`, {
      data: {
        kind: "test",
        reference: "pnpm test:e2e",
        summary: "Browser regression fixture evidence.",
      },
    });
    expect(evidence.ok()).toBeTruthy();

    const knowledge = await postJson(request, "/api/knowledge", {
      projectRoot,
      idempotencyKey: `browser-regression-knowledge-${process.pid}`,
      kind: "decision",
      title: "Browser regression fixture decision",
      body: "The browser suite uses an isolated SQLite database.",
      sessionId,
      tags: ["e2e", "testing"],
      references: ["playwright.config.ts"],
    });
    expect(knowledge.outcome).toBe("knowledge_recorded");

    for (let index = 1; index <= 24; index += 1) {
      const extraSession = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
        projectRoot,
        idempotencyKey: `browser-regression-extra-${process.pid}-${index}`,
        title: `Browser regression extra session ${index}`,
        summary: "Additional fixture data used to verify bounded virtual lists.",
        changedFiles: ["README.md"],
        verification: {
          status: "passed",
          summary: "Virtual list fixture is deterministic.",
        },
        completedAt: new Date(Date.now() - index * 60_000).toISOString(),
      });
      const extraEvidence = await request.post(`/api/sessions/${extraSession.session.id}/evidence`, {
        data: {
          kind: "test",
          reference: `virtual-list-${index}`,
          summary: "Virtual list fixture evidence.",
        },
      });
      expect(extraEvidence.ok()).toBeTruthy();
      const extraKnowledge = await postJson(request, "/api/knowledge", {
        projectRoot,
        idempotencyKey: `browser-regression-extra-knowledge-${process.pid}-${index}`,
        kind: "pattern",
        title: `Virtual list fixture knowledge ${index}`,
        body: "Additional fixture knowledge used to verify bounded virtual lists.",
        sessionId: extraSession.session.id,
        tags: ["e2e", "virtual-list"],
        references: ["apps/web/src/components/VirtualList.vue"],
      });
      expect(extraKnowledge.outcome).toBe("knowledge_recorded");
    }

    // The report page opens on all tracked projects, which only shows all-project syntheses.
    const synthesisRequest = await postJson<{ request: { id: string } }>(request, "/api/reports/synthesis-requests", {
      period: "week",
      date: reportDate,
      idempotencyKey: `browser-regression-report-${process.pid}`,
    });
    expect(synthesisRequest.outcome).toBe("report_synthesis_request");

    const sourceBlock = {
      title: "Browser validation",
      detail: "The regression fixture confirms the primary Work Intelligence views remain navigable.",
      sourceSessionIds: [sessionId],
    };
    const summaryPayload = {
      executiveSummary: "The primary Work Intelligence flows are available for browser validation.",
      themes: [sourceBlock],
      highlights: [sourceBlock],
      verification: [sourceBlock],
      comparison: [sourceBlock],
      risks: [],
      decisions: [sourceBlock],
      nextSteps: [sourceBlock],
      sourceSessionIds: [sessionId],
      generatedByAgent: "Playwright fixture",
      generatedByModel: "test-fixture",
    };
    const summary = await postJson(request, "/api/reports/summaries", {
      requestId: synthesisRequest.request.id,
      title: "Browser regression report",
      ...summaryPayload,
      promptVersion: "e2e-fixture-v1",
    });
    expect(summary.outcome).toBe("report_summary_saved");

    const newerRequest = await postJson<{ request: { id: string } }>(request, "/api/reports/synthesis-requests", {
      period: "week",
      date: reportDate,
      idempotencyKey: `browser-regression-report-v2-${process.pid}`,
    });
    expect(newerRequest.outcome).toBe("report_synthesis_request");
    const newerSummary = await postJson(request, "/api/reports/summaries", {
      requestId: newerRequest.request.id,
      title: "Browser regression report updated",
      ...summaryPayload,
      promptVersion: "e2e-fixture-v2",
    });
    expect(newerSummary.outcome).toBe("report_summary_saved");
  });

  test("filters outstanding nextSteps and supports source navigation and status transitions", async ({ page }) => {
    const primaryText = "Keep the UI regression suite green.";
    const otherText = "Check the other project filter.";
    const primaryItem = () => page.getByTestId("outstanding-item").filter({ hasText: primaryText });
    const selectStatus = async (label: string): Promise<void> => {
      await page.getByRole("button", { name: tt("common.status") }).click();
      await page.getByRole("menuitemradio", { name: label, exact: true }).click();
    };

    await page.goto("/sessions");
    await page.getByRole("tab", { name: ttPattern("common.openItems") }).click();
    await expect(page).toHaveURL(/\/sessions\/outstanding$/);
    await expect(page.getByRole("heading", { name: tt("common.workHistory") }).first()).toBeVisible();
    await expect(page.getByTestId("outstanding-item").filter({ hasText: primaryText })).toBeVisible();
    await expect(page.getByTestId("outstanding-item").filter({ hasText: otherText })).toBeVisible();

    await page.getByRole("button", { name: tt("common.project") }).click();
    await page.getByRole("menuitemradio", { name: "Browser Regression Fixture", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`itemProject=${projectId}`));
    await expect(primaryItem()).toBeVisible();
    await expect(page.getByTestId("outstanding-item").filter({ hasText: otherText })).toHaveCount(0);

    await primaryItem()
      .getByRole("button", {
        name: tt("outstanding.openSourceSession", { sourceSessionTitle: "Browser regression fixture session" }),
      })
      .click();
    const sessionPanel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    await expect(sessionPanel).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`session=${sessionId}`));
    await sessionPanel.getByRole("button", { name: tt("common.close"), exact: true }).click();
    await expect(sessionPanel).toBeHidden();

    await primaryItem()
      .getByRole("button", { name: tt("common.noLongerNeeded") })
      .click();
    const confirmation = page.getByRole("dialog", { name: tt("outstanding.markThisOpenItemAs") });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: tt("outstanding.keepAsPending") }).click();
    await expect(confirmation).toBeHidden();
    await expect(primaryItem()).toBeVisible();

    await primaryItem()
      .getByRole("button", { name: tt("outstanding.markDoneAction") })
      .click();
    await expect(page.getByText(tt("outstanding.markedAsDone"), { exact: true })).toBeVisible();
    await expect(primaryItem()).toHaveCount(0);
    await selectStatus(tt("common.completedStatus"));
    await expect(primaryItem()).toBeVisible();
    await primaryItem()
      .getByRole("button", { name: tt("outstanding.reopen") })
      .click();
    await expect(page.getByText(tt("outstanding.openItemReopened"), { exact: true }).last()).toBeVisible();
    await expect(primaryItem()).toHaveCount(0);

    await selectStatus(tt("common.pending"));
    await expect(primaryItem()).toBeVisible();
    await primaryItem()
      .getByRole("button", { name: tt("common.noLongerNeeded") })
      .click();
    await page
      .getByRole("dialog", { name: tt("outstanding.markThisOpenItemAs") })
      .getByRole("button", { name: tt("outstanding.markNotNeededAction") })
      .click();
    await expect(page.getByText(tt("outstanding.markedAsNoLongerNeeded"), { exact: true })).toBeVisible();
    await expect(primaryItem()).toHaveCount(0);
    await selectStatus(tt("common.noLongerNeeded"));
    await expect(primaryItem()).toBeVisible();
    await primaryItem()
      .getByRole("button", { name: tt("outstanding.reopen") })
      .click();
    await expect(page.getByText(tt("outstanding.openItemReopened"), { exact: true }).last()).toBeVisible();
    await expect(primaryItem()).toHaveCount(0);
    await selectStatus(tt("common.pending"));
    await expect(primaryItem()).toBeVisible();
  });

  test("batches at most 100 outstanding items and undoes the complete batch from another page", async ({
    page,
    request,
  }) => {
    await page.goto(`/sessions/outstanding?itemProject=${otherProjectId}&itemStatus=pending&itemPage=1&itemSize=100`);
    await expect(page.getByText(ttPattern("ui.showingOf", { total: 120 }))).toBeVisible();

    const selectCurrentPage = page.getByRole("checkbox", { name: tt("outstanding.selectAllOpenItemsOn") });
    const completeBatch = page.getByRole("button", { name: tt("outstanding.markDone"), exact: true });
    const notNeededBatch = page.getByRole("button", { name: tt("outstanding.markNotNeeded"), exact: true });
    await selectCurrentPage.check();
    await expect(completeBatch).toBeEnabled();
    await expect(notNeededBatch).toBeEnabled();
    await completeBatch.click();

    const undoBatch = page.getByRole("button", { name: tt("outstanding.undoThisBatch"), exact: true });
    await expect(undoBatch).toBeVisible();
    await expect.poll(() => getOutstandingItemTotal(request, otherProjectId, "completed")).toBe(100);
    await expect.poll(() => getOutstandingItemTotal(request, otherProjectId, "pending")).toBe(20);
    await expect(selectCurrentPage).not.toBeChecked();
    await expect(completeBatch).toBeDisabled();

    await page.getByRole("button", { name: tt("common.status") }).click();
    await page.getByRole("menuitemradio", { name: tt("common.completedStatus"), exact: true }).click();
    await expect(selectCurrentPage).toBeDisabled();
    await expect(completeBatch).toBeDisabled();
    await expect(notNeededBatch).toBeDisabled();
    await page.getByRole("button", { name: tt("common.status") }).click();
    await page.getByRole("menuitemradio", { name: tt("common.pending"), exact: true }).click();

    // The undo action belongs to the batch, not the page currently rendered in the list.
    await page.getByLabel(tt("outstanding.openItemsPerPage")).selectOption("10");
    await page.getByRole("button", { name: tt("ui.nextPage"), exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("itemPage")).toBe("2");
    await expect(undoBatch).toBeVisible();
    await undoBatch.click();
    await expect(undoBatch).toBeHidden();
    await expect.poll(() => getOutstandingItemTotal(request, otherProjectId, "pending")).toBe(120);
    await expect.poll(() => getOutstandingItemTotal(request, otherProjectId, "completed")).toBe(0);
    // The restored rows change page membership; wait for the UI to show them before selecting.
    await expect(page.getByText(ttPattern("ui.showingOf", { total: 120 }))).toBeVisible();

    await selectCurrentPage.check();
    // Same-page background refreshes must not erase selections while a user prepares a batch.
    // SSE may refresh again after visibilitychange; keep the fixture stable until both assertions finish.
    await page.route("**/api/outstanding-items?*", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { items: Array<{ sourceSessionTitle: string }> };
      for (const item of body.items) item.sourceSessionTitle = "Refreshed batch source";
      await route.fulfill({ response, json: body });
    });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(
      page
        .getByRole("button", {
          name: tt("outstanding.openSourceSession", { sourceSessionTitle: "Refreshed batch source" }),
        })
        .first(),
    ).toBeVisible();
    await expect(selectCurrentPage).toBeChecked();
    await page.unroute("**/api/outstanding-items?*");
    await notNeededBatch.click();
    const confirmation = page.getByRole("dialog", { name: tt("outstanding.markNotNeeded"), exact: true });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: tt("outstanding.markNotNeededAction"), exact: true }).click();
    await expect(undoBatch).toBeVisible();
    await expect.poll(() => getOutstandingItemTotal(request, otherProjectId, "not_needed")).toBe(10);
    await expect.poll(() => getOutstandingItemTotal(request, otherProjectId, "pending")).toBe(110);

    await undoBatch.click();
    await expect(undoBatch).toBeHidden();
    await expect.poll(() => getOutstandingItemTotal(request, otherProjectId, "pending")).toBe(120);
    await expect.poll(() => getOutstandingItemTotal(request, otherProjectId, "not_needed")).toBe(0);
  });

  test("clears outstanding batch selection when the page or project filter changes", async ({ page }) => {
    await page.goto(`/sessions/outstanding?itemProject=${otherProjectId}&itemStatus=pending&itemPage=1&itemSize=10`);
    const selectCurrentPage = page.getByRole("checkbox", { name: tt("outstanding.selectAllOpenItemsOn") });
    const itemCheckboxes = page.getByRole("checkbox", { name: ttPattern("outstanding.selectOpenItem") });
    const completeBatch = page.getByRole("button", { name: tt("outstanding.markDone"), exact: true });

    await itemCheckboxes.first().check();
    await expect(completeBatch).toBeEnabled();
    await page.getByRole("button", { name: tt("ui.nextPage"), exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("itemPage")).toBe("2");
    await expect(selectCurrentPage).not.toBeChecked();
    await expect(itemCheckboxes.first()).not.toBeChecked();
    await expect(completeBatch).toBeDisabled();

    await itemCheckboxes.first().check();
    await expect(completeBatch).toBeEnabled();
    await page.getByRole("button", { name: tt("common.project"), exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Browser Regression Fixture", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("itemProject")).toBe(projectId);
    await expect(selectCurrentPage).not.toBeChecked();
    await expect(itemCheckboxes.first()).not.toBeChecked();
    await expect(completeBatch).toBeDisabled();
  });

  test("syncs outstanding source Session date filters to the URL and API across reloads", async ({ page }) => {
    const requestedRanges: Array<{ from: string | null; to: string | null }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/api/outstanding-items") {
        requestedRanges.push({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
      }
    });

    await page.goto(`/sessions/outstanding?itemProject=${projectId}&itemStatus=pending`);
    const dateFilter = page.getByRole("button", { name: tt("outstanding.sourceSessionDate"), exact: true });
    await expect(dateFilter).toBeVisible();
    const firstItemCheckbox = page.getByRole("checkbox", { name: ttPattern("outstanding.selectOpenItem") }).first();
    // Initial query refreshes can briefly disable the checkbox between pointer events.
    await expect(async () => {
      await firstItemCheckbox.check();
      await expect(firstItemCheckbox).toBeChecked();
    }).toPass({ timeout: 8000 });

    await dateFilter.click();
    await page.getByRole("button", { name: tt("common.today"), exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("itemFrom")).toBe(reportDate);
    await expect.poll(() => new URL(page.url()).searchParams.get("itemTo")).toBe(reportDate);
    await expect.poll(() => requestedRanges[requestedRanges.length - 1]).toEqual({ from: reportDate, to: reportDate });
    await expect(page.getByRole("checkbox", { name: tt("outstanding.selectAllOpenItemsOn") })).not.toBeChecked();
    await expect(firstItemCheckbox).not.toBeChecked();

    const requestsBeforeReload = requestedRanges.length;
    await page.reload();
    await expect.poll(() => requestedRanges.length).toBeGreaterThan(requestsBeforeReload);
    await expect.poll(() => new URL(page.url()).searchParams.get("itemFrom")).toBe(reportDate);
    await expect.poll(() => new URL(page.url()).searchParams.get("itemTo")).toBe(reportDate);
    await expect.poll(() => requestedRanges[requestedRanges.length - 1]).toEqual({ from: reportDate, to: reportDate });
    await expect(page.getByRole("button", { name: tt("common.today"), exact: true })).toBeVisible();
  });

  test("keeps the outstanding-items list bounded and overflow-free at desktop, tablet, and mobile widths", async ({
    page,
  }, testInfo) => {
    for (const width of [1440, 960, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/sessions/outstanding?itemProject=${otherProjectId}&itemStatus=pending&itemPage=1&itemSize=100`);
      const list = await expectBoundedVirtualList(page, tt("outstanding.openItemsList"));
      await expect(list.getByRole("listitem").first()).toBeVisible();
      await expect(page.getByRole("checkbox", { name: tt("outstanding.selectAllOpenItemsOn") })).toBeVisible();
      await expect(page.getByRole("button", { name: tt("outstanding.markDone"), exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`outstanding-items-${width}.png`) });
      await expectUserScrollsListInternally(page, tt("outstanding.openItemsList"));
      await expectNoHorizontalOverflow(page);
    }
  });

  test("shows outstanding-item loading, empty, and error states", async ({ page }) => {
    await page.goto(`/sessions/outstanding?itemProject=${projectId}&itemStatus=completed`);
    await expect(page.getByTestId("outstanding-items-empty")).toBeVisible();
    await expect(page.getByTestId("outstanding-items-empty")).toContainText(
      tt("outstanding.noItemsRightNow", { value: tt("common.completedStatus") }),
    );

    await page.route("**/api/outstanding-items?*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    });
    await page.goto(`/sessions/outstanding?itemProject=${projectId}&itemStatus=pending`);
    await expect(page.getByTestId("outstanding-items-loading")).toBeVisible();
    await expect(
      page.getByTestId("outstanding-item").filter({ hasText: "Keep the UI regression suite green." }),
    ).toBeVisible();
    // A refetch can still be inside its 250 ms delay; wait for it so its continue() does not race the removal.
    await page.unrouteAll({ behavior: "wait" });

    await page.route("**/api/outstanding-items*", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "The fixture API is unavailable.", code: "service_unavailable" }),
      });
    });
    await page.goto(`/sessions/outstanding?itemProject=${projectId}&itemStatus=completed&itemPage=2`);
    await expect(page.getByTestId("outstanding-items-error")).toContainText(
      tt("format.theServiceIsTemporarilyUnavailable"),
    );
    await expect(
      page.getByTestId("outstanding-items-error").getByRole("button", { name: tt("common.retry") }),
    ).toBeVisible();
  });

  test("reviews Agent decisions and promotes one with its source Session linked", async ({ page }) => {
    await page.goto("/reports/risks");
    const reportDecisions = page.getByTestId("report-agent-autonomous-decisions");
    await expect(reportDecisions).toContainText(tt("reports.agentAutonomousDecisionsThisPeriod"));
    await expect(reportDecisions).toContainText("Confirm this Agent choice in the Web review queue.");
    await expect(reportDecisions).toContainText("Promote this Agent choice into Knowledge.");
    await expect(reportDecisions).toContainText("Reject this Agent choice in the Web review queue.");

    await page.goto("/knowledge/decisions");
    const panel = page.getByTestId("agent-decision-review");
    const decision = (text: string) => panel.getByTestId("agent-decision-item").filter({ hasText: text });

    await decision("Promote this Agent choice into Knowledge.")
      .getByRole("button", { name: "Browser regression fixture session" })
      .click();
    const sessionPanel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    const sessionDecisions = sessionPanel.getByTestId("session-decision");
    await expect(sessionDecisions.filter({ hasText: tt("session.agentSOwnChoice") })).toHaveCount(3);
    await expect(sessionDecisions.filter({ hasText: tt("session.sourceNotMarked") })).toHaveCount(1);
    await sessionPanel.press("Escape");
    await expect(sessionPanel).toBeHidden();

    const confirmed = decision("Confirm this Agent choice in the Web review queue.");
    await expect(confirmed).toBeVisible();
    await confirmed.getByRole("button", { name: tt("common.confirm") }).click();
    await expect(confirmed).toHaveCount(0);

    const promoted = decision("Promote this Agent choice into Knowledge.");
    await expect(promoted).toBeVisible();
    await promoted.getByRole("button", { name: tt("knowledge.turnIntoKnowledge") }).click();
    const dialog = page.getByRole("dialog", { name: tt("knowledge.turnAgentDecisionIntoKnowledge") });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(tt("knowledge.title")).fill("E2E promoted Agent decision");
    await dialog.getByLabel(tt("common.body")).fill("This decision is promoted with its source Session.");
    await dialog.getByRole("button", { name: tt("knowledge.createAndLinkKnowledge") }).click();
    await expect(dialog).toBeHidden();
    await expect(promoted).toHaveCount(0);

    const rejected = decision("Reject this Agent choice in the Web review queue.");
    await expect(rejected).toBeVisible();
    await rejected.getByRole("button", { name: tt("knowledge.reject") }).click();
    await expect(rejected).toHaveCount(0);

    const reviewed = withAgentStore((store) => store.getSessionDetail(sessionId)?.decisions ?? []);
    expect(reviewed.find((item) => item.text.startsWith("Confirm"))).toMatchObject({ reviewStatus: "confirmed" });
    expect(reviewed.find((item) => item.text.startsWith("Promote"))).toMatchObject({
      reviewStatus: "promoted",
      knowledgeId: expect.any(String),
    });
    expect(reviewed.find((item) => item.text.startsWith("Reject"))).toMatchObject({ reviewStatus: "rejected" });
    const promotedKnowledgeId = reviewed.find((item) => item.reviewStatus === "promoted")?.knowledgeId;
    expect(promotedKnowledgeId).toBeTruthy();
    const promotedKnowledge = withAgentStore((store) =>
      store.searchKnowledge({ projectRoot, query: "E2E promoted Agent decision", limit: 10 }),
    );
    expect(promotedKnowledge).toMatchObject({ outcome: "knowledge", items: [{ sessionId }] });
  });

  test("shows a standing Knowledge page with its sources and keeps a manual edit as a new version", async ({
    page,
  }) => {
    const reviewSourceId = withAgentStore((store) => {
      const finalized = store.finalizeSession({
        projectRoot,
        idempotencyKey: `e2e-knowledge-review-source-${process.pid}`,
        title: "E2E cited source that changes",
        summary: "The page cites this source before it is voided and restored.",
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
      });
      if (finalized.outcome !== "finalized") throw new Error("Expected the cited fixture Session to finalize.");
      return finalized.session.id;
    });
    const saved = withAgentStore((store) => {
      store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
      return store.saveKnowledgePage({
        projectRoot,
        slug: "pitfalls",
        idempotencyKey: `e2e-knowledge-page-${process.pid}`,
        sections: [
          {
            heading: "E2E build order",
            content: "Build the shared packages first.",
            sourceSessionIds: [reviewSourceId],
          },
          { heading: "E2E unknowns", content: "資料不足", sourceSessionIds: [] },
        ],
      });
    });
    expect(saved).toMatchObject({ outcome: "knowledge_page_saved", page: { version: 1 } });

    await page.waitForTimeout(5);
    withAgentStore((store) =>
      store.setSessionVoid({
        sessionId: reviewSourceId,
        voided: true,
        reason: "E2E source review fixture.",
      }),
    );

    await page.goto("/knowledge/pages");
    const row = page.getByTestId("knowledge-page-row").filter({ hasText: "常見陷阱" });
    await expect(row).toContainText(tt("common.upToDate"));
    await expect(row).toContainText(tt("knowledge.sourcesNeedChecking"));
    await expect(row).toContainText("E2E build order");
    await row.getByRole("button", { name: tt("knowledge.view") }).click();
    const panel = page.getByRole("dialog", { name: tt("common.knowledgePages") });
    await expect(panel).toContainText("Build the shared packages first.");
    await expect(panel).toContainText(tt("status.theSourceSessionWasVoided"));
    await expect(panel.getByRole("button", { name: "E2E cited source that changes" }).first()).toBeVisible();

    withAgentStore((store) => store.setSessionVoid({ sessionId: reviewSourceId, voided: false }));
    await page.reload();
    // Selected sources now survive reload through the URL; close the restored panel before reopening it.
    await expect(page.getByRole("dialog", { name: tt("common.knowledgePages") })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: tt("common.knowledgePages") })).toBeHidden();
    await expect(page).not.toHaveURL(/knowledgePage=/);
    const restoredRow = page.getByTestId("knowledge-page-row").filter({ hasText: "常見陷阱" });
    await expect(restoredRow).toContainText(tt("knowledge.sourcesNeedChecking"));
    await restoredRow.getByRole("button", { name: tt("knowledge.view") }).click();
    const restoredPanel = page.getByRole("dialog", { name: tt("common.knowledgePages") });
    await expect(restoredPanel).toContainText(tt("status.theSourceSessionWasRestored"));

    await restoredPanel.getByRole("button", { name: tt("knowledge.editedByHand") }).click();
    const editor = page.getByRole("dialog", { name: tt("knowledge.editKnowledgePage") });
    await editor.getByLabel(tt("common.body")).first().fill("Build the shared packages first, then the apps.");
    await editor.getByRole("button", { name: tt("knowledge.saveNewVersion") }).click();
    await expect(editor).toBeHidden();
    await expect(restoredPanel).toContainText("Build the shared packages first, then the apps.");
    await expect(
      restoredPanel.getByRole("button", { name: ttPattern("knowledge.version", { version: 2 }) }),
    ).toBeVisible();
    await expect(restoredPanel.getByText(tt("knowledge.citedSourcesNeedChecking"))).toHaveCount(0);
    await restoredPanel.getByRole("button", { name: ttPattern("knowledge.version", { version: 1 }) }).click();
    await expect(restoredPanel).toContainText(tt("knowledge.viewingVersion", { shownVersion: 1 }));
    await expect(restoredPanel).toContainText("Build the shared packages first.");
  });

  test("shows and filters new Knowledge page data separately from a required rewrite", async ({ page }) => {
    const { sourceSessionId, sourcedThrough } = withAgentStore((store) => {
      const finalize = (idempotencyKey: string, title: string, summary: string) => {
        const result = store.finalizeSession({
          projectRoot,
          idempotencyKey,
          title,
          summary,
          workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
          changedFiles: [],
          verification: { status: "passed" },
        });
        if (result.outcome !== "finalized") throw new Error("Expected the fixture Session to finalize.");
        return result.session.id;
      };
      const source = finalize(
        `e2e-c2-source-${process.pid}`,
        "E2E Knowledge page source",
        "The page's existing answer.",
      );
      store.requestKnowledgePageUpdate({
        projectRoot,
        slug: "c2-checkpoint",
        title: "E2E review checkpoint",
        question: "What has changed since the answer was saved?",
      });
      const saved = store.saveKnowledgePage({
        projectRoot,
        slug: "c2-checkpoint",
        idempotencyKey: `e2e-c2-page-${process.pid}`,
        sections: [{ heading: "Existing answer", content: "The page's existing answer.", sourceSessionIds: [source] }],
      });
      if (saved.outcome !== "knowledge_page_saved") throw new Error("Expected the C2 page to save.");
      if (!saved.page.sourcedThrough) throw new Error("Expected the saved page to record its source cutoff.");
      return { sourceSessionId: source, sourcedThrough: saved.page.sourcedThrough };
    });
    expect(sourceSessionId).toBeTruthy();

    // Keep the later Session strictly beyond the page's millisecond-precision source cutoff in fast CI runs.
    await expect.poll(() => Date.now()).toBeGreaterThan(Date.parse(sourcedThrough));
    const newSessionId = withAgentStore((store) => {
      const later = store.finalizeSession({
        projectRoot,
        idempotencyKey: `e2e-c2-new-data-${process.pid}`,
        title: "E2E unrelated new data",
        summary: "An unrelated Session to assess.",
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
      });
      if (later.outcome !== "finalized") throw new Error("Expected the new-data fixture Session to finalize.");
      return later.session.id;
    });

    await page.goto("/knowledge/pages");
    const row = page.getByTestId("knowledge-page-row").filter({ hasText: "E2E review checkpoint" });
    await expect(row).toContainText(tt("common.newDataAvailable"));
    await expect(row).toContainText(ttPattern("knowledge.newSessionsToAssessCount"));
    await expect(row).toContainText(ttPattern("knowledge.checkedThroughValue"));
    await expect(row.locator("time")).toHaveAttribute("datetime", sourcedThrough);

    await page.getByRole("button", { name: tt("common.status") }).click();
    await page.getByRole("menuitemradio", { name: tt("common.newDataAvailable") }).click();
    await expect(row).toBeVisible();

    const checked = withAgentStore((store) =>
      store.markKnowledgePageChecked({
        projectRoot,
        slug: "c2-checkpoint",
        throughSessionId: newSessionId,
      }),
    );
    expect(checked).toMatchObject({ outcome: "knowledge_page_checked", page: { version: 1, status: "fresh" } });
    await page.reload();
    await page.getByRole("button", { name: tt("common.status") }).click();
    await page.getByRole("menuitemradio", { name: tt("common.newDataAvailable") }).click();
    await expect(page.getByTestId("knowledge-page-row").filter({ hasText: "E2E review checkpoint" })).toHaveCount(0);
    await page.getByRole("button", { name: tt("common.status") }).click();
    await page.getByRole("menuitemradio", { name: tt("knowledge.allStatuses") }).click();
    const checkedRow = page.getByTestId("knowledge-page-row").filter({ hasText: "E2E review checkpoint" });
    await expect(checkedRow).toContainText(tt("common.upToDate"));
    if (checked.outcome !== "knowledge_page_checked" || !checked.page.checkedThrough) {
      throw new Error("Expected the check cursor to expose its reviewed Session time.");
    }
    await expect(checkedRow.locator("time")).toHaveAttribute("datetime", checked.page.checkedThrough.completedAt);
  });

  test("shows how often Sessions confirmed or contradicted Knowledge and links to them", async ({ page }) => {
    const title = `E2E evidence Knowledge ${process.pid}`;
    const confirmingTitle = `E2E confirming Session ${process.pid}`;
    withAgentStore((store) => {
      const recorded = store.recordKnowledge({
        projectRoot,
        idempotencyKey: `e2e-evidence-knowledge-${process.pid}`,
        kind: "pattern",
        title,
        body: "Evidence counts come from Sessions that applied or contradicted this item.",
      });
      if (recorded.outcome !== "knowledge_recorded") throw new Error("Expected the evidence fixture Knowledge.");
      const finalized = store.finalizeSession({
        projectRoot,
        idempotencyKey: `e2e-evidence-session-${process.pid}`,
        title: confirmingTitle,
        summary: "Applied the evidence fixture Knowledge.",
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
        appliedKnowledgeIds: [recorded.knowledge.id],
      });
      if (finalized.outcome !== "finalized") throw new Error("Expected the evidence fixture Session.");
    });

    await page.goto(`/knowledge?q=${encodeURIComponent(title)}`);
    const row = page.getByTestId("knowledge-row").filter({ hasText: title });
    await row
      .getByRole("button", {
        name: ttPattern("knowledge.confirmedTimesContradictedTimesView", { confirmed: 1, contradicted: 0 }),
      })
      .click();
    const panel = page.getByRole("dialog", { name: tt("knowledge.knowledgeChangeHistory") });
    const feedback = panel.getByTestId("knowledge-feedback");
    await expect(feedback).toContainText(tt("knowledge.confirmedBySession"));
    await feedback.getByRole("button", { name: confirmingTitle }).click();
    await expect(page.getByRole("dialog", { name: tt("session.sessionDetails") })).toContainText(confirmingTitle);
  });

  test("lists hotspot files on the graph page and opens their Sessions", async ({ page }) => {
    await page.goto("/graph/hotspots");
    const hotspots = page.getByTestId("graph-hotspots");
    const readme = hotspots.getByTestId("hotspot").filter({ hasText: "README.md" });
    await expect(readme).toContainText(ttPattern("graph.sessions"));
    await expect(hotspots).toContainText(tt("graph.barSessionsThatChangedIt"));
    await readme.getByText(ttPattern("graph.lastSessions")).click();
    await readme.getByRole("button", { name: "Browser regression fixture session" }).click();
    await expect(page.getByRole("dialog", { name: tt("session.sessionDetails") })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("tab", { name: ttPattern("graph.graph") }).click();
    await expect(page).toHaveURL(/\/graph(\?|$)/);
  });

  test("serves the production Web UI and API from one origin @cross-browser", async ({ page }) => {
    const response = await page.goto("/dashboard");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: tt("nav.workOverview") })).toBeVisible();

    const policy = response?.headers()["content-security-policy"] ?? "";
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("unsafe-eval");

    const health = await page.request.get("/api/health");
    expect(health.ok()).toBeTruthy();
    expect(new URL(health.url()).origin).toBe(new URL(page.url()).origin);
    const healthBody = await health.json();
    expect(healthBody).toMatchObject({
      ok: true,
      database: "connected",
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      schemaVersion: expect.any(Number),
    });
    await expect(page.getByTestId("app-version")).toHaveText(`v${healthBody.version}`);
    await expect(page.getByTestId("schema-version")).toHaveText(`Schema v${healthBody.schemaVersion}`);
  });

  test("shows an empty state when there are no project deletion audits", async ({ page }) => {
    await page.goto("/projects/deletion-audit");
    const deletionAudit = page.getByTestId("project-deletion-audit");
    await expect(deletionAudit).toContainText(tt("projects.noDeletionHistory"));
    await expect(deletionAudit).not.toContainText(tt("projects.couldNotLoadDeletionHistory"));
    for (const width of [1440, 960, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
    }
  });

  test("shows the global API offline banner and refreshes after the API reconnects", async ({ page }) => {
    let dashboardRequestCount = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/dashboard") {
        dashboardRequestCount += 1;
      }
    });
    await page.route("**/api/**", (route) => route.abort());
    await page.goto("/");

    const offlineBanner = page.getByRole("alert").filter({ hasText: tt("app.cannotReachTheWorkIntelligence") });
    await expect(offlineBanner).toBeVisible();
    for (const width of [1440, 960, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(offlineBanner).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
    const failedRequestCount = dashboardRequestCount;

    await page.unroute("**/api/**");
    await expect.poll(() => dashboardRequestCount, { timeout: 15_000 }).toBeGreaterThan(failedRequestCount);
    await expect(offlineBanner).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: tt("nav.workOverview") })).toBeVisible();
  });

  test("keeps the report synthesis card readable with sourced sections and versions", async ({ page, request }) => {
    await page.goto("/");
    await page.getByTestId("nav-reports").click();
    await expect(page.getByRole("heading", { name: tt("nav.workReports") }).first()).toBeVisible();

    const synthesis = page.getByTestId("report-synthesis");
    await expect(synthesis).toBeVisible();
    await expect(synthesis).toContainText("Browser regression report updated");
    await expect(synthesis).toContainText(tt("common.completedStatus"));
    await expect(synthesis).toContainText(tt("common.statusOpenItems"));
    await expect(synthesis.getByRole("button", { name: /1 Session/ }).first()).toBeVisible();
    const history = page.getByTestId("report-synthesis-history");
    await expect(history).toContainText(tt("reports.pastVersions"));
    await history.locator("summary").click();
    await expect(history.getByTestId("report-synthesis-version")).toHaveCount(2);
    await expect(history).toContainText("Browser regression report");

    // The overview's deterministic part changes shape with the period.
    const breakdown = page.getByTestId("report-breakdown");
    await expect(breakdown).toContainText(tt("reports.byDay"));
    await expect(breakdown).toContainText(tt("reports.projectShare"));
    const periods = page.getByRole("radiogroup", { name: tt("reports.chooseReportPeriod") });
    await periods.getByRole("radio", { name: tt("common.day") }).click();
    await expect(breakdown).toContainText(tt("reports.workCompletedThatDay"));
    await periods.getByRole("radio", { name: tt("reports.year") }).click();
    await expect(breakdown).toContainText(tt("reports.byQuarter"));
    await periods.getByRole("radio", { name: tt("common.week") }).click();
    await expect(breakdown).toContainText(tt("reports.byDay"));

    await synthesis.getByRole("button", { name: tt("common.refresh"), exact: true }).click();
    await expect(synthesis).toContainText(tt("common.pending"));
    await expect(synthesis.getByRole("button", { name: tt("reports.cancelThisCleanup") })).toBeVisible();
    await expect(synthesis.getByRole("button", { name: tt("common.copyAgentInstruction") })).toBeVisible();

    // An Agent finishing the request shows up on the open page without a manual refresh.
    const pendingResponse = await request.get(
      `/api/reports/synthesis-requests?period=week&date=${reportDate}&scopeType=all&status=pending`,
    );
    const pending = (await pendingResponse.json()) as { requests: Array<{ id: string }> };
    const agentSummary = await postJson(request, "/api/reports/summaries", {
      requestId: pending.requests[0]?.id,
      title: "Browser regression report by Agent",
      executiveSummary: "Saved while the report page was open.",
      highlights: [
        { title: "Auto refresh", detail: "The page picked this up by itself.", sourceSessionIds: [sessionId] },
      ],
      risks: [],
      decisions: [],
      nextSteps: [],
      sourceSessionIds: [sessionId],
      generatedByAgent: "Playwright fixture",
      promptVersion: "e2e-fixture-v3",
    });
    expect(agentSummary.outcome).toBe("report_summary_saved");
    await expect(page.getByText(tt("reports.theAgentFinishedTheAi"))).toBeVisible({ timeout: 15_000 });
    await expect(synthesis).toContainText("Browser regression report by Agent");

    await page.getByRole("tab", { name: tt("labels.rawRecords") }).click();
    const reportSessionPageSize = page.getByLabel(tt("reports.rawReportRecordsPerPage"));
    await expect(reportSessionPageSize).toHaveValue("10");
    await expect(reportSessionPageSize.locator("option")).toHaveCount(5);
    await reportSessionPageSize.selectOption("all");
    await expectBoundedVirtualList(page, tt("reports.rawReportRecordsList"));

    await page.getByRole("tab", { name: tt("labels.evidence") }).click();
    const reportEvidencePageSize = page.getByLabel(tt("reports.reportEvidencePerPage"));
    await expect(reportEvidencePageSize).toHaveValue("10");
    await expect(reportEvidencePageSize.locator("option")).toHaveCount(5);
    await reportEvidencePageSize.selectOption("all");
    await expectBoundedVirtualList(page, tt("reports.reportEvidenceList"));
  });

  test("builds a report for a custom date range", async ({ page }) => {
    for (const width of [1440, 960, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/reports");
      await expect(page.getByTestId("report-breakdown")).toBeVisible();
      const periodControl = page.getByTestId("report-period-date-control");
      const controlBounds = () =>
        periodControl.evaluate((element) => {
          const { x, y, width: controlWidth, height } = element.getBoundingClientRect();
          return { x, y, width: controlWidth, height };
        });
      const defaultBounds = await controlBounds();

      if (width === 1440) {
        const periodSelector = page.getByRole("radiogroup", { name: tt("reports.chooseReportPeriod") });
        for (const period of [
          tt("common.day"),
          tt("common.week"),
          tt("common.month"),
          tt("reports.quarter"),
          tt("reports.year"),
        ]) {
          await periodSelector.getByRole("radio", { name: period, exact: true }).click();
          await periodControl.getByRole("button").click();
          const datePicker = page.getByRole("dialog", { name: tt("reports.chooseReportDate") });
          await expect(datePicker.getByRole("button", { name: reportDate })).toBeVisible();
          await datePicker.getByRole("button", { name: reportDate }).click();
          await expect(datePicker).toHaveCount(0);
        }
        expect(await controlBounds()).toEqual(defaultBounds);
      }

      await page
        .getByRole("radiogroup", { name: tt("reports.chooseReportPeriod") })
        .getByRole("radio", { name: tt("reports.custom") })
        .click();
      // Switching to a custom range starts from the last 14 days without a transient invalid query.
      await expect(page).toHaveURL(
        /period=custom.*from=\d{4}-\d{2}-\d{2}.*to=\d{4}-\d{2}-\d{2}|period=custom.*to=.*from=/,
      );
      await expect(
        page.getByText(ttPattern("reports.periodSummary", { value: tt("common.customRange") })),
      ).toBeVisible();
      await expect(page.getByTestId("report-breakdown")).toContainText(tt("reports.byDay"));
      await expect(page.getByText(tt("reports.chooseTheStartAndEnd"), { exact: true })).toHaveCount(0);
      expect(await controlBounds()).toEqual(defaultBounds);

      await periodControl.getByRole("button").click();
      const picker = page.getByRole("dialog", { name: tt("ui.chooseDateRange") });
      await expect(picker.getByRole("button", { name: tt("ui.anyDate"), exact: true })).toHaveCount(0);
      await picker.getByRole("button", { name: tt("ui.last7Days"), exact: true }).click();
      await expect(page.getByTestId("report-breakdown")).toContainText(tt("reports.byDay"));
      expect(await controlBounds()).toEqual(defaultBounds);

      await periodControl.getByRole("button").click();
      const calendarDays = picker.locator(".ui-date-range__grid button");
      await calendarDays.nth(10).click();
      await expect(picker).toContainText(ttPattern("ui.startsChooseAnEndDate"));
      await calendarDays.nth(12).click();
      await expect(picker).toHaveCount(0);
      await expect(page.getByTestId("report-breakdown")).toContainText(tt("reports.byDay"));
      await expect(page.getByText(tt("reports.chooseTheStartAndEnd"), { exact: true })).toHaveCount(0);
      expect(await controlBounds()).toEqual(defaultBounds);
    }

    await expect(
      page.getByTestId("report-synthesis").getByRole("button", { name: tt("reports.askAgentToSynthesizeThis") }),
    ).toBeEnabled();

    await page.goto(`/reports?period=custom&from=${reportDate}&to=${reportDate}`);
    await expect(page.getByTestId("report-breakdown")).toContainText(tt("reports.byDay"));
    await expect(
      page.getByText(
        ttPattern("reports.periodSummary", { value: tt("common.customRange"), from: reportDate, to: reportDate }),
      ),
    ).toBeVisible();

    await page.goto("/reports?period=custom");
    await expect(page.getByTestId("report-breakdown")).toContainText(tt("reports.byDay"));
    await expect(page).toHaveURL(/period=custom.*from=\d{4}-\d{2}-\d{2}.*to=\d{4}-\d{2}-\d{2}/);

    await page.goto(`/reports?period=custom&from=${reportDate}`);
    await expect(page.getByTestId("report-breakdown")).toContainText(tt("reports.byDay"));
    await expect(page).toHaveURL(/period=custom.*from=\d{4}-\d{2}-\d{2}.*to=\d{4}-\d{2}-\d{2}/);
  });

  test("keeps Worklog and Knowledge page-size controls at the intended default", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-sessions").click();
    await expect(page.getByRole("heading", { name: tt("common.workHistory") }).first()).toBeVisible();

    const sessionPageSize = page.getByLabel(tt("sessions.workHistoryPerPage"));
    await expect(sessionPageSize).toHaveValue("10");
    await expect(sessionPageSize.locator("option")).toHaveCount(5);
    await sessionPageSize.selectOption("20");
    await expect(sessionPageSize).toHaveValue("20");
    await sessionPageSize.selectOption("all");
    const sessionList = await expectBoundedVirtualList(page, tt("sessions.workHistoryList"));
    // The virtual list places rows by estimated heights first and corrects them once ResizeObserver has
    // measured them, so wait for the layout to settle instead of sampling a single frame.
    await expect
      .poll(() =>
        sessionList.getByTestId("session-row").evaluateAll((rows) => {
          const boxes = rows.map((row) => row.getBoundingClientRect());
          return Math.max(0, ...boxes.slice(1).map((box, index) => (boxes[index]?.bottom ?? 0) - box.top));
        }),
      )
      .toBeLessThanOrEqual(1);

    await page.getByTestId("nav-knowledge").click();
    await expect(page.getByRole("heading", { name: tt("common.workKnowledge") }).first()).toBeVisible();
    const knowledgePageSize = page.getByLabel(tt("knowledge.knowledgePerPage"));
    await expect(knowledgePageSize).toHaveValue("10");
    await expect(knowledgePageSize.locator("option")).toHaveCount(5);
    await knowledgePageSize.selectOption("all");
    await expectBoundedVirtualList(page, tt("knowledge.workKnowledgeList"));
  });

  test("keeps Graph filters and source detail navigation available", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-graph").click();
    await expect(page.getByRole("heading", { name: tt("nav.workGraph") }).first()).toBeVisible();

    const nodeFilter = page.getByLabel(tt("graph.chooseGraphNodeKind"));
    const previewLimit = page.getByLabel(tt("graph.chooseGraphPreviewSize"));
    const loadPreset = page.getByLabel(tt("graph.chooseGraphLoadLimit"));
    await expect(nodeFilter).toHaveValue("all");
    await expect(previewLimit).toHaveValue("120");
    await expect(loadPreset).toHaveValue("180");
    await nodeFilter.selectOption("session");
    await previewLimit.selectOption("60");
    await page.getByRole("button", { name: tt("graph.updateGraph") }).click();
    const visibleCount = page.getByTestId("graph-visible-count");
    await expect(visibleCount).toContainText(tt("graph.nodes"));

    const graphViewport = page.getByTestId("graph-viewport");
    const graphLaneHeader = page.getByTestId("graph-lane-header");
    await expect(graphLaneHeader).toBeVisible();
    const graphDisplayedNodeCount = Number(
      (await visibleCount.innerText()).match(
        new RegExp(tt("graph.showingNodes").replace("{length}", "(\\d+)").replace("{graphFilteredTotalNodes}", "\\d+")),
      )?.[1] ?? 0,
    );
    const graphNodes = graphViewport.getByRole("button", { name: ttPattern("graph.view") });
    const graphRenderedNodeCount = await graphNodes.count();
    expect(graphDisplayedNodeCount).toBeGreaterThan(graphRenderedNodeCount);
    const headerTopBeforeScroll = await graphLaneHeader.evaluate((element) => element.getBoundingClientRect().top);
    await graphViewport.evaluate((element) => {
      element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight);
    });
    const headerTopAfterScroll = await graphLaneHeader.evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(headerTopAfterScroll - headerTopBeforeScroll)).toBeLessThan(2);

    await expect(graphNodes.first()).toBeVisible();
    await graphNodes.first().click();
    await expect(page.getByRole("button", { name: tt("graph.closeGraphNodeDetails") })).toBeVisible();
    await page.getByRole("button", { name: tt("graph.closeGraphNodeDetails") }).click();
  });

  test("keeps Session detail usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: tt("layout.openMainMenu") }).click();
    await page.getByTestId("nav-sessions").click();
    await expect(page.getByTestId("nav-sessions")).not.toBeInViewport();
    const firstRow = page.getByTestId("session-row").filter({ hasText: "Browser regression fixture session" }).first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();
    const detail = page.getByRole("dialog");
    await expect(detail).toBeVisible();
    const workSummary = page.getByTestId("session-work-summary");
    await expect(workSummary).toContainText(tt("labels.outcomes"));
    await expect(workSummary).toContainText("The browser fixture remains readable.");
    await expect(workSummary).toContainText(tt("common.statusOpenItems"));

    await expect(detail).toBeInViewport({ ratio: 1 });
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: tt("common.close"), exact: true }).click();
    await expect(detail).toBeHidden();
  });

  test("keeps every page free of horizontal overflow on narrow viewports", async ({ page }) => {
    for (const width of [640, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [path, heading] of pageRoutes) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }
    }
  });

  test("keeps every page free of horizontal overflow in English, whose copy runs longer", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("work-intelligence:locale", "en-US"));
    for (const width of [640, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [path] of pageRoutes) {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
        await expect(page.getByRole("heading").first()).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }
    }
  });

  test("supports direct page routes @cross-browser", async ({ page }) => {
    for (const [path, heading] of pageRoutes) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }

    await page.goto("/worklog");
    await expect(page).toHaveURL(/\/sessions$/);
    await expect(page.getByRole("heading", { name: tt("common.workHistory") }).first()).toBeVisible();
  });

  test("shows the read-only system status page", async ({ page }) => {
    await page.goto("/system-status");
    await expect(page.getByRole("heading", { name: tt("nav.systemStatus") })).toBeVisible();
    await expect(page.getByText(tt("systemStatus.appVersion"))).toBeVisible();
    await expect(page.getByText(tt("systemStatus.databaseSize"))).toBeVisible();
    await expect(page.getByText(tt("systemStatus.sseConnection"))).toBeVisible();
    await expect(page.getByText(tt("systemStatus.latestAutomaticBackup"), { exact: true })).toBeVisible();
    await expect(page.getByText(tt("systemStatus.latestDataMaintenance"), { exact: true })).toBeVisible();
    await expect(page.getByText("pnpm run doctor").first()).toBeVisible();
    const userService = page.getByTestId("user-service");
    await expect(userService).toBeVisible();
    await expect(userService.getByText(tt("systemStatus.startAtLogin"), { exact: true })).toBeVisible();
    await expect(userService.getByText(tt("systemStatus.serviceConfiguration"), { exact: true })).toBeVisible();
    await expect(userService.getByText(tt("systemStatus.serviceLog"), { exact: true })).toBeVisible();
    const agentConnections = page.getByTestId("agent-connections");
    await expect(agentConnections.getByText("Codex", { exact: true })).toBeVisible();
    await expect(agentConnections.getByText("Claude Code", { exact: true })).toBeVisible();
    await expect(agentConnections.getByText(tt("status.mcpRegistration"), { exact: true })).toHaveCount(2);
    await expect(agentConnections.getByText(tt("status.globalHook"), { exact: true })).toHaveCount(2);
    await expect(page.getByTestId("agent-mcp-reconnect")).toContainText(tt("systemStatus.reconnect"));

    for (const width of [1440, 960, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
    }
  });

  test("guides first-run setup only while a project or Session is missing and passes axe @accessibility", async ({
    page,
  }) => {
    let mode: "no-project" | "no-session" | "complete" = "no-project";
    const mutatingRequests: string[] = [];
    const disconnectedAgents: SystemAgentConnections = {
      codex: { mcpRegistered: "missing", canonicalSkill: "missing", legacySkill: "missing", hook: "missing" },
      claudeCode: { mcpRegistered: "missing", skill: "missing", hook: "missing" },
    };
    page.on("request", (request) => {
      if (request.url().includes("/api/") && request.method() !== "GET") {
        mutatingRequests.push(`${request.method()} ${request.url()}`);
      }
    });
    await page.route("**/api/dashboard", async (route) => {
      const response = await route.fetch();
      const summary = (await response.json()) as {
        trackedProjects: number;
        finalizedSessions: number;
        recentSessions: unknown[];
      };
      if (mode !== "complete") {
        summary.trackedProjects = mode === "no-session" ? 1 : 0;
        summary.finalizedSessions = 0;
        summary.recentSessions = [];
      }
      await route.fulfill({ response, json: summary });
    });
    await page.route("**/api/projects", async (route) => {
      if (mode === "no-project") {
        await route.fulfill({ json: [] });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/system/status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          mcp: {
            restartRequired: false,
            monitoringAvailable: false,
            activeProcesses: 0,
            outdatedProcesses: 0,
            updateAvailableProcesses: 0,
          },
          agents: disconnectedAgents,
        }),
      });
    });

    await page.goto("/dashboard");
    const checklist = page.getByTestId("first-run-checklist");
    await expect(checklist).toBeVisible();
    await expect(checklist.getByTestId("first-run-step-project")).toContainText(tt("status.toDo"));
    await expect(checklist.getByTestId("first-run-step-tracking")).toContainText(tt("status.toDo"));
    await expect(checklist.getByTestId("first-run-step-agent")).toContainText(tt("status.toDo"));
    await expect(checklist.getByRole("link", { name: tt("common.addProject") })).toHaveAttribute("href", "/projects");
    await expect(checklist.getByRole("button", { name: tt("dashboard.copyInstallCommand") })).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual(
      [],
    );

    mode = "no-session";
    await page.reload();
    await expect(page.getByTestId("first-run-step-project")).toContainText(tt("common.completedStatus"));
    await expect(page.getByTestId("first-run-step-tracking")).toContainText(tt("common.completedStatus"));
    await expect(page.getByTestId("first-run-step-session")).toContainText(tt("status.toDo"));
    await expect(page.getByText(tt("dashboard.pleaseSummarizeTheWorkJust"))).toBeVisible();

    mode = "complete";
    await page.reload();
    await expect(page.getByTestId("first-run-checklist")).toHaveCount(0);
    expect(mutatingRequests).toEqual([]);
  });

  test("shows stale MCP connections and refreshes them from the system status API", async ({ page }) => {
    let statusRequests = 0;
    const mcpStatuses = [
      {
        restartRequired: true,
        monitoringAvailable: true,
        activeProcesses: 2,
        outdatedProcesses: 1,
        updateAvailableProcesses: 0,
        message: "磁碟上的 Work Intelligence MCP 建置已更新，請重新連線 MCP。",
      },
      {
        restartRequired: false,
        updateAvailable: true,
        monitoringAvailable: true,
        activeProcesses: 2,
        outdatedProcesses: 0,
        updateAvailableProcesses: 1,
        message: "MCP 有新版可用，仍可照常讀寫。",
      },
      {
        restartRequired: false,
        monitoringAvailable: true,
        activeProcesses: 1,
        outdatedProcesses: 0,
        updateAvailableProcesses: 0,
        message: "所有可監測的 MCP 連線都是目前建置。",
      },
      {
        restartRequired: false,
        monitoringAvailable: false,
        activeProcesses: 0,
        outdatedProcesses: 0,
        updateAvailableProcesses: 0,
        message: "無法確認 MCP heartbeat 狀態。",
      },
      {
        restartRequired: false,
        monitoringAvailable: true,
        activeProcesses: 0,
        outdatedProcesses: 0,
        updateAvailableProcesses: 0,
        message: "尚無可監測的 MCP 連線。",
      },
    ];
    await page.route("**/api/system/status", async (route) => {
      const response = await route.fetch();
      const status = (await response.json()) as { mcp: Record<string, unknown> };
      statusRequests += 1;
      await route.fulfill({
        response,
        json: {
          ...status,
          mcp: mcpStatuses[Math.min(statusRequests - 1, mcpStatuses.length - 1)],
        },
      });
    });

    await page.goto("/system-status");
    await expect(page.getByText(tt("systemStatus.mcpNeedsToReconnect"))).toBeVisible();
    await expect(
      page
        .getByTestId("mcp-connection")
        .getByText("磁碟上的 Work Intelligence MCP 建置已更新，請重新連線 MCP。", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: tt("systemStatus.refreshStatus") }).click();
    await expect(page.getByTestId("agent-mcp-reconnect")).toContainText(tt("status.updateAvailable"));
    await expect(page.getByText(tt("systemStatus.mcpNeedsToReconnect"))).toHaveCount(0);
    const mcpCard = page.getByTestId("mcp-connection");
    await expect(mcpCard.getByText(tt("systemStatus.processesWithAnUpdateAvailable"))).toBeVisible();
    await expect(
      mcpCard.getByText(tt("systemStatus.outdatedProcessCount", { outdatedProcesses: 1 }), { exact: true }),
    ).toBeVisible();
    await expect(
      mcpCard.getByText(tt("systemStatus.updateAvailableProcessCount", { updateAvailableProcesses: 0 }), {
        exact: true,
      }),
    ).toBeVisible();
    for (const width of [1440, 960, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }

    await page.getByRole("button", { name: tt("systemStatus.refreshStatus") }).click();
    await expect(page.getByText(tt("systemStatus.mcpNeedsToReconnect"))).toHaveCount(0);
    await expect(page.getByText(tt("status.currentVersion"))).toBeVisible();
    await expect(page.getByTestId("agent-mcp-reconnect")).toContainText(tt("status.noReconnectNeeded"));

    await page.getByRole("button", { name: tt("systemStatus.refreshStatus") }).click();
    await expect(page.getByTestId("agent-mcp-reconnect")).toContainText(tt("status.cannotConfirm"));

    await page.getByRole("button", { name: tt("systemStatus.refreshStatus") }).click();
    await expect(page.getByTestId("agent-mcp-reconnect")).toContainText(tt("status.noConnectionsToConfirmYet"));
    expect(statusRequests).toBeGreaterThanOrEqual(4);
  });

  test("has no critical or serious axe violations on primary and management pages @accessibility", async ({ page }) => {
    test.setTimeout(90_000);
    const failures: string[] = [];

    for (const [path, heading] of accessibilityRoutes) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();

      const { violations } = await new AxeBuilder({ page }).analyze();
      for (const violation of violations) {
        if (violation.impact !== "critical" && violation.impact !== "serious") continue;

        const selectors = violation.nodes.map((node) => node.target.join(" ")).join("; ");
        failures.push(`${path}: ${violation.id} — ${violation.help}${selectors ? ` (${selectors})` : ""}`);
      }
    }

    expect(failures, `axe found critical or serious accessibility issues:\n${failures.join("\n")}`).toEqual([]);
  });

  test("has no critical or serious axe violations in the light theme @accessibility", async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => window.localStorage.setItem("work-intelligence:theme", "light"));
    const failures: string[] = [];

    for (const [path, heading] of accessibilityRoutes) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

      const { violations } = await new AxeBuilder({ page }).analyze();
      for (const violation of violations) {
        if (violation.impact !== "critical" && violation.impact !== "serious") continue;

        const selectors = violation.nodes.map((node) => node.target.join(" ")).join("; ");
        failures.push(`${path}: ${violation.id} — ${violation.help}${selectors ? ` (${selectors})` : ""}`);
      }
    }

    expect(failures, `axe found critical or serious accessibility issues:\n${failures.join("\n")}`).toEqual([]);
  });

  test("switches the interface language and theme from the header and remembers both", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: tt("nav.workOverview") }).first()).toBeVisible();

    await page.getByRole("button", { name: LANGUAGE_NAMES["zh-TW"] }).click();
    await page.getByRole("menuitemradio", { name: LANGUAGE_NAMES["en-US"] }).click();
    await expect(page.getByRole("heading", { name: textIn("en-US", "nav.workOverview") }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: textIn("en-US", "common.workHistory") }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");

    const theme = await page.locator("html").getAttribute("data-theme");
    const next = theme === "dark" ? "light" : "dark";
    await page
      .getByRole("button", {
        name: textIn("en-US", next === "light" ? "common.switchToLightTheme" : "common.switchToDarkTheme"),
      })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", next);

    await page.reload();
    await expect(page.getByRole("heading", { name: textIn("en-US", "nav.workOverview") }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", next);

    await page.goto("/system-status");
    const preferences = page.getByTestId("preferences");
    await preferences.getByRole("radio", { name: LANGUAGE_NAMES["zh-TW"] }).click();
    await expect(page.getByRole("heading", { name: tt("nav.systemStatus") }).first()).toBeVisible();
    await preferences.getByRole("radio", { name: tt("systemStatus.followSystem") }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
  });

  test("opens the Session panel from a ?session deep link and closes it", async ({ page }) => {
    await page.goto(`/sessions?session=${sessionId}`);
    const panel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Browser regression fixture session");
    await expect(panel).toContainText(tt("session.changedFilesAreNotGit"));
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page).not.toHaveURL(/session=/);
  });

  test("shows the count of masked sensitive values in Session details", async ({ page, request }) => {
    const token = `ghp_${"X".repeat(36)}`;
    const result = await postJson<{ session: SessionRecord; redactions: { total: number } }>(
      request,
      "/api/work/finalize",
      {
        projectRoot,
        idempotencyKey: `browser-regression-redaction-${process.pid}`,
        title: `Redaction fixture ${token}`,
        summary: `Sensitive summary ${token}`,
        changedFiles: [],
        verification: { status: "passed" },
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      },
    );
    expect(result.redactions.total).toBe(2);

    await page.goto(`/sessions?session=${result.session.id}`);
    const panel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    await expect(
      panel.getByRole("status").filter({ hasText: tt("session.sensitiveValuesRedacted", { redactionCount: 2 }) }),
    ).toHaveText(tt("session.sensitiveValuesRedacted", { redactionCount: 2 }));
    await expect(panel).not.toContainText(token);
  });

  test("edits a Session summary and workSummary in place from the panel", async ({ page, request }) => {
    const editable = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `browser-regression-editable-${process.pid}`,
      title: "Editable fixture session",
      summary: "Original editable summary.",
      workSummary: {
        outcomes: ["Original outcome."],
        scope: ["Original scope."],
        decisions: [],
        verification: [],
        nextSteps: [],
      },
      changedFiles: [],
      verification: { status: "not_run" },
    });
    const editableId = editable.session.id;

    await page.goto(`/sessions?session=${editableId}`);
    const panel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    await expect(panel).toContainText("Original editable summary.");
    await panel.getByRole("button", { name: tt("session.editSession") }).click();

    const editor = page.getByRole("dialog", { name: tt("session.editSession") });
    await expect(editor).toBeVisible();
    await editor.getByLabel(tt("session.title")).fill("Edited fixture title");
    await editor.getByLabel(tt("session.summary")).fill("Edited summary from the Web UI.");
    await editor.getByLabel(tt("labels.outcomes")).fill("Edited outcome one.\nEdited outcome two.");
    await editor.getByLabel(tt("session.verificationStatus")).selectOption("passed");
    await editor.getByLabel(tt("session.verificationNotes")).fill("Ran pnpm test after the fix.");
    await editor.getByRole("button", { name: tt("common.saveChanges") }).click();

    await expect(editor).toBeHidden();
    await expect(panel.getByRole("heading", { name: "Edited fixture title" })).toBeVisible();
    await expect(panel).toContainText("Edited summary from the Web UI.");
    await expect(panel).toContainText("Edited outcome two.");
    // Untouched sections are patched around, not cleared.
    await expect(panel).toContainText("Original scope.");

    await expect(panel).toContainText(tt("session.verificationChangeHistory"));

    const detail = (await (await request.get(`/api/sessions/${editableId}`)).json()) as {
      session: { id: string; title: string; summary: string; workSummary: { outcomes: string[]; scope: string[] } };
      verificationHistory: Array<{ source: string; previous?: { status: string }; resulting: { status: string } }>;
    };
    expect(detail.session).toMatchObject({
      id: editableId,
      title: "Edited fixture title",
      summary: "Edited summary from the Web UI.",
      workSummary: { outcomes: ["Edited outcome one.", "Edited outcome two."], scope: ["Original scope."] },
      verification: { status: "passed", summary: "Ran pnpm test after the fix." },
    });
    expect(detail.verificationHistory).toEqual([
      expect.objectContaining({
        source: "web",
        previous: { status: "not_run" },
        resulting: expect.objectContaining({ status: "passed" }),
      }),
    ]);
  });

  test("voids a Session from the panel, lists it under the voided filter, and restores it", async ({
    page,
    request,
  }) => {
    const target = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `browser-regression-voidable-${process.pid}`,
      title: "Voidable fixture session",
      summary: "Recorded by mistake.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "not_run" },
    });
    const targetId = target.session.id;

    await page.goto(`/sessions?session=${targetId}`);
    const panel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    await panel.getByRole("button", { name: tt("session.voidSession") }).click();
    const dialog = page.getByRole("dialog", { name: tt("session.voidSession") });
    await dialog.getByLabel(tt("session.reasonLabel")).fill("Recorded while testing.");
    await dialog.getByRole("button", { name: tt("common.void"), exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(panel).toContainText(tt("session.thisSessionIsVoided"));
    await expect(panel).toContainText("Recorded while testing.");

    await page.goto("/sessions?voided=only");
    await expect(page.getByTestId("session-row").filter({ hasText: "Voidable fixture session" })).toBeVisible();
    await page.goto("/sessions");
    await expect(page.getByTestId("session-row").filter({ hasText: "Voidable fixture session" })).toHaveCount(0);

    await page.goto(`/sessions?session=${targetId}`);
    await panel.getByRole("button", { name: tt("session.restore") }).click();
    await page
      .getByRole("dialog", { name: tt("session.restoreThisSession") })
      .getByRole("button", { name: tt("session.restore") })
      .click();
    await expect(panel).not.toContainText(tt("session.thisSessionIsVoided"));
    await expect(panel.getByRole("button", { name: tt("session.voidSession") })).toBeVisible();
  });

  test("permanently deletes a voided Session from the panel after a danger confirmation", async ({ page, request }) => {
    const target = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `browser-regression-deletable-${process.pid}`,
      title: "Deletable fixture session",
      summary: "Recorded as a test.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: ["Fixture item."] },
      changedFiles: [],
      verification: { status: "not_run" },
    });
    const targetId = target.session.id;
    const voided = await request.patch(`/api/sessions/${targetId}/void`, {
      data: { voided: true, reason: "Recorded as a test." },
    });
    expect(voided.ok()).toBe(true);

    await page.goto(`/sessions?session=${targetId}`);
    const panel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    await expect(panel).toContainText(tt("session.thisSessionIsVoided"));
    await panel.getByRole("button", { name: tt("session.deletePermanently") }).click();
    const confirm = page.getByRole("dialog", { name: tt("session.deleteSessionPermanently") });
    await expect(confirm).toContainText("Deletable fixture session");
    await confirm.getByRole("button", { name: tt("session.deletePermanently") }).click();

    await expect(panel).toBeHidden();
    expect((await request.get(`/api/sessions/${targetId}`)).status()).toBe(404);
    await page.goto("/sessions?voided=only");
    await expect(page.getByTestId("session-row").filter({ hasText: "Deletable fixture session" })).toHaveCount(0);

    // The deletion wrote a pre-deletion snapshot; remove it so later backup tests start from an empty list.
    const backups = (await (await request.get("/api/backups")).json()) as {
      backups: Array<{ kind: string; fileName: string }>;
    };
    const snapshot = backups.backups.find((backup) => backup.kind === "session_deletion");
    expect(snapshot).toBeDefined();
    const removed = await request.delete(`/api/backups/${encodeURIComponent(snapshot?.fileName ?? "")}`, {
      data: {},
    });
    expect(removed.ok()).toBe(true);
  });

  test("links two Sessions from the panel and shows the link on both sides", async ({ page, request }) => {
    await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `browser-regression-link-plan-${process.pid}`,
      title: "Linkable planning session",
      summary: "Planned the work.",
      changedFiles: [],
      verification: { status: "not_run" },
    });
    const build = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `browser-regression-link-build-${process.pid}`,
      title: "Linkable implementation session",
      summary: "Implemented the plan.",
      changedFiles: [],
      verification: { status: "not_run" },
    });

    await page.goto(`/sessions?session=${build.session.id}`);
    const panel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    const links = panel.getByTestId("session-links");
    await links.getByText(tt("session.linkedSessions")).click();
    await links.getByRole("button", { name: tt("session.addLink") }).click();
    const dialog = page.getByRole("dialog", { name: tt("session.addSessionLink") });
    await dialog.getByLabel(tt("session.searchForASessionTo")).fill("Linkable planning");
    await dialog.getByLabel(/Linkable planning session/).check();
    await dialog.getByRole("button", { name: tt("session.createLink") }).click();
    await expect(dialog).toBeHidden();
    await expect(links).toContainText(tt("labels.continues"));

    await links.getByRole("link", { name: "Linkable planning session" }).click();
    await expect(panel).toContainText("Linkable planning session");
    await expect(panel.getByTestId("session-links")).toContainText(tt("labels.continuedBy"));
    await expect(panel.getByTestId("session-links")).toContainText("Linkable implementation session");
  });

  test("resizes the Session panel from its edge and remembers the width", async ({ page }) => {
    await page.goto(`/sessions?session=${sessionId}`);
    const panel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    await expect(panel).toBeVisible();
    const handle = panel.getByRole("separator", { name: tt("ui.resize", { label: tt("session.sessionDetails") }) });
    const before = (await panel.boundingBox())?.width ?? 0;
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(before + 40);
    const resized = Number(await handle.getAttribute("aria-valuenow"));

    await page.reload();
    await expect(panel).toBeVisible();
    await expect(handle).toHaveAttribute("aria-valuenow", String(resized));
  });

  test("searches the Graph and focuses the first hit", async ({ page }) => {
    await page.goto("/graph");
    const search = page.getByLabel(tt("graph.searchGraphNodes"));
    await search.fill("Browser regression fixture");
    await expect(page.getByTestId("graph-visible-count")).toContainText(ttPattern("graph.matchingNodesShowingNodes"));
    await expect(page).toHaveURL(/q=Browser/);
    await search.press("Enter");
    await expect(page.getByRole("button", { name: tt("graph.closeGraphNodeDetails") })).toBeVisible();
    await expect(page.getByTestId("graph-viewport").getByRole("button", { pressed: true })).toHaveCount(1);

    await search.fill("zz-no-such-graph-node");
    await expect(page.getByText(tt("graph.noMatchingNodes"))).toBeVisible();
  });

  test("explains the relation between two graph nodes and shows the edge legend", async ({ page }) => {
    await page.goto("/graph?q=Browser%20regression%20fixture%20session");
    await expect(page.getByText(tt("graph.recordedRelationships"))).toBeVisible();
    await expect(page.getByText(ttPattern("graph.derivedRelationshipsChangedTogetherHidden"))).toBeVisible();
    await page.getByLabel(tt("graph.searchGraphNodes")).press("Enter");
    const pathSection = page.getByTestId("graph-path");
    const target = pathSection.getByLabel(tt("graph.chooseANodeToFind"));
    await target.selectOption({
      label: tt("graph.nodeKindAndLabel", { value: tt("labels.changedFiles"), value2: "README.md" }),
    });
    await pathSection.getByRole("button", { name: tt("graph.findPath") }).click();
    const steps = pathSection.getByRole("list", { name: tt("graph.connectionPath") });
    await expect(steps.getByRole("listitem")).toHaveCount(1);
    await expect(steps).toContainText("修改了 README.md");

    await page.getByTestId("graph-show-derived").check();
    await expect(page).toHaveURL(/\/graph/);
  });

  test("shows days on the timeline, zooms into one, opens a Session, and offers the same data as a list", async ({
    page,
  }) => {
    await page.goto("/graph/timeline");
    const timeline = page.getByTestId("graph-timeline");
    // The 30-day range opens as one column per day; clicking a day zooms in to single Sessions.
    await timeline
      .getByTestId("timeline-day")
      .filter({ hasText: /^Browser Regression Fixture，/ })
      .last()
      .click();
    await expect(timeline.getByTestId("timeline-day")).toHaveCount(0);
    const bar = timeline.getByRole("button", { name: /Browser regression fixture session/ }).first();
    await expect(bar).toBeVisible();
    await bar.click();
    const detail = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    await expect(detail).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();

    await timeline.getByRole("radio", { name: tt("common.list") }).click();
    const list = timeline.getByTestId("timeline-list");
    await expect(list.getByRole("button", { name: "Browser regression fixture session" }).first()).toBeVisible();
  });

  test("opens changed files in the chosen editor and links a repository safely", async ({ page }) => {
    await page.goto("/system-status");
    await page
      .getByTestId("preferences")
      .getByLabel(tt("systemStatus.editorUsedToOpenFiles"))
      .selectOption({ label: "VS Code" });

    await page.goto(`/sessions?session=${sessionId}`);
    const panel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    const open = panel.getByTestId("open-in-editor").first();
    await expect(open).toHaveAttribute("href", /^vscode:\/\/file\/.+README\.md$/);
    await expect(open).toHaveAttribute("rel", "noopener noreferrer");
    await page.keyboard.press("Escape");

    await page.goto("/projects");
    const row = page.getByTestId("project-row").filter({ hasText: "Browser Regression Fixture" });
    await row
      .getByRole("button", { name: tt("projects.setRepositoryUrlLabel", { name: "Browser Regression Fixture" }) })
      .click();
    const dialog = page.getByRole("dialog", { name: tt("projects.repositoryUrl") });
    await dialog.getByLabel(tt("projects.url")).fill("http://example.test/repo");
    await dialog.getByRole("button", { name: tt("common.save") }).click();
    await expect(dialog).toContainText("https://");
    await dialog.getByLabel(tt("projects.url")).fill("https://example.test/fixture/repo");
    await dialog.getByRole("button", { name: tt("common.save") }).click();
    await expect(dialog).toBeHidden();
    const link = row.getByRole("link", { name: "https://example.test/fixture/repo" });
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");

    // Leave the shared fixture as it was for later tests.
    await page.goto("/system-status");
    await page
      .getByTestId("preferences")
      .getByLabel(tt("systemStatus.editorUsedToOpenFiles"))
      .selectOption({ label: tt("labels.none") });
  });

  test("reads grouped architecture cards, sources, local relations and authored paths under CSP @cross-browser", async ({
    page,
    browserName,
  }) => {
    test.setTimeout(90_000);
    const cspMessages: string[] = [];
    page.on("console", (message) => {
      if (/content security policy|refused to apply inline style/i.test(message.text()))
        cspMessages.push(message.text());
    });
    const maliciousLabel = "API <img src=x onerror=alert(1)>";
    const diagramSessionId = withAgentStore((store) => {
      const result = store.finalizeSession({
        projectRoot,
        idempotencyKey: `architecture-${process.pid}`,
        title: "Architecture reader fixture",
        summary: "Grouped architecture snapshot",
        changedFiles: [],
        verification: { status: "passed" },
        diagrams: [
          {
            title: "WorkLog architecture",
            kind: "architecture",
            formatVersion: 1,
            source: JSON.stringify({
              version: 1,
              nodes: [
                {
                  id: "web",
                  label: "Web UI",
                  groupId: "client",
                  description: "Displays saved Sessions",
                  position: { x: 40, y: 80 },
                  source: { path: "apps/web/src/App.vue", line: 1 },
                },
                {
                  id: "mcp",
                  label: "MCP",
                  groupId: "client",
                  description: "Validates Agent writes",
                  position: { x: 40, y: 260 },
                },
                {
                  id: "api",
                  label: maliciousLabel,
                  groupId: "server",
                  description: "REST routes and policy",
                  position: { x: 340, y: 80 },
                  source: { path: "apps/server/src/server.ts", line: 22 },
                },
                { id: "schema", label: "Input schema", groupId: "server", position: { x: 340, y: 260 } },
                { id: "store", label: "Diagram service", groupId: "storage", position: { x: 640, y: 80 } },
                { id: "db", label: "SQLite", groupId: "storage", position: { x: 640, y: 260 } },
              ],
              groups: [
                { id: "client", label: "Client" },
                { id: "server", label: "Server" },
                { id: "storage", label: "Storage" },
              ],
              edges: [
                { id: "request", from: "web", to: "api", label: "read" },
                { id: "agent", from: "mcp", to: "schema", label: "validate" },
                { id: "validate", from: "api", to: "schema", label: "validate" },
                { id: "save", from: "schema", to: "store", label: "persist" },
                { id: "write", from: "store", to: "db", label: "transaction" },
              ],
              paths: [{ id: "save", label: "Save snapshot", edgeIds: ["agent", "save", "write"] }],
            }),
          },
        ],
      });
      if (result.outcome !== "finalized") throw new Error("Expected architecture fixture");
      return result.session.id;
    });
    const response = await page.goto(`/sessions?session=${diagramSessionId}`);
    expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
    const panel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    const embedded = panel.getByTestId("session-diagram").filter({ hasText: "WorkLog architecture" });
    const expand = embedded.getByRole("button", { name: tt("session.expandDiagram") });
    await expand.click();
    const reader = page.getByRole("dialog", { name: tt("session.diagramReader") });
    const canvas = reader.getByRole("region", { name: tt("session.diagramCanvas", { title: "WorkLog architecture" }) });
    const inspect = (label: string) =>
      canvas.getByRole("button", { name: tt("session.inspectArchitectureNode", { label }), exact: true });
    await expect(canvas.locator(".architecture__node")).toHaveCount(6);
    await expect(canvas.locator("foreignObject, img, script, style")).toHaveCount(0);
    await inspect("Web UI").focus();
    await page.keyboard.press("Enter");
    const details = reader.getByRole("complementary", { name: tt("session.architectureNodeDetails") });
    await expect(details).toContainText("apps/web/src/App.vue");
    await expect(details).toContainText(tt("session.architectureSourceLine", { line: 1 }));
    await reader.getByRole("combobox", { name: tt("session.architectureGroups") }).selectOption("server");
    await expect(canvas.locator(".architecture__node")).toHaveCount(2);
    await inspect(maliciousLabel).click();
    await expect(details).toContainText("REST routes and policy");
    await expect(details).toContainText("apps/server/src/server.ts");
    // Focusing direct relations from a group includes neighbors outside that group.
    await details.getByRole("button", { name: tt("session.architectureLocalView") }).click();
    await expect(canvas.locator(".architecture__node")).toHaveCount(3);
    await expect(inspect("Web UI")).toBeVisible();
    await reader
      .getByRole("button", { name: tt("session.architectureOverview"), exact: true })
      .last()
      .click();
    await reader.getByRole("combobox", { name: tt("session.authoredPath") }).selectOption("save");
    await expect(canvas.locator(".architecture__node")).toHaveCount(6);
    await expect(reader.locator(".architecture__path li")).toHaveCount(4);
    await expect(canvas.locator(".architecture__edge.is-on-path")).toHaveCount(3);
    await expect(reader.locator(".architecture__path")).toContainText(tt("session.authoredPathNote"));
    await inspect("Diagram service").click();
    await details.getByRole("button", { name: tt("session.architectureLocalView") }).click();
    await expect(canvas.locator(".architecture__node")).toHaveCount(3);
    await expect(reader.locator(".architecture__path")).toHaveCount(0);
    await reader
      .getByRole("button", { name: tt("session.architectureOverview"), exact: true })
      .last()
      .click();
    await expect(canvas.locator(".architecture__node")).toHaveCount(6);
    const beforeClose = await canvas.evaluate((element) => element.clientWidth);
    await details.getByRole("button", { name: tt("session.closeArchitectureInspector") }).click();
    await expect(details).toBeHidden();
    await expect.poll(() => canvas.evaluate((element) => element.clientWidth)).toBeGreaterThan(beforeClose);
    await reader.getByRole("button", { name: tt("session.architectureNodeDetails"), exact: true }).click();
    await inspect("Web UI").click();
    await reader.getByRole("button", { name: tt("session.actualDiagramSize") }).click();
    await expect(reader.locator("output")).toHaveText(tt("session.diagramZoom", { percent: 100 }));
    await reader.getByRole("button", { name: tt("session.zoomIn"), exact: true }).click();
    await canvas.focus();
    const beforeKey = await canvas.evaluate((element) => element.scrollLeft);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => canvas.evaluate((element) => element.scrollLeft)).toBeGreaterThan(beforeKey);
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Missing canvas bounds");
    const beforeDrag = await canvas.evaluate((element) => element.scrollLeft);
    await page.mouse.move(box.x + 8, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 56, box.y + 8);
    await page.mouse.up();
    await expect.poll(() => canvas.evaluate((element) => element.scrollLeft)).toBeLessThan(beforeDrag);
    await canvas.focus();
    await page.keyboard.press("0");
    await expect.poll(() => canvas.evaluate((element) => element.scrollLeft)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden();
    await expect(expand).toBeFocused();
    await expand.click();
    await page.reload();
    await expect(reader).toBeVisible();
    // A resizable reader must adapt to its own width even on a wide desktop viewport.
    await page.setViewportSize({ width: 1440, height: 1000 });
    const resize = reader.getByRole("separator", { name: tt("ui.resize", { label: tt("session.diagramReader") }) });
    await resize.focus();
    await page.keyboard.press("Home");
    await expect(reader.locator(".architecture__groups")).toBeVisible();
    for (let step = 0; step < 22; step++) await page.keyboard.press("ArrowRight");
    expect((await reader.boundingBox())?.width).toBeLessThan(640);
    await expect(reader.locator(".architecture__groups")).toBeHidden();
    expect(await canvas.evaluate((element) => element.clientWidth)).toBeGreaterThan(300);
    await expect(canvas.locator(".architecture__node")).toHaveCount(6);
    await page.keyboard.press("Home");
    await expect(reader.locator(".architecture__groups")).toBeVisible();
    for (const [width, theme, locale] of [
      [1440, "dark", "zh-TW"],
      [960, "light", "en-US"],
      [375, "dark", "en-US"],
      [375, "light", "zh-TW"],
    ] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(
        ({ theme, locale }) => {
          localStorage.setItem("work-intelligence:theme", theme);
          localStorage.setItem("work-intelligence:locale", locale);
        },
        { theme, locale },
      );
      await page.reload();
      const localized = page.getByRole("dialog", { name: textIn(locale, "session.diagramReader") });
      await expect(localized.getByRole("region").locator(".architecture__node")).toHaveCount(6);
      await localized
        .getByRole("region")
        .getByRole("button", { name: textIn(locale, "session.inspectArchitectureNode", { label: "Web UI" }) })
        .click();
      expect(await localized.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const axe = await new AxeBuilder({ page })
        .include(`[aria-label="${textIn(locale, "session.diagramReader")}"]`)
        .analyze();
      expect(axe.violations).toEqual([]);
      if (browserName !== "webkit")
        await page.screenshot({ path: test.info().outputPath(`architecture-${width}-${theme}-${locale}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Future envelopes must stay readable as escaped source rather than going through either renderer.
    await page.route(`**/api/sessions/${diagramSessionId}`, async (route) => {
      const fetched = await route.fetch();
      const body = await fetched.json();
      body.diagrams[0].formatVersion = 99;
      body.diagrams[0].source = '<script>alert("untrusted")</script>';
      await route.fulfill({ response: fetched, json: body });
    });
    await page.reload();
    await expect(reader.locator("pre")).toContainText('<script>alert("untrusted")</script>');
    await expect(reader.locator("script, .architecture__canvas")).toHaveCount(0);
    expect(cspMessages).toEqual([]);
  });

  test("keeps 200 architecture nodes usable with bounded selection cost @cross-browser", async ({
    page,
    browserName,
  }) => {
    test.setTimeout(60_000);
    const id = withAgentStore((store) => {
      const result = store.finalizeSession({
        projectRoot,
        idempotencyKey: `architecture-bound-${process.pid}`,
        title: "Architecture bound fixture",
        summary: "200 synthetic nodes",
        changedFiles: [],
        verification: { status: "passed" },
        diagrams: [
          {
            title: "200 synthetic nodes",
            kind: "architecture",
            source: JSON.stringify({
              version: 1,
              nodes: Array.from({ length: 200 }, (_, index) => ({ id: `n${index}`, label: `Node ${index}` })),
              edges: Array.from({ length: 199 }, (_, index) => ({
                id: `e${index}`,
                from: `n${index}`,
                to: `n${index + 1}`,
              })),
            }),
          },
        ],
      });
      if (result.outcome !== "finalized") throw new Error("Expected bound fixture");
      return result.session.id;
    });
    await page.goto(`/sessions?session=${id}`);
    await page
      .getByRole("dialog", { name: tt("session.sessionDetails") })
      .getByRole("button", { name: tt("session.expandDiagram") })
      .click();
    const reader = page.getByRole("dialog", { name: tt("session.diagramReader") });
    await expect(reader.locator(".architecture__node")).toHaveCount(200);
    const samples = await reader.evaluate(async (element) => {
      const buttons = [...element.querySelectorAll<HTMLButtonElement>(".architecture__node")];
      const results: number[] = [];
      for (const index of [0, 50, 100, 150, 199]) {
        const start = performance.now();
        buttons[index]!.click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        results.push(performance.now() - start);
      }
      return results;
    });
    const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
    expect(median).toBeLessThan(2_000);
    await test.info().attach("architecture-selection-cost", {
      body: JSON.stringify({
        browserName,
        nodes: 200,
        samples,
        median,
        measurement: "programmatic selection to two frames; not input latency or FPS",
      }),
      contentType: "application/json",
    });
    await reader.getByRole("button", { name: tt("session.actualDiagramSize") }).click();
    await reader
      .getByRole("region")
      .getByRole("button", { name: tt("session.inspectArchitectureNode", { label: "Node 199" }) })
      .click();
    await expect(reader.getByRole("complementary")).toContainText("Node 199");
    await reader
      .getByRole("complementary")
      .getByRole("button", { name: tt("session.architectureLocalView") })
      .click();
    await expect(reader.locator(".architecture__node")).toHaveCount(2);
  });

  test("reads, pans and zooms a Mermaid diagram under the strict CSP, falls back to source, and voids it @cross-browser", async ({
    page,
    browserName,
  }) => {
    test.setTimeout(60_000);
    const cspConsoleMessages: string[] = [];
    page.on("console", (message) => {
      if (/content security policy|refused to apply inline style/i.test(message.text())) {
        cspConsoleMessages.push(message.text());
      }
    });

    const diagramSessionId = withAgentStore((store) => {
      const finalized = store.finalizeSession({
        projectRoot,
        idempotencyKey: `e2e-diagram-${process.pid}`,
        title: `E2E diagram Session ${process.pid}`,
        summary: "Carries one valid and one broken diagram.",
        changedFiles: [],
        verification: { status: "passed" },
        diagrams: [
          {
            title: "E2E honey flow",
            source:
              "flowchart LR\n  Hive --> Extractor --> Jar\n  " +
              Array.from(
                { length: 18 },
                (_, index) => `Step${index}[Processing stage ${index}] --> Step${index + 1}`,
              ).join("\n  "),
          },
          { title: "E2E broken diagram", source: "flowchart LR\n  A -->" },
        ],
      });
      if (finalized.outcome !== "finalized") throw new Error("Expected the diagram fixture Session.");
      return finalized.session.id;
    });

    const response = await page.goto(`/sessions?session=${diagramSessionId}`);
    expect(response?.headers()["content-security-policy"]).toContain("style-src-elem 'self'");
    const panel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
    const flow = panel.getByTestId("session-diagram").filter({ hasText: "E2E honey flow" });
    // Mermaid loads only when a diagram scrolls into view.
    await flow.scrollIntoViewIfNeeded();
    await expect(flow.getByRole("img", { name: "E2E honey flow", exact: true }).locator("svg")).toBeVisible();
    await expect(flow.getByRole("img", { name: "E2E honey flow", exact: true }).locator("svg")).toContainText(
      "Extractor",
    );
    const expand = flow.getByRole("button", { name: tt("session.expandDiagram") });
    await expand.click();
    const reader = page.getByRole("dialog", { name: tt("session.diagramReader") });
    const canvas = reader.getByRole("region", { name: tt("session.diagramCanvas", { title: "E2E honey flow" }) });
    await expect(canvas.locator("svg")).toBeVisible();
    await expect(canvas.locator("foreignObject")).toHaveCount(0);
    expect(
      await canvas.locator("svg").evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll(".node")).every((node) => {
          const box = node.getBoundingClientRect();
          return box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
        });
      }),
    ).toBe(true);

    await expect(page).toHaveURL(/diagram=/);
    await reader.getByRole("button", { name: tt("session.zoomIn"), exact: true }).click();
    await expect.poll(() => canvas.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const zoomedWidth = await canvas.locator("svg").evaluate((element) => element.getBoundingClientRect().width);
    await reader.getByRole("button", { name: tt("session.zoomOut"), exact: true }).click();
    await expect
      .poll(() => canvas.locator("svg").evaluate((element) => element.getBoundingClientRect().width))
      .toBeLessThan(zoomedWidth);
    await canvas.focus();
    await page.keyboard.press("+");
    const beforeKey = await canvas.evaluate((element) => element.scrollLeft);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => canvas.evaluate((element) => element.scrollLeft)).toBeGreaterThan(beforeKey);
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Missing diagram canvas bounds.");
    const beforeDrag = await canvas.evaluate((element) => element.scrollLeft);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 48, bounds.y + bounds.height / 2);
    await page.mouse.up();
    await expect.poll(() => canvas.evaluate((element) => element.scrollLeft)).toBeLessThan(beforeDrag);
    await canvas.focus();
    await page.keyboard.press("0");
    await expect.poll(() => canvas.evaluate((element) => element.scrollLeft)).toBe(0);
    await reader.getByRole("button", { name: tt("session.actualDiagramSize") }).click();
    await expect(reader.locator("output")).toHaveText(tt("session.diagramZoom", { percent: 100 }));
    await reader.getByRole("button", { name: tt("session.fitDiagram") }).click();
    await reader.getByText(tt("session.viewSource"), { exact: true }).click();
    await expect(reader.locator("pre")).toContainText("Step18");
    await canvas.focus();
    await page.keyboard.press("k");
    await expect(reader).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden();
    await expect(expand).toBeFocused();
    await expect(panel).toBeVisible();
    await expand.click();
    await page.reload();
    await expect(reader).toBeVisible();
    await expect(canvas.locator("svg")).toBeVisible();
    for (const [width, theme, locale] of [
      [1440, "dark", "zh-TW"],
      [960, "light", "en-US"],
      [375, "dark", "en-US"],
      [375, "light", "zh-TW"],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(
        ({ theme, locale }) => {
          localStorage.setItem("work-intelligence:theme", theme);
          localStorage.setItem("work-intelligence:locale", locale);
        },
        { theme, locale },
      );
      await page.reload();
      const localizedReader = page.getByRole("dialog", { name: textIn(locale, "session.diagramReader") });
      await expect(localizedReader.getByRole("region").locator("svg")).toBeVisible();
      await expect(localizedReader.getByRole("button", { name: textIn(locale, "session.fitDiagram") })).toBeVisible();
      expect(await localizedReader.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (width < 640)
        expect(await localizedReader.evaluate((element) => element.getBoundingClientRect().width)).toBe(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await localizedReader.getByRole("button", { name: textIn(locale, "session.actualDiagramSize") }).click();
      await expect(localizedReader.locator("output")).toHaveText(
        textIn(locale, "session.diagramZoom", { percent: 100 }),
      );
      // Playwright injects a <style> to sync WebKit screenshots, contaminating the application CSP check.
      if (browserName !== "webkit") {
        await page.screenshot({ path: test.info().outputPath(`diagram-reader-${width}-${theme}-${locale}.png`) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(reader).toBeVisible();
    const violations = await new AxeBuilder({ page })
      .include('[aria-label="' + tt("session.diagramReader") + '"]')
      .analyze();
    expect(violations.violations).toEqual([]);
    await reader.getByRole("button", { name: tt("session.backToSession") }).click();
    await expect(reader).toBeHidden();
    const broken = panel.getByTestId("session-diagram").filter({ hasText: "E2E broken diagram" });
    await broken.scrollIntoViewIfNeeded();
    await expect(broken).toContainText(ttPattern("session.couldNotDrawThisDiagramHereIsThe"));
    await expect(broken.locator("pre")).toContainText("A -->");
    await broken.getByRole("button", { name: tt("session.expandDiagram") }).click();
    await expect(reader.locator("pre")).toContainText("A -->");
    await expect(reader.getByRole("button", { name: tt("session.zoomIn"), exact: true })).toBeDisabled();
    await reader.getByRole("button", { name: tt("common.retry") }).click();
    await expect(reader.locator("pre")).toContainText("A -->");
    await reader.getByRole("button", { name: tt("session.backToSession") }).click();
    await expect(reader).toBeHidden();

    await panel
      .getByRole("button", { name: tt("session.voidDiagram") })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: tt("session.voidDiagram") });
    await dialog.getByLabel(tt("session.reasonLabel")).fill("E2E: wrong flow.");
    await dialog.getByRole("button", { name: tt("common.void") }).click();
    await expect(dialog).toBeHidden();
    await expect(panel).toContainText(tt("session.reasonValue", { reason: "E2E: wrong flow." }));
    expect(cspConsoleMessages).toEqual([]);
  });

  test("confirms backup deletion using only keyboard navigation @keyboard", async ({ page, request }) => {
    await postJson(request, "/api/backups", {});
    await page.goto("/projects/backup");

    const backups = page.getByRole("tabpanel", { name: tt("projects.dataBackup") });
    const deleteTrigger = backups.getByRole("button", { name: ttPattern("projects.deleteBackup") }).first();
    await expect(deleteTrigger).toBeVisible();

    let triggerFocused = false;
    for (let index = 0; index < 60; index += 1) {
      if (await deleteTrigger.evaluate((element) => element === document.activeElement)) {
        triggerFocused = true;
        break;
      }
      await page.keyboard.press("Tab");
    }
    expect(triggerFocused).toBe(true);
    await page.keyboard.press("Enter");

    const confirmation = page.getByRole("dialog", { name: ttPattern("projects.deleteBackupConfirm") });
    const cancelButton = confirmation.getByRole("button", { name: tt("common.cancel") });
    const deleteButton = confirmation.getByRole("button", { name: tt("projects.deleteBackupPermanently") });
    await expect(confirmation).toBeVisible();
    await expect(cancelButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(deleteButton).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByText(ttPattern("projects.deletedBackup"))).toBeVisible();
    await expect(backups).toContainText(tt("projects.noBackupsYet"));
  });

  test("manages backups from the projects page and explains how to move the database", async ({ page, request }) => {
    await page.goto("/projects/backup");
    const backups = page.getByRole("tabpanel", { name: tt("projects.dataBackup") });
    await expect(backups).toContainText(tt("projects.exportAllData"));
    await expect(backups).toContainText("pnpm db:restore");
    await backups.getByRole("button", { name: tt("projects.backUpNow") }).click();
    await expect(page.getByText(tt("projects.backedUpTheCurrentData"))).toBeVisible();
    const listResponse = await request.get("/api/backups");
    expect(listResponse.ok()).toBeTruthy();
    const backupList = (await listResponse.json()) as {
      backups: Array<{ fileName: string; kind: string; bytes: number }>;
    };
    expect(backupList.backups).toHaveLength(1);
    const [backup] = backupList.backups;
    expect(backup?.kind).toBe("manual");
    expect(backup?.bytes).toBeGreaterThan(0);
    const fileName = backup?.fileName ?? "";
    await expect(backups.getByText(fileName, { exact: true })).toBeVisible();
    await expect(backups).toContainText(ttPattern("projects.folderAutomaticBackupsAreKept", { length: 1 }));

    await backups.getByRole("button", { name: tt("projects.deleteBackup", { fileName }) }).click();
    const confirmation = page.getByRole("dialog", { name: tt("projects.deleteBackupConfirm", { fileName }) });
    await expect(confirmation).toContainText(tt("projects.kind", { value: tt("labels.manual") }));
    await expect(confirmation).toContainText(tt("projects.thisIsTheOnlyBackup"));
    await confirmation.getByRole("button", { name: tt("projects.deleteBackupPermanently") }).click();
    await expect(page.getByText(tt("projects.deletedBackup", { fileName }))).toBeVisible();
    await expect(backups).toContainText(tt("projects.noBackupsYet"));
    await expectNoHorizontalOverflow(page);
  });

  test("exports one project and previews an idempotent import", async ({ page }) => {
    await page.goto("/projects/backup");
    const backups = page.getByRole("tabpanel", { name: tt("projects.dataBackup") });
    await backups.getByLabel(tt("projects.chooseExportScope")).selectOption("project");
    await backups.getByLabel(tt("projects.chooseProjectsToExport")).selectOption(projectId);

    const downloadPromise = page.waitForEvent("download");
    await backups.getByRole("button", { name: tt("common.exportJson") }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const exported = readFileSync(downloadPath ?? "");
    const bundle = JSON.parse(exported.toString("utf8")) as {
      scope: { type: string; projectId: string };
      tables: { projects: Array<{ id: string }> };
    };
    expect(bundle.scope).toEqual({ type: "project", projectId });
    expect(bundle.tables.projects).toHaveLength(1);

    await backups.getByLabel(tt("projects.importFile")).setInputFiles({
      name: download.suggestedFilename(),
      mimeType: "application/json",
      buffer: exported,
    });
    const preview = backups.getByTestId("project-import-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Browser Regression Fixture");
    await expect(preview.getByTestId("project-import-selected-projects")).toContainText(projectRoot);
    await expect(preview.getByTestId("project-import-selected-projects")).toContainText(
      tt("projects.matchedAnExistingProject"),
    );
    await expect(preview.getByTestId("project-import-additions")).toContainText(tt("common.added"));
    await expect(preview.getByTestId("project-import-skipped")).toContainText(tt("projects.skipped"));
    await expect(preview.getByTestId("project-import-conflicts")).toContainText(tt("projects.conflicts"));

    await preview.getByRole("button", { name: tt("projects.confirmAndImport") }).click();
    const confirmation = page.getByRole("dialog", { name: tt("projects.confirmProjectDataImport") });
    await expect(confirmation).toContainText(ttPattern("projects.recordsWillBeAddedAnd"));
    await confirmation.getByRole("button", { name: tt("projects.import"), exact: true }).click();
    await expect(
      page.getByText(ttPattern("projects.importFinishedAddedSkippedIn", { value: 0, value3: 0 })),
    ).toBeVisible();
    for (const width of [1440, 960, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
    }
  });

  test("previews missing portable project roots, picks locations, and confirms matching siblings", async ({ page }) => {
    const databasePath = process.env.WORK_INTELLIGENCE_E2E_DB;
    if (!databasePath) throw new Error("The E2E database path is not configured.");
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-e2e-portable-locations-"));
    const targetParent = mkdtempSync(join(tmpdir(), "work-intelligence-e2e-target-projects-"));
    const alphaTarget = join(targetParent, "round6-alpha");
    const betaTarget = join(targetParent, "round6-beta");
    const sourceParent = join(root, "old-computer");
    const alphaSource = join(sourceParent, "round6-alpha");
    const betaSource = join(sourceParent, "round6-beta");
    mkdirSync(alphaTarget);
    mkdirSync(betaTarget);
    const secretFileContent = "folder-picker-preview-must-not-read-this-file";
    writeFileSync(join(alphaTarget, "private.txt"), secretFileContent, "utf8");

    const created = withAgentStore((store) => {
      const alpha = store.addProject("Round 6 Alpha Fixture", alphaSource);
      const beta = store.addProject("Round 6 Beta Fixture", betaSource);
      return { bundle: store.exportProjectData({ type: "all" }), ids: [alpha.id, beta.id] as const };
    });
    const exported: ProjectDataExport = structuredClone(created.bundle);
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare("DELETE FROM projects WHERE id = ? OR id = ?").run(...created.ids);
    } finally {
      db.close();
    }

    try {
      await page.route("**/api/system/pick-folder", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ outcome: "folder_picked", path: alphaTarget, name: "round6-alpha" }),
        }),
      );
      await page.goto("/projects/backup");
      const backups = page.getByRole("tabpanel", { name: tt("projects.dataBackup") });
      await backups.getByLabel(tt("projects.importFile")).setInputFiles({
        name: "missing-project-roots.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(exported)),
      });

      const preview = backups.getByTestId("project-import-preview");
      await expect(preview).toBeVisible();
      const projects = preview.getByTestId("project-import-selected-projects");
      await expect(projects).toContainText(alphaSource);
      await expect(projects).toContainText(tt("projects.thisFolderWasNotFound"));
      await expect(projects).not.toContainText(secretFileContent);

      await projects
        .getByRole("button", { name: tt("projects.chooseANewLocationFor", { name: "Round 6 Alpha Fixture" }) })
        .click();
      const siblingConfirmation = page.getByRole("dialog", { name: tt("projects.applyOtherProjectsLocations") });
      await expect(siblingConfirmation).toContainText(tt("projects.otherProjectsAlsoHaveA", { length: 1 }));
      await siblingConfirmation.getByRole("button", { name: tt("projects.applyToAll") }).click();
      await expect(projects).toContainText(alphaTarget);
      await expect(projects).toContainText(betaTarget);
      await expect(projects).toContainText(tt("projects.folderFound"));

      await preview.getByRole("button", { name: tt("projects.confirmAndImport") }).click();
      const confirmation = page.getByRole("dialog", { name: tt("projects.confirmProjectDataImport") });
      await confirmation.getByRole("button", { name: tt("projects.import"), exact: true }).click();
      await expect(page.getByText(ttPattern("projects.importFinishedAddedSkippedIn"))).toBeVisible();

      const verifyDb = new DatabaseSync(databasePath);
      try {
        expect(verifyDb.prepare("SELECT root_path, status FROM projects WHERE id = ?").get(created.ids[0])).toEqual({
          root_path: alphaTarget,
          status: "paused",
        });
        expect(verifyDb.prepare("SELECT root_path, status FROM projects WHERE id = ?").get(created.ids[1])).toEqual({
          root_path: betaTarget,
          status: "paused",
        });
      } finally {
        verifyDb.close();
      }
      await page.unroute("**/api/system/pick-folder");
    } finally {
      const cleanupDb = new DatabaseSync(databasePath);
      try {
        cleanupDb.prepare("DELETE FROM projects WHERE id = ? OR id = ?").run(...created.ids);
      } finally {
        cleanupDb.close();
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(targetParent, { recursive: true, force: true });
      await page.unroute("**/api/system/pick-folder");
    }
  });

  test("asks for consent before a project starts being tracked", async ({ page, request }) => {
    await postJson(request, "/api/projects", { name: "Consent Fixture", rootPath: `${projectRoot}/e2e` });
    await page.goto("/projects");
    const status = page.getByLabel(tt("projects.updateTheTrackingStatusOf", { name: "Consent Fixture" }));
    await expect(status).toHaveValue("unregistered");
    await status.selectOption("tracked");
    const consent = page.getByRole("dialog", { name: ttPattern("projects.switchToTracked") });
    await expect(consent).toBeVisible();
    await consent.getByRole("button", { name: tt("common.cancel") }).click();
    await expect(consent).toBeHidden();
    await expect(page.getByLabel(tt("projects.updateTheTrackingStatusOf", { name: "Consent Fixture" }))).toHaveValue(
      "unregistered",
    );
  });

  test("requires the exact project name and reports the pre-deletion backup", async ({ page, request }) => {
    const workspace = mkdtempSync(join(tmpdir(), "work-intelligence-delete-workspace-"));
    const sentinel = join(workspace, "keep-this-file.txt");
    writeFileSync(sentinel, "Workspace files are outside WorkLog deletion.", "utf8");
    const name = "Permanent Delete E2E Fixture";
    try {
      const project = await postJson<ProjectRecord>(request, "/api/projects", { name, rootPath: workspace });
      await page.goto("/projects");
      const row = page.getByTestId("project-row").filter({ hasText: name });
      await row.getByRole("button", { name: tt("projects.permanentlyDelete", { name }) }).click();

      const dialog = page.getByRole("dialog", { name: tt("projects.permanentlyDeleteProjectData") });
      await expect(dialog).toContainText(tt("projects.aFullDatabaseBackupIs"));
      await expect(dialog).toContainText(tt("projects.deletionHappensOnlyAfterA", { name }));
      const confirmation = dialog.getByLabel(tt("projects.typeToConfirmPermanentDeletion", { name }));
      const deleteButton = dialog.getByRole("button", { name: tt("projects.deletePermanently"), exact: true });
      await confirmation.fill("Wrong name");
      await expect(deleteButton).toBeDisabled();
      await confirmation.fill(name);
      await expect(deleteButton).toBeEnabled();
      await deleteButton.click();

      const success = page.getByText(ttPattern("projects.projectPermanentlyDeletedPreDeletion"));
      await expect(success).toBeVisible();
      const backupReminder = page
        .getByRole("status")
        .filter({ hasText: ttPattern("projects.projectDataDeletedTheBackup") });
      await expect(backupReminder).toContainText(ttPattern("projects.thePreDeletionBackupOf"));
      await expect(page.getByRole("link", { name: tt("projects.goToBackupManagement") })).toHaveAttribute(
        "href",
        "/projects/backup",
      );
      await expect(dialog).toBeHidden();
      await expect(row).toHaveCount(0);
      expect(existsSync(sentinel)).toBe(true);

      const backupResponse = await request.get("/api/backups");
      expect(backupResponse.ok()).toBeTruthy();
      const backupList = (await backupResponse.json()) as { backups: Array<{ fileName: string }> };
      const toast = await success.textContent();
      const backupFileName = toast?.split("：").at(-1);
      expect(backupFileName).toMatch(/^work-intelligence-e2e-\d+-pre-delete-.*\.sqlite$/);
      expect(backupList.backups.some((backup) => backup.fileName === backupFileName)).toBe(true);

      const projectsResponse = await request.get("/api/projects");
      const remainingProjects = (await projectsResponse.json()) as Array<{ id: string }>;
      expect(remainingProjects.some((remaining) => remaining.id === project.id)).toBe(false);

      await page.getByRole("tab", { name: tt("projects.deletionHistory") }).click();
      const deletionAudit = page.getByTestId("project-deletion-audit");
      await expect(deletionAudit).toContainText(project.id);
      await expect(deletionAudit).toContainText(tt("common.project"));
      const auditResponse = await request.get("/api/project-deletion-audits");
      expect(auditResponse.ok()).toBeTruthy();
      const auditRecords = (await auditResponse.json()) as Array<{ deletedAt: string; projectId: string }>;
      const deletedAudit = auditRecords.find((item) => item.projectId === project.id);
      if (!deletedAudit) {
        throw new Error("The project deletion audit was not returned by the API.");
      }
      await expect(deletionAudit.locator("time")).toHaveAttribute("datetime", deletedAudit.deletedAt);
      await expect(
        deletionAudit.getByText(tt("common.project"), { exact: true }).locator("..").locator("dd"),
      ).toHaveText("1");
      await expect(deletionAudit).not.toContainText(name);
      await expect(deletionAudit).not.toContainText(workspace);
      for (const width of [1440, 960, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await expectNoHorizontalOverflow(page);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("fills the project root from the folder dialog", async ({ page }) => {
    // Answer for the API so no real dialog opens on the machine running the tests.
    await page.route("**/api/system/pick-folder", (route) =>
      route.fulfill({ json: { outcome: "folder_picked", path: "/Users/me/code/apiary", name: "apiary" } }),
    );
    await page.goto("/projects");
    await page
      .getByRole("button", { name: tt("common.addProject") })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: tt("common.addProject") });
    await dialog.getByRole("button", { name: tt("projects.chooseFolder") }).click();
    await expect(dialog.getByLabel(tt("projects.workspaceRoot"))).toHaveValue("/Users/me/code/apiary");
    await expect(dialog.getByLabel(tt("projects.projectName"))).toHaveValue("apiary");

    await page.unroute("**/api/system/pick-folder");
    await page.route("**/api/system/pick-folder", (route) =>
      route.fulfill({ json: { outcome: "folder_pick_unavailable", reason: "none" } }),
    );
    await dialog.getByRole("button", { name: tt("projects.chooseFolder") }).click();
    await expect(page.getByText(tt("projects.thisComputerCannotOpenA"))).toBeVisible();
    await expect(dialog.getByLabel(tt("projects.workspaceRoot"))).toHaveValue("/Users/me/code/apiary");
  });

  test("jumps to a page from the command palette", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: tt("nav.workOverview") }).first()).toBeVisible();
    await page.keyboard.press("Control+KeyK");
    const palette = page.getByRole("dialog", { name: tt("common.searchOrJumpToA") });
    await expect(palette).toBeVisible();
    await page.keyboard.type(tt("nav.workReports"));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/reports/);
    await expect(palette).toBeHidden();
  });

  // Opt-in visual baseline: UI_SCREENSHOTS=<label> pnpm test:e2e writes docs/ui-baseline/<label>/*.png
  test("lists work that started before the report period", async ({ page, request }) => {
    await postJson(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `browser-regression-spanning-${process.pid}`,
      title: "Long-running fixture work",
      summary: "Started ten days ago and finished today.",
      changedFiles: [],
      verification: { status: "passed" },
      startedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await page.goto("/reports/work?period=week");
    const spanning = page.getByTestId("report-spanning");
    await expect(spanning).toContainText(tt("reports.startedEarlierCompletedInThis"));
    await expect(spanning).toContainText("Long-running fixture work");
  });

  test("shows Agent-proposed Knowledge as soon as the Agent submits it, and accepts it", async ({ page }) => {
    await page.goto("/knowledge/candidates");
    const candidates = page.getByTestId("knowledge-candidates");
    await candidates.getByRole("button", { name: tt("knowledge.synthesizeCandidates") }).click();
    await page.getByRole("menuitem", { name: "Browser Regression Fixture" }).click();
    await expect(candidates).toContainText(ttPattern("knowledge.hasSessionsWaitingForThe", { value: "" }));

    withAgentStore((store) => {
      const context = store.getKnowledgeCandidateContext({ projectRoot });
      if (context.outcome !== "knowledge_candidate_context") {
        throw new Error(`Expected candidate context, got ${context.outcome}`);
      }
      const submitted = store.submitKnowledgeCandidates({
        requestId: context.request.id,
        candidates: [
          {
            sourceSessionId: context.sessions[0]!.id,
            kind: "gotcha",
            title: "E2E candidate: the browser suite needs its own database",
            body: "Browser tests run against an isolated SQLite file.",
            rationale: "The fixture session decided to use one isolated SQLite fixture.",
          },
        ],
      });
      expect(submitted.outcome).toBe("knowledge_candidates_submitted");
    });

    // The page re-checks the open request and shows the result without a reload.
    await expect(
      page.getByText(ttPattern("knowledge.theAgentSubmittedKnowledgeCandidatesForPleaseReview")),
    ).toBeVisible({ timeout: 15_000 });
    const candidate = candidates.getByTestId("knowledge-candidate").filter({ hasText: "E2E candidate" });
    await candidate.getByRole("button", { name: tt("knowledge.accept"), exact: true }).click();
    await expect(page.getByText(tt("knowledge.addedToKnowledge"))).toBeVisible();
    // Accepted Knowledge lives on the Knowledge tab.
    await page.getByRole("tab", { name: /^Knowledge/ }).click();
    await expect(
      page.getByTestId("knowledge-row").filter({ hasText: "E2E candidate: the browser suite needs its own database" }),
    ).toBeVisible();
  });

  test("flags Knowledge whose files changed and clears the flag once confirmed", async ({ page, request }) => {
    const title = "E2E trust: fixtures live in playwright.config.ts";
    const recorded = await postJson(request, "/api/knowledge", {
      projectRoot,
      idempotencyKey: `browser-regression-trust-${process.pid}`,
      kind: "pattern",
      title,
      body: "The browser fixtures are configured in playwright.config.ts.",
      appliesTo: ["playwright.config.ts"],
    });
    expect(recorded.outcome).toBe("knowledge_recorded");
    await postJson(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `browser-regression-trust-change-${process.pid}`,
      title: "Change the browser fixtures",
      summary: "Changed playwright.config.ts after the Knowledge was recorded.",
      changedFiles: ["playwright.config.ts"],
      verification: { status: "passed" },
    });

    await page.goto("/knowledge");
    const row = page.getByTestId("knowledge-row").filter({ hasText: title });
    await expect(row).toContainText(tt("status.possiblyStale"));
    await row.getByRole("button", { name: tt("knowledge.more") }).click();
    await page.getByRole("menuitem", { name: tt("knowledge.stillValid") }).click();
    await expect(row).not.toContainText(tt("status.possiblyStale"));
    await expect(row).toContainText(ttPattern("knowledge.confirmedValidAt"));
  });

  test("picks up a metadata backfill the Agent finishes while the page is open", async ({ page, request }) => {
    const finalized = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `browser-regression-backfill-${process.pid}`,
      title: "Legacy session missing verification",
      summary: "Imported before verification was recorded.",
      changedFiles: ["README.md"],
      verification: { status: "passed" },
    });
    // Simulate a legacy record: verification was never supplied.
    const db = new DatabaseSync(process.env.WORK_INTELLIGENCE_E2E_DB!);
    db.prepare("UPDATE sessions SET verification_json = NULL WHERE id = ?").run(finalized.session.id);
    db.close();

    await page.goto("/projects/backfill");
    // Scanning creates the Agent request when gaps exist.
    await page.getByRole("button", { name: tt("projects.scanMetadataGaps") }).click();
    await expect(page.getByRole("button", { name: tt("projects.cancelBackfill") })).toBeVisible();

    // Act as the Agent: read the request's context and write back every confirmed gap.
    const requests = await request.get("/api/backfill/metadata-requests");
    const pending = ((await requests.json()) as { requests: Array<{ id: string; status: string }> }).requests.find(
      (item) => item.status === "pending" || item.status === "processing",
    );
    const contextResponse = await request.get(`/api/backfill/metadata-requests/${pending?.id}/context`);
    const context = (await contextResponse.json()) as { items: Array<{ sessionId: string }> };
    expect(context.items.map((item) => item.sessionId)).toContain(finalized.session.id);
    const applied = await postJson(request, "/api/backfill/metadata", {
      requestId: pending?.id,
      updates: context.items.map((item) => ({
        sessionId: item.sessionId,
        changedFiles: ["README.md"],
        verification: { status: "passed", summary: "Confirmed from the fixture." },
      })),
    });
    expect(applied.outcome).toBe("backfill_applied");
    await expect(page.getByText(tt("projects.theAgentFinishedTheMetadata"))).toBeVisible({ timeout: 15_000 });
  });

  test("refreshes the Session list after a Session is created over REST", async ({ page, request }) => {
    let sessionListRequestCount = 0;
    let sessionListResponseCount = 0;
    page.on("request", (requestEvent) => {
      const url = new URL(requestEvent.url());
      if (requestEvent.method() === "GET" && url.pathname === "/api/sessions") {
        sessionListRequestCount += 1;
      }
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (response.request().method() === "GET" && url.pathname === "/api/sessions") {
        sessionListResponseCount += 1;
      }
    });

    const eventsConnected = page.waitForResponse(
      (response) => response.url().endsWith("/api/events") && response.status() === 200,
    );
    await page.goto("/sessions");
    await eventsConnected;
    await expect(page.getByTestId("session-row").first()).toBeVisible();
    await expect.poll(() => sessionListRequestCount).toBeGreaterThan(0);
    await expect.poll(() => sessionListResponseCount).toBe(sessionListRequestCount);

    async function createSession(title: string): Promise<void> {
      const finalized = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
        projectRoot,
        idempotencyKey: `browser-live-session-${process.pid}-${title}`,
        title,
        summary: "透過 REST 新增後，工作歷程應自動更新。",
        changedFiles: [],
        verification: { status: "passed" },
        completedAt: new Date().toISOString(),
      });
      expect(finalized.session.id).toBeTruthy();
    }

    const liveTitle = `即時更新前景測試 ${process.pid}`;
    const initialRequestCount = sessionListRequestCount;
    await createSession(liveTitle);
    await expect(page.getByTestId("session-row").filter({ hasText: liveTitle })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => sessionListRequestCount).toBe(initialRequestCount + 1);
    await expect.poll(() => sessionListResponseCount).toBe(sessionListRequestCount);
    await page.waitForTimeout(200);
    expect(sessionListRequestCount).toBe(initialRequestCount + 1);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hiddenRequestCount = sessionListRequestCount;
    const hiddenTitle = `即時更新背景測試 ${process.pid}`;
    await createSession(hiddenTitle);
    const newRow = page.getByTestId("session-row").filter({ hasText: hiddenTitle });
    await page.waitForTimeout(2_200);
    await expect(newRow).toHaveCount(0);
    expect(sessionListRequestCount).toBe(hiddenRequestCount);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(newRow).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => sessionListRequestCount).toBe(hiddenRequestCount + 1);
    await expect.poll(() => sessionListResponseCount).toBe(sessionListRequestCount);
    await page.waitForTimeout(200);
    expect(sessionListRequestCount).toBe(hiddenRequestCount + 1);
  });

  test("captures page screenshots for visual comparison", async ({ page }) => {
    const label = process.env.UI_SCREENSHOTS;
    test.skip(!label, "Set UI_SCREENSHOTS=<label> to capture screenshots.");
    test.setTimeout(120_000);
    for (const width of [1440, 960, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [path, heading] of pageRoutes) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: `docs/ui-baseline/${label}/${path.slice(1)}-${width}.png`, fullPage: true });
      }
    }
  });

  test("edits an Agent-proposed Knowledge candidate before accepting it", async ({ page }) => {
    const originalTitle = `E2E candidate to edit ${process.pid}`;
    const editedTitle = `E2E edited candidate ${process.pid}`;
    const editedBody = `Reviewed candidate body ${process.pid}.`;
    const candidateId = await submitKnowledgeCandidateForReview(page, {
      title: originalTitle,
      body: "Agent-proposed candidate body.",
      rationale: "Candidate fixture for reviewer edits.",
    });

    const candidates = page.getByTestId("knowledge-candidates");
    const candidate = candidates.getByTestId("knowledge-candidate").filter({ hasText: originalTitle });
    await expect(candidate).toBeVisible();
    await candidate.getByRole("button", { name: tt("knowledge.editAndAccept"), exact: true }).click();

    const editor = page.getByRole("dialog", { name: tt("knowledge.editAndAcceptKnowledgeCandidate") });
    await expect(editor).toBeVisible();
    await editor.getByLabel(tt("knowledge.title")).fill(editedTitle);
    await editor.getByLabel(tt("knowledge.knowledgeKind")).selectOption("decision");
    await editor.getByLabel(tt("common.body")).fill(editedBody);
    await editor.getByLabel(tt("knowledge.tags")).fill("E2E, reviewer-edited");
    await editor
      .getByLabel(tt("knowledge.appliesToPaths"))
      .fill("e2e/work-intelligence.spec.ts\napps/web/src/views/KnowledgeView.vue");
    await editor.getByRole("button", { name: tt("knowledge.acceptAndAddToKnowledge") }).click();

    await expect(page.getByText(tt("knowledge.addedToKnowledge"))).toBeVisible();
    await expect(candidates.getByTestId("knowledge-candidate").filter({ hasText: originalTitle })).toHaveCount(0);
    await page.getByRole("tab", { name: /^Knowledge/ }).click();
    const knowledge = page.getByTestId("knowledge-row").filter({ hasText: editedTitle });
    await expect(knowledge).toBeVisible();
    await expect(knowledge).toContainText(tt("status.technicalDecision"));
    await expect(knowledge).toContainText(editedBody);
    await expect(knowledge).toContainText("#E2E");
    await expect(knowledge).toContainText("#reviewer-edited");
    await expect(knowledge).toContainText(tt("knowledge.appliesTo", { pattern: "e2e/work-intelligence.spec.ts" }));

    const accepted = withAgentStore((store) => store.listKnowledgeCandidates({ projectRoot, status: "accepted" }));
    expect(accepted.outcome).toBe("knowledge_candidates");
    if (accepted.outcome === "knowledge_candidates") {
      expect(accepted.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: candidateId, status: "accepted" })]),
      );
    }
  });

  test("rejects an Agent-proposed Knowledge candidate without recording it as Knowledge", async ({ page }) => {
    const title = `E2E candidate to reject ${process.pid}`;
    const candidateId = await submitKnowledgeCandidateForReview(page, {
      title,
      body: "This proposal should be rejected.",
      rationale: "Candidate fixture for the rejection flow.",
    });

    const candidates = page.getByTestId("knowledge-candidates");
    const candidate = candidates.getByTestId("knowledge-candidate").filter({ hasText: title });
    await expect(candidate).toBeVisible();
    await candidate.getByRole("button", { name: tt("knowledge.reject"), exact: true }).click();

    const confirmation = page.getByRole("dialog", { name: tt("knowledge.rejectThisCandidate") });
    await expect(confirmation).toContainText(ttPattern("knowledge.willNotBecomeKnowledgeAnd"));
    await confirmation.getByRole("button", { name: tt("knowledge.reject"), exact: true }).click();

    await expect(page.getByText(tt("knowledge.candidateRejected"))).toBeVisible();
    await expect(candidates.getByTestId("knowledge-candidate").filter({ hasText: title })).toHaveCount(0);
    await page.getByRole("tab", { name: /^Knowledge/ }).click();
    await expect(page.locator("#knowledge-panel-list")).toBeVisible();
    await expect(page.getByTestId("knowledge-row").filter({ hasText: title })).toHaveCount(0);

    const rejected = withAgentStore((store) => store.listKnowledgeCandidates({ projectRoot, status: "rejected" }));
    expect(rejected.outcome).toBe("knowledge_candidates");
    if (rejected.outcome === "knowledge_candidates") {
      expect(rejected.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: candidateId, status: "rejected" })]),
      );
    }
  });

  test("creates and displays an AI summary for an exact custom report range", async ({ page }) => {
    await page.goto(`/reports?period=custom&from=${reportDate}&to=${reportDate}`);
    const synthesis = page.getByTestId("report-synthesis");
    const createButton = synthesis.getByRole("button", { name: tt("reports.askAgentToSynthesizeThis") });
    await expect(createButton).toBeEnabled();
    const created = page.waitForResponse(
      (response) =>
        response.url().includes("/api/reports/synthesis-requests") && response.request().method() === "POST",
    );
    await createButton.click();
    await created;

    const customRequest = withAgentStore((store) => {
      const requests = store.listReportSynthesisRequests({
        period: "custom",
        from: reportDate,
        to: reportDate,
        scopeType: "all",
        status: "pending",
      });
      if (requests.outcome !== "report_synthesis_requests") {
        throw new Error(`Expected custom synthesis requests, got ${requests.outcome}`);
      }
      const request = requests.requests[0];
      if (!request) {
        throw new Error("The custom report request was not stored for the selected range.");
      }
      const context = store.getReportSynthesisContext({ requestId: request.id });
      if (context.outcome !== "report_context") {
        throw new Error(`Expected a custom report context, got ${context.outcome}`);
      }
      const saved = store.saveReportSummary({
        requestId: request.id,
        title: "自訂期間工作整理",
        executiveSummary: "自訂日期範圍已取得來源工作並完成整理。",
        highlights: [],
        risks: [],
        decisions: [],
        nextSteps: [],
        sourceSessionIds: context.sourceSessionIds,
        generatedByAgent: "Playwright fixture",
        promptVersion: "e2e-custom-report-v1",
      });
      return { request, context, saved };
    });
    expect(customRequest.request).toMatchObject({ period: "custom", range: { from: reportDate, to: reportDate } });
    expect(customRequest.context.report).toMatchObject({
      outcome: "report",
      period: "custom",
      range: { from: reportDate, to: reportDate },
    });
    expect(customRequest.saved).toMatchObject({
      outcome: "report_summary_saved",
      summary: { period: "custom", range: { from: reportDate, to: reportDate } },
    });
    await expect(synthesis).toContainText("自訂日期範圍已取得來源工作並完成整理。", { timeout: 15_000 });
  });

  test("reports session truncation through the API and warns in the report page", async ({ page, request }) => {
    const truncationProjectRoot = mkdtempSync(join(tmpdir(), "work-intelligence-report-truncation-"));
    const from = "2099-01-01";
    const to = "2099-01-01";

    try {
      const project = await postJson<ProjectRecord>(request, "/api/projects", {
        name: "Report truncation fixture",
        rootPath: truncationProjectRoot,
      });
      const tracked = await request.patch(`/api/projects/${project.id}`, { data: { status: "tracked" } });
      expect(tracked.ok()).toBeTruthy();

      withAgentStore((store) => {
        for (let index = 0; index < 201; index += 1) {
          const finalized = store.finalizeSession({
            projectRoot: truncationProjectRoot,
            idempotencyKey: `browser-report-truncation-${process.pid}-${index}`,
            title: `Report truncation fixture ${index}`,
            summary: "Isolated fixture for the report session limit.",
            completedAt: "2099-01-01T12:00:00.000Z",
          });
          if (finalized.outcome !== "finalized") {
            throw new Error(`Expected a finalized report fixture, got ${finalized.outcome}`);
          }
        }
      });

      const reportResponse = await request.get(`/api/reports?from=${from}&to=${to}`);
      expect(reportResponse.ok()).toBeTruthy();
      const report = (await reportResponse.json()) as {
        sessionTruncation: { currentPeriod: boolean; previousPeriod: boolean };
      };
      expect(report.sessionTruncation).toEqual({ currentPeriod: true, previousPeriod: false });

      await page.goto(`/reports?period=custom&from=${from}&to=${to}`);
      const notice = page.getByTestId("report-session-truncation");
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(tt("reports.thisPeriodExceedsTheReport"));
      await expect(notice).toContainText(tt("reports.summariesTrendsProjectSharesAnd"));
    } finally {
      rmSync(truncationProjectRoot, { recursive: true, force: true });
    }
  });

  // This fixture creates many records and checks three viewport sizes; allow setup and assertions 60 seconds.
  test("keeps long lists and report/project tables internally scrollable at desktop, tablet, and mobile widths", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));

    const fixtureKey = `browser-long-lists-${process.pid}-${Date.now()}`;
    const longItems = (section: string) =>
      Array.from({ length: 12 }, (_, index) => `${section} 第 ${index + 1} 筆長清單項目，供捲動檢查使用。`);
    const detail = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `${fixtureKey}-detail`,
      title: "Long list detail fixture",
      summary: "A Session with long summary, changed-file, and activity lists.",
      workSummary: {
        outcomes: longItems(tt("labels.outcomes")),
        scope: longItems(tt("labels.scope")),
        decisions: longItems(tt("common.decisions")),
        verification: longItems(tt("common.verification")),
        nextSteps: longItems(tt("common.status")),
      },
      changedFiles: Array.from({ length: 20 }, (_, index) => `src/long-list-fixture-${index + 1}.ts`),
      events: Array.from({ length: 20 }, (_, index) => ({
        type: "note",
        summary: `Long-list activity event ${index + 1}.`,
      })),
      verification: { status: "passed", summary: "Long-list fixture is valid." },
    });
    const detailSessionId = detail.session.id;

    for (let index = 1; index <= 12; index += 1) {
      const evidence = await request.post(`/api/sessions/${detailSessionId}/evidence`, {
        data: {
          kind: "test",
          reference: `${fixtureKey}-evidence-${index}`,
          summary: `長清單 Evidence 第 ${index} 筆`,
        },
      });
      expect(evidence.ok()).toBeTruthy();

      const knowledge = await postJson(request, "/api/knowledge", {
        projectRoot,
        idempotencyKey: `${fixtureKey}-knowledge-${index}`,
        kind: "pattern",
        title: `Long list Knowledge ${index}`,
        body: `Long detail Knowledge entry ${index} for virtual-list verification.`,
        sessionId: detailSessionId,
      });
      expect(knowledge.outcome).toBe("knowledge_recorded");

      const linkedSession = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
        projectRoot,
        idempotencyKey: `${fixtureKey}-linked-${index}`,
        title: `Long list linked Session ${index}`,
        summary: "A linked Session for the detail panel list.",
        changedFiles: [],
        verification: { status: "passed" },
      });
      const linked = await request.post(`/api/sessions/${detailSessionId}/links`, {
        data: { relatedSessionId: linkedSession.session.id, relation: "related" },
      });
      expect(linked.ok()).toBeTruthy();
    }

    const candidateSessions = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
          projectRoot,
          idempotencyKey: `${fixtureKey}-candidate-source-${index + 1}`,
          title: `Long list candidate source ${index + 1}`,
          summary: "An uncovered Session used for the Knowledge candidate list.",
          changedFiles: [],
          verification: { status: "passed" },
        }),
      ),
    );
    expect(candidateSessions).toHaveLength(12);
    withAgentStore((store) => {
      const requested = store.requestKnowledgeCandidates(projectRoot);
      if (requested.outcome !== "knowledge_candidate_request") {
        throw new Error(`Expected a Knowledge candidate request, got ${requested.outcome}`);
      }
      const context = store.getKnowledgeCandidateContext({ requestId: requested.request.id });
      if (context.outcome !== "knowledge_candidate_context") {
        throw new Error(`Expected Knowledge candidate context, got ${context.outcome}`);
      }
      const submitted = store.submitKnowledgeCandidates({
        requestId: requested.request.id,
        candidates: context.sessions.map((session, index) => ({
          sourceSessionId: session.id,
          kind: "gotcha",
          title: `Long list candidate ${index + 1}`,
          body: `Knowledge candidate ${index + 1} for the bounded-list check.`,
          rationale: "The fixture records a separate uncovered Session for this candidate.",
        })),
      });
      if (submitted.outcome !== "knowledge_candidates_submitted") {
        throw new Error(`Expected Knowledge candidates to submit, got ${submitted.outcome}`);
      }
      expect(submitted.candidates.length).toBeGreaterThan(5);
    });

    const metadataSessions: SessionRecord[] = [];
    for (let index = 1; index <= 12; index += 1) {
      const metadataSession = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
        projectRoot,
        idempotencyKey: `${fixtureKey}-metadata-${index}`,
        title: `Long list metadata gap ${index}`,
        summary: "A Session with deliberately missing legacy metadata.",
        changedFiles: [],
        verification: { status: "passed" },
      });
      metadataSessions.push(metadataSession.session);
    }
    const database = new DatabaseSync(process.env.WORK_INTELLIGENCE_E2E_DB!);
    const clearMetadata = database.prepare(
      "UPDATE sessions SET changed_files_json = '[]', verification_json = NULL WHERE id = ?",
    );
    for (const session of metadataSessions) {
      clearMetadata.run(session.id);
    }
    database.close();

    const today = new Date(`${reportDate}T12:00:00`);
    const daysSinceMonday = (today.getDay() + 6) % 7;
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - daysSinceMonday);
    weekStart.setHours(0, 0, 0, 0);
    for (let index = 1; index <= 20; index += 1) {
      const startedAt = new Date(weekStart.getTime() - 24 * 60 * 60 * 1000).toISOString();
      await postJson(request, "/api/work/finalize", {
        projectRoot,
        idempotencyKey: `${fixtureKey}-spanning-${index}`,
        title: `Long list spanning work ${index}`,
        summary: "A Session that started before the report week and finished within it.",
        changedFiles: [],
        verification: { status: "passed" },
        startedAt,
        completedAt: new Date().toISOString(),
      });
    }

    for (let index = 1; index <= 12; index += 1) {
      const longProjectRoot = join(tmpdir(), fixtureKey, `report-project-${index}`);
      const project = await postJson<ProjectRecord>(request, "/api/projects", {
        name: `Long list report project ${index}`,
        rootPath: longProjectRoot,
      });
      const tracked = await request.patch(`/api/projects/${project.id}`, { data: { status: "tracked" } });
      expect(tracked.ok()).toBeTruthy();

      const projectSession = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
        projectRoot: longProjectRoot,
        idempotencyKey: `${fixtureKey}-report-project-session-${index}`,
        title: `Long list project Session ${index}: ${"Long report row content ".repeat(8)}`,
        summary: "A tracked-project Session for report table scrolling.",
        changedFiles: [`src/report-project-${index}.ts`],
        verification: { status: "passed", summary: "The synthetic report fixture is valid." },
        events: [
          {
            type: "note",
            summary: `Long list decision ${index}: ${"決策範例內容".repeat(60)}`,
          },
        ],
        completedAt: new Date().toISOString(),
      });
      expect(projectSession.session.id).toBeTruthy();
    }

    for (let index = 0; index < 8; index += 1) {
      await postJson(request, "/api/backups", {});
    }

    for (const width of [1440, 960, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const expectPanelFill = width >= 960;

      await page.goto("/sessions");
      const sessionList = await expectBoundedVirtualList(page, tt("sessions.workHistoryList"));
      if (expectPanelFill) {
        await expectPanelToFillViewport(sessionList);
        await expectListToMeetPagination(sessionList);
      }
      await expectPaginationVisibleWithinViewport(page, tt("sessions.workHistoryPerPage"));
      await expectUserScrollsListInternally(page, tt("sessions.workHistoryList"));
      await expectNoHorizontalOverflow(page);

      await page.goto("/knowledge");
      const knowledgeList = await expectBoundedVirtualList(page, tt("knowledge.workKnowledgeList"));
      if (expectPanelFill) {
        await expectPanelToFillViewport(knowledgeList);
      }
      await expectPaginationVisibleWithinViewport(page, tt("knowledge.knowledgePerPage"));
      await expectNoHorizontalOverflow(page);

      await page.goto("/knowledge/candidates");
      await expectBoundedVirtualList(page, tt("knowledge.knowledgeCandidateList"));
      await expectNoHorizontalOverflow(page);

      await page.goto("/projects");
      const projectList = await expectBoundedVirtualList(page, tt("projects.projectList"));
      if (expectPanelFill) {
        await expectPanelToFillViewport(projectList);
      }
      await expectNoHorizontalOverflow(page);

      await page.goto("/projects/import");
      const handoffImportList = await expectBoundedVirtualList(page, tt("projects.handoffImportProjectList"));
      if (expectPanelFill) {
        await expectPanelToFillViewport(handoffImportList);
      }
      await expectNoHorizontalOverflow(page);

      await page.goto("/projects/backfill");
      await page.getByRole("button", { name: tt("projects.scanMetadataGaps") }).click();
      await expect(page.getByRole("list", { name: tt("projects.metadataBackfillList") })).toBeVisible();
      await expectBoundedVirtualList(page, tt("projects.metadataBackfillList"));
      await expectNoHorizontalOverflow(page);

      await page.goto("/reports/work?period=week");
      const completedWorkList = await expectBoundedVirtualList(page, tt("reports.reportOutcomesList"));
      if (expectPanelFill) {
        await expectPanelToFillViewport(completedWorkList);
      }
      const spanning = page.getByTestId("report-spanning");
      await expect(spanning).toContainText("Long list spanning work 1");
      const spanningList = await expectBoundedVirtualList(page, tt("reports.crossPeriodWorkList"));
      if (expectPanelFill) {
        await expectPanelToFillViewport(spanningList);
      }
      await expectNoHorizontalOverflow(page);

      await page.getByRole("tab", { name: tt("labels.trend") }).click();
      const reportProjectsList = await expectBoundedVirtualList(page, tt("reports.reportProjectDistributionList"));
      if (expectPanelFill) {
        await expectPanelToFillViewport(reportProjectsList);
      }
      await expectNoHorizontalOverflow(page);

      await page.getByRole("tab", { name: tt("labels.risks") }).click();
      const reportRiskList = page.getByRole("list", { name: tt("reports.reportRisksList") });
      await expect(reportRiskList).toBeVisible();
      const reportDecisionList = await expectBoundedVirtualList(page, tt("reports.reportDecisionsList"));
      if (expectPanelFill) {
        await expectPanelToFillViewport(reportRiskList);
        await expectPanelToFillViewport(reportDecisionList);
      }
      await expectNoHorizontalOverflow(page);

      await page.getByRole("tab", { name: tt("labels.rawRecords") }).click();
      const reportSessionList = await expectBoundedVirtualList(page, tt("reports.rawReportRecordsList"));
      if (expectPanelFill) {
        await expectPanelToFillViewport(reportSessionList);
        await expectListToMeetPagination(reportSessionList);
      }
      await expectPaginationVisibleWithinViewport(page, tt("reports.rawReportRecordsPerPage"));
      await expectUserScrollsListInternally(page, tt("reports.rawReportRecordsList"));
      await expectNoHorizontalOverflow(page);

      await page.getByRole("tab", { name: tt("labels.evidence") }).click();
      const reportEvidenceList = await expectBoundedVirtualList(page, tt("reports.reportEvidenceList"));
      if (expectPanelFill) {
        await expectPanelToFillViewport(reportEvidenceList);
        await expectListToMeetPagination(reportEvidenceList);
      }
      await expectPaginationVisibleWithinViewport(page, tt("reports.reportEvidencePerPage"));
      await expectNoHorizontalOverflow(page);

      await page.goto(`/sessions?session=${detailSessionId}`);
      const panel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
      await expect(panel).toBeVisible();
      await expectBoundedVirtualList(page, tt("session.list", { label: tt("labels.outcomes") }));
      await expectBoundedVirtualList(page, tt("session.sessionChangedFilesList"));
      for (const [title, label] of [
        [tt("session.sectionEvidence"), tt("session.sessionEvidenceList")],
        [tt("session.sectionKnowledge"), tt("session.sessionKnowledgeList")],
        [tt("session.linkedSessions"), tt("session.linkedSessionsList")],
        [tt("session.sectionEvents"), tt("session.sessionEventsList")],
      ] as const) {
        const summary = panel.locator("summary").filter({ hasText: title }).first();
        const disclosure = summary.locator("..");
        if ((await disclosure.getAttribute("open")) === null) {
          await summary.click();
        }
        await expectBoundedVirtualList(page, label);
      }
      await expectNoHorizontalOverflow(page);

      await page.goto("/dashboard");
      // grow-to-viewport: the list reaches the viewport bottom and scrolls inside only when its rows do not
      // fit there, so it either scrolls internally or ends inside the viewport; it never stretches the page.
      const recentWork = page.getByRole("list", { name: tt("dashboard.recentlyCompletedWorkList") });
      await expect(recentWork).toBeVisible();
      await expect(recentWork).toHaveCSS("overflow-y", "auto");
      const recentWorkFit = await recentWork.evaluate((element) => {
        const main = element.closest("#main");
        return {
          scrolls: element.scrollHeight > element.clientHeight,
          bottom: element.getBoundingClientRect().bottom,
          mainBottom: main?.getBoundingClientRect().bottom ?? window.innerHeight,
        };
      });
      if (!recentWorkFit.scrolls) expect(recentWorkFit.bottom).toBeLessThanOrEqual(recentWorkFit.mainBottom);
      await expectNoHorizontalOverflow(page);

      await page.goto("/graph");
      await expectNoHorizontalOverflow(page);

      await page.goto("/projects/backup");
      await expectBoundedVirtualList(page, tt("projects.backupList"));
      await expectNoHorizontalOverflow(page);
    }

    // Wide but not so tall that one page of ten rows fits without internal scrolling: the compact
    // page header leaves the list most of the viewport.
    await page.setViewportSize({ width: 2048, height: 900 });
    for (const [path, heading, listName, paginationLabel] of [
      ["/sessions", tt("common.workHistory"), tt("sessions.workHistoryList"), tt("sessions.workHistoryPerPage")],
      [
        "/reports/raw?period=week",
        tt("nav.workReports"),
        tt("reports.rawReportRecordsList"),
        tt("reports.rawReportRecordsPerPage"),
      ],
    ] as const) {
      await page.goto(path);
      const list = await expectBoundedVirtualList(page, listName);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
      await expect(page.locator("#main")).toHaveJSProperty("scrollTop", 0);
      await expectPanelToFillViewport(list);
      await expectListToMeetPagination(list);
      await expectPaginationVisibleWithinViewport(page, paginationLabel);
      await expectUserScrollsListInternally(page, listName);
    }

    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/sessions");
    await expectPaginationVisibleWithinViewport(page, tt("sessions.workHistoryPerPage"));
    await page.goto("/reports/raw?period=week");
    await expectPaginationVisibleWithinViewport(page, tt("reports.rawReportRecordsPerPage"));

    expect(browserErrors).toEqual([]);
  });
  test("edits in-progress verification and preserves report/audit distinctions @cross-browser", async ({
    page,
    request,
    browserName,
  }) => {
    test.setTimeout(90_000);
    const fixture = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `browser-progress-${process.pid}`,
      title: "Progress verification fixture",
      summary: "Synthetic completed checkpoint.",
      changedFiles: [],
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      verification: { status: "not_run" },
    });
    const id = fixture.session.id;
    for (const status of ["in_progress", "passed", "in_progress", "failed"] as const) {
      await page.goto(`/sessions?session=${id}`);
      const panel = page.getByRole("dialog", { name: tt("session.sessionDetails") });
      await panel.getByRole("button", { name: tt("session.editSession") }).click();
      const editor = page.getByRole("dialog", { name: tt("session.editSession") });
      await editor.getByLabel(tt("session.verificationStatus")).selectOption(status);
      await editor.getByRole("button", { name: tt("common.saveChanges") }).click();
      await expect(editor).toBeHidden();
      const detail = await (await request.get(`/api/sessions/${id}`)).json();
      expect(detail.session.verification.status).toBe(status);
      expect(detail.session.id).toBe(id);
    }
    const invalid = await request.patch(`/api/sessions/${id}/verification`, { data: { status: "__proto__" } });
    expect(invalid.status()).toBe(400);
    const restored = await request.patch(`/api/sessions/${id}/verification`, {
      data: { status: "in_progress", summary: "<script>fixture</script>" },
    });
    expect(restored.ok()).toBeTruthy();
    const detail = await (await request.get(`/api/sessions/${id}`)).json();
    expect(detail.verificationHistory.map((row: { resulting: { status: string } }) => row.resulting.status)).toEqual([
      "in_progress",
      "failed",
      "in_progress",
      "passed",
      "in_progress",
    ]);
    const report = await (await request.get("/api/reports?period=day")).json();
    expect(report.totals.verification.in_progress).toBeGreaterThan(0);
    expect(
      report.risks.some(
        (risk: { kind: string; sourceSessionIds: string[] }) =>
          risk.kind === "verification" && risk.sourceSessionIds.includes(id),
      ),
    ).toBeTruthy();
    for (const [width, theme, locale] of [
      [1440, "dark", "zh-TW"],
      [960, "light", "en-US"],
      [375, "dark", "en-US"],
      [375, "light", "zh-TW"],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(
        ({ theme, locale }) => {
          localStorage.setItem("work-intelligence:theme", theme);
          localStorage.setItem("work-intelligence:locale", locale);
        },
        { theme, locale },
      );
      await page.goto(`/sessions?session=${id}`);
      const panel = page.getByRole("dialog", { name: textIn(locale, "session.sessionDetails") });
      await expect(panel).toContainText(textIn(locale, "common.inProgress"));
      await expect(panel).toContainText("<script>fixture</script>");
      expect(await panel.locator("script").count()).toBe(0);
      await expectNoHorizontalOverflow(page);
      // WebKit mouse clicks do not focus buttons; use keyboard activation to verify focus restoration.
      const editButton = panel.getByRole("button", { name: textIn(locale, "session.editSession") });
      await editButton.focus();
      await editButton.press("Enter");
      const editor = page.getByRole("dialog", { name: textIn(locale, "session.editSession") });
      await expect(editor.getByLabel(textIn(locale, "session.verificationStatus"))).toHaveValue("in_progress");
      await expectNoHorizontalOverflow(page);
      const axe = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(axe.violations).toEqual([]);
      if (browserName !== "webkit")
        await page.screenshot({
          path: test.info().outputPath(`verification-progress-${width}-${theme}-${locale}.png`),
        });
      await editor.press("Escape");
      await expect(editor).toBeHidden();
      await expect(panel.getByRole("button", { name: textIn(locale, "session.editSession") })).toBeFocused();
    }
  });
});
