import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDatabaseCli, type DatabaseCliDependencies } from "../../apps/server/src/cli.js";
import { DatabaseInitializationError, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-cli-"));
  tempDirs.push(root);
  return root;
}

function createStore(): WorkIntelligenceStore {
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  return store;
}

function dependencies(
  store: WorkIntelligenceStore,
  invocationDirectory: string,
  messages: { log: string[]; error: string[] },
  confirmPortableImport?: () => Promise<boolean>,
): DatabaseCliDependencies {
  return {
    invocationDirectory,
    withStore: <T>(task: (activeStore: WorkIntelligenceStore) => T) => task(store),
    log: (message) => messages.log.push(message),
    error: (message) => messages.error.push(message),
    ...(confirmPortableImport ? { confirmPortableImport } : {}),
  };
}

function createPortableProject(store: WorkIntelligenceStore, root: string) {
  const projectRoot = join(root, "old-project");
  const project = store.addProject("命令列匯入專案", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  const finalized = store.finalizeSession({
    projectRoot,
    idempotencyKey: "cli-session-1",
    title: "命令列可攜式匯出",
    summary: "驗證 CLI 匯出與匯入流程。",
    completedAt: "2026-09-25T10:00:00.000Z",
  });
  if (finalized.outcome !== "finalized") {
    throw new Error(`Expected a finalized Session, got ${finalized.outcome}.`);
  }
  return { project, finalized };
}

describe("database maintenance CLI", () => {
  it("exports all projects and a selected project to portable JSON", async () => {
    const root = createRoot();
    const store = createStore();
    const { project, finalized } = createPortableProject(store, root);
    const messages = { log: [] as string[], error: [] as string[] };
    const deps = dependencies(store, root, messages);

    expect(await runDatabaseCli(["export", "--all", "--out", "exports/all.json"], deps)).toBe(0);
    const allBundle = JSON.parse(readFileSync(join(root, "exports/all.json"), "utf8")) as {
      scope: { type: string };
      tables: { sessions: Array<{ id: string }> };
    };
    expect(allBundle.scope.type).toBe("all");
    expect(allBundle.tables.sessions.map((session) => session.id)).toContain(finalized.session.id);

    expect(await runDatabaseCli(["export", "--project", project.name], deps)).toBe(0);
    const projectFile = readdirSync(root).find(
      (name) => name.startsWith("work-intelligence-project-") && name.endsWith(".json"),
    );
    expect(projectFile).toBeDefined();
    const projectBundle = JSON.parse(readFileSync(join(root, projectFile ?? ""), "utf8")) as {
      scope: { type: string; projectId: string };
    };
    expect(projectBundle.scope).toEqual({ type: "project", projectId: project.id });
    expect(messages.log).toHaveLength(2);
    expect(messages.log.join("\n")).toContain("JSON 未加密");
  });

  it("previews imports without writing, then imports only after confirmation", async () => {
    const root = createRoot();
    const source = createStore();
    const { project, finalized } = createPortableProject(source, root);
    const bundleFile = join(root, "portable.json");
    writeFileSync(bundleFile, JSON.stringify(source.exportProjectData({ type: "project", projectId: project.id })));

    const destination = createStore();
    const messages = { log: [] as string[], error: [] as string[] };
    const deps = dependencies(destination, root, messages, async () => true);
    const newRoot = join(root, "new-project-location");
    const args = ["import", "portable.json", "--project", project.id, "--remap-root", `${project.rootPath}=${newRoot}`];

    expect(await runDatabaseCli([...args, "--dry-run"], deps)).toBe(0);
    expect(destination.listProjects()).toEqual([]);
    expect(messages.log.join("\n")).toContain("僅預覽，資料沒有變更");

    expect(await runDatabaseCli(args, deps)).toBe(0);
    expect(destination.listProjects()).toMatchObject([{ id: project.id, status: "paused", rootPath: newRoot }]);
    expect(destination.getSessionById(finalized.session.id)?.summary).toBe(finalized.session.summary);
    expect(messages.log.join("\n")).toContain("匯入完成");
    expect(existsSync(newRoot)).toBe(false);
  });

  it("reports malformed commands and requires an interactive confirmation for real imports", async () => {
    const root = createRoot();
    const store = createStore();
    const { project } = createPortableProject(store, root);
    const bundleFile = join(root, "portable.json");
    writeFileSync(bundleFile, JSON.stringify(store.exportProjectData({ type: "project", projectId: project.id })));
    const messages = { log: [] as string[], error: [] as string[] };
    const deps = dependencies(store, root, messages);

    expect(await runDatabaseCli([], deps)).toBe(0);
    expect(await runDatabaseCli(["unknown"], deps)).toBe(1);
    expect(await runDatabaseCli(["import", "--remap-root=relative"], deps)).toBe(1);
    expect(await runDatabaseCli(["import", "portable.json"], deps)).toBe(1);
    expect(messages.error.join("\n")).toContain("互動確認");
    expect(await runDatabaseCli(["export", "--project", "missing-project"], deps)).toBe(1);
    expect(messages.error.join("\n")).toContain("找不到專案");

    writeFileSync(bundleFile, "not JSON");
    expect(await runDatabaseCli(["import", "portable.json", "--dry-run"], deps)).toBe(1);
    expect(messages.error.join("\n")).toContain("不是有效的 JSON");
  });

  it("prints the safe newer-schema refusal when startup cannot open the database", async () => {
    const messages = { log: [] as string[], error: [] as string[] };
    const deps: DatabaseCliDependencies = {
      invocationDirectory: createRoot(),
      withStore: () => {
        throw new DatabaseInitializationError(
          "DATABASE_SCHEMA_VERSION_TOO_NEW",
          "資料庫 schema 版本 11 比此程式支援的版本 10 新。請更新 Work Intelligence 後再開啟資料庫。",
        );
      },
      log: (message) => messages.log.push(message),
      error: (message) => messages.error.push(message),
    };

    expect(await runDatabaseCli(["backup"], deps)).toBe(1);
    expect(messages.error.join("\n")).toContain("請更新 Work Intelligence");
    expect(messages.error.join("\n")).not.toContain("SQLITE");
  });
});
