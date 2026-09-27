import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { redactDatabase } from "../../packages/storage/src/database-redaction.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const tempDirs: string[] = [];
const stores: WorkIntelligenceStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database redaction", () => {
  it("keeps dry-run read-only and backs up before one transactional rewrite", () => {
    const directory = mkdtempSync(join(tmpdir(), "work-intelligence-redaction-"));
    tempDirs.push(directory);
    const databasePath = join(directory, "test.sqlite");
    const backupDirectory = join(directory, "backups");
    const projectRoot = join(directory, "project");
    mkdirSync(projectRoot);
    const token = `ghp_${"A".repeat(36)}`;
    const store = new WorkIntelligenceStore(databasePath);
    stores.push(store);
    const project = store.addProject("Redaction fixture", projectRoot);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot,
      idempotencyKey: "redaction-legacy-fixture",
      title: "舊資料遮蔽測試",
      summary: "不含敏感文字的初始摘要。",
      handoffContent: "安全的初始交接。",
      completedAt: "2026-09-20T10:00:00.000Z",
    });
    if (finalized.outcome !== "finalized") {
      throw new Error("The test Session must be finalized.");
    }
    store.attachEvidence({ sessionId: finalized.session.id, kind: "test", reference: "fixture", summary: "safe" });
    store.recordKnowledge({
      projectRoot,
      idempotencyKey: "redaction-legacy-knowledge",
      kind: "procedure",
      title: "測試知識",
      body: "安全的初始內容。",
      sessionId: finalized.session.id,
    });

    const seed = new DatabaseSync(databasePath);
    try {
      seed.prepare("UPDATE sessions SET summary = ? WHERE id = ?").run(`舊摘要 ${token}`, finalized.session.id);
      seed.prepare("UPDATE work_events SET summary = ? WHERE session_id = ?").run(token, finalized.session.id);
      seed.prepare("UPDATE raw_snapshots SET content = ? WHERE session_id = ?").run(token, finalized.session.id);
      seed.prepare("UPDATE evidence SET summary = ? WHERE session_id = ?").run(token, finalized.session.id);
      seed.prepare("UPDATE knowledge SET body = ? WHERE session_id = ?").run(token, finalized.session.id);
    } finally {
      seed.close();
    }
    store.recall({ q: token, projectRoot });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const preview = redactDatabase({ databasePath });
    expect(preview).toMatchObject({ mode: "dry_run", affectedSessions: 1, redactions: { total: 5 } });
    const unchanged = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        (
          unchanged.prepare("SELECT summary FROM sessions WHERE id = ?").get(finalized.session.id) as {
            summary: string;
          }
        ).summary,
      ).toContain(token);
      expect(
        (
          unchanged.prepare("SELECT redaction_count FROM sessions WHERE id = ?").get(finalized.session.id) as {
            redaction_count: number;
          }
        ).redaction_count,
      ).toBe(0);
    } finally {
      unchanged.close();
    }

    const applied = redactDatabase({ databasePath, apply: true, backup: { directory: backupDirectory } });
    expect(applied).toMatchObject({ mode: "applied", affectedSessions: 1, redactions: { total: 5 } });
    expect(applied.backupFileName).toBeTruthy();
    expect(existsSync(join(backupDirectory, applied.backupFileName ?? ""))).toBe(true);

    const verify = new DatabaseSync(databasePath);
    try {
      const textRows = [
        verify.prepare("SELECT summary FROM sessions WHERE id = ?").get(finalized.session.id),
        verify.prepare("SELECT summary FROM work_events WHERE session_id = ?").get(finalized.session.id),
        verify.prepare("SELECT content FROM raw_snapshots WHERE session_id = ?").get(finalized.session.id),
        verify.prepare("SELECT summary FROM evidence WHERE session_id = ?").get(finalized.session.id),
        verify.prepare("SELECT body FROM knowledge WHERE session_id = ?").get(finalized.session.id),
      ];
      expect(JSON.stringify(textRows)).not.toContain(token);
      expect(
        (
          verify.prepare("SELECT redaction_count FROM sessions WHERE id = ?").get(finalized.session.id) as {
            redaction_count: number;
          }
        ).redaction_count,
      ).toBe(5);
      expect(
        (
          verify.prepare("SELECT COUNT(*) AS count FROM search_chunks WHERE content LIKE ?").get(`%${token}%`) as {
            count: number;
          }
        ).count,
      ).toBe(0);
      expect(
        (
          verify.prepare("SELECT COUNT(*) AS count FROM search_dirty WHERE doc_id = ?").get(finalized.session.id) as {
            count: number;
          }
        ).count,
      ).toBe(1);
    } finally {
      verify.close();
    }
  });
});
