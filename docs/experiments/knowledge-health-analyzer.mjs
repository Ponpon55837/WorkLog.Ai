// Read-only Knowledge Health analyzer (research experiment, not a product API).
//
// analyzeKnowledgeHealth(db) takes an already opened DatabaseSync (open it with { readOnly: true }) and returns
// deterministic findings. Nothing is written, no model is called, and no text leaves the process. Each finding:
//   { rule, subjectType, subjectId, sourceId, key, reason, at, version }
// rule      machine name of the check
// subjectId the Knowledge or Page that carries the problem
// sourceId  the Session (or other Knowledge) the problem points at
// key       stable identity used by the evaluator: the subject id, or "a|b" (sorted) for pair rules
// at        the time the problem became true in the data (voided_at, updated_at, created_at ...)
// version   Page version, or "rev:<updated_at>" for Knowledge
import { performance } from "node:perf_hooks";

export const RULES = [
  "source_invalid_cited",
  "source_modified_after_creation",
  "source_orphaned",
  "lifecycle_supersede_conflict",
  "topic_multiple_active",
  "possible_conflict_negation",
  "duplicate_overlap",
];

const SIMILARITY_DUPLICATE = 0.8;
const SIMILARITY_CONFLICT = 0.6;
const BUCKET_CAP = 200;
const NEGATION = new Set(["not", "never", "no", "dont", "don't", "avoid", "禁止", "不要", "不可", "避免", "別"]);
const CJK = /[㐀-鿿]/u;

function parseList(text) {
  try {
    const value = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// Words for Latin text, character bigrams for CJK runs.
export function tokenize(text) {
  const tokens = new Set();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}_']+/gu) ?? []) {
    if (CJK.test(word)) {
      const chars = [...word];
      if (chars.length === 1) tokens.add(word);
      for (let index = 0; index + 1 < chars.length; index += 1) tokens.add(chars[index] + chars[index + 1]);
    } else {
      tokens.add(word);
    }
  }
  return tokens;
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function pairKey(left, right) {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function normalizeTitle(title) {
  return [...tokenize(title)].sort().join(" ");
}

function sessionsById(db, ids) {
  const found = new Map();
  if (ids.length === 0) return found;
  const rows = db
    .prepare(
      `SELECT id, project_id, updated_at, voided_at FROM sessions
       WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids));
  for (const row of rows) found.set(row.id, row);
  return found;
}

function sortFindings(findings) {
  return findings.sort(
    (a, b) =>
      a.rule.localeCompare(b.rule) ||
      a.at.localeCompare(b.at) ||
      a.subjectId.localeCompare(b.subjectId) ||
      a.sourceId.localeCompare(b.sourceId),
  );
}

export function analyzeKnowledgeHealth(db) {
  const started = performance.now();
  const findings = [];
  const skippedBuckets = [];

  const knowledge = db
    .prepare(
      `SELECT k.id, k.project_id, k.session_id, k.kind, k.title, k.body, k.tags_json, k.references_json,
              k.status, k.created_at, k.updated_at, k.applies_to_json, k.last_confirmed_at, k.supersedes_id
       FROM knowledge k JOIN projects p ON p.id = k.project_id
       WHERE p.status = 'tracked'
       ORDER BY k.created_at ASC, k.id ASC`,
    )
    .all()
    .map((row) => ({
      ...row,
      tags: parseList(row.tags_json),
      references: parseList(row.references_json),
      appliesTo: parseList(row.applies_to_json),
    }));
  const pages = db
    .prepare(
      `SELECT g.id, g.project_id, g.slug, g.version, g.sections_json, g.sourced_through
       FROM knowledge_pages g JOIN projects p ON p.id = g.project_id
       WHERE p.status = 'tracked' AND g.version > 0
       ORDER BY g.id ASC`,
    )
    .all()
    .map((row) => ({ ...row, sections: parseList(row.sections_json) }));
  const byId = new Map(knowledge.map((item) => [item.id, item]));
  const active = knowledge.filter((item) => item.status === "active");

  // Rules 1-3 need the cited / created-from Sessions in one lookup.
  const referencedIds = new Set();
  for (const item of knowledge) {
    if (item.session_id) referencedIds.add(item.session_id);
    for (const reference of item.references) if (/^[0-9a-f-]{36}$/i.test(reference)) referencedIds.add(reference);
  }
  for (const page of pages) for (const section of page.sections) for (const id of section.sourceSessionIds ?? []) referencedIds.add(id);
  const sessions = sessionsById(db, [...referencedIds]);

  // source_invalid_cited: an active Knowledge or a Page cites a voided, missing, or cross-project Session.
  for (const item of active) {
    const cited = new Set([item.session_id, ...item.references.filter((r) => sessions.has(r))].filter(Boolean));
    for (const id of cited) {
      const source = sessions.get(id);
      if (!source) continue;
      if (source.project_id !== item.project_id) {
        findings.push(finding("source_invalid_cited", "knowledge", item, id, item.id, "來源 Session 屬於其他專案", item.updated_at));
      } else if (source.voided_at) {
        findings.push(finding("source_invalid_cited", "knowledge", item, id, item.id, "來源 Session 已作廢，Knowledge 仍為 active", source.voided_at));
      }
    }
  }
  for (const page of pages) {
    const seen = new Set();
    for (const section of page.sections) {
      for (const id of section.sourceSessionIds ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const source = sessions.get(id);
        const base = { id: page.id, project_id: page.project_id, updated_at: page.sourced_through ?? "", version: page.version };
        if (!source) findings.push(pageFinding("source_invalid_cited", base, id, `區段「${section.heading}」引用的 Session 不存在`, base.updated_at));
        else if (source.project_id !== page.project_id) findings.push(pageFinding("source_invalid_cited", base, id, `區段「${section.heading}」引用其他專案的 Session`, base.updated_at));
        else if (source.voided_at) findings.push(pageFinding("source_invalid_cited", base, id, `區段「${section.heading}」引用已作廢的 Session`, source.voided_at));
      }
    }
  }

  // source_modified_after_creation: the source Session changed after the Knowledge (or its last confirmation).
  for (const item of active) {
    const source = item.session_id ? sessions.get(item.session_id) : undefined;
    if (!source || source.voided_at) continue;
    const reference = item.last_confirmed_at && item.last_confirmed_at > item.created_at ? item.last_confirmed_at : item.created_at;
    if (source.updated_at > reference) {
      findings.push(finding("source_modified_after_creation", "knowledge", item, source.id, item.id, "來源 Session 在 Knowledge 建立／最後確認之後被修改", source.updated_at));
    }
  }
  // Pages: same check against sourced_through (this duplicates the shipped needsReview reason on purpose, so the
  // overlap can be measured).
  for (const page of pages) {
    if (!page.sourced_through) continue;
    const seen = new Set();
    for (const section of page.sections) {
      for (const id of section.sourceSessionIds ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const source = sessions.get(id);
        if (source && !source.voided_at && source.project_id === page.project_id && source.updated_at > page.sourced_through) {
          findings.push(pageFinding("source_modified_after_creation", { id: page.id, project_id: page.project_id, version: page.version }, id, `區段「${section.heading}」的來源在存檔後被修改`, source.updated_at));
        }
      }
    }
  }

  // source_orphaned: created from a Session that no longer exists. A manual Knowledge never had one, so its
  // creation audit has no sessionId and it is exempt.
  const sourceless = active.filter((item) => !item.session_id).map((item) => item.id);
  if (sourceless.length > 0) {
    const rows = db
      .prepare(
        `SELECT knowledge_id, json_extract(after_json, '$.sessionId') AS session_id FROM knowledge_audit
         WHERE action = 'created' AND knowledge_id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(sourceless));
    for (const row of rows) {
      if (!row.session_id) continue;
      const item = byId.get(row.knowledge_id);
      findings.push(finding("source_orphaned", "knowledge", item, row.session_id, item.id, "建立時的來源 Session 已不存在（來源被刪除），且沒有其他來源", item.updated_at));
    }
  }

  // lifecycle_supersede_conflict: supersedes chain disagrees with status.
  for (const item of knowledge) {
    if (!item.supersedes_id) continue;
    const target = byId.get(item.supersedes_id);
    if (!target) {
      findings.push(finding("lifecycle_supersede_conflict", "knowledge", item, item.supersedes_id, item.id, "supersedes 指向不存在或不在追蹤專案的 Knowledge", item.updated_at));
    } else if (target.project_id !== item.project_id) {
      findings.push(finding("lifecycle_supersede_conflict", "knowledge", item, target.id, item.id, "supersedes 指向其他專案", item.updated_at));
    } else if (item.status === "active" && target.status === "active") {
      findings.push(finding("lifecycle_supersede_conflict", "knowledge", item, target.id, item.id, "新版與被取代的舊版同時 active", item.updated_at));
    } else {
      // Cycle check: walk at most `knowledge.length` hops.
      let cursor = target;
      for (let hops = 0; cursor && hops < knowledge.length; hops += 1) {
        if (cursor.id === item.id) {
          findings.push(finding("lifecycle_supersede_conflict", "knowledge", item, target.id, item.id, "supersedes 形成環", item.updated_at));
          break;
        }
        cursor = cursor.supersedes_id ? byId.get(cursor.supersedes_id) : undefined;
      }
    }
  }

  // topic_multiple_active: several active items share project + kind + normalized title without a supersedes link.
  const topics = new Map();
  for (const item of active) {
    const key = `${item.project_id}\u0000${item.kind}\u0000${normalizeTitle(item.title)}`;
    const group = topics.get(key);
    if (group) group.push(item);
    else topics.set(key, [item]);
  }
  for (const group of topics.values()) {
    if (group.length < 2) continue;
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const [a, b] = [group[left], group[right]];
        if (a.supersedes_id === b.id || b.supersedes_id === a.id) continue;
        if (a.body === b.body) continue; // exact copies are reported by duplicate_overlap
        findings.push(pairFinding("topic_multiple_active", a, b, "同專案同類型同標題有多個 active 版本且沒有 supersedes 關係", b.created_at));
      }
    }
  }

  // Candidate pairs for the two text rules come from inverted indexes, never from an all-pairs loop.
  const tokens = new Map(active.map((item) => [item.id, tokenize(item.body)]));
  const bodyTokens = new Map();
  const polarityTokens = new Map();
  for (const item of active) {
    const all = tokens.get(item.id);
    const negated = [...all].some((token) => NEGATION.has(token));
    bodyTokens.set(item.id, negated);
    polarityTokens.set(item.id, new Set([...all].filter((token) => !NEGATION.has(token))));
  }
  const sourceBuckets = new Map();
  const tagBuckets = new Map();
  const addTo = (map, key, item) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  };
  for (const item of active) {
    if (item.session_id) addTo(sourceBuckets, `${item.project_id}\u0000s:${item.session_id}`, item);
    for (const reference of item.references) addTo(sourceBuckets, `${item.project_id}\u0000r:${reference}`, item);
    for (const tag of item.tags) addTo(tagBuckets, `${item.project_id}\u0000${tag.toLowerCase()}`, item);
  }
  const seenPairs = new Set();
  const forPairs = (buckets, label, visit) => {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.length < 2) continue;
      if (bucket.length > BUCKET_CAP) {
        skippedBuckets.push({ label, size: bucket.length, bucket: bucketKey.split("\u0000")[1] });
        continue;
      }
      for (let left = 0; left < bucket.length; left += 1) {
        for (let right = left + 1; right < bucket.length; right += 1) {
          const key = `${label}:${pairKey(bucket[left].id, bucket[right].id)}`;
          if (seenPairs.has(key)) continue;
          seenPairs.add(key);
          visit(bucket[left], bucket[right]);
        }
      }
    }
  };
  forPairs(sourceBuckets, "dup", (a, b) => {
    if (a.supersedes_id === b.id || b.supersedes_id === a.id) return;
    const similarity = jaccard(tokens.get(a.id), tokens.get(b.id));
    if (similarity >= SIMILARITY_DUPLICATE) {
      findings.push(pairFinding("duplicate_overlap", a, b, `來源重疊且文字相似度 ${similarity.toFixed(2)}`, b.created_at));
    }
  });
  forPairs(tagBuckets, "conflict", (a, b) => {
    if (a.supersedes_id === b.id || b.supersedes_id === a.id) return;
    if (bodyTokens.get(a.id) === bodyTokens.get(b.id)) return;
    const similarity = jaccard(polarityTokens.get(a.id), polarityTokens.get(b.id));
    if (similarity >= SIMILARITY_CONFLICT) {
      findings.push(pairFinding("possible_conflict_negation", a, b, `相同標籤、內容高度相似（${similarity.toFixed(2)}）但否定語氣相反`, b.created_at));
    }
  });

  return {
    findings: sortFindings(findings),
    skippedBuckets,
    counts: { knowledge: knowledge.length, activeKnowledge: active.length, pages: pages.length, sessionsLookedUp: sessions.size },
    elapsedMs: performance.now() - started,
  };
}

function finding(rule, subjectType, item, sourceId, key, reason, at) {
  return { rule, subjectType, subjectId: item.id, sourceId, key, reason, at, version: `rev:${item.updated_at}` };
}

function pageFinding(rule, page, sourceId, reason, at) {
  return { rule, subjectType: "page", subjectId: page.id, sourceId, key: `${page.id}:${sourceId}`, reason, at, version: String(page.version) };
}

function pairFinding(rule, left, right, reason, at) {
  const [first, second] = left.created_at <= right.created_at ? [left, right] : [right, left];
  return {
    rule,
    subjectType: "knowledge",
    subjectId: second.id,
    sourceId: first.id,
    key: pairKey(left.id, right.id),
    reason,
    at,
    version: `rev:${second.updated_at}`,
  };
}
