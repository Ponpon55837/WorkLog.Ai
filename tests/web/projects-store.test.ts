import { PiniaColada } from "@pinia/colada";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "vue";
import type { ProjectDeletionCounts, ProjectRecord } from "@work-intelligence/core";
import { useProjectsStore } from "../../apps/web/src/stores/projects.js";

const toastMocks = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("../../apps/web/src/composables/useToast", () => ({
  useToast: () => ({ showToast: toastMocks.showToast }),
}));

const deletionCounts: ProjectDeletionCounts = {
  projects: 0,
  sessions: 0,
  workEvents: 0,
  rawSnapshots: 0,
  evidence: 0,
  knowledge: 0,
  knowledgeAudit: 0,
  voidAudit: 0,
  sessionVerificationUpdates: 0,
  sessionLinks: 0,
  knowledgeCandidateRequests: 0,
  knowledgeCandidates: 0,
  reportSynthesisRequests: 0,
  reportSummaries: 0,
  metadataBackfillRequests: 0,
  sessionSummaryUpdates: 0,
  sessionWorkSummaryUpdates: 0,
  searchChunks: 0,
  searchFts: 0,
  searchPaths: 0,
  searchDirty: 0,
};

const initialProject: ProjectRecord = {
  id: "project-1",
  name: "Alpha",
  rootPath: "/projects/alpha",
  status: "tracked",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

let projects: ProjectRecord[];
let deletionAudits: Array<{ projectId: string; deletedAt: string; deletedCounts: ProjectDeletionCounts }>;
let requestCount: (path: string, method?: string) => number;

function projectRecord(id: string, name: string, rootPath: string): ProjectRecord {
  return {
    id,
    name,
    rootPath,
    status: "unregistered",
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
  };
}

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  toastMocks.showToast.mockClear();
  projects = [initialProject];
  deletionAudits = [];
  const calls: Array<{ path: string; method: string }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method });

    if (url.pathname === "/api/dashboard") {
      const trackedProjects = projects.filter((project) => project.status === "tracked").length;
      return respond({
        trackedProjects,
        activeProjects: projects.length,
        finalizedSessions: 0,
        recordedEvents: 0,
        recentSessions: [],
      });
    }
    if (url.pathname === "/api/projects" && method === "GET") {
      return respond(projects);
    }
    if (url.pathname === "/api/projects" && method === "POST") {
      const input = JSON.parse(String(init?.body)) as { name: string; rootPath: string };
      const project = projectRecord(`project-${projects.length + 1}`, input.name, input.rootPath);
      projects = [...projects, project];
      return respond(project);
    }
    if (url.pathname === "/api/project-deletion-audits") {
      return respond(deletionAudits);
    }
    if (url.pathname.startsWith("/api/projects/") && method === "PATCH") {
      const projectId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const input = JSON.parse(String(init?.body)) as { status?: ProjectRecord["status"] };
      projects = projects.map((project) =>
        project.id === projectId ? { ...project, status: input.status ?? project.status } : project,
      );
      const project = projects.find((item) => item.id === projectId);
      return respond(project);
    }
    if (url.pathname.startsWith("/api/projects/") && method === "DELETE") {
      const projectId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      projects = projects.filter((project) => project.id !== projectId);
      const deletedAt = "2026-09-26T12:00:00.000Z";
      deletionAudits = [{ projectId, deletedAt, deletedCounts: deletionCounts }, ...deletionAudits];
      return respond({
        outcome: "project_deleted",
        projectId,
        deletedAt,
        backupFileName: "backup-before-delete.sqlite",
        deletedCounts: deletionCounts,
      });
    }
    return respond({ error: `Unexpected request: ${method} ${url.pathname}` });
  });
  vi.stubGlobal("fetch", fetchMock);
  requestCount = (path, method = "GET") => calls.filter((call) => call.path === path && call.method === method).length;

  const pinia = createPinia();
  createApp({}).use(pinia).use(PiniaColada);
  setActivePinia(pinia);
});

afterEach(() => {
  setActivePinia(undefined);
  vi.unstubAllGlobals();
});

describe("projects Pinia store", () => {
  it("loads project queries and invalidates affected data after successful mutations", async () => {
    const store = useProjectsStore();

    await Promise.all([store.loadDashboard(), store.loadProjects(), store.loadProjectDeletionAudits()]);
    expect(store.projects).toEqual([initialProject]);
    expect(store.dashboard.trackedProjects).toBe(1);
    expect(store.projectDeletionAudits).toEqual([]);
    expect(requestCount("/api/dashboard")).toBe(1);
    expect(requestCount("/api/projects", "GET")).toBe(1);
    expect(requestCount("/api/project-deletion-audits")).toBe(1);

    expect(await store.addProject({ name: "Beta", rootPath: "/projects/beta" })).toBe(true);
    expect(store.projects.map((project) => project.name)).toEqual(["Alpha", "Beta"]);
    expect(requestCount("/api/projects", "POST")).toBe(1);
    expect(requestCount("/api/projects", "GET")).toBeGreaterThan(1);
    expect(requestCount("/api/dashboard")).toBeGreaterThan(1);

    await store.updateProjectStatus(initialProject, "ignored");
    expect(store.projects.find((project) => project.id === initialProject.id)?.status).toBe("ignored");
    expect(requestCount("/api/projects/project-1", "PATCH")).toBe(1);
    expect(requestCount("/api/projects", "GET")).toBeGreaterThan(2);
    expect(requestCount("/api/dashboard")).toBeGreaterThan(2);

    const betaProject = store.projects.find((project) => project.name === "Beta");
    expect(betaProject).toBeDefined();
    if (!betaProject) {
      throw new Error("Expected the newly created Beta project.");
    }
    const notice = await store.deleteProject(betaProject, "Beta");
    expect(notice).toEqual({ projectName: "Beta", backupFileName: "backup-before-delete.sqlite" });
    expect(store.projects.map((project) => project.name)).toEqual(["Alpha"]);
    expect(store.projectDeletionAudits).toHaveLength(1);
    expect(requestCount("/api/projects/project-2", "DELETE")).toBe(1);
    expect(requestCount("/api/project-deletion-audits")).toBeGreaterThan(1);
    expect(requestCount("/api/dashboard")).toBeGreaterThan(3);
  });

  it("keeps project list and dashboard queries disabled until requested", async () => {
    const store = useProjectsStore();
    await Promise.resolve();

    expect(requestCount("/api/dashboard")).toBe(0);
    expect(requestCount("/api/projects")).toBe(0);

    await store.loadProjects();
    expect(requestCount("/api/projects")).toBe(1);
  });

  it("invalidates deletion audits without fetching until the audit view is active", async () => {
    const store = useProjectsStore();
    await store.loadProjects();
    await store.loadProjectDeletionAudits();
    const project = store.projects[0];
    if (!project) {
      throw new Error("Expected the initial project fixture.");
    }

    expect(requestCount("/api/project-deletion-audits")).toBe(1);
    store.setProjectDeletionAuditsActive(false);
    await store.deleteProject(project, project.name);

    expect(requestCount("/api/project-deletion-audits")).toBe(1);
    store.setProjectDeletionAuditsActive(true);
    await vi.waitFor(() => expect(store.projectDeletionAudits).toHaveLength(1));

    expect(requestCount("/api/project-deletion-audits")).toBe(2);
  });
});
