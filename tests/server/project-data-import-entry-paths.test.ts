import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDataExport } from "@work-intelligence/core";
import { projectDataExportSchema, projectDataImportInputSchema } from "../../packages/schema/src/index.js";
import {
  LATEST_SCHEMA_VERSION,
  ProjectDataTransferError,
  WorkIntelligenceStore,
} from "../../packages/storage/src/index.js";
import { BackupWorkerClient } from "../../apps/server/src/backup-worker-client.js";
import { runDatabaseCli } from "../../apps/server/src/cli.js";
import { createApiHandler } from "../../apps/server/src/server.js";

// Fictional data only. Every validation rule runs exactly once on every way into an import: the store called
// directly, REST (inline and through the background worker) and the CLI. Each class of invalid file the transfer
// tests cover is refused on each path with the same code, and nothing is written, not even a backup.

type InvalidCase = {
  name: string;
  code: "invalid_input" | "unsupported_schema";
  input: (bundle: ProjectDataExport) => unknown;
};

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wi-import-entry-"));
  roots.push(root);
  return root;
}

function exportedBundle(): ProjectDataExport {
  const source = new WorkIntelligenceStore(":memory:");
  cleanups.push(() => source.close());
  const projectRoot = join(createRoot(), "project");
  mkdirSync(projectRoot);
  const project = source.addProject("Synthetic entry paths", projectRoot);
  source.updateProject(project.id, { status: "tracked" });
  const result = source.finalizeSession({
    projectRoot,
    idempotencyKey: "entry-path-session",
    title: "Synthetic entry Session",
    summary: "Synthetic.",
    completedAt: "2026-04-01T00:00:00.000Z",
  });
  if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
  source.recordKnowledge({
    projectRoot,
    idempotencyKey: "entry-path-knowledge",
    kind: "gotcha",
    title: "Synthetic rule",
    body: "Synthetic.",
    appliesTo: ["src/entry.ts"],
  });
  return source.exportProjectData({ type: "all" });
}

/** A deep copy with one change, so each case starts from the same valid bundle. */
function changed(bundle: ProjectDataExport, change: (copy: ProjectDataExport) => void): ProjectDataExport {
  const copy = structuredClone(bundle);
  change(copy);
  return copy;
}

const INVALID_BUNDLES: Array<{ name: string; code: InvalidCase["code"]; change: (copy: ProjectDataExport) => void }> = [
  { name: "wrong format", code: "invalid_input", change: (copy) => Object.assign(copy, { format: "other-export" }) },
  {
    name: "unknown column",
    code: "invalid_input",
    change: (copy) => Object.assign(copy.tables.sessions[0]!, { synthetic_extra: "x" }),
  },
  { name: "missing required column", code: "invalid_input", change: (copy) => delete copy.tables.sessions[0]!.title },
  {
    name: "duplicate row id",
    code: "invalid_input",
    change: (copy) => copy.tables.sessions.push({ ...copy.tables.sessions[0]! }),
  },
  {
    name: "invalid JSON column",
    code: "invalid_input",
    change: (copy) => Object.assign(copy.tables.sessions[0]!, { changed_files_json: "[not json" }),
  },
  {
    name: "relative project root",
    code: "invalid_input",
    change: (copy) => Object.assign(copy.tables.projects[0]!, { root_path: "relative/project" }),
  },
  {
    name: "unsupported status",
    code: "invalid_input",
    change: (copy) => Object.assign(copy.tables.projects[0]!, { status: "synthetic-status" }),
  },
  {
    name: "appliesTo beyond the stored bound",
    code: "invalid_input",
    change: (copy) =>
      Object.assign(copy.tables.knowledge[0]!, {
        applies_to_json: JSON.stringify(Array.from({ length: 101 }, (_, index) => `src/${index}.ts`)),
      }),
  },
  {
    name: "single-project scope without its project",
    code: "invalid_input",
    change: (copy) => Object.assign(copy, { scope: { type: "project", projectId: "not-in-file" } }),
  },
  {
    name: "newer schema",
    code: "unsupported_schema",
    change: (copy) => Object.assign(copy, { schemaVersion: LATEST_SCHEMA_VERSION + 1 }),
  },
  { name: "older schema", code: "unsupported_schema", change: (copy) => Object.assign(copy, { schemaVersion: 30 }) },
];

function invalidCases(bundle: ProjectDataExport): InvalidCase[] {
  return [
    ...INVALID_BUNDLES.map(({ name, code, change }) => ({
      name,
      code,
      input: () => ({ bundle: changed(bundle, change) }),
    })),
    { name: "unknown input key", code: "invalid_input", input: () => ({ bundle, synthetic: true }) },
    {
      name: "duplicate remap source",
      code: "invalid_input",
      input: () => ({
        bundle,
        remap: [
          { from: "/synthetic/a", to: "/synthetic/b" },
          { from: "/synthetic/a/", to: "/synthetic/c" },
        ],
      }),
    },
  ];
}

/** A file database, so an import would write a backup if it got that far. */
function destination(): { store: WorkIntelligenceStore; databasePath: string; backups: string } {
  const root = createRoot();
  const databasePath = join(root, "destination.sqlite");
  const backups = join(root, "backups");
  const store = new WorkIntelligenceStore(databasePath, { backup: { directory: backups } });
  cleanups.push(() => store.close());
  return { store, databasePath, backups };
}

function expectUnchanged(store: WorkIntelligenceStore): void {
  expect(store.listProjects()).toEqual([]);
  const backups = store.listBackups();
  expect(backups.outcome === "database_backups" ? backups.backups : []).toEqual([]);
}

function storeFailure(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ProjectDataTransferError ? error.code : `unexpected ${String(error)}`;
  }
  return undefined;
}

async function listen(handler: ReturnType<typeof createApiHandler>): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

async function post(baseUrl: string, path: string, body: unknown): Promise<{ status: number; code?: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, code: ((await response.json()) as { code?: string }).code };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project-data import entry paths", () => {
  it("refuses every invalid class when the store is called directly", () => {
    const bundle = exportedBundle();
    const { store } = destination();
    for (const invalid of invalidCases(bundle)) {
      expect({
        case: invalid.name,
        preview: storeFailure(() => store.previewProjectDataImport(invalid.input(bundle) as never)),
      }).toEqual({
        case: invalid.name,
        preview: invalid.code,
      });
      expect({
        case: invalid.name,
        import: storeFailure(() => store.importProjectData(invalid.input(bundle) as never)),
      }).toEqual({
        case: invalid.name,
        import: invalid.code,
      });
    }
    expectUnchanged(store);
  });

  it("refuses every invalid class over REST, inline and through the background worker", async () => {
    const bundle = exportedBundle();
    const inline = destination();
    const worked = destination();
    const worker = new BackupWorkerClient(worked.databasePath, { directory: worked.backups }, LATEST_SCHEMA_VERSION, {
      idleTimeoutMs: 0,
    });
    cleanups.push(() => worker.close());
    const inlineUrl = await listen(createApiHandler(inline.store));
    const workerUrl = await listen(createApiHandler(worked.store, { backgroundStore: worker }));
    for (const invalid of invalidCases(bundle)) {
      for (const baseUrl of [inlineUrl, workerUrl]) {
        for (const path of ["/api/import/preview", "/api/import"]) {
          const response = await post(baseUrl, path, invalid.input(bundle));
          expect({ case: invalid.name, path, ...response }).toEqual({
            case: invalid.name,
            path,
            status: 400,
            code: invalid.code,
          });
        }
      }
    }
    expectUnchanged(inline.store);
    expectUnchanged(worked.store);
    // The same worker then imports a valid file, so a refusal never left it unusable.
    expect(await post(workerUrl, "/api/import", { bundle })).toEqual({ status: 200, code: undefined });
    expect(worked.store.listProjects()).toHaveLength(1);
  }, 60_000);

  it("refuses every invalid file class from db:import", async () => {
    const bundle = exportedBundle();
    const { store } = destination();
    const root = createRoot();
    for (const { name, code, change } of INVALID_BUNDLES) {
      writeFileSync(join(root, "invalid.json"), JSON.stringify(changed(bundle, change)));
      const errors: string[] = [];
      const exitCode = await runDatabaseCli(["import", "invalid.json"], {
        invocationDirectory: root,
        withStore: (task) => task(store),
        log: () => undefined,
        error: (message) => errors.push(message),
        confirmPortableImport: async () => true,
      });
      expect({ name, exitCode }).toEqual({ name, exitCode: 1 });
      expect({ name, message: errors.join("\n") }).toEqual({
        name,
        message: expect.stringMatching(code === "unsupported_schema" ? /schema 版本/ : /匯入檔格式錯誤/),
      });
    }
    expectUnchanged(store);
  });

  it("validates a valid file exactly once per request, preview or import, on every in-process path", async () => {
    const bundle = exportedBundle();
    const inputParse = vi.spyOn(projectDataImportInputSchema, "safeParse");
    const bundleParse = vi.spyOn(projectDataExportSchema, "safeParse");
    const counted = async (run: () => unknown): Promise<number> => {
      inputParse.mockClear();
      await run();
      expect(bundleParse).not.toHaveBeenCalled();
      return inputParse.mock.calls.length;
    };

    const direct = destination();
    expect(await counted(() => direct.store.previewProjectDataImport({ bundle }))).toBe(1);
    expect(await counted(() => direct.store.importProjectData({ bundle }))).toBe(1);

    const inline = destination();
    const inlineUrl = await listen(createApiHandler(inline.store));
    expect(await counted(() => post(inlineUrl, "/api/import/preview", { bundle }))).toBe(1);
    expect(await counted(() => post(inlineUrl, "/api/import", { bundle }))).toBe(1);

    const cli = destination();
    const root = createRoot();
    writeFileSync(join(root, "valid.json"), JSON.stringify(bundle));
    const cliRun = () =>
      runDatabaseCli(["import", "valid.json"], {
        invocationDirectory: root,
        withStore: (task) => task(cli.store),
        log: () => undefined,
        error: () => undefined,
        confirmPortableImport: async () => true,
      });
    // One validation covers the preview and the import that follows it.
    expect(await counted(cliRun)).toBe(1);
    expect(cli.store.listProjects()).toHaveLength(1);
  });
});
