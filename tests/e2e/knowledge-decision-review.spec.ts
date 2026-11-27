import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { tt } from "./helpers/i18n.js";

type Fixture = { projectId: string; root: string; texts: string[] };

async function seed(request: APIRequestContext, count: number): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "decision-review-fictional-"));
  const created = await request.post("/api/projects", { data: { name: "Decision Review Fixture", rootPath: root } });
  expect(created.ok()).toBeTruthy();
  const project = (await created.json()) as { id: string };
  expect((await request.patch(`/api/projects/${project.id}`, { data: { status: "tracked" } })).ok()).toBeTruthy();
  const texts = Array.from(
    { length: count },
    (_, index) => `Fictional review choice ${project.id.slice(0, 6)} ${index + 1}`,
  );
  const finalized = await request.post("/api/work/finalize", {
    data: {
      projectRoot: root,
      idempotencyKey: `decision-review-${project.id}`,
      title: "Decision review source",
      summary: "Fictional Agent choices wait for review.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: texts.map((text) => ({ text, origin: "agent_autonomous" })),
        verification: [],
        nextSteps: [],
      },
      changedFiles: [],
      verification: { status: "passed", summary: "Fictional browser verification." },
    },
  });
  expect(finalized.ok()).toBeTruthy();
  return { projectId: project.id, root, texts };
}

async function reviewStatuses(request: APIRequestContext, fixture: Fixture): Promise<Record<string, string>> {
  const response = await request.get("/api/session-decisions", {
    params: { projectRoot: fixture.root, status: "all", limit: "200" },
  });
  const body = (await response.json()) as { items: Array<{ text: string; reviewStatus: string }> };
  return Object.fromEntries(body.items.map((item) => [item.text, item.reviewStatus]));
}

function row(page: Page, text: string) {
  return page.getByTestId("agent-decision-item").filter({ hasText: text });
}

function rejectDialog(page: Page, count: number) {
  return page.getByRole("dialog", { name: tt("knowledge.rejectDecisionsTitle", { count }) });
}

test.describe("Agent decision review", () => {
  test("makes Confirm the one primary action and keeps Turn into Knowledge in the More menu", async ({
    page,
    request,
  }) => {
    const fixture = await seed(request, 1);
    await page.goto(`/knowledge/decisions?project=${fixture.projectId}`);
    const item = row(page, fixture.texts[0]!);
    const confirm = item.getByRole("button", { name: tt("common.confirm") });
    const reject = item.getByRole("button", { name: tt("knowledge.reject") });
    await expect(confirm).toBeVisible();

    const background = (locator: typeof confirm) => locator.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(await background(confirm)).not.toBe(await background(reject));
    await expect(item.getByRole("button", { name: tt("knowledge.turnIntoKnowledge") })).toHaveCount(0);

    await item.getByRole("button", { name: tt("knowledge.more") }).click();
    await expect(page.getByRole("menuitem", { name: tt("knowledge.turnIntoKnowledge") })).toBeVisible();
  });

  test("confirms at once without an undo and moves focus to the next decision", async ({ page, request }) => {
    const fixture = await seed(request, 2);
    await page.goto(`/knowledge/decisions?project=${fixture.projectId}`);
    const first = row(page, fixture.texts[0]!);
    await first.getByRole("button", { name: tt("common.confirm") }).click();

    await expect(first).toHaveCount(0);
    await expect(page.getByText(tt("knowledge.agentAutonomousDecisionConfirmed"))).toBeVisible();
    await expect(page.getByRole("button", { name: tt("common.undo") })).toHaveCount(0);
    await expect(row(page, fixture.texts[1]!).getByRole("button", { name: tt("common.confirm") })).toBeFocused();
    expect((await reviewStatuses(request, fixture))[fixture.texts[0]!]).toBe("confirmed");
  });

  test("asks before rejecting one decision and keeps it when the question is declined", async ({ page, request }) => {
    const fixture = await seed(request, 1);
    await page.goto(`/knowledge/decisions?project=${fixture.projectId}`);
    const item = row(page, fixture.texts[0]!);

    await item.getByRole("button", { name: tt("knowledge.reject") }).click();
    await rejectDialog(page, 1)
      .getByRole("button", { name: tt("common.cancel") })
      .click();
    await expect(item).toBeVisible();
    expect((await reviewStatuses(request, fixture))[fixture.texts[0]!]).toBe("pending");

    await item.getByRole("button", { name: tt("knowledge.reject") }).click();
    await rejectDialog(page, 1)
      .getByRole("button", { name: tt("knowledge.reject") })
      .click();
    await expect(item).toHaveCount(0);
    expect((await reviewStatuses(request, fixture))[fixture.texts[0]!]).toBe("rejected");
  });

  test("selects decisions and confirms or rejects the selection", async ({ page, request }) => {
    const fixture = await seed(request, 5);
    await page.goto(`/knowledge/decisions?project=${fixture.projectId}`);
    await expect(row(page, fixture.texts[0]!)).toBeVisible();
    await expect(page.getByTestId("decision-batch-toolbar")).toHaveCount(0);

    await page.getByRole("checkbox", { name: tt("knowledge.selectAllDecisionsInList") }).check();
    const summary = page.getByTestId("decision-selection-summary");
    await expect(summary).toHaveText(tt("knowledge.decisionsSelected", { count: 5 }));

    await page.getByRole("checkbox", { name: tt("knowledge.selectDecision", { text: fixture.texts[4]! }) }).uncheck();
    await expect(summary).toHaveText(tt("knowledge.decisionsSelected", { count: 4 }));
    await page.getByRole("button", { name: tt("knowledge.confirmSelected") }).click();

    await expect(page.getByText(tt("knowledge.decisionsConfirmed", { count: 4 }))).toBeVisible();
    await expect(page.getByTestId("decision-batch-toolbar")).toHaveCount(0);
    await expect(row(page, fixture.texts[0]!)).toHaveCount(0);
    await expect(row(page, fixture.texts[4]!)).toBeVisible();

    await page.getByRole("checkbox", { name: tt("knowledge.selectDecision", { text: fixture.texts[4]! }) }).check();
    await page.getByRole("button", { name: tt("knowledge.rejectSelected") }).click();
    await rejectDialog(page, 1)
      .getByRole("button", { name: tt("knowledge.reject") })
      .click();
    await expect(row(page, fixture.texts[4]!)).toHaveCount(0);

    const statuses = await reviewStatuses(request, fixture);
    expect(fixture.texts.slice(0, 4).map((text) => statuses[text])).toEqual(Array(4).fill("confirmed"));
    expect(statuses[fixture.texts[4]!]).toBe("rejected");
  });

  test("leaves every decision pending when the batch reject question is declined", async ({ page, request }) => {
    const fixture = await seed(request, 3);
    await page.goto(`/knowledge/decisions?project=${fixture.projectId}`);
    await page.getByRole("checkbox", { name: tt("knowledge.selectAllDecisionsInList") }).check();
    await page.getByRole("button", { name: tt("knowledge.rejectSelected") }).click();
    await rejectDialog(page, 3)
      .getByRole("button", { name: tt("common.cancel") })
      .click();

    await expect(page.getByTestId("decision-selection-summary")).toHaveText(
      tt("knowledge.decisionsSelected", { count: 3 }),
    );
    expect(Object.values(await reviewStatuses(request, fixture))).toEqual(Array(3).fill("pending"));
  });

  test("opens Turn into Knowledge with an empty title, the decision as content and the cursor in the content", async ({
    page,
    request,
  }) => {
    const fixture = await seed(request, 1);
    await page.goto(`/knowledge/decisions?project=${fixture.projectId}`);
    await row(page, fixture.texts[0]!)
      .getByRole("button", { name: tt("knowledge.more") })
      .click();
    await page.getByRole("menuitem", { name: tt("knowledge.turnIntoKnowledge") }).click();

    const dialog = page.getByRole("dialog", { name: tt("knowledge.turnAgentDecisionIntoKnowledge") });
    await expect(dialog.getByLabel(tt("knowledge.title"))).toHaveValue("");
    await expect(dialog.getByLabel(tt("knowledge.title"))).toHaveAttribute(
      "placeholder",
      tt("knowledge.titlePlaceholder"),
    );
    await expect(dialog.getByText(tt("knowledge.titleHint"))).toBeVisible();
    await expect(dialog.getByLabel(tt("common.body"))).toHaveValue(fixture.texts[0]!);
    await expect(dialog.getByLabel(tt("common.body"))).toBeFocused();
    await expect(dialog.getByLabel(tt("knowledge.tags"))).toHaveValue("");
  });
});

test.describe("Work knowledge entry", () => {
  test("opens the decisions tab while something waits and keeps the URL bare", async ({ page, request }) => {
    await seed(request, 1);
    await page.goto("/");
    await page.getByTestId("nav-knowledge").click();

    await expect(page.getByRole("tab", { name: tt("knowledge.decisionsToConfirm") })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page).toHaveURL(/\/knowledge$/);

    await page.getByRole("tab", { name: /^Knowledge/ }).click();
    await expect(page).toHaveURL(/\/knowledge\/list/);
    await expect(page.getByRole("tab", { name: /^Knowledge/ })).toHaveAttribute("aria-selected", "true");
  });

  test("opens Knowledge when nothing waits for review", async ({ page }) => {
    await page.route("**/api/session-decisions?*", (route) =>
      route.fulfill({ json: { outcome: "session_decisions", items: [], pendingCount: 0 } }),
    );
    await page.route("**/api/knowledge/candidates*", (route) =>
      route.fulfill({ json: { outcome: "knowledge_candidates", items: [], openRequests: [], backlog: [] } }),
    );
    await page.goto("/knowledge");

    await expect(page.getByRole("tab", { name: /^Knowledge/ })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/knowledge$/);
  });

  test("counts pending decisions and candidates on the sidebar entry", async ({ page, request }) => {
    await seed(request, 2);
    const decisions = (await (await request.get("/api/session-decisions?status=pending&limit=1")).json()) as {
      pendingCount: number;
    };
    const candidates = (await (await request.get("/api/knowledge/candidates")).json()) as { items: unknown[] };
    const total = decisions.pendingCount + candidates.items.length;
    expect(total).toBeGreaterThanOrEqual(2);

    await page.goto("/dashboard");

    await expect(page.getByTestId("nav-knowledge")).toContainText(String(total));
  });
});
