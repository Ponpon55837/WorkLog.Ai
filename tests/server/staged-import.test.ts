import { createServer, request as httpRequest, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDataImportResult, ProjectDataImportStaged } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { BackupWorkerClient } from "../../apps/server/src/backup-worker-client.js";
import { createApiHandler } from "../../apps/server/src/server.js";
import {
  MAX_STAGED_IMPORTS,
  STAGED_IMPORT_BUSY_MESSAGE,
  STAGED_IMPORT_NOT_FOUND_MESSAGE,
  STAGED_IMPORT_TTL_MS,
  StagedImportError,
  StagedImports,
} from "../../apps/server/src/staged-imports.js";

const roots: string[] = [];
const servers: Server[] = [];
const stores: WorkIntelligenceStore[] = [];
const workers: BackupWorkerClient[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-staged-import-"));
  roots.push(root);
  return root;
}

/** A source database with two synthetic projects and one Session each, and its full export as JSON text. */
function syntheticExport(root: string): string {
  const source = new WorkIntelligenceStore(":memory:");
  stores.push(source);
  for (const name of ["Staged alpha", "Staged beta"]) {
    const projectRoot = join(root, name.replace(" ", "-"));
    mkdirSync(projectRoot);
    const project = source.addProject(name, projectRoot);
    source.updateProject(project.id, { status: "tracked" });
    source.finalizeSession({
      projectRoot,
      idempotencyKey: `${name}-session`,
      title: `${name} Session`,
      summary: "Synthetic Session for the staged import.",
    });
  }
  return JSON.stringify(source.exportProjectData({ type: "all" }));
}

async function startApi(
  transferRoot: string,
  databasePath = ":memory:",
): Promise<{ baseUrl: string; store: WorkIntelligenceStore }> {
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  const backgroundStore =
    databasePath === ":memory:" ? undefined : new BackupWorkerClient(databasePath, {}, LATEST_SCHEMA_VERSION);
  if (backgroundStore) workers.push(backgroundStore);
  const server = createServer(
    createApiHandler(store, { transferRoot, ...(backgroundStore ? { backgroundStore } : {}) }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test API did not expose a TCP address.");
  return { baseUrl: `http://127.0.0.1:${address.port}`, store };
}

async function post<T>(baseUrl: string, path: string, body: string | object): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/** Sends a raw POST with chosen headers (fetch cannot set Host) and resolves with the status code. */
function rawPost(baseUrl: string, path: string, headers: Record<string, string>, body: string): Promise<number> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers },
      (incoming) => {
        incoming.resume();
        incoming.on("end", () => resolve(incoming.statusCode ?? 0));
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function stagedDirectories(transferRoot: string): string[] {
  return existsSync(transferRoot) ? readdirSync(transferRoot).filter((name) => name.startsWith("import-")) : [];
}

describe("StagedImports", () => {
  it("reports itself in use while an upload is being saved or an operation reads a staged file", async () => {
    const staged = new StagedImports(tempRoot());
    expect(staged.inUse).toBe(false);
    const reservation = staged.reserve();
    expect(staged.inUse).toBe(true);
    writeFileSync(reservation.path, "{}");
    reservation.commit();
    expect(staged.inUse).toBe(false);

    let during = false;
    await staged.use(reservation.id, {}, async () => {
      during = staged.inUse;
    });
    expect(during).toBe(true);
    expect(staged.inUse).toBe(false);
    staged.clear();
  });

  it("expires a staged file after its time to live, and the id then answers not found", async () => {
    const root = tempRoot();
    let now = 1_000;
    const staged = new StagedImports(root, () => now);
    const reservation = staged.reserve();
    writeFileSync(reservation.path, "{}");
    reservation.commit();
    expect(reservation.expiresAt.getTime()).toBe(1_000 + STAGED_IMPORT_TTL_MS);

    await expect(staged.use(reservation.id, {}, async (upload) => upload.envelope)).resolves.toBe("bundle");
    now += STAGED_IMPORT_TTL_MS;
    await expect(staged.use(reservation.id, {}, async () => "late")).rejects.toMatchObject({
      statusCode: 404,
      message: STAGED_IMPORT_NOT_FOUND_MESSAGE,
    });
    expect(existsSync(reservation.directory)).toBe(false);
    expect(staged.size).toBe(0);
  });

  it("refuses ids it did not hand out, including malformed ones", async () => {
    const staged = new StagedImports(tempRoot());
    for (const id of ["", "../import-x", "a".repeat(43), "x".repeat(200)]) {
      await expect(staged.use(id, {}, async () => "never")).rejects.toBeInstanceOf(StagedImportError);
    }
  });

  it("keeps a file that is in use until the operation ends, even when it is removed", async () => {
    const staged = new StagedImports(tempRoot());
    const reservation = staged.reserve();
    reservation.commit();
    let release!: () => void;
    const running = staged.use(reservation.id, {}, () => new Promise<void>((resolve) => (release = resolve)));
    staged.remove(reservation.id);
    expect(existsSync(reservation.directory)).toBe(true);
    release();
    await running;
    expect(existsSync(reservation.directory)).toBe(false);
  });

  it(`keeps at most ${MAX_STAGED_IMPORTS}: a new upload removes the oldest idle one, and is refused when all are busy`, async () => {
    let now = 0;
    const staged = new StagedImports(tempRoot(), () => now);
    const first = staged.reserve();
    first.commit();
    now += 1;
    const second = staged.reserve();
    second.commit();
    now += 1;
    const third = staged.reserve();
    expect(existsSync(first.directory)).toBe(false);
    expect(existsSync(second.directory)).toBe(true);
    // The third is still uploading (in use), and the second is now read by a preview.
    let release!: () => void;
    const running = staged.use(second.id, {}, () => new Promise<void>((resolve) => (release = resolve)));
    expect(() => staged.reserve()).toThrow(STAGED_IMPORT_BUSY_MESSAGE);
    release();
    await running;
    third.discard();
    expect(existsSync(third.directory)).toBe(false);
    staged.clear();
    expect(existsSync(second.directory)).toBe(false);
  });
});

describe("staged import over HTTP", () => {
  it("stages a raw export once, then previews with other choices and imports from the same file", async () => {
    const root = tempRoot();
    const transferRoot = join(root, "tmp");
    const { baseUrl, store } = await startApi(transferRoot);

    const staged = await post<ProjectDataImportStaged>(
      baseUrl,
      "/api/import/staged?strategy=merge",
      syntheticExport(root),
    );
    expect(staged.status).toBe(201);
    expect(staged.body.stagingId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(staged.body.expiresAt)).toBeGreaterThan(Date.now());
    expect(staged.body.header.scope).toEqual({ type: "all" });
    expect(staged.body.header.projects.map((project) => project.name).sort()).toEqual(["Staged alpha", "Staged beta"]);
    expect(staged.body.preview).toMatchObject({ outcome: "project_data_import_preview", strategy: "merge" });
    expect(staged.body.preview.additions.sessions).toBe(2);
    expect(stagedDirectories(transferRoot)).toHaveLength(1);

    const alpha = staged.body.header.projects.find((project) => project.name === "Staged alpha")!;
    const id = staged.body.stagingId;
    const preview = await post<ProjectDataImportStaged["preview"]>(baseUrl, `/api/import/staged/${id}/preview`, {
      projectId: alpha.id,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.selectedProjects.map((project) => project.name)).toEqual(["Staged alpha"]);
    expect(preview.body.additions.sessions).toBe(1);
    expect(preview.body.selectedProjects[0]?.folderStatus).toBe("found");

    const imported = await post<ProjectDataImportResult>(baseUrl, `/api/import/staged/${id}`, { projectId: alpha.id });
    expect(imported.status).toBe(200);
    expect(imported.body.changed).toBe(true);
    expect(store.listProjects().map((project) => project.name)).toEqual(["Staged alpha"]);
    // Imported: the staged file is gone and the id no longer works.
    expect(stagedDirectories(transferRoot)).toEqual([]);
    const again = await post<{ code: string; error: string }>(baseUrl, `/api/import/staged/${id}/preview`, {});
    expect(again).toEqual({
      status: 404,
      body: expect.objectContaining({ code: "not_found", error: STAGED_IMPORT_NOT_FOUND_MESSAGE }),
    });
  });

  it("validates and imports a staged file in the background process", async () => {
    const root = tempRoot();
    const transferRoot = join(root, "tmp");
    const { baseUrl, store } = await startApi(transferRoot, join(root, "work-intelligence.sqlite"));
    const staged = await post<ProjectDataImportStaged>(baseUrl, "/api/import/staged", syntheticExport(root));
    expect(staged.status).toBe(201);
    expect(staged.body.preview.additions.sessions).toBe(2);
    const imported = await post<ProjectDataImportResult>(baseUrl, `/api/import/staged/${staged.body.stagingId}`, {});
    expect(imported.status).toBe(200);
    expect(store.listProjects()).toHaveLength(2);
    expect(stagedDirectories(transferRoot)).toEqual([]);
  });

  it("does not keep a file that fails validation, and answers with the usual messages", async () => {
    const root = tempRoot();
    const transferRoot = join(root, "tmp");
    const { baseUrl } = await startApi(transferRoot);

    const notJson = await post<{ code: string }>(baseUrl, "/api/import/staged", "{ not json");
    expect(notJson.status).toBe(400);
    const wrongFormat = await post<{ code: string; error: string }>(baseUrl, "/api/import/staged", { format: "other" });
    expect(wrongFormat.status).toBe(400);
    expect(wrongFormat.body.code).toBe("invalid_input");
    expect(wrongFormat.body.error).toMatch(/^匯入檔格式錯誤：/);
    const badStrategy = await post<{ code: string }>(
      baseUrl,
      "/api/import/staged?strategy=everything",
      syntheticExport(root),
    );
    expect(badStrategy.status).toBe(400);
    expect(stagedDirectories(transferRoot)).toEqual([]);

    const text = await fetch(`${baseUrl}/api/import/staged`, { method: "POST", body: "{}" });
    expect(text.status).toBe(415);
    expect(stagedDirectories(transferRoot)).toEqual([]);
  });

  it("refuses a foreign Host or Origin before reading the body, so nothing is written", async () => {
    const root = tempRoot();
    const transferRoot = join(root, "tmp");
    const { baseUrl } = await startApi(transferRoot);
    const body = syntheticExport(root);
    const json = { "content-type": "application/json" };
    expect(await rawPost(baseUrl, "/api/import/staged", { ...json, host: "attacker.example" }, body)).toBe(421);
    expect(await rawPost(baseUrl, "/api/import/staged", { ...json, origin: "https://attacker.example" }, body)).toBe(
      403,
    );
    expect(stagedDirectories(transferRoot)).toEqual([]);
  });

  it("keeps the file after a refused choice, and removes it on cancel", async () => {
    const root = tempRoot();
    const transferRoot = join(root, "tmp");
    const { baseUrl } = await startApi(transferRoot);
    const staged = await post<ProjectDataImportStaged>(baseUrl, "/api/import/staged", syntheticExport(root));
    const id = staged.body.stagingId;

    const unknownProject = await post<{ code: string }>(baseUrl, `/api/import/staged/${id}/preview`, {
      projectId: "not-in-this-export",
    });
    expect(unknownProject.status).toBeGreaterThanOrEqual(400);
    expect(stagedDirectories(transferRoot)).toHaveLength(1);
    const unknownOption = await post<{ code: string }>(baseUrl, `/api/import/staged/${id}/preview`, { bundle: {} });
    expect(unknownOption.status).toBe(400);
    expect(stagedDirectories(transferRoot)).toHaveLength(1);

    const cancel = await fetch(`${baseUrl}/api/import/staged/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(cancel.status).toBe(204);
    expect(stagedDirectories(transferRoot)).toEqual([]);
    const formCancel = await fetch(`${baseUrl}/api/import/staged/${id}`, { method: "DELETE" });
    expect(formCancel.status).toBe(415);
  });
});
