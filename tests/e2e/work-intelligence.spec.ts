import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { WorkIntelligenceStore } from "../../packages/storage/dist/index.js";

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
  ["/dashboard", "工作總覽"],
  ["/sessions", "工作歷程"],
  ["/reports", "工作報告"],
  ["/knowledge", "工作知識"],
  ["/graph", "工作圖譜"],
  ["/projects", "專案"],
];

async function postJson<T>(request: APIRequestContext, endpoint: string, body: unknown): Promise<ApiResult<T>> {
  const response = await request.post(endpoint, { data: body });
  expect(response.ok(), `${endpoint} returned ${response.status()}`).toBeTruthy();
  return (await response.json()) as ApiResult<T>;
}

async function submitKnowledgeCandidateForReview(
  page: Page,
  input: { title: string; body: string; rationale: string },
): Promise<string> {
  await page.goto("/knowledge");
  const candidates = page.getByTestId("knowledge-candidates");
  await candidates.getByRole("button", { name: "整理候選" }).click();
  await page.getByRole("menuitem", { name: "Browser Regression Fixture" }).click();
  await expect(candidates).toContainText("等待 Agent 整理");

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
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await list.focus();
  await page.keyboard.press("PageDown");
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  return list;
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

    const finalized = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `browser-regression-${process.pid}`,
      title: "Browser regression fixture session",
      summary: "Fixture data used to exercise the Work Intelligence UI.",
      workSummary: {
        outcomes: ["The browser fixture remains readable."],
        scope: ["The primary Work Intelligence views."],
        decisions: ["Use one isolated SQLite fixture."],
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

  test("serves the production Web UI and API from one origin @cross-browser", async ({ page }) => {
    const response = await page.goto("/dashboard");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "工作總覽" })).toBeVisible();

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

  test("shows the global API offline banner and refreshes after the API reconnects", async ({ page }) => {
    let dashboardRequestCount = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/dashboard") {
        dashboardRequestCount += 1;
      }
    });
    await page.route("**/api/**", (route) => route.abort());
    await page.goto("/");

    const offlineBanner = page.getByRole("alert").filter({ hasText: "無法連線到 Work Intelligence API" });
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
    await expect(page.getByRole("heading", { name: "工作總覽" })).toBeVisible();
  });

  test("keeps the report synthesis card readable with sourced sections and versions", async ({ page, request }) => {
    await page.goto("/");
    await page.getByTestId("nav-reports").click();
    await expect(page.getByRole("heading", { name: "工作報告" }).first()).toBeVisible();

    const synthesis = page.getByTestId("report-synthesis");
    await expect(synthesis).toBeVisible();
    await expect(synthesis).toContainText("Browser regression report updated");
    await expect(synthesis).toContainText("已完成");
    await expect(synthesis).toContainText("狀態／未結項");
    await expect(synthesis.getByRole("button", { name: /1 Session/ }).first()).toBeVisible();
    const history = page.getByTestId("report-synthesis-history");
    await expect(history).toContainText("歷史版本");
    await history.locator("summary").click();
    await expect(history.getByTestId("report-synthesis-version")).toHaveCount(2);
    await expect(history).toContainText("Browser regression report");

    // The overview's deterministic part changes shape with the period.
    const breakdown = page.getByTestId("report-breakdown");
    await expect(breakdown).toContainText("每日分布");
    await expect(breakdown).toContainText("專案占比");
    const periods = page.getByRole("radiogroup", { name: "選擇報表區間" });
    await periods.getByRole("radio", { name: "日" }).click();
    await expect(breakdown).toContainText("當日完成的工作");
    await periods.getByRole("radio", { name: "年" }).click();
    await expect(breakdown).toContainText("每季分布");
    await periods.getByRole("radio", { name: "週" }).click();
    await expect(breakdown).toContainText("每日分布");

    await synthesis.getByRole("button", { name: "重新整理", exact: true }).click();
    await expect(synthesis).toContainText("待處理");
    await expect(synthesis.getByRole("button", { name: "取消這次整理" })).toBeVisible();
    await expect(synthesis.getByRole("button", { name: "複製 Agent 指令" })).toBeVisible();

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
    await expect(page.getByText("Agent 已完成 AI 報告整理。")).toBeVisible({ timeout: 15_000 });
    await expect(synthesis).toContainText("Browser regression report by Agent");

    await page.getByRole("tab", { name: "原始紀錄" }).click();
    const reportSessionPageSize = page.getByLabel("報告原始工作紀錄每頁筆數");
    await expect(reportSessionPageSize).toHaveValue("10");
    await expect(reportSessionPageSize.locator("option")).toHaveCount(5);
    await reportSessionPageSize.selectOption("all");
    await expectBoundedVirtualList(page, "報告原始工作紀錄清單");

    await page.getByRole("tab", { name: "證據" }).click();
    const reportEvidencePageSize = page.getByLabel("報告來源證據每頁筆數");
    await expect(reportEvidencePageSize).toHaveValue("10");
    await expect(reportEvidencePageSize.locator("option")).toHaveCount(5);
    await reportEvidencePageSize.selectOption("all");
    await expectBoundedVirtualList(page, "報告來源證據清單");
  });

  test("builds a report for a custom date range", async ({ page }) => {
    await page.goto("/reports");
    await page.getByRole("radiogroup", { name: "選擇報表區間" }).getByRole("radio", { name: "自訂" }).click();
    // Switching to a custom range starts from the last 14 days.
    await expect(page).toHaveURL(
      /period=custom.*from=\d{4}-\d{2}-\d{2}.*to=\d{4}-\d{2}-\d{2}|period=custom.*to=.*from=/,
    );
    await expect(page.getByText(/自訂期間 · \d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}/)).toBeVisible();
    await expect(page.getByTestId("report-breakdown")).toContainText("每日分布");
    await expect(
      page.getByTestId("report-synthesis").getByRole("button", { name: "請 Agent 整理這份報告" }),
    ).toBeEnabled();

    await page.goto(`/reports?period=custom&from=${reportDate}&to=${reportDate}`);
    await expect(page.getByTestId("report-breakdown")).toContainText("每日分布");
    await expect(page.getByText(`自訂期間 · ${reportDate} – ${reportDate}`)).toBeVisible();
  });

  test("keeps Worklog and Knowledge page-size controls at the intended default", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-sessions").click();
    await expect(page.getByRole("heading", { name: "工作歷程" }).first()).toBeVisible();

    const sessionPageSize = page.getByLabel("工作歷程每頁筆數");
    await expect(sessionPageSize).toHaveValue("10");
    await expect(sessionPageSize.locator("option")).toHaveCount(5);
    await sessionPageSize.selectOption("20");
    await expect(sessionPageSize).toHaveValue("20");
    await sessionPageSize.selectOption("all");
    const sessionList = await expectBoundedVirtualList(page, "工作歷程清單");
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
    await expect(page.getByRole("heading", { name: "工作知識" }).first()).toBeVisible();
    const knowledgePageSize = page.getByLabel("Knowledge 每頁筆數");
    await expect(knowledgePageSize).toHaveValue("10");
    await expect(knowledgePageSize.locator("option")).toHaveCount(5);
    await knowledgePageSize.selectOption("all");
    await expectBoundedVirtualList(page, "工作知識清單");
  });

  test("keeps Graph filters and source detail navigation available", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-graph").click();
    await expect(page.getByRole("heading", { name: "工作圖譜" }).first()).toBeVisible();

    const nodeFilter = page.getByLabel("選擇 Graph 節點類型");
    const previewLimit = page.getByLabel("選擇 Graph 畫面預覽量");
    const loadPreset = page.getByLabel("選擇 Graph 資料載入上限");
    await expect(nodeFilter).toHaveValue("all");
    await expect(previewLimit).toHaveValue("120");
    await expect(loadPreset).toHaveValue("180");
    await nodeFilter.selectOption("session");
    await previewLimit.selectOption("60");
    await page.getByRole("button", { name: "更新圖譜" }).click();
    const visibleCount = page.getByTestId("graph-visible-count");
    await expect(visibleCount).toContainText("節點");

    const graphViewport = page.getByTestId("graph-viewport");
    const graphLaneHeader = page.getByTestId("graph-lane-header");
    await expect(graphLaneHeader).toBeVisible();
    const graphDisplayedNodeCount = Number((await visibleCount.innerText()).match(/顯示\s+(\d+)/)?.[1] ?? 0);
    const graphNodes = graphViewport.getByRole("button", { name: /^查看/ });
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
    await expect(page.getByRole("button", { name: "關閉 Graph 節點詳細資料" })).toBeVisible();
    await page.getByRole("button", { name: "關閉 Graph 節點詳細資料" }).click();
  });

  test("keeps Session detail usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "開啟主選單" }).click();
    await page.getByTestId("nav-sessions").click();
    await expect(page.getByTestId("nav-sessions")).not.toBeInViewport();
    const firstRow = page.getByTestId("session-row").first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();
    const detail = page.getByRole("dialog");
    await expect(detail).toBeVisible();
    const workSummary = page.getByTestId("session-work-summary");
    await expect(workSummary).toContainText("成果");
    await expect(workSummary).toContainText("The browser fixture remains readable.");
    await expect(workSummary).toContainText("狀態／未結項");

    await expect(detail).toBeInViewport({ ratio: 1 });
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "關閉", exact: true }).click();
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

  test("supports direct page routes @cross-browser", async ({ page }) => {
    for (const [path, heading] of pageRoutes) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }

    await page.goto("/worklog");
    await expect(page).toHaveURL(/\/sessions$/);
    await expect(page.getByRole("heading", { name: "工作歷程" }).first()).toBeVisible();
  });

  test("opens the Session panel from a ?session deep link and closes it", async ({ page }) => {
    await page.goto(`/sessions?session=${sessionId}`);
    const panel = page.getByRole("dialog", { name: "Session 詳情" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Browser regression fixture session");
    await expect(panel).toContainText("changed files 不代表 Git commit");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page).not.toHaveURL(/session=/);
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
    const panel = page.getByRole("dialog", { name: "Session 詳情" });
    await expect(panel).toContainText("Original editable summary.");
    await panel.getByRole("button", { name: "編輯 Session" }).click();

    const editor = page.getByRole("dialog", { name: "編輯 Session" });
    await expect(editor).toBeVisible();
    await editor.getByLabel("主摘要").fill("Edited summary from the Web UI.");
    await editor.getByLabel("成果").fill("Edited outcome one.\nEdited outcome two.");
    await editor.getByLabel("Verification 狀態").selectOption("passed");
    await editor.getByLabel("Verification 說明").fill("Ran pnpm test after the fix.");
    await editor.getByRole("button", { name: "儲存變更" }).click();

    await expect(editor).toBeHidden();
    await expect(panel).toContainText("Edited summary from the Web UI.");
    await expect(panel).toContainText("Edited outcome two.");
    // Untouched sections are patched around, not cleared.
    await expect(panel).toContainText("Original scope.");

    await expect(panel).toContainText("Verification 修改紀錄");

    const detail = (await (await request.get(`/api/sessions/${editableId}`)).json()) as {
      session: { id: string; summary: string; workSummary: { outcomes: string[]; scope: string[] } };
      verificationHistory: Array<{ source: string; previous?: { status: string }; resulting: { status: string } }>;
    };
    expect(detail.session).toMatchObject({
      id: editableId,
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
    const panel = page.getByRole("dialog", { name: "Session 詳情" });
    await panel.getByRole("button", { name: "作廢 Session" }).click();
    const dialog = page.getByRole("dialog", { name: "作廢 Session" });
    await dialog.getByLabel("原因").fill("Recorded while testing.");
    await dialog.getByRole("button", { name: "作廢", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(panel).toContainText("這筆 Session 已作廢");
    await expect(panel).toContainText("Recorded while testing.");

    await page.goto("/sessions?voided=only");
    await expect(page.getByTestId("session-row").filter({ hasText: "Voidable fixture session" })).toBeVisible();
    await page.goto("/sessions");
    await expect(page.getByTestId("session-row").filter({ hasText: "Voidable fixture session" })).toHaveCount(0);

    await page.goto(`/sessions?session=${targetId}`);
    await panel.getByRole("button", { name: "還原" }).click();
    await page.getByRole("dialog", { name: "還原這筆 Session？" }).getByRole("button", { name: "還原" }).click();
    await expect(panel).not.toContainText("這筆 Session 已作廢");
    await expect(panel.getByRole("button", { name: "作廢 Session" })).toBeVisible();
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
    const panel = page.getByRole("dialog", { name: "Session 詳情" });
    const links = panel.getByTestId("session-links");
    await links.getByText("關聯 Session").click();
    await links.getByRole("button", { name: "新增關聯" }).click();
    const dialog = page.getByRole("dialog", { name: "新增 Session 關聯" });
    await dialog.getByLabel("搜尋要關聯的 Session").fill("Linkable planning");
    await dialog.getByLabel(/Linkable planning session/).check();
    await dialog.getByRole("button", { name: "建立關聯" }).click();
    await expect(dialog).toBeHidden();
    await expect(links).toContainText("接續自");

    await links.getByRole("link", { name: "Linkable planning session" }).click();
    await expect(panel).toContainText("Linkable planning session");
    await expect(panel.getByTestId("session-links")).toContainText("後續");
    await expect(panel.getByTestId("session-links")).toContainText("Linkable implementation session");
  });

  test("resizes the Session panel from its edge and remembers the width", async ({ page }) => {
    await page.goto(`/sessions?session=${sessionId}`);
    const panel = page.getByRole("dialog", { name: "Session 詳情" });
    await expect(panel).toBeVisible();
    const handle = panel.getByRole("separator", { name: "調整Session 詳情寬度" });
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
    const search = page.getByLabel("搜尋 Graph 節點");
    await search.fill("Browser regression fixture");
    await expect(page.getByTestId("graph-visible-count")).toContainText("符合");
    await expect(page).toHaveURL(/q=Browser/);
    await search.press("Enter");
    await expect(page.getByRole("button", { name: "關閉 Graph 節點詳細資料" })).toBeVisible();
    await expect(page.getByTestId("graph-viewport").getByRole("button", { pressed: true })).toHaveCount(1);

    await search.fill("zz-no-such-graph-node");
    await expect(page.getByText("沒有符合的節點")).toBeVisible();
  });

  test("backs up the database from the projects page and explains how to move it", async ({ page }) => {
    await page.goto("/projects/backup");
    const backups = page.getByRole("tabpanel", { name: "資料備份" });
    await expect(backups).toContainText("匯出整份資料");
    await expect(backups).toContainText("pnpm db:restore");
    await backups.getByRole("button", { name: "立即備份" }).click();
    await expect(page.getByText("已備份目前的資料。")).toBeVisible();
    await expect(backups.getByText(/^work-intelligence-e2e-\d+-manual-\d{8}T\d{6}Z/).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("exports one project and previews an idempotent import", async ({ page }) => {
    await page.goto("/projects/backup");
    const backups = page.getByRole("tabpanel", { name: "資料備份" });
    await backups.getByLabel("選擇匯出範圍").selectOption("project");
    await backups.getByLabel("選擇匯出專案").selectOption(projectId);

    const downloadPromise = page.waitForEvent("download");
    await backups.getByRole("button", { name: "匯出 JSON" }).click();
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

    await backups.getByLabel("匯入檔").setInputFiles({
      name: download.suggestedFilename(),
      mimeType: "application/json",
      buffer: exported,
    });
    await backups.getByRole("button", { name: "預覽匯入" }).click();
    const preview = backups.getByTestId("project-import-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Browser Regression Fixture");
    await expect(preview.getByTestId("project-import-selected-projects")).toContainText(projectRoot);
    await expect(preview.getByTestId("project-import-selected-projects")).toContainText("對應既有專案");
    await expect(preview.getByTestId("project-import-additions")).toContainText("新增");
    await expect(preview.getByTestId("project-import-skipped")).toContainText("略過");
    await expect(preview.getByTestId("project-import-conflicts")).toContainText("衝突");

    await preview.getByRole("button", { name: "確認並匯入" }).click();
    const confirmation = page.getByRole("dialog", { name: "確認匯入專案資料" });
    await expect(confirmation).toContainText("新匯入的專案會先暫停記錄");
    await confirmation.getByRole("button", { name: "匯入", exact: true }).click();
    await expect(page.getByText(/匯入完成：新增 0 筆、略過 [1-9]\d* 筆，衝突 0 筆。/)).toBeVisible();
    for (const width of [1440, 960, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
    }
  });

  test("asks for consent before a project starts being tracked", async ({ page, request }) => {
    await postJson(request, "/api/projects", { name: "Consent Fixture", rootPath: `${projectRoot}/e2e` });
    await page.goto("/projects");
    const status = page.getByLabel("更新 Consent Fixture 的專案記錄狀態");
    await expect(status).toHaveValue("unregistered");
    await status.selectOption("tracked");
    const consent = page.getByRole("dialog", { name: /切換為記錄中/ });
    await expect(consent).toBeVisible();
    await consent.getByRole("button", { name: "取消" }).click();
    await expect(consent).toBeHidden();
    await expect(page.getByLabel("更新 Consent Fixture 的專案記錄狀態")).toHaveValue("unregistered");
  });

  test("fills the project root from the folder dialog", async ({ page }) => {
    // Answer for the API so no real dialog opens on the machine running the tests.
    await page.route("**/api/system/pick-folder", (route) =>
      route.fulfill({ json: { outcome: "folder_picked", path: "/Users/me/code/apiary", name: "apiary" } }),
    );
    await page.goto("/projects");
    await page.getByRole("button", { name: "加入專案" }).first().click();
    const dialog = page.getByRole("dialog", { name: "加入專案" });
    await dialog.getByRole("button", { name: "選擇資料夾" }).click();
    await expect(dialog.getByLabel("Workspace 根目錄")).toHaveValue("/Users/me/code/apiary");
    await expect(dialog.getByLabel("專案名稱")).toHaveValue("apiary");

    await page.unroute("**/api/system/pick-folder");
    await page.route("**/api/system/pick-folder", (route) =>
      route.fulfill({ json: { outcome: "folder_pick_unavailable", reason: "none" } }),
    );
    await dialog.getByRole("button", { name: "選擇資料夾" }).click();
    await expect(page.getByText("這台電腦無法開啟選擇資料夾視窗，請直接輸入路徑。")).toBeVisible();
    await expect(dialog.getByLabel("Workspace 根目錄")).toHaveValue("/Users/me/code/apiary");
  });

  test("jumps to a page from the command palette", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "工作總覽" }).first()).toBeVisible();
    await page.keyboard.press("Control+KeyK");
    const palette = page.getByRole("dialog", { name: "搜尋或跳至頁面" });
    await expect(palette).toBeVisible();
    await page.keyboard.type("工作報告");
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
    await expect(spanning).toContainText("更早開始、在這段期間完成");
    await expect(spanning).toContainText("Long-running fixture work");
  });

  test("shows Agent-proposed Knowledge as soon as the Agent submits it, and accepts it", async ({ page }) => {
    await page.goto("/knowledge");
    const candidates = page.getByTestId("knowledge-candidates");
    await candidates.getByRole("button", { name: "整理候選" }).click();
    await page.getByRole("menuitem", { name: "Browser Regression Fixture" }).click();
    await expect(candidates).toContainText("等待 Agent 整理");

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
    await expect(page.getByText(/Agent 已送出.*Knowledge 候選/)).toBeVisible({ timeout: 15_000 });
    const candidate = candidates.getByTestId("knowledge-candidate").filter({ hasText: "E2E candidate" });
    await candidate.getByRole("button", { name: "接受", exact: true }).click();
    await expect(page.getByText("已加入 Knowledge。")).toBeVisible();
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
    await expect(row).toContainText("可能過時");
    await row.getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "確認仍有效" }).click();
    await expect(row).not.toContainText("可能過時");
    await expect(row).toContainText("確認有效於");
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
    await page.getByRole("button", { name: "掃描 metadata 缺口" }).click();
    await expect(page.getByRole("button", { name: "取消回補" })).toBeVisible();

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
    await expect(page.getByText("Agent 已完成 metadata 回補。")).toBeVisible({ timeout: 15_000 });
  });

  test("refreshes the Session list after a Session is created over REST", async ({ page, request }) => {
    const eventsConnected = page.waitForResponse(
      (response) => response.url().endsWith("/api/events") && response.status() === 200,
    );
    await page.goto("/sessions");
    await eventsConnected;
    await expect(page.getByTestId("session-row").first()).toBeVisible();

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
    await createSession(liveTitle);
    await expect(page.getByTestId("session-row").filter({ hasText: liveTitle })).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hiddenTitle = `即時更新背景測試 ${process.pid}`;
    await createSession(hiddenTitle);
    const newRow = page.getByTestId("session-row").filter({ hasText: hiddenTitle });
    await page.waitForTimeout(2_200);
    await expect(newRow).toHaveCount(0);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(newRow).toBeVisible({ timeout: 10_000 });
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
    await candidate.getByRole("button", { name: "修改後接受", exact: true }).click();

    const editor = page.getByRole("dialog", { name: "修改後接受 Knowledge 候選" });
    await expect(editor).toBeVisible();
    await editor.getByLabel("標題").fill(editedTitle);
    await editor.getByLabel("Knowledge 類型").selectOption("decision");
    await editor.getByLabel("內容").fill(editedBody);
    await editor.getByLabel("標籤").fill("E2E, reviewer-edited");
    await editor.getByLabel("適用路徑").fill("e2e/work-intelligence.spec.ts\napps/web/src/views/KnowledgeView.vue");
    await editor.getByRole("button", { name: "接受並加入 Knowledge" }).click();

    await expect(page.getByText("已加入 Knowledge。")).toBeVisible();
    const knowledge = page.getByTestId("knowledge-row").filter({ hasText: editedTitle });
    await expect(knowledge).toBeVisible();
    await expect(knowledge).toContainText("技術決策");
    await expect(knowledge).toContainText(editedBody);
    await expect(knowledge).toContainText("#E2E");
    await expect(knowledge).toContainText("#reviewer-edited");
    await expect(knowledge).toContainText("適用 e2e/work-intelligence.spec.ts");
    await expect(candidates.getByTestId("knowledge-candidate").filter({ hasText: originalTitle })).toHaveCount(0);

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
    await candidate.getByRole("button", { name: "拒絕", exact: true }).click();

    const confirmation = page.getByRole("dialog", { name: "拒絕這筆候選？" });
    await expect(confirmation).toContainText("不會成為 Knowledge");
    await confirmation.getByRole("button", { name: "拒絕", exact: true }).click();

    await expect(page.getByText("已拒絕這筆候選。")).toBeVisible();
    await expect(candidates.getByTestId("knowledge-candidate").filter({ hasText: title })).toHaveCount(0);
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
    const createButton = synthesis.getByRole("button", { name: "請 Agent 整理這份報告" });
    await expect(createButton).toBeEnabled();
    await createButton.click();

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
      await expect(notice).toContainText("本期超過 200 個 Session 的報告上限");
      await expect(notice).toContainText("只依納入報告的 Session 計算");
    } finally {
      rmSync(truncationProjectRoot, { recursive: true, force: true });
    }
  });

  test("keeps unpaginated long lists scrollable and error-free at desktop, tablet, and mobile widths", async ({
    page,
    request,
  }) => {
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
        outcomes: longItems("成果"),
        scope: longItems("範圍"),
        decisions: longItems("決策"),
        verification: longItems("驗證"),
        nextSteps: longItems("狀態"),
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

    for (const width of [1440, 960, 375]) {
      await page.setViewportSize({ width, height: 900 });

      await page.goto("/knowledge");
      await expectBoundedVirtualList(page, "Knowledge 候選清單");
      await expectNoHorizontalOverflow(page);

      await page.goto("/projects/backfill");
      await page.getByRole("button", { name: "掃描 metadata 缺口" }).click();
      await expect(page.getByRole("list", { name: "metadata 回補清單" })).toBeVisible();
      await expectBoundedVirtualList(page, "metadata 回補清單");
      await expectNoHorizontalOverflow(page);

      await page.goto("/reports/work?period=week");
      const spanning = page.getByTestId("report-spanning");
      await expect(spanning).toContainText("Long list spanning work 1");
      await expectBoundedVirtualList(page, "跨期工作清單");
      await expectNoHorizontalOverflow(page);

      await page.goto(`/sessions?session=${detailSessionId}`);
      const panel = page.getByRole("dialog", { name: "Session 詳情" });
      await expect(panel).toBeVisible();
      await expectBoundedVirtualList(page, "成果清單");
      await expectBoundedVirtualList(page, "Session changed files 清單");
      for (const [title, label] of [
        ["Evidence", "Session Evidence 清單"],
        ["Knowledge", "Session Knowledge 清單"],
        ["關聯 Session", "關聯 Session 清單"],
        ["Events", "Session Events 清單"],
      ] as const) {
        const summary = panel.locator("summary").filter({ hasText: title }).first();
        const disclosure = summary.locator("..");
        if ((await disclosure.getAttribute("open")) === null) {
          await summary.click();
        }
        await expectBoundedVirtualList(page, label);
      }
      await expectNoHorizontalOverflow(page);
    }

    expect(browserErrors).toEqual([]);
  });
});
