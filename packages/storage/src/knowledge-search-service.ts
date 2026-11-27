import { KNOWLEDGE_STATUSES } from "@work-intelligence/core";
import type {
  AgentKnowledgeQueryResult,
  CompactKnowledgeItem,
  KnowledgeKind,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeRecord,
  KnowledgeSkippedResult,
  KnowledgeStatus,
  RelaxedKnowledgeMatch,
} from "@work-intelligence/core";
import type { KnowledgeCount } from "./knowledge-repository.js";
import type { KnowledgeRankHit, KnowledgeRankOptions, KnowledgeRanking } from "./search-repository.js";
import { parseListSearchTerms } from "./list-search-scan.js";
import { excerptAround } from "./search-text.js";
import { staleFlags } from "./stale-flags.js";

export interface KnowledgeSearchServiceDependencies {
  searchKnowledge(options: KnowledgeQuery): KnowledgeQueryResult | KnowledgeSkippedResult;
  searchKnowledgeCompact(options: KnowledgeQuery): KnowledgeQueryResult<CompactKnowledgeItem> | KnowledgeSkippedResult;
  countKnowledge(options: KnowledgeQuery & { status: KnowledgeStatus }): KnowledgeCount;
  rankKnowledge(options: KnowledgeRankOptions): KnowledgeRanking;
  getKnowledgeWithTrustMany(knowledgeIds: string[]): Map<string, KnowledgeRecord>;
}

const RELAXED_MATCH_LIMIT = 3;
const RELAXED_EXCERPT_CHARS = 400;
const RELAXED_APPLIES_TO_LIMIT = 3;

function toRelaxedMatch(record: KnowledgeRecord, hit: KnowledgeRankHit): RelaxedKnowledgeMatch {
  const body = record.body.replace(/\s+/g, " ").trim();
  const appliesTo = record.appliesTo.slice(0, RELAXED_APPLIES_TO_LIMIT);
  const omittedAppliesTo = record.appliesTo.length - appliesTo.length;
  return {
    id: record.id,
    projectId: record.projectId,
    ...(record.projectName ? { projectName: record.projectName } : {}),
    kind: record.kind,
    status: record.status,
    title: record.title,
    ...(appliesTo.length > 0 ? { appliesTo } : {}),
    ...(omittedAppliesTo > 0 ? { appliesToOmittedCount: omittedAppliesTo } : {}),
    matchedTerms: hit.matchedTerms,
    ...(hit.matchedPaths ? { matchedPaths: hit.matchedPaths } : {}),
    excerpt: excerptAround(body, hit.matchedTerms, RELAXED_EXCERPT_CHARS),
    ...(body.length > RELAXED_EXCERPT_CHARS ? { excerptTruncated: true as const } : {}),
    ...staleFlags(record),
    ...(record.review ? { needsReview: true as const } : {}),
  };
}

export class KnowledgeSearchService {
  public constructor(private readonly dependencies: KnowledgeSearchServiceDependencies) {}

  public search(options: KnowledgeQuery = {}): AgentKnowledgeQueryResult | KnowledgeSkippedResult {
    return this.answer(this.dependencies.searchKnowledge(options), options);
  }

  public searchCompact(
    options: KnowledgeQuery = {},
  ): AgentKnowledgeQueryResult<CompactKnowledgeItem> | KnowledgeSkippedResult {
    return this.answer(this.dependencies.searchKnowledgeCompact(options), options);
  }

  private answer<Item>(
    strict: KnowledgeQueryResult<Item> | KnowledgeSkippedResult,
    options: KnowledgeQuery,
  ): AgentKnowledgeQueryResult<Item> | KnowledgeSkippedResult {
    const query = options.query?.trim() || options.q?.trim() || "";
    if (strict.outcome !== "knowledge" || !query) {
      return strict;
    }
    const effective = parseListSearchTerms(query);
    const effectiveQuery =
      effective.warnings.length > 0
        ? effective.terms.map((term) => (/\s/u.test(term) ? `"${term}"` : term)).join(" ")
        : undefined;
    if (strict.pageInfo.total > 0) {
      return {
        outcome: strict.outcome,
        project: strict.project,
        projects: strict.projects,
        match: "strict",
        items: strict.items,
        pageInfo: strict.pageInfo,
        ...(effectiveQuery !== undefined ? { effectiveQuery } : {}),
        ...(strict.warnings ? { warnings: strict.warnings } : {}),
      };
    }

    // Reuse the project the strict search passed through the policy gate, never the raw input.
    const projectId = strict.project?.id;
    const status = options.status ?? "active";
    const ranking = this.dependencies.rankKnowledge({
      q: query,
      projectId,
      status,
      kind: options.kind,
      limit: RELAXED_MATCH_LIMIT,
    });
    const records = this.dependencies.getKnowledgeWithTrustMany(ranking.hits.map((hit) => hit.id));
    const relaxedMatches = ranking.hits.flatMap((hit): RelaxedKnowledgeMatch[] => {
      const record = records.get(hit.id);
      if (!record) {
        return [];
      }
      return [toRelaxedMatch(record, hit)];
    });
    const {
      counts: otherStatusMatches,
      fullCounts: otherStatusFullMatches,
      truncated: countsTruncated,
    } = this.otherStatusMatches(query, status, projectId, options.kind, ranking);
    const warnings = [
      ...(strict.warnings ?? []),
      ...(countsTruncated
        ? [
            "Counting matches in other statuses skipped records above the per-record search size; otherStatusMatches may be low.",
          ]
        : []),
    ];
    const otherStatuses = Object.keys(otherStatusMatches) as KnowledgeStatus[];
    const noWordFound = ranking.termHits.length > 0 && ranking.termHits.every((entry) => entry.count === 0);
    const hints = [
      relaxedMatches.length > 0
        ? "No Knowledge contains every word; relaxedMatches are digests sharing only their matchedTerms. Read one in full with work_get_knowledge_history (projectRoot, knowledgeId) before relying on it."
        : Object.keys(otherStatusFullMatches).length > 0
          ? `No ${status} Knowledge matched.`
          : noWordFound
            ? `No ${status} Knowledge in this scope contains any of these words (see termHits); rephrase or try work_recall.`
            : "Nothing matched; rephrase or try work_recall.",
      ...otherStatuses.map((other) =>
        otherStatusFullMatches[other]
          ? `${otherStatusFullMatches[other]} ${other} contain every word; pass status "${other}" to read them.`
          : `${otherStatusMatches[other]} ${other} share only some words (leads, not an answer); pass status "${other}" for their relaxedMatches.`,
      ),
      ...(effectiveQuery !== undefined
        ? [
            `The query was cut to its first ${effective.terms.length} words (or word length); counts and any re-query use only: ${effectiveQuery}`,
          ]
        : []),
      ...(ranking.queryTruncated
        ? ["The relaxed search cut the query's extra terms or paths; matchedTerms are partial."]
        : []),
    ];
    return {
      outcome: strict.outcome,
      ...(strict.project ? { project: strict.project } : {}),
      projects: strict.projects,
      match: relaxedMatches.length > 0 ? "relaxed" : "none",
      items: strict.items,
      pageInfo: strict.pageInfo,
      ...(relaxedMatches.length > 0 ? { relaxedMatches } : {}),
      ...(otherStatuses.length > 0 ? { otherStatusMatches } : {}),
      ...(Object.keys(otherStatusFullMatches).length > 0 ? { otherStatusFullMatches } : {}),
      ...(ranking.termHits.length > 0 ? { termHits: ranking.termHits } : {}),
      ...(ranking.termHitsTruncated ? { termHitsTruncated: true as const } : {}),
      ...(effectiveQuery !== undefined ? { effectiveQuery } : {}),
      ...(ranking.queryTruncated ? { queryTruncated: true as const } : {}),
      ...(ranking.appliesToScanTruncated ? { appliesToScanTruncated: true as const } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      hint: hints.join(" "),
    };
  }

  private otherStatusMatches(
    query: string,
    status: KnowledgeStatus,
    projectId: string | undefined,
    kind: KnowledgeKind | undefined,
    ranking: KnowledgeRanking,
  ): {
    counts: Partial<Record<KnowledgeStatus, number>>;
    fullCounts: Partial<Record<KnowledgeStatus, number>>;
    truncated: boolean;
  } {
    const counts: Partial<Record<KnowledgeStatus, number>> = {};
    const fullCounts: Partial<Record<KnowledgeStatus, number>> = {};
    let truncated = false;
    for (const other of KNOWLEDGE_STATUSES) {
      if (other === status) continue;
      const strict = this.dependencies.countKnowledge({ q: query, projectId, kind, status: other });
      truncated ||= strict.truncated;
      const count = strict.count > 0 ? strict.count : (ranking.totals[other] ?? 0);
      if (count > 0) counts[other] = count;
      if (strict.count > 0) fullCounts[other] = strict.count;
    }
    return { counts, fullCounts, truncated };
  }
}
