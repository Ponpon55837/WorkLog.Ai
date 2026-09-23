import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const projectRoot = process.cwd();
const reportDate = new Date().toISOString().slice(0, 10);

type ProjectRecord = { id: string };
type SessionRecord = { id: string };
type ApiResult<T> = T & { outcome?: string; reason?: string };

const pageRoutes: ReadonlyArray<readonly [string, string]> = [
  ["/dashboard", "工作總覽"],
  ["/sessions", "工作歷程"],
  ["/reports", "工作報告"],
  ["/knowledge", "工作知識"],
  ["/graph", "工作圖譜"],
  ["/projects", "專案記錄管理"]
];

async function postJson<T>(request: APIRequestContext, endpoint: string, body: unknown): Promise<ApiResult<T>> {
  const response = await request.post(endpoint, { data: body });
  expect(response.ok(), `${endpoint} returned ${response.status()}`).toBeTruthy();
  return (await response.json()) as ApiResult<T>;
}

async function expectBoundedVirtualList(page: Page, name: string): Promise<Locator> {
  const list = page.getByRole("list", { name });
  await expect(list).toBeVisible();
  await expect(list).toHaveCSS("overflow-y", "auto");
  const visibleItems = await list.getByRole("listitem").count();
  expect(visibleItems).toBeGreaterThan(0);
  expect(visibleItems).toBeLessThan(25);
  return list;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
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
      workSummary: {
        outcomes: ["The browser fixture remains readable."],
        scope: ["The primary Work Intelligence views."],
        decisions: ["Use one isolated SQLite fixture."],
        verification: ["Browser regression fixture is deterministic."],
        nextSteps: ["Keep the UI regression suite green."]
      },
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

    for (let index = 1; index <= 24; index += 1) {
      const extraSession = await postJson<{ session: SessionRecord }>(request, "/api/work/finalize", {
        projectRoot,
        idempotencyKey: `browser-regression-extra-${process.pid}-${index}`,
        title: `Browser regression extra session ${index}`,
        summary: "Additional fixture data used to verify bounded virtual lists.",
        changedFiles: ["README.md"],
        verification: {
          status: "passed",
          summary: "Virtual list fixture is deterministic."
        },
        completedAt: new Date(Date.now() - index * 60_000).toISOString()
      });
      const extraEvidence = await request.post(`/api/sessions/${extraSession.session.id}/evidence`, {
        data: {
          kind: "test",
          reference: `virtual-list-${index}`,
          summary: "Virtual list fixture evidence."
        }
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
        references: ["apps/web/src/components/VirtualList.vue"]
      });
      expect(extraKnowledge.outcome).toBe("knowledge_recorded");
    }

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
    await page.getByTestId("nav-reports").click();
    await expect(page.getByRole("heading", { name: "工作報告" }).first()).toBeVisible();

    const synthesis = page.getByTestId("report-synthesis");
    await expect(synthesis).toBeVisible();
    await expect(synthesis).not.toHaveAttribute("open");
    await page.getByTestId("report-synthesis-toggle").click();
    await expect(synthesis).toHaveAttribute("open", "");
    await expect(synthesis).toContainText("Browser regression report updated");
    await expect(synthesis).toContainText("提煉完成");
    const history = page.getByTestId("report-synthesis-history");
    await expect(history).toContainText("2 個版本");
    await history.locator("summary").click();
    await expect(history.getByTestId("report-synthesis-version")).toHaveCount(2);
    await expect(history).toContainText("Browser regression report");

    const resynthesizeButton = synthesis.getByRole("button", { name: "重新提煉", exact: true });
    await expect(resynthesizeButton).toBeEnabled();
    await resynthesizeButton.click();
    await expect(synthesis.getByRole("button", { name: "等待 Agent 處理中…", exact: true })).toBeDisabled();

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
    const sessionRowBoxes = await sessionList.getByTestId("session-row").evaluateAll((rows) =>
      rows.map((row) => row.getBoundingClientRect()).map((box) => ({ top: box.top, bottom: box.bottom }))
    );
    for (let index = 1; index < sessionRowBoxes.length; index += 1) {
      expect(sessionRowBoxes[index]?.top ?? 0).toBeGreaterThanOrEqual((sessionRowBoxes[index - 1]?.bottom ?? 0) - 1);
    }

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
    await page.getByTestId("nav-sessions").click();
    const firstRow = page.getByTestId("session-row").first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();
    const detail = page.getByRole("dialog");
    await expect(detail).toBeVisible();
    const workSummary = page.getByTestId("session-work-summary");
    await expect(workSummary).toContainText("成果");
    await expect(workSummary).toContainText("The browser fixture remains readable.");
    await expect(workSummary).toContainText("狀態／未結項");

    const dialogBox = await detail.boundingBox();
    expect(dialogBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(391);
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

  test("supports direct page routes", async ({ page }) => {
    for (const [path, heading] of pageRoutes) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }

    await page.goto("/worklog");
    await expect(page).toHaveURL(/\/sessions$/);
    await expect(page.getByRole("heading", { name: "工作歷程" }).first()).toBeVisible();
  });

  // Opt-in visual baseline: UI_SCREENSHOTS=<label> pnpm test:e2e writes docs/ui-baseline/<label>/*.png
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
});
