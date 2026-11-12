import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeReviewHint } from "@work-intelligence/core";
import { truncateText } from "@work-intelligence/shared";
import { parseJson } from "./session-record-codecs.js";
import { APPLIES_TO_SCAN_LIMIT, appliesToStrength, normalizePath, type PathContext } from "./search-text.js";

export interface KnowledgeReviewFocus {
  projectId: string;
  /** The finalized Session: Knowledge it recorded or already gave feedback on is not suggested again. */
  sessionId: string;
  /** The Session's stored changed files. */
  changedFiles: readonly string[];
  project: PathContext;
}

type KnowledgeAppliesToRow = { id: string; title: string; applies_to_json: string; updated_at: string };

const KNOWLEDGE_TO_REVIEW_LIMIT = 3;
const KNOWLEDGE_TO_REVIEW_TITLE_CHARS = 120;

/**
 * Up to three active Knowledge items of the Session's own project whose appliesTo covers a file the Session changed,
 * strongest match first (the work_recall rule: exact, segment suffix, directory, glob), then the newest. Reads the
 * same newest-first bounded rows as the other appliesTo scans and changes nothing.
 */
export function findKnowledgeToReview(db: DatabaseSync, focus: KnowledgeReviewFocus): KnowledgeReviewHint[] {
  const contexts = [focus.project];
  const files = new Map<string, string>();
  for (const file of focus.changedFiles) {
    const key = normalizePath(file, contexts);
    if (key && !files.has(key)) files.set(key, file);
  }
  if (files.size === 0) return [];
  const rows = db
    .prepare(
      `SELECT k.id, k.title, k.applies_to_json, k.updated_at FROM knowledge k
       WHERE k.project_id = ? AND k.status = 'active' AND k.applies_to_json <> '[]'
         AND (k.session_id IS NULL OR k.session_id <> ?)
         AND NOT EXISTS (SELECT 1 FROM knowledge_feedback f WHERE f.knowledge_id = k.id AND f.session_id = ?)
       ORDER BY k.updated_at DESC, k.id ASC LIMIT ?`,
    )
    .all(focus.projectId, focus.sessionId, focus.sessionId, APPLIES_TO_SCAN_LIMIT) as KnowledgeAppliesToRow[];
  const matched = rows.flatMap((row) => {
    let best = { strength: 0, path: "", appliesTo: "" };
    for (const raw of parseJson<unknown[]>(row.applies_to_json, [])) {
      if (typeof raw !== "string") continue;
      const pattern = normalizePath(raw, contexts);
      if (!pattern) continue;
      for (const [key, path] of files) {
        const strength = appliesToStrength(pattern, key);
        if (strength > best.strength) best = { strength, path, appliesTo: raw };
      }
    }
    return best.strength > 0 ? [{ row, ...best }] : [];
  });
  return matched
    .sort(
      (left, right) =>
        right.strength - left.strength ||
        right.row.updated_at.localeCompare(left.row.updated_at) ||
        left.row.id.localeCompare(right.row.id),
    )
    .slice(0, KNOWLEDGE_TO_REVIEW_LIMIT)
    .map(({ row, path, appliesTo }) => ({
      id: row.id,
      title: truncateText(row.title, KNOWLEDGE_TO_REVIEW_TITLE_CHARS),
      path,
      ...(appliesTo === path ? {} : { appliesTo }),
    }));
}
