import { describe, expect, it } from "vitest";
import { Router, apiRoutes, type Route } from "../../apps/server/src/routes/index.js";

// The complete REST surface. A route added or removed without updating this list (and docs/rest-api.md) fails here.
const EXPECTED_ROUTES = [
  "POST /api/backfill/metadata",
  "GET /api/backfill/metadata-requests",
  "POST /api/backfill/metadata-requests",
  "POST /api/backfill/metadata-requests/:requestId/cancel",
  "GET /api/backfill/metadata-requests/:requestId/context",
  "GET /api/backfill/metadata/preview",
  "GET /api/backups",
  "POST /api/backups",
  "DELETE /api/backups/:fileName*",
  "GET /api/context",
  "GET /api/dashboard",
  "PATCH /api/diagrams/:diagramId/void",
  "GET /api/events",
  "PATCH /api/evidence/:evidenceId/void",
  "POST /api/export",
  "GET /api/graph",
  "GET /api/graph/path",
  "GET /api/health",
  "POST /api/import",
  "POST /api/import/preview",
  "POST /api/imports/handoffs",
  "GET /api/imports/handoffs/preview",
  "GET /api/insights/activity",
  "GET /api/insights/hotspots",
  "GET /api/insights/timeline",
  "GET /api/knowledge",
  "GET /api/outstanding-items",
  "POST /api/outstanding-cleanup/requests",
  "GET /api/outstanding-cleanup/requests",
  "GET /api/outstanding-cleanup/requests/:requestId/context",
  "GET /api/outstanding-cleanup/requests/:requestId/proposals",
  "POST /api/outstanding-cleanup/requests/:requestId/proposals",
  "POST /api/outstanding-cleanup/requests/:requestId/decisions",
  "POST /api/outstanding-cleanup/requests/:requestId/cancel",
  "POST /api/knowledge",
  "GET /api/knowledge-pages",
  "PATCH /api/knowledge-pages/:pageId",
  "GET /api/knowledge-pages/:pageId/versions",
  "POST /api/knowledge-pages/update-requests",
  "PATCH /api/knowledge/:knowledgeId",
  "PATCH /api/outstanding-items/:itemId",
  "PATCH /api/outstanding-items/batch",
  "GET /api/knowledge/:knowledgeId/history",
  "POST /api/knowledge/candidate-requests",
  "GET /api/knowledge/candidates",
  "POST /api/knowledge/candidates/:candidateId/decision",
  "GET /api/project-deletion-audits",
  "GET /api/projects",
  "POST /api/projects",
  "DELETE /api/projects/:projectId",
  "PATCH /api/projects/:projectId",
  "PATCH /api/projects/:projectId/location",
  "GET /api/reports",
  "GET /api/reports/export",
  "GET /api/reports/summaries",
  "POST /api/reports/summaries",
  "DELETE /api/reports/summaries/:summaryId",
  "GET /api/reports/synthesis-requests",
  "POST /api/reports/synthesis-requests",
  "GET /api/reports/synthesis-requests/:requestId",
  "POST /api/reports/synthesis-requests/:requestId/cancel",
  "GET /api/reports/synthesis-requests/:requestId/context",
  "POST /api/reports/synthesis-requests/:requestId/retry",
  "GET /api/search",
  "GET /api/session-decisions",
  "PATCH /api/session-decisions/:decisionId/review",
  "GET /api/agent-reads",
  "GET /api/knowledge/:knowledgeId/agent-reads",
  "GET /api/sessions",
  "GET /api/sessions/:sessionId/agent-reads",
  "GET /api/sessions/agents",
  "GET /api/sessions/:sessionId",
  "DELETE /api/sessions/:sessionId",
  "POST /api/sessions/:sessionId/evidence",
  "DELETE /api/sessions/:sessionId/links",
  "POST /api/sessions/:sessionId/links",
  "DELETE /api/sessions/:sessionId/links/:relatedSessionId",
  "PATCH /api/sessions/:sessionId/metadata",
  "PATCH /api/sessions/:sessionId/summary",
  "PATCH /api/sessions/:sessionId/title",
  "PATCH /api/sessions/:sessionId/verification",
  "PATCH /api/sessions/:sessionId/void",
  "PATCH /api/sessions/:sessionId/work-summary",
  "POST /api/system/pick-folder",
  "GET /api/system/status",
  "POST /api/work/finalize",
];

const handler: Route["handler"] = () => undefined;

describe("API route table", () => {
  it("registers every expected method and path exactly once", () => {
    const registered = apiRoutes.map((route) => `${route.method} ${route.pattern}`);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual([...EXPECTED_ROUTES].sort());
  });

  it("rejects a duplicate route when the table is built", () => {
    const route: Route = { method: "GET", pattern: "/api/example/:id", handler };
    expect(() => new Router([route, { ...route }])).toThrow("Duplicate API route: GET /api/example/:id");
  });

  it("matches literal paths before parameters, binds raw segments, and supports a trailing rest parameter", () => {
    const router = new Router([
      { method: "GET", pattern: "/api/items/:id", handler },
      { method: "GET", pattern: "/api/items/export", handler },
      { method: "PATCH", pattern: "/api/items/:id/void", handler },
      { method: "DELETE", pattern: "/api/files/:name*", handler },
    ]);
    expect(router.match("GET", "/api/items/export")?.route.pattern).toBe("/api/items/export");
    expect(router.match("GET", "/api/items/a%2Fb")?.params).toEqual({ id: "a%2Fb" });
    expect(router.match("PATCH", "/api/items/7/void")?.params).toEqual({ id: "7" });
    expect(router.match("GET", "/api/items/7/void")).toBeUndefined();
    expect(router.match("POST", "/api/items/7")).toBeUndefined();
    expect(router.match("DELETE", "/api/files/a/b.sqlite")?.params).toEqual({ name: "a/b.sqlite" });
    expect(router.match("DELETE", "/api/files")).toBeUndefined();
  });
});
