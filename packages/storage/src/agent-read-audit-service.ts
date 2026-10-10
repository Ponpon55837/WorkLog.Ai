import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AgentReadAuditItem, AgentReadAuditPage, AgentReadReferences } from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { createPageInfo } from "./pagination.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

export type {
  AgentReadAuditItem,
  AgentReadAuditPage,
  AgentReadReference,
  AgentReadReferences,
} from "@work-intelligence/core";

export type AgentReadRecordType = "session" | "knowledge";

export const AGENT_READ_AUDIT_MAX_IDS = 50;
export const AGENT_READ_AUDIT_MAX_ROWS = 5_000;
export const AGENT_READ_AUDIT_MAX_AGE_DAYS = 30;
const PRUNE_EVERY_INSERTS = 100;
const MAX_WALK_NODES = 20_000;
const MAX_WALK_DEPTH = 10;
const REFERENCE_LIMIT = 20;

export interface AgentReadExtraction {
  projectId?: string;
  sessionIds: string[];
  knowledgeIds: string[];
}

export interface RecordAgentReadInput {
  tool: string;
  agentClient?: string;
  /** The tool's response as returned to the Agent; only ids are read from it. */
  result: unknown;
  /** The project the call was scoped to by id, when its input named one. */
  projectId?: string;
  now?: string;
}

export interface ListAgentReadsOptions {
  projectId?: string;
  agentClient?: string;
  page?: number;
  pageSize?: number;
}

interface AuditRow {
  id: string;
  created_at: string;
  tool: string;
  agent_client: string | null;
  project_id: string | null;
  project_name: string | null;
  outcome: string;
  returned_count: number;
  session_ids_json: string;
  knowledge_ids_json: string;
  omitted_session_count: number;
  omitted_knowledge_count: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(value: Record<string, unknown>): string | undefined {
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200 ? value.id : undefined;
}

/** Which kind of stored record an object is, from its own shape; undefined for pointers and everything else. */
function recordTypeOf(value: Record<string, unknown>): AgentReadRecordType | undefined {
  if (!idOf(value)) return undefined;
  if (value.type === "session" || value.type === "knowledge") return value.type;
  if (typeof value.projectId !== "string") return undefined;
  if ("completedAt" in value && ("verificationStatus" in value || "summary" in value)) return "session";
  if ("kind" in value && "title" in value && ("body" in value || "excerpt" in value)) return "knowledge";
  return undefined;
}

/**
 * Collects the Session and Knowledge ids a tool response actually carried, plus the single project they belong
 * to. Reads ids only; no text from the response is kept.
 */
export function extractAgentReadRecords(result: unknown): AgentReadExtraction {
  const sessions = new Set<string>();
  const knowledge = new Set<string>();
  const projects = new Set<string>();
  let visited = 0;
  const walk = (node: unknown, depth: number): void => {
    if (visited++ >= MAX_WALK_NODES || depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (!isObject(node)) return;
    const type = recordTypeOf(node);
    if (type) {
      (type === "session" ? sessions : knowledge).add(idOf(node)!);
      if (typeof node.projectId === "string") projects.add(node.projectId);
    }
    for (const child of Object.values(node)) {
      if (typeof child === "object" && child !== null) walk(child, depth + 1);
    }
  };
  // A projected Session may intentionally omit summary; its mandatory identity was still returned.
  if (isObject(result) && isObject(result.projection) && isObject(result.session) && idOf(result.session)) {
    sessions.add(idOf(result.session)!);
    if (typeof result.session.projectId === "string") projects.add(result.session.projectId);
  }
  walk(result, 0);
  let scopedProject: string | undefined;
  if (isObject(result)) {
    if (isObject(result.project) && typeof result.project.id === "string") scopedProject = result.project.id;
    else if (typeof result.projectId === "string") scopedProject = result.projectId;
  }
  const projectId = scopedProject ?? (projects.size === 1 ? [...projects][0] : undefined);
  return { projectId, sessionIds: [...sessions], knowledgeIds: [...knowledge] };
}

function outcomeOf(result: unknown): string {
  if (isObject(result) && typeof result.outcome === "string" && /^[a-z0-9_]{1,40}$/.test(result.outcome)) {
    return result.outcome;
  }
  return "ok";
}

function parseIds(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function mapRow(row: AuditRow): AgentReadAuditItem {
  return {
    id: row.id,
    at: row.created_at,
    tool: row.tool,
    ...(row.agent_client ? { agentClient: row.agent_client } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.project_name ? { projectName: row.project_name } : {}),
    outcome: row.outcome,
    returnedCount: row.returned_count,
    sessionIds: parseIds(row.session_ids_json),
    knowledgeIds: parseIds(row.knowledge_ids_json),
    omittedSessionCount: row.omitted_session_count,
    omittedKnowledgeCount: row.omitted_knowledge_count,
  };
}

/**
 * Passive, content-free log of which Sessions and Knowledge items the MCP read tools returned to Agents.
 * It stores ids, counts, tool names, and the client name only, never queries, paths, text, or errors.
 */
export class AgentReadAuditService {
  private insertsSincePrune = 0;

  public constructor(private readonly db: DatabaseSync) {}

  /** Records one successful read. Never throws: the audit must not break or slow the read. */
  public record(input: RecordAgentReadInput): void {
    try {
      const outcome = outcomeOf(input.result);
      const skipped = outcome === "skipped" || outcome.endsWith("_skipped");
      const extraction: AgentReadExtraction = skipped
        ? { sessionIds: [], knowledgeIds: [] }
        : extractAgentReadRecords(input.result);
      const projectId = skipped ? undefined : (input.projectId ?? extraction.projectId);
      const sessionIds = extraction.sessionIds.slice(0, AGENT_READ_AUDIT_MAX_IDS);
      const knowledgeIds = extraction.knowledgeIds.slice(0, AGENT_READ_AUDIT_MAX_IDS);
      const auditId = randomUUID();
      this.withoutLockWait(() =>
        runImmediateTransaction(this.db, () => {
          this.db
            .prepare(
              `INSERT INTO agent_read_audit
             (id, created_at, tool, agent_client, project_id, outcome, returned_count,
              session_ids_json, knowledge_ids_json, omitted_session_count, omitted_knowledge_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              auditId,
              input.now ?? nowIso(),
              input.tool.slice(0, 100),
              input.agentClient ? input.agentClient.slice(0, 100) : null,
              projectId ?? null,
              outcome,
              extraction.sessionIds.length + extraction.knowledgeIds.length,
              JSON.stringify(sessionIds),
              JSON.stringify(knowledgeIds),
              extraction.sessionIds.length - sessionIds.length,
              extraction.knowledgeIds.length - knowledgeIds.length,
            );
          if (sessionIds.length + knowledgeIds.length > 0) {
            const insertRecord = this.db.prepare(
              "INSERT OR IGNORE INTO agent_read_audit_records (audit_id, record_type, record_id) VALUES (?, ?, ?)",
            );
            for (const id of sessionIds) insertRecord.run(auditId, "session", id);
            for (const id of knowledgeIds) insertRecord.run(auditId, "knowledge", id);
          }
          if (this.insertsSincePrune++ % PRUNE_EVERY_INSERTS === 0) {
            this.prune(input.now);
          }
        }),
      );
    } catch {
      // Best effort by design: a busy or failing audit table never fails the read.
    }
  }

  /** Runs the audit write without waiting on another process's lock: a busy database drops the audit row instead. */
  private withoutLockWait(operation: () => void): void {
    if (this.db.isTransaction) return operation();
    const row = this.db.prepare("PRAGMA busy_timeout").get() as { timeout?: number } | undefined;
    this.db.exec("PRAGMA busy_timeout = 0");
    try {
      operation();
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${Number(row?.timeout ?? 5000)}`);
    }
  }

  /** Recent reads of tracked projects (and reads with no project), newest first. */
  public listRecent(options: ListAgentReadsOptions = {}): AgentReadAuditPage {
    const clauses = ["(a.project_id IS NULL OR p.status = 'tracked')"];
    const parameters: string[] = [];
    if (options.projectId) {
      clauses.push("a.project_id = ?");
      parameters.push(options.projectId);
    }
    if (options.agentClient) {
      clauses.push("a.agent_client = ?");
      parameters.push(options.agentClient);
    }
    const from = `FROM agent_read_audit a LEFT JOIN projects p ON p.id = a.project_id WHERE ${clauses.join(" AND ")}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS count ${from}`).get(...parameters) as { count: number }).count;
    const pageInfo = createPageInfo(options.page, options.pageSize, total, 100);
    const rows = this.db
      .prepare(
        `SELECT a.*, p.name AS project_name ${from}
         ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...parameters, pageInfo.pageSize, (pageInfo.page - 1) * pageInfo.pageSize) as unknown as AuditRow[];
    const agents = this.db
      .prepare(
        `SELECT DISTINCT a.agent_client AS agent_client
         FROM agent_read_audit a LEFT JOIN projects p ON p.id = a.project_id
         WHERE a.agent_client IS NOT NULL AND (a.project_id IS NULL OR p.status = 'tracked')
         ORDER BY a.agent_client`,
      )
      .all() as unknown as Array<{ agent_client: string }>;
    return { items: rows.map(mapRow), pageInfo, agents: agents.map((row) => row.agent_client) };
  }

  /** How many audited reads returned this record to an Agent, with the newest ones. */
  public forRecord(type: AgentReadRecordType, recordId: string, limit = REFERENCE_LIMIT): AgentReadReferences {
    const total = (
      this.db
        .prepare("SELECT COUNT(*) AS count FROM agent_read_audit_records WHERE record_type = ? AND record_id = ?")
        .get(type, recordId) as { count: number }
    ).count;
    const rows = this.db
      .prepare(
        `SELECT a.created_at, a.tool, a.agent_client
         FROM agent_read_audit_records r JOIN agent_read_audit a ON a.id = r.audit_id
         WHERE r.record_type = ? AND r.record_id = ?
         ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`,
      )
      .all(type, recordId, Math.min(Math.max(Math.trunc(limit), 1), 100)) as unknown as Array<{
      created_at: string;
      tool: string;
      agent_client: string | null;
    }>;
    return {
      total,
      items: rows.map((row) => ({
        at: row.created_at,
        tool: row.tool,
        ...(row.agent_client ? { agentClient: row.agent_client } : {}),
      })),
    };
  }

  /** Drops rows older than the retention window or beyond the newest row cap; one bounded DELETE. */
  public prune(now: string = nowIso()): void {
    const cutoff = new Date(Date.parse(now) - AGENT_READ_AUDIT_MAX_AGE_DAYS * 86_400_000).toISOString();
    this.db
      .prepare(
        `DELETE FROM agent_read_audit WHERE created_at < ?
            OR id IN (SELECT id FROM agent_read_audit ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
      )
      .run(cutoff, AGENT_READ_AUDIT_MAX_ROWS);
  }
}
