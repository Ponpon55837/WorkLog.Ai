import { KNOWLEDGE_STATUSES } from "@work-intelligence/core";
import type {
  AgentKnowledgeQueryResult,
  KnowledgeKind,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeRecord,
  KnowledgeSkippedResult,
  KnowledgeStatus,
  RelaxedKnowledgeMatch,
} from "@work-intelligence/core";
import type { KnowledgeRankOptions, KnowledgeRanking } from "./search-repository.js";

export interface KnowledgeSearchServiceDependencies {
  /** The strict list search with trust signals, policy-gated like every Knowledge read. */
  searchKnowledge(options: KnowledgeQuery): KnowledgeQueryResult | KnowledgeSkippedResult;
  /** Strict match count in an already-gated scope. */
  countKnowledge(options: KnowledgeQuery & { status: KnowledgeStatus }): number;
  rankKnowledge(options: KnowledgeRankOptions): KnowledgeRanking;
  /** Full records with trust signals for Knowledge of tracked projects; other ids are absent from the map. */
  getKnowledgeWithTrustMany(knowledgeIds: string[]): Map<string, KnowledgeRecord>;
}

// The fallback is a pointer to likely candidates, not a second result list: a few full records are enough to read.
const RELAXED_MATCH_LIMIT = 3;

/**
 * The Agent-facing Knowledge search. The strict list search (every word in some field, newest first) stays the answer
 * whenever it finds anything, exactly as the Web list shows it. Only when it finds nothing does a relaxed ranked
 * search over the same scope and status stand in, labelled with the terms each record shares; and the answer then
 * counts matches in the statuses the filter hid, so an archived record is not mistaken for a missing one.
 */
export class KnowledgeSearchService {
  public constructor(private readonly dependencies: KnowledgeSearchServiceDependencies) {}

  public search(options: KnowledgeQuery = {}): AgentKnowledgeQueryResult | KnowledgeSkippedResult {
    const strict = this.dependencies.searchKnowledge(options);
    const query = options.query?.trim() || options.q?.trim() || "";
    if (strict.outcome !== "knowledge" || !query) {
      return strict;
    }
    if (strict.pageInfo.total > 0) {
      return {
        outcome: strict.outcome,
        project: strict.project,
        projects: strict.projects,
        match: "strict",
        items: strict.items,
        pageInfo: strict.pageInfo,
      };
    }

    // The strict search already passed the scope through the policy gate; reuse its project, never the raw input.
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
      return [
        {
          ...record,
          matchedTerms: hit.matchedTerms,
          ...(hit.matchedPaths ? { matchedPaths: hit.matchedPaths } : {}),
        },
      ];
    });
    const otherStatusMatches = this.otherStatusMatches(query, status, projectId, options.kind, ranking);
    const otherStatuses = Object.keys(otherStatusMatches) as KnowledgeStatus[];
    const hints = [
      relaxedMatches.length > 0
        ? "No Knowledge contains every word; relaxedMatches share only their matchedTerms. Read one before relying on it."
        : "Nothing matched; rephrase or try work_recall.",
      ...otherStatuses.map(
        (other) => `${otherStatusMatches[other]} ${other} match; pass status "${other}" to read them.`,
      ),
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
      hint: hints.join(" "),
    };
  }

  /**
   * Per other status, how many records the same search would answer there: the strict count when it has any,
   * otherwise the relaxed count, which is what passing that status would show. Counts only, in the same gated scope.
   */
  private otherStatusMatches(
    query: string,
    status: KnowledgeStatus,
    projectId: string | undefined,
    kind: KnowledgeKind | undefined,
    ranking: KnowledgeRanking,
  ): Partial<Record<KnowledgeStatus, number>> {
    const counts: Partial<Record<KnowledgeStatus, number>> = {};
    for (const other of KNOWLEDGE_STATUSES) {
      if (other === status) continue;
      const strictCount = this.dependencies.countKnowledge({ q: query, projectId, kind, status: other });
      const count = strictCount > 0 ? strictCount : (ranking.totals[other] ?? 0);
      if (count > 0) counts[other] = count;
    }
    return counts;
  }
}
