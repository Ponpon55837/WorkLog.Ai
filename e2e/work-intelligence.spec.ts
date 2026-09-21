import { expect, test, type APIRequestContext } from "@playwright/test";

const projectRoot = process.cwd();
const reportDate = new Date().toISOString().slice(0, 10);

type ProjectRecord = { id: string };
type SessionRecord = { id: string };
type ApiResult<T> = T & { outcome?: string; reason?: string };

async function postJson<T>(request: APIRequestContext, endpoint: string, body: unknown): Promise<ApiResult<T>> {
  const response = await request.post(endpoint, { data: body });
  expect(response.ok(), `${endpoint} returned ${response.status()}`).toBeTruthy();
  return (await response.json()) as ApiResult<T>;
}

test.describe("Work Intelligence browser regression", () => {
  test.describe.configure({ mode: "serial" });

  let projectId = "";
  let sessionId = "";

  test.beforeAll(async ({ request }) => {
    const project = await postJson<ProjectRecord>(request, "/api/projects", {
      name: "Browser Regression Fixture",
      rootPath: projectRoot
    });
    projectId = project.id;

    const trackedProject = await request.patch(`/api/projects/${projectId}`, {
      data: { status: "tracked" }
    });
    expect(trackedProject.ok()).toBeTruthy();

    const finalized = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
      projectRoot,
      idempotencyKey: `browser-regression-${process.pid}`,
      title: "Browser regression fixture session",
      summary: "Fixture data used to exercise the Work Intelligence UI.",
      changedFiles: ["README.md"],
      verification: {
        status: "passed",
        summary: "Browser regression fixture is deterministic."
      },
      events: [
        { type: "verification", summary: "Fixture verification completed." }
      ],
      completedAt: new Date().toISOString()
    });
    sessionId = finalized.session.id;

    const evidence = await request.post(`/api/sessions/${sessionId}/evidence`, {
      data: {
        kind: "test",
        reference: "pnpm test:e2e",
        summary: "Browser regression fixture evidence."
      }
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
      references: ["playwright.config.ts"]
    });
    expect(knowledge.outcome).toBe("knowledge_recorded");

    const synthesisRequest = await postJson<{ request: { id: string } }>(request, "/api/reports/synthesis-requests", {
      period: "week",
      date: reportDate,
      projectId,
      idempotencyKey: `browser-regression-report-${process.pid}`
    });
    expect(synthesisRequest.outcome).toBe("report_synthesis_request");

    const sourceBlock = {
      title: "Browser validation",
      detail: "The regression fixture confirms the primary Work Intelligence views remain navigable.",
      sourceSessionIds: [sessionId]
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
      generatedByModel: "test-fixture"
    };
    const summary = await postJson(request, "/api/reports/summaries", {
      requestId: synthesisRequest.request.id,
      title: "Browser regression report",
      ...summaryPayload,
      promptVersion: "e2e-fixture-v1"
    });
    expect(summary.outcome).toBe("report_summary_saved");

    const newerRequest = await postJson<{ request: { id: string } }>(request, "/api/reports/synthesis-requests", {
      period: "week",
      date: reportDate,
      projectId,
      idempotencyKey: `browser-regression-report-v2-${process.pid}`
    });
    expect(newerRequest.outcome).toBe("report_synthesis_request");
    const newerSummary = await postJson(request, "/api/reports/summaries", {
      requestId: newerRequest.request.id,
      title: "Browser regression report updated",
      ...summaryPayload,
      promptVersion: "e2e-fixture-v2"
    });
    expect(newerSummary.outcome).toBe("report_summary_saved");
  });

  test("keeps the report synthesis card collapsible and readable", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /工作報告 Reports/ }).click();
    await expect(page.getByRole("heading", { name: "工作報告" }).first()).toBeVisible();

    const synthesis = page.locator("details.report-synthesis-card");
    await expect(synthesis).toBeVisible();
    await expect(synthesis).not.toHaveAttribute("open");
    await synthesis.locator("summary.report-synthesis-summary").click();
    await expect(synthesis).toHaveAttribute("open", "");
    await expect(synthesis).toContainText("Browser regression report updated");
    await expect(synthesis).toContainText("提煉完成");
    const history = synthesis.locator("details.report-synthesis-history");
    await expect(history).toContainText("2 個版本");
    await history.locator("summary").click();
    await expect(history.locator(".report-synthesis-history-item")).toHaveCount(2);
    await expect(history).toContainText("Browser regression report");

    const resynthesizeButton = synthesis.getByRole("button", { name: "重新提煉", exact: true });
    await expect(resynthesizeButton).toBeEnabled();
    await resynthesizeButton.click();
    await expect(synthesis.getByRole("button", { name: "等待 Agent 處理中…", exact: true })).toBeDisabled();

    await page.getByRole("tab", { name: "原始紀錄" }).click();
    const reportSessionPageSize = page.getByLabel("報告原始工作紀錄每頁筆數");
    await expect(reportSessionPageSize).toHaveValue("10");
    await expect(reportSessionPageSize.locator("option")).toHaveCount(5);

    await page.getByRole("tab", { name: "證據" }).click();
    const reportEvidencePageSize = page.getByLabel("報告來源證據每頁筆數");
    await expect(reportEvidencePageSize).toHaveValue("10");
    await expect(reportEvidencePageSize.locator("option")).toHaveCount(5);
  });

  test("keeps Worklog and Knowledge page-size controls at the intended default", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /工作歷程/ }).click();
    await expect(page.getByRole("heading", { name: "工作歷程" }).first()).toBeVisible();

    const sessionPageSize = page.getByLabel("工作歷程每頁筆數");
    await expect(sessionPageSize).toHaveValue("10");
    await expect(sessionPageSize.locator("option")).toHaveCount(5);
    await sessionPageSize.selectOption("20");
    await expect(sessionPageSize).toHaveValue("20");

    await page.getByRole("button", { name: /工作知識 Knowledge/ }).click();
    await expect(page.getByRole("heading", { name: "工作知識" }).first()).toBeVisible();
    const knowledgePageSize = page.getByLabel("Knowledge 每頁筆數");
    await expect(knowledgePageSize).toHaveValue("10");
    await expect(knowledgePageSize.locator("option")).toHaveCount(5);
  });

  test("keeps Graph filters and source detail navigation available", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /工作圖譜 Graph/ }).click();
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
    await expect(page.locator(".graph-visual-panel .report-count")).toContainText("節點");

    const graphViewport = page.locator(".graph-viewport");
    const graphLaneHeader = graphViewport.locator(".graph-lane-header");
    await expect(graphLaneHeader).toBeVisible();
    await expect(graphLaneHeader).toHaveCSS("position", "sticky");
    const headerTopBeforeScroll = await graphLaneHeader.evaluate((element) => element.getBoundingClientRect().top);
    await graphViewport.evaluate((element) => {
      element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight);
    });
    const headerTopAfterScroll = await graphLaneHeader.evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(headerTopAfterScroll - headerTopBeforeScroll)).toBeLessThan(2);

    const graphNode = page.locator(".graph-svg-node").first();
    await expect(graphNode).toBeVisible();
    await graphNode.click();
    await expect(page.getByRole("button", { name: "關閉 Graph 節點詳細資料" })).toBeVisible();
    await page.getByRole("button", { name: "關閉 Graph 節點詳細資料" }).click();
  });

  test("keeps Session detail modal usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: /工作歷程/ }).click();
    await expect(page.locator(".worklog-row").first()).toBeVisible();
    await page.locator(".worklog-row").first().click();
    await expect(page.getByRole("button", { name: "關閉" })).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
    await page.getByRole("button", { name: "關閉" }).click();
  });
});
