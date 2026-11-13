import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore, type GitRunner } from "../../packages/storage/src/index.js";

// Fictional fixtures only.
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Fictional", "-c", "user.email=fictional@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function connect(options: { tracked?: boolean; repository?: boolean; runGit?: GitRunner } = {}) {
  const { tracked = true, repository = true, runGit } = options;
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-observe-"));
  if (repository) {
    git(root, "init", "-q");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "kept.ts"), "export const kept = 1;\n");
    writeFileSync(join(root, "edited.ts"), "export const edited = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "initial");
  }
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject("Observed git project", root);
  if (tracked) store.updateProject(project.id, { status: "tracked" });
  const server = createWorkIntelligenceMcpServer(store, "9.9.9", LATEST_SCHEMA_VERSION, undefined, undefined, runGit);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
    () => client.close(),
  );
  return { client, store, root };
}

function payload(root: string, key: string, changedFiles: string[], extra: Record<string, unknown> = {}) {
  return {
    projectRoot: root,
    idempotencyKey: key,
    title: `Title ${key}`,
    summary: `Summary ${key}.`,
    workSummary: { outcomes: ["Done."], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles,
    verification: { status: "passed" as const },
    ...extra,
  };
}

type Receipt = {
  outcome: string;
  session: { id: string };
  changedFileChangesSource?: { serverObservedGit: number };
  changedFileChangesFollowUp?: { missingCount: number; missingPaths?: string[] };
  suggestedCall?: { tool: string; arguments: Record<string, unknown> };
};

async function finalize(client: Client, args: Record<string, unknown>): Promise<Receipt> {
  const result = await client.callTool({
    name: "work_write_idempotent",
    arguments: { operation: "work_finalize_session", arguments: args },
  });
  const [content] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content?.text ?? "null") as Receipt;
}

describe("finalize with server-observed Git changes", () => {
  it("fills statuses the Agent omitted from a real tracked repository", async () => {
    const { client, store, root } = await connect();
    writeFileSync(join(root, "fresh.ts"), "export const fresh = 1;\n");
    writeFileSync(join(root, "edited.ts"), "export const edited = 2;\n");

    const receipt = await finalize(
      client,
      payload(root, "observe-1", ["fresh.ts", "edited.ts", "docs-only.md"], {
        changedFileChanges: [{ path: "docs-only.md", status: "modified" }],
      }),
    );

    expect(receipt.outcome).toBe("finalized");
    expect(receipt.changedFileChangesSource).toEqual({ serverObservedGit: 2 });
    expect(receipt.changedFileChangesFollowUp).toBeUndefined();
    const stored = store.getSessionById(receipt.session.id)?.changedFileChanges ?? [];
    expect(stored[0]).toEqual({ path: "docs-only.md", status: "modified" });
    expect(stored.slice(1)).toEqual(
      expect.arrayContaining([
        { path: "fresh.ts", status: "added" },
        { path: "edited.ts", status: "modified" },
      ]),
    );
    expect(stored).toHaveLength(3);
  });

  it("follows up for paths Git does not report, with a suggested call", async () => {
    const { client, root } = await connect();
    writeFileSync(join(root, "fresh.ts"), "export const fresh = 1;\n");

    const receipt = await finalize(client, payload(root, "observe-2", ["fresh.ts", "kept.ts"]));

    expect(receipt.changedFileChangesSource).toEqual({ serverObservedGit: 1 });
    expect(receipt.changedFileChangesFollowUp).toMatchObject({ missingCount: 1, missingPaths: ["kept.ts"] });
    expect(receipt.suggestedCall).toEqual({
      tool: "work_update_session_metadata",
      arguments: { sessionId: receipt.session.id, changedFilesMode: "merge" },
    });
  });

  it("still finalizes when git fails", async () => {
    const calls: string[][] = [];
    const runGit: GitRunner = async (args) => {
      calls.push(args);
      throw new Error("git is unavailable");
    };
    const { client, store, root } = await connect({ runGit });

    const receipt = await finalize(client, payload(root, "observe-3", ["fresh.ts"]));

    expect(receipt.outcome).toBe("finalized");
    expect(calls.length).toBeGreaterThan(0);
    expect(receipt.changedFileChangesSource).toBeUndefined();
    expect(receipt.changedFileChangesFollowUp).toMatchObject({ missingCount: 1 });
    expect(store.getSessionById(receipt.session.id)?.changedFileChanges).toEqual([]);
  });

  it("never runs git for an untracked project, a backfill, or a duplicate retry", async () => {
    const calls: string[][] = [];
    const runGit: GitRunner = async (args) => {
      calls.push(args);
      return "";
    };
    const untracked = await connect({ tracked: false, runGit });
    const skipped = await finalize(untracked.client, payload(untracked.root, "observe-4", ["fresh.ts"]));
    expect(skipped.outcome).toBe("skipped");
    expect(calls).toHaveLength(0);

    const tracked = await connect({ runGit });
    await finalize(
      tracked.client,
      payload(tracked.root, "observe-5", ["fresh.ts"], {
        startedAt: "2020-01-01T00:00:00.000Z",
        completedAt: "2020-01-01T01:00:00.000Z",
      }),
    );
    expect(calls).toHaveLength(0);

    await finalize(tracked.client, payload(tracked.root, "observe-6", ["fresh.ts"]));
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    await finalize(tracked.client, payload(tracked.root, "observe-6", ["fresh.ts"]));
    expect(calls).toHaveLength(afterFirst);
  });

  it("compares with the HEAD seen at the start of the segment", async () => {
    const calls: string[][] = [];
    const runGit: GitRunner = async (args) => {
      calls.push(args);
      return "";
    };
    const { client, root } = await connect({ runGit });
    const head = git(root, "rev-parse", "HEAD");
    await client.callTool({
      name: "work_read",
      arguments: { operation: "work_get_project_status", arguments: { projectRoot: root } },
    });
    writeFileSync(join(root, "later.ts"), "export const later = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "work in the segment");

    await finalize(client, payload(root, "observe-7", ["later.ts"]));

    expect(calls[0]).toContain("--is-ancestor");
    expect(calls[0]).toContain(head);
  });
});
