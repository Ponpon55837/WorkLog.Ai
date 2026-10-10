import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  emptyReportPresentation,
  REPORT_SECTION_KEYS,
  type ReportPresentation,
  type ReportPresentationState,
  type ReportSummary,
} from "@work-intelligence/core";
import {
  reportPresentationStateSchema,
  saveReportSummaryInputSchema,
  updateReportPresentationSchema,
} from "@work-intelligence/schema";
import { nowIso } from "@work-intelligence/shared";
import { redactValue } from "./secret-redaction.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

type Base = { id: string; project_id: string | null; source_session_ids_json: string; request_id: string };
export class ReportPresentationError extends Error {
  public constructor(public readonly code: "not_found" | "conflict" | "invalid_input") {
    super("Report presentation is unavailable.");
  }
}

export class ReportPresentationService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly summaries: (summaryId: string) => ReportSummary | undefined,
  ) {}

  /** A global summary becomes unavailable as a whole when any cited project/source is unavailable. */
  public base(summaryId: string): ReportSummary {
    const row = this.db
      .prepare(
        `SELECT s.id,s.request_id,s.project_id,s.source_session_ids_json FROM report_summaries s LEFT JOIN projects p ON p.id=s.project_id WHERE s.id=? AND (s.project_id IS NULL OR p.status='tracked')`,
      )
      .get(summaryId) as Base | undefined;
    if (!row) throw new ReportPresentationError("not_found");
    let ids: unknown;
    try {
      ids = JSON.parse(row.source_session_ids_json);
    } catch {
      throw new ReportPresentationError("not_found");
    }
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every((id) => typeof id === "string"))
      throw new ReportPresentationError("not_found");
    const valid = this.db
      .prepare(
        `SELECT COUNT(DISTINCT s.id) AS n FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id IN (SELECT value FROM json_each(?)) AND s.voided_at IS NULL AND p.status='tracked' AND (? IS NULL OR s.project_id=?)`,
      )
      .get(JSON.stringify(ids), row.project_id, row.project_id) as { n: number };
    if (valid.n !== new Set(ids).size) throw new ReportPresentationError("not_found");
    const summary = this.summaries(summaryId);
    if (!summary) throw new ReportPresentationError("not_found");
    const checked = saveReportSummaryInputSchema.safeParse(summary);
    const allowed = new Set(ids);
    if (
      !checked.success ||
      REPORT_SECTION_KEYS.some((key) =>
        checked.data[key]?.some((block) => block.sourceSessionIds.some((id) => !allowed.has(id))),
      )
    )
      throw new ReportPresentationError("not_found");
    return redactValue(summary).value;
  }

  public get(summaryId: string): ReportPresentation {
    this.base(summaryId);
    return this.read(summaryId);
  }

  public update(input: {
    summaryId: string;
    expectedRevision: number;
    state: ReportPresentationState;
  }): ReportPresentation {
    const parsed = updateReportPresentationSchema.safeParse(input);
    if (!parsed.success) throw new ReportPresentationError("invalid_input");
    const sanitized = reportPresentationStateSchema.safeParse(redactValue(parsed.data.state).value);
    if (!sanitized.success) throw new ReportPresentationError("invalid_input");
    const state = sanitized.data;
    return runImmediateTransaction(this.db, () => {
      const base = this.base(input.summaryId);
      const current = this.read(input.summaryId);
      if (current.revision !== input.expectedRevision) throw new ReportPresentationError("conflict");
      if (
        state.overrides.some((item) => !base[item.section][item.ordinal]) ||
        [...state.hidden, ...state.pinned].some((key) => !base[key].length)
      )
        throw new ReportPresentationError("invalid_input");
      // Canonical hidden/override order removes meaningless revisions without changing pin order.
      state.hidden = REPORT_SECTION_KEYS.filter((key) => state.hidden.includes(key));
      state.overrides.sort(
        (a, b) =>
          REPORT_SECTION_KEYS.indexOf(a.section) - REPORT_SECTION_KEYS.indexOf(b.section) || a.ordinal - b.ordinal,
      );
      if (JSON.stringify(state) === JSON.stringify(current.state)) return current;
      this.db
        .prepare(
          `INSERT INTO report_presentations (id,summary_id,revision,state_json,actor,created_at) VALUES (?,?,?,?,?,?)`,
        )
        .run(randomUUID(), base.id, current.revision + 1, JSON.stringify(state), "web", nowIso());
      return this.read(input.summaryId);
    });
  }

  private read(summaryId: string): ReportPresentation {
    const latest = this.db
      .prepare(
        `SELECT revision,state_json,created_at FROM report_presentations WHERE summary_id=? ORDER BY revision DESC LIMIT 1`,
      )
      .get(summaryId) as { revision: number; state_json: string; created_at: string } | undefined;
    const rows = this.db
      .prepare(
        `SELECT revision,created_at,actor FROM report_presentations WHERE summary_id=? ORDER BY revision DESC LIMIT 20`,
      )
      .all(summaryId) as Array<{ revision: number; created_at: string; actor: "web" }>;
    let state = emptyReportPresentation();
    if (latest) {
      try {
        state = reportPresentationStateSchema.parse(JSON.parse(latest.state_json));
      } catch {
        throw new ReportPresentationError("not_found");
      }
    }
    return {
      outcome: "report_presentation",
      summaryId,
      revision: latest?.revision ?? 0,
      state,
      updatedAt: latest?.created_at,
      history: rows.map((row) => ({ revision: row.revision, createdAt: row.created_at, actor: row.actor })),
    };
  }
}
