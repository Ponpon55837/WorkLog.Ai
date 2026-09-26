import { describe, expect, it } from "vitest";
import {
  CHANGED_FILE_CHANGE_STATUSES,
  CHANGED_FILE_SOURCES,
  CHANGED_FILES_MODES,
  GRAPH_EDGE_KINDS,
  GRAPH_NODE_KINDS,
  HANDOFF_IMPORT_DECISIONS,
  KNOWLEDGE_AUDIT_ACTIONS,
  KNOWLEDGE_CANDIDATE_REQUEST_STATUSES,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_STATUSES,
  MAX_CUSTOM_REPORT_DAYS,
  METADATA_BACKFILL_REQUEST_STATUSES,
  METADATA_BACKFILL_SCOPE_TYPES,
  PROJECT_DATA_TABLES,
  PROJECT_STATUSES,
  REPORT_EVIDENCE_KINDS,
  REPORT_EXPORT_FORMATS,
  REPORT_PERIODS,
  REPORT_SYNTHESIS_SCOPE_TYPES,
  REPORT_SYNTHESIS_STATUSES,
  SESSION_SUMMARY_UPDATE_MODES,
  WORK_EVENT_TYPES,
  WORK_REPORT_PERIODS,
  WORK_SUMMARY_UPDATE_MODES,
} from "../../packages/core/src/index.js";

describe("core runtime contracts", () => {
  it("exports stable enum-like values and report limits", () => {
    expect(PROJECT_STATUSES).toEqual(["unregistered", "tracked", "paused", "ignored"]);
    expect(WORK_EVENT_TYPES).toEqual(["planning", "execution", "verification", "closing", "note", "finalized"]);
    expect(CHANGED_FILE_SOURCES).toEqual(["agent", "handoff", "git", "worktree"]);
    expect(CHANGED_FILES_MODES).toEqual(["replace", "merge"]);
    expect(CHANGED_FILE_CHANGE_STATUSES).toEqual(["added", "modified", "deleted", "renamed"]);
    expect(KNOWLEDGE_KINDS).toEqual(["decision", "pattern", "gotcha", "procedure", "skill"]);
    expect(KNOWLEDGE_STATUSES).toEqual(["active", "archived"]);
    expect(KNOWLEDGE_AUDIT_ACTIONS).toEqual(["created", "updated", "archived", "restored"]);
    expect(GRAPH_NODE_KINDS).toEqual(["project", "session", "knowledge", "evidence", "file"]);
    expect(GRAPH_EDGE_KINDS).toEqual(["contains", "changed_file", "has_knowledge", "has_evidence", "session_link"]);
    expect(REPORT_PERIODS).toEqual(["day", "week", "month", "quarter", "year"]);
    expect(WORK_REPORT_PERIODS).toEqual([...REPORT_PERIODS, "custom"]);
    expect(MAX_CUSTOM_REPORT_DAYS).toBe(366);
    expect(REPORT_EXPORT_FORMATS).toEqual(["json", "markdown"]);
    expect(REPORT_SYNTHESIS_STATUSES).toEqual(["pending", "processing", "completed", "failed", "cancelled"]);
    expect(REPORT_SYNTHESIS_SCOPE_TYPES).toEqual(["all", "project"]);
    expect(METADATA_BACKFILL_REQUEST_STATUSES).toEqual(["pending", "processing", "completed", "failed", "cancelled"]);
    expect(METADATA_BACKFILL_SCOPE_TYPES).toEqual(["all", "project"]);
    expect(REPORT_EVIDENCE_KINDS).toEqual(["handoff", "verification", "changed-files", "event", "attached"]);
    expect(HANDOFF_IMPORT_DECISIONS).toEqual(["eligible", "excluded", "already_imported", "error"]);
    expect(SESSION_SUMMARY_UPDATE_MODES).toEqual(["replace", "append"]);
    expect(WORK_SUMMARY_UPDATE_MODES).toEqual(["replace", "patch"]);
    expect(KNOWLEDGE_CANDIDATE_REQUEST_STATUSES).toEqual(["pending", "processing", "completed", "failed", "cancelled"]);
    expect(PROJECT_DATA_TABLES).toContain("sessions");
  });
});
