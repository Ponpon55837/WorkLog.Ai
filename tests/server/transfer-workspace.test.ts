import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDataExport } from "@work-intelligence/core";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { Readable } from "node:stream";
import { MAX_PROJECT_IMPORT_BYTES, receiveJsonBodyFile, RequestBodyError } from "../../apps/server/src/http.js";
import { createApiHandler } from "../../apps/server/src/server.js";
import { preflightDatabase, type DatabaseIdentity } from "../../apps/server/src/database-preflight.js";
import { startApi, type StartedApi } from "../../apps/server/src/start-api.js";
import {
  ORPHAN_TRANSFER_AGE_MS,
  TRANSFER_DISK_FULL_MESSAGE,
  TRANSFER_FREE_SPACE_FACTOR,
  TRANSFER_MARKER_CONTENT,
  TRANSFER_MARKER_FILE,
  TRANSFER_ROOT_NAME,
  createTransferDirectory,
  hasTransferSpace,
  removeTransferDirectory,
  sweepTransferDirectories,
  transferRoot,
} from "../../apps/server/src/transfer-workspace.js";

// The HTTP layer asks `hasTransferSpace` whether the disk can take an upload; the mock answers from `space.override`
// and otherwise runs the real function, so the unit tests below and the real disk checks are unchanged.
const space = vi.hoisted(() => ({ override: undefined as boolean | undefined }));
vi.mock("../../apps/server/src/transfer-workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/server/src/transfer-workspace.js")>();
  return {
    ...actual,
    hasTransferSpace: vi.fn(
      async (directory: string, bytes: number) => space.override ?? actual.hasTransferSpace(directory, bytes),
    ),
  };
});

// Fictional data only.
const HOUR_MS = 60 * 60 * 1000;
const roots: string[] = [];
const servers: Server[] = [];
const stores: WorkIntelligenceStore[] = [];
const apis: StartedApi[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wi-transfer-workspace-"));
  roots.push(root);
  return root;
}

/** A directory as createTransferDirectory leaves it (with its marker, unless `marker` says otherwise), `ageMs` old. */
function makeDirectory(
  root: string,
  name: string,
  ageMs: number,
  marker: string | null = TRANSFER_MARKER_CONTENT,
): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "import.json"), "{}");
  if (marker !== null) writeFileSync(join(path, TRANSFER_MARKER_FILE), marker);
  const time = new Date(Date.now() - ageMs);
  utimesSync(path, time, time);
  return path;
}

function transferDirectories(root: string): string[] {
  return existsSync(root) ? readdirSync(root).filter((name) => /^(import|export)-/.test(name)) : [];
}

function bundle(): ProjectDataExport {
  const source = new WorkIntelligenceStore(":memory:");
  stores.push(source);
  const projectRoot = join(createRoot(), "project");
  mkdirSync(projectRoot);
  const project = source.addProject("Synthetic transfer project", projectRoot);
  source.updateProject(project.id, { status: "tracked" });
  source.finalizeSession({
    projectRoot,
    idempotencyKey: "transfer-session",
    title: "Synthetic transfer Session",
    summary: "Synthetic.",
    completedAt: "2026-04-01T00:00:00.000Z",
  });
  return source.exportProjectData({ type: "all" });
}

async function startServer(options: { transferRoot?: string; store?: WorkIntelligenceStore } = {}): Promise<string> {
  const store = options.store ?? new WorkIntelligenceStore(":memory:");
  if (!options.store) stores.push(store);
  const server = createServer(
    createApiHandler(store, options.transferRoot ? { transferRoot: options.transferRoot } : {}),
  );
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

/** A request that declares `contentLength` bytes and sends none of them; resolves with the response and drops it. */
function declaredOnly(
  baseUrl: string,
  path: string,
  contentLength: number,
): Promise<{ status: number; body: { error: string; code: string } }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(
      `${baseUrl}${path}`,
      { method: "POST", headers: { "content-type": "application/json", "content-length": String(contentLength) } },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          request.destroy();
          resolveRequest({ status: response.statusCode ?? 0, body: JSON.parse(text) });
        });
      },
    );
    request.on("error", rejectRequest);
    request.flushHeaders();
  });
}

async function post(baseUrl: string, path: string, body: string, contentType = "application/json"): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": contentType }, body });
}

beforeEach(() => {
  space.override = undefined;
});

afterEach(async () => {
  space.override = undefined;
  vi.restoreAllMocks();
  for (const api of apis.splice(0)) await api.shutdown();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("transferRoot", () => {
  it("uses a directory under the system temporary directory for an in-memory database", () => {
    expect(transferRoot(":memory:")).toBe(join(tmpdir(), "work-intelligence-transfers"));
    expect(transferRoot("")).toBe(join(tmpdir(), "work-intelligence-transfers"));
  });

  it("uses a dedicated folder beside the database file", () => {
    const database = join(createRoot(), "data", "work.sqlite");
    expect(transferRoot(database)).toBe(join(dirname(database), TRANSFER_ROOT_NAME));
  });

  it("resolves a relative database path against the working directory", () => {
    expect(transferRoot(join("relative", "work.sqlite"))).toBe(
      join(dirname(resolve("relative", "work.sqlite")), TRANSFER_ROOT_NAME),
    );
  });
});

describe("createTransferDirectory and removeTransferDirectory", () => {
  it("creates the root and a uniquely named directory for each kind", () => {
    const root = join(createRoot(), "nested", "tmp");
    const first = createTransferDirectory(root, "import");
    const second = createTransferDirectory(root, "import");
    const exported = createTransferDirectory(root, "export");
    expect(dirname(first)).toBe(root);
    expect(first).not.toBe(second);
    expect(first.slice(root.length + 1)).toMatch(/^import-[A-Za-z0-9]{6}$/);
    expect(exported.slice(root.length + 1)).toMatch(/^export-[A-Za-z0-9]{6}$/);
    expect(statSync(first).isDirectory()).toBe(true);
    expect(readFileSync(join(first, TRANSFER_MARKER_FILE), "utf8")).toBe(TRANSFER_MARKER_CONTENT);
  });

  it("makes the directory private to the owner", () => {
    const root = join(createRoot(), "tmp");
    const directory = createTransferDirectory(root, "import");
    if (process.platform === "win32") {
      // POSIX modes are not enforced on Windows; the directory is still created.
      expect(statSync(directory).isDirectory()).toBe(true);
      return;
    }
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("removes a directory with its contents, and is safe for one that is gone", () => {
    const directory = createTransferDirectory(join(createRoot(), "tmp"), "import");
    writeFileSync(join(directory, "import.json"), "{}");
    removeTransferDirectory(directory);
    expect(existsSync(directory)).toBe(false);
    expect(() => removeTransferDirectory(directory)).not.toThrow();
  });
});

describe("sweepTransferDirectories", () => {
  it("removes only old import and export directories", () => {
    const root = createRoot();
    const old = [makeDirectory(root, "import-OldAA1", 2 * HOUR_MS), makeDirectory(root, "export-OldAA2", 3 * HOUR_MS)];
    const keep = [
      makeDirectory(root, "import-YngAA1", 5 * 60 * 1000),
      makeDirectory(root, "export-YngAA2", HOUR_MS - 60_000),
      makeDirectory(root, "backup-Old3", 5 * HOUR_MS),
      makeDirectory(root, "import-with_underscore", 5 * HOUR_MS),
      makeDirectory(root, "import-", 5 * HOUR_MS),
      makeDirectory(root, "myimport-OldAA4", 5 * HOUR_MS),
      makeDirectory(root, "Import-OldAA5", 5 * HOUR_MS),
    ];
    writeFileSync(join(root, "notes.txt"), "keep");
    const oldTime = new Date(Date.now() - 5 * HOUR_MS);
    utimesSync(join(root, "notes.txt"), oldTime, oldTime);

    expect(sweepTransferDirectories(root)).toBe(2);

    for (const path of old) expect(existsSync(path)).toBe(false);
    for (const path of keep) expect(existsSync(path)).toBe(true);
    expect(existsSync(join(root, "notes.txt"))).toBe(true);
  });

  it("keeps a user's folder that only looks like a transfer directory", () => {
    const root = createRoot();
    const ours = makeDirectory(root, "export-OldAA1", 5 * HOUR_MS);
    const user = [
      makeDirectory(root, "export-backup", 5 * HOUR_MS, null),
      makeDirectory(root, "import-photos", 5 * HOUR_MS, null),
      makeDirectory(root, "export-2024AB", 5 * HOUR_MS, "notes"),
      makeDirectory(root, "import-2024", 5 * HOUR_MS),
      makeDirectory(root, "import-Photos2", 5 * HOUR_MS),
    ];
    expect(sweepTransferDirectories(root)).toBe(1);
    expect(existsSync(ours)).toBe(false);
    for (const path of user) expect(existsSync(join(path, "import.json"))).toBe(true);
  });

  it("follows no symbolic link, neither an entry nor the root", () => {
    const root = createRoot();
    // A junction on Windows needs no extra privilege; elsewhere the type is ignored.
    const elsewhere = makeDirectory(join(root, "elsewhere"), "export-Target", 5 * HOUR_MS);
    const transfers = join(root, "transfers");
    mkdirSync(transfers);
    symlinkSync(elsewhere, join(transfers, "export-Link01"), "junction");
    expect(sweepTransferDirectories(transfers)).toBe(0);
    expect(existsSync(join(elsewhere, "import.json"))).toBe(true);

    const linkedRoot = join(root, "linked-root");
    symlinkSync(join(root, "elsewhere"), linkedRoot, "junction");
    const target = makeDirectory(join(root, "elsewhere"), "import-Real01", 5 * HOUR_MS);
    expect(sweepTransferDirectories(linkedRoot)).toBe(0);
    expect(existsSync(join(target, "import.json"))).toBe(true);
  });

  it("removes an old directory together with what is in it", () => {
    const root = createRoot();
    const directory = makeDirectory(root, "import-Nest01", 2 * HOUR_MS);
    mkdirSync(join(directory, "deeper"));
    writeFileSync(join(directory, "deeper", "import.spill"), "x");
    const time = new Date(Date.now() - 2 * HOUR_MS);
    utimesSync(directory, time, time);
    expect(sweepTransferDirectories(root)).toBe(1);
    expect(existsSync(directory)).toBe(false);
  });

  it("uses the age limit and the clock it is given", () => {
    const root = createRoot();
    const directory = makeDirectory(root, "import-Clock1", 0);
    expect(sweepTransferDirectories(root)).toBe(0);
    expect(sweepTransferDirectories(root, Date.now() + ORPHAN_TRANSFER_AGE_MS - 60_000)).toBe(0);
    expect(existsSync(directory)).toBe(true);
    expect(sweepTransferDirectories(root, Date.now() + ORPHAN_TRANSFER_AGE_MS + 60_000)).toBe(1);
    const another = makeDirectory(root, "export-Limit1", 10 * 60 * 1000);
    expect(sweepTransferDirectories(root, Date.now(), 5 * 60 * 1000)).toBe(1);
    expect(existsSync(another)).toBe(false);
  });

  it("returns 0 for a root that does not exist or is not a directory, without throwing", () => {
    const root = createRoot();
    expect(sweepTransferDirectories(join(root, "missing"))).toBe(0);
    writeFileSync(join(root, "file"), "x");
    expect(sweepTransferDirectories(join(root, "file"))).toBe(0);
  });

  it("returns 0 for an empty root", () => {
    expect(sweepTransferDirectories(createRoot())).toBe(0);
  });
});

describe("hasTransferSpace", () => {
  it("accepts a tiny upload", async () => {
    expect(await hasTransferSpace(createRoot(), 1)).toBe(true);
    expect(await hasTransferSpace(createRoot(), 0)).toBe(true);
  });

  it("refuses an upload no disk can hold", async () => {
    expect(await hasTransferSpace(createRoot(), Number.MAX_SAFE_INTEGER / 4)).toBe(false);
  });

  it("counts the upload times the free-space factor", () => {
    expect(TRANSFER_FREE_SPACE_FACTOR).toBe(2.5);
  });

  it("does not block when the file system cannot report its free space", async () => {
    expect(await hasTransferSpace(join(createRoot(), "does-not-exist"), Number.MAX_SAFE_INTEGER / 4)).toBe(true);
  });
});

describe("import uploads and the transfer root, over HTTP", () => {
  it("refuses a declared length over the cap with 413 before any body is sent, and leaves nothing behind", async () => {
    const root = join(createRoot(), "tmp");
    const baseUrl = await startServer({ transferRoot: root });
    vi.mocked(hasTransferSpace).mockClear();
    for (const path of ["/api/import/preview", "/api/import"]) {
      const response = await declaredOnly(baseUrl, path, MAX_PROJECT_IMPORT_BYTES + 1);
      expect(response.status).toBe(413);
      expect(response.body.code).toBe("payload_too_large");
      expect(transferDirectories(root)).toEqual([]);
    }
    // The cap is decided from the header alone; the disk is not even asked.
    expect(hasTransferSpace).not.toHaveBeenCalled();
  });

  it("answers 507 database_disk_full with the Traditional Chinese message when the disk is short", async () => {
    const root = join(createRoot(), "tmp");
    const baseUrl = await startServer({ transferRoot: root });
    const text = JSON.stringify({ bundle: bundle() });
    vi.mocked(hasTransferSpace).mockClear();
    space.override = false;
    for (const path of ["/api/import/preview", "/api/import"]) {
      const response = await post(baseUrl, path, text);
      expect(response.status).toBe(507);
      expect(await response.json()).toMatchObject({ code: "database_disk_full", error: TRANSFER_DISK_FULL_MESSAGE });
      expect(transferDirectories(root)).toEqual([]);
    }
    // The check was made for the declared length, in the transfer directory of the request.
    const [directory, bytes] = vi.mocked(hasTransferSpace).mock.calls[0] as [string, number];
    expect(bytes).toBe(Buffer.byteLength(text));
    expect(dirname(directory)).toBe(root);

    // The same request goes through once the disk has room, so the refusal left the server usable.
    space.override = undefined;
    expect((await post(baseUrl, "/api/import/preview", text)).status).toBe(200);
    expect(transferDirectories(root)).toEqual([]);
  });

  it("refuses a body that streams past the cap without declaring its length", async () => {
    const root = createRoot();
    const chunks = [Buffer.alloc(600, 0x20), Buffer.alloc(600, 0x20)];
    const request = Object.assign(Readable.from(chunks), { headers: { "content-type": "application/json" } });
    const received = receiveJsonBodyFile(request as never, join(root, "bundle.json"), 1_000);
    await expect(received).rejects.toBeInstanceOf(RequestBodyError);
    await expect(received).rejects.toMatchObject({ statusCode: 413 });
  });

  it("asks for the cap when the client declares no length", async () => {
    const root = join(createRoot(), "tmp");
    const baseUrl = await startServer({ transferRoot: root });
    vi.mocked(hasTransferSpace).mockClear();
    space.override = false;
    const response = await fetch(`${baseUrl}/api/import/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(507);
    expect(vi.mocked(hasTransferSpace).mock.calls[0]?.[1]).toBe(MAX_PROJECT_IMPORT_BYTES);
    expect(transferDirectories(root)).toEqual([]);
  });

  it("leaves no import directory after an invalid body, a wrong content type or an imported file", async () => {
    const root = join(createRoot(), "tmp");
    const baseUrl = await startServer({ transferRoot: root });
    const text = JSON.stringify({ bundle: bundle() });
    expect((await post(baseUrl, "/api/import/preview", "{not json")).status).toBe(400);
    expect(transferDirectories(root)).toEqual([]);
    expect((await post(baseUrl, "/api/import", text, "text/plain")).status).toBe(415);
    expect(transferDirectories(root)).toEqual([]);
    expect((await post(baseUrl, "/api/import", '{"bundle":{}}')).status).toBe(400);
    expect(transferDirectories(root)).toEqual([]);
    expect((await post(baseUrl, "/api/import", text)).status).toBe(200);
    expect(transferDirectories(root)).toEqual([]);
  });

  it("removes the import directory when the client drops the connection mid-upload", async () => {
    const root = join(createRoot(), "tmp");
    const baseUrl = await startServer({ transferRoot: root });
    const request = httpRequest(`${baseUrl}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "100000" },
    });
    request.on("error", () => undefined);
    request.write('{"bundle":');
    await waitFor(() => transferDirectories(root).length > 0, "the upload directory to appear");
    request.destroy();
    await waitFor(() => transferDirectories(root).length === 0, "the upload directory to be removed");
  });

  it("stages uploads beside a file database by default and leaves that directory empty", async () => {
    const root = createRoot();
    const databasePath = join(root, "data", "work.sqlite");
    mkdirSync(dirname(databasePath));
    const store = new WorkIntelligenceStore(databasePath);
    stores.push(store);
    const baseUrl = await startServer({ store });
    const text = JSON.stringify({ bundle: bundle() });
    expect((await post(baseUrl, "/api/import", text)).status).toBe(200);
    const staging = transferRoot(databasePath);
    expect(existsSync(staging)).toBe(true);
    expect(readdirSync(staging)).toEqual([]);
    // The folder is dedicated to transfers, never the database's own folder or a generic name like tmp.
    expect(staging).toBe(join(dirname(databasePath), TRANSFER_ROOT_NAME));
  });
});

describe("startApi sweeps orphan transfer directories", () => {
  async function databaseIn(root: string): Promise<{ path: string; identity: DatabaseIdentity }> {
    const path = join(root, "work.sqlite");
    new WorkIntelligenceStore(path).close();
    const result = await preflightDatabase(path);
    if (!result.identity) throw new Error("the synthetic database has no identity");
    return { path, identity: result.identity };
  }

  it("removes a directory more than an hour old and keeps a young one", async () => {
    const root = createRoot();
    const database = await databaseIn(root);
    const staging = transferRoot(database.path);
    const orphan = makeDirectory(staging, "import-Orph01", 2 * HOUR_MS);
    const orphanExport = makeDirectory(staging, "export-Orph02", 25 * HOUR_MS);
    const young = makeDirectory(staging, "import-Live01", 2 * 60 * 1000);
    const unrelated = makeDirectory(staging, "other-Old", 5 * HOUR_MS);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const api = startApi({ database, port: 0 });
    apis.push(api);
    await api.listening;

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(orphanExport)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("starts when there is no staging directory yet", async () => {
    const root = createRoot();
    const database = await databaseIn(root);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = startApi({ database, port: 0 });
    apis.push(api);
    await expect(api.listening).resolves.toBeDefined();
  });
});
