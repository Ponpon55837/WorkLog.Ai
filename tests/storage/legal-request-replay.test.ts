import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  linkSessionsInputSchema,
  mcpFinalizeSessionInputSchema,
  resolveOutstandingItemsInputSchema,
  saveKnowledgePageInputSchema,
  updateSessionMetadataInputSchema,
} from "../../packages/schema/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const SEED = 440;
const GENERATED_OPERATIONS = 160;
const SUCCESS_OUTCOMES: Record<string, ReadonlySet<string>> = {
  finalize: new Set(["finalized"]),
  metadata: new Set(["updated"]),
  resolve: new Set(["outstanding_items_resolved"]),
  link: new Set(["session_link_updated"]),
  page: new Set(["knowledge_page_saved"]),
};

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-replay-"));
  tempDirs.push(root);
  const projectRoot = join(root, "lighthouse");
  const otherRoot = join(root, "quarry");
  mkdirSync(projectRoot);
  mkdirSync(otherRoot);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  store.updateProject(store.addProject("Lighthouse", projectRoot).id, { status: "tracked" });
  store.updateProject(store.addProject("Quarry", otherRoot).id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2031, 2, 1));
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  return { store, projectRoot, otherRoot, tick };
}

function finalizeRequest(projectRoot: string, key: string, fields: Record<string, unknown> = {}) {
  return mcpFinalizeSessionInputSchema.parse({
    projectRoot,
    idempotencyKey: key,
    title: `Lamp rotation ${key}`,
    summary: `${key}: the lamp rotation schedule was adjusted.`,
    workSummary: { outcomes: [`${key} outcome`], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: [],
    verification: { status: "passed" },
    ...fields,
  });
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function sample<T>(random: () => number, values: readonly T[], limit: number): T[] {
  return values.filter(() => random() < 0.5).slice(0, limit);
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("legal write requests replayed against the current server", () => {
  it("accepts every generated legal request and keeps retries idempotent", () => {
    const { store, projectRoot, otherRoot, tick } = setup();
    const random = seededRandom(SEED);
    const sessions: string[] = [];
    const keys: string[] = [];
    const knowledgeIds: string[] = [];
    const outcomes: Array<{ kind: string; outcome: string }> = [];
    const otherSession = store.finalizeSession(finalizeRequest(otherRoot, "quarry-1"));
    if (otherSession.outcome !== "finalized") throw new Error("Expected the other project's Session");
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });

    const record = (kind: string, result: { outcome: string }) => outcomes.push({ kind, outcome: result.outcome });
    const pendingIds = () => store.pendingOutstandingItemsForSessions(sessions).map((item) => item.id);

    for (let step = 0; step < GENERATED_OPERATIONS; step += 1) {
      tick();
      const operation =
        sessions.length < 3
          ? "finalize"
          : pick(random, ["finalize", "finalize", "retry", "metadata", "resolve", "link", "knowledge", "page"]);
      if (operation === "finalize") {
        const key = `replay-${step}`;
        const pending = pendingIds();
        const resolved = sample(random, pending, 2);
        const superseded = sample(
          random,
          pending.filter((id) => !resolved.includes(id)),
          1,
        );
        const applied = sample(random, knowledgeIds, 2);
        const contradicted = sample(
          random,
          knowledgeIds.filter((id) => !applied.includes(id)),
          1,
        );
        const backfill = random() < 0.25;
        const legacyDecisions = random() < 0.5;
        const nextSteps = superseded.length > 0 || random() < 0.5 ? [`Recheck the fog horn after ${key}`] : [];
        const completedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
        const request = finalizeRequest(projectRoot, key, {
          workSummary: {
            outcomes: [`${key} outcome`],
            scope: random() < 0.5 ? ["src/lamp.ts"] : [],
            decisions: legacyDecisions
              ? [`Keep the ${key} interval`]
              : [{ text: `Chose ${key}`, origin: "agent_autonomous" }],
            verification: ["pnpm test passed"],
            nextSteps,
          },
          ...(random() < 0.5 ? { changedFiles: ["src/lamp.ts"] } : {}),
          ...(random() < 0.4 ? { baselineChangedFiles: ["notes/draft.md"] } : {}),
          ...(random() < 0.4
            ? { changedFileChanges: [{ path: "src/lamp.ts", status: "modified" }], changedFiles: ["src/lamp.ts"] }
            : {}),
          ...(backfill
            ? { completedAt, startedAt: new Date(Date.parse(completedAt) - 3_600_000).toISOString() }
            : random() < 0.5
              ? { startedAt: new Date(Date.now() - 30 * 60_000).toISOString() }
              : {}),
          ...(resolved.length ? { resolvedOutstandingItemIds: resolved } : {}),
          ...(superseded.length ? { supersededOutstandingItemIds: superseded } : {}),
          ...(applied.length ? { appliedKnowledgeIds: applied } : {}),
          ...(contradicted.length ? { contradictedKnowledgeIds: contradicted } : {}),
          ...(random() < 0.3
            ? { parentSessionId: pick(random, sessions.length ? sessions : [otherSession.session.id]) }
            : {}),
          ...(random() < 0.2
            ? { relatedSessionIds: [pick(random, sessions.length ? sessions : ["missing-session"])] }
            : {}),
          ...(random() < 0.15 ? { resolvedOutstandingItemIds: [...resolved, "missing-item"] } : {}),
          ...(random() < 0.15 ? { maintainedKnowledgePages: ["architecture"] } : {}),
        });
        const result = store.finalizeSession(request);
        record("finalize", result);
        if (result.outcome === "finalized") {
          sessions.push(result.session.id);
          keys.push(key);
        }
      } else if (operation === "retry") {
        const key = pick(random, keys);
        const stored = store.getSessionByIdempotencyKey(key)!;
        const result = store.finalizeSession(finalizeRequest(projectRoot, key, { summary: stored.summary }));
        record("finalize", result);
        expect(result.outcome === "finalized" && result.duplicate).toBe(true);
      } else if (operation === "metadata") {
        const result = store.updateSessionMetadata(
          updateSessionMetadataInputSchema.parse({
            sessionId: pick(random, sessions),
            ...(knowledgeIds.length
              ? { appliedKnowledgeIds: [pick(random, knowledgeIds)] }
              : { changedFiles: ["src/lamp.ts"], changedFilesMode: "merge" }),
          }),
        );
        record("metadata", result);
      } else if (operation === "resolve") {
        const pending = pendingIds();
        if (pending.length === 0) continue;
        const result = store.resolveOutstandingItems(
          resolveOutstandingItemsInputSchema.parse({
            sessionId: sessions.at(-1),
            resolvedOutstandingItemIds: [pick(random, pending)],
          }),
        );
        record("resolve", result);
      } else if (operation === "link") {
        const [first, second] = [pick(random, sessions), pick(random, sessions)];
        if (first === second) continue;
        const result = store.linkSessions(
          linkSessionsInputSchema.parse({ sessionId: first, relatedSessionId: second }),
        );
        record("link", result);
      } else if (operation === "knowledge") {
        const result = store.recordKnowledge({
          projectRoot,
          idempotencyKey: `knowledge-${step}`,
          kind: "gotcha",
          title: `Lens cleaning ${step}`,
          body: "Wipe the lens before the evening rotation.",
          sessionId: pick(random, sessions),
        });
        if (result.outcome === "knowledge_recorded") knowledgeIds.push(result.knowledge.id);
      } else {
        const context = store.getKnowledgePageContext({ projectRoot, slug: "architecture" });
        if (context.outcome !== "knowledge_page_context") throw new Error("Expected page context");
        const source = pick(random, sessions);
        const shape = pick(random, ["token", "token", "no-token", "section"]);
        const request = saveKnowledgePageInputSchema.parse({
          projectRoot,
          slug: "architecture",
          idempotencyKey: `page-${step}`,
          ...(shape === "section"
            ? { upsertSections: [{ heading: "Lamp", content: `Rotation ${step}.`, sourceSessionIds: [source] }] }
            : { sections: [{ heading: "Lamp", content: `Rotation ${step}.`, sourceSessionIds: [source] }] }),
          ...(shape === "no-token" ? {} : { reviewToken: context.reviewToken }),
        });
        const result = store.saveKnowledgePage(request);
        record("page", result);
        if (random() < 0.3) record("page", store.saveKnowledgePage(request));
      }
    }

    const failures = outcomes.filter(({ kind, outcome }) => !SUCCESS_OUTCOMES[kind]!.has(outcome));
    const summary = outcomes.reduce<Record<string, number>>((counts, { kind }) => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      return counts;
    }, {});
    console.info(`Legal request replay (seed ${SEED}): ${JSON.stringify(summary)}`);
    expect(failures).toEqual([]);
    expect(knowledgeIds.length).toBeGreaterThan(0);
    expect(Object.keys(summary).sort()).toEqual(Object.keys(SUCCESS_OUTCOMES).sort());
  });

  it("answers each self-contradicting finalize request the documented way", () => {
    const { store, projectRoot, tick } = setup();
    const source = store.finalizeSession(
      finalizeRequest(projectRoot, "source", {
        workSummary: {
          outcomes: ["o"],
          scope: [],
          decisions: [],
          verification: [],
          nextSteps: ["Replace the lamp bulb", "Paint the rail"],
        },
      }),
    );
    if (source.outcome !== "finalized") throw new Error("Expected the source Session");
    const [bulb, rail] = store.pendingOutstandingItemsForSessions([source.session.id]).map((item) => item.id);
    const knowledge = store.recordKnowledge({
      projectRoot,
      idempotencyKey: "knowledge",
      kind: "gotcha",
      title: "Bulb socket",
      body: "The socket needs a quarter turn.",
      sessionId: source.session.id,
    });
    if (knowledge.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");
    const knowledgeId = knowledge.knowledge.id;
    const rejectionOf = (key: string, fields: Record<string, unknown>) => {
      tick();
      const sessionsBefore = store.listSessions().length;
      const tokenBefore = store.getChangeToken();
      const result = store.finalizeSession(finalizeRequest(projectRoot, key, fields));
      expect(store.listSessions()).toHaveLength(sessionsBefore);
      expect(store.getChangeToken()).toEqual(tokenBefore);
      return result;
    };

    expect(
      rejectionOf("both-lists", { resolvedOutstandingItemIds: [bulb], supersededOutstandingItemIds: [bulb] }),
    ).toMatchObject({ outcome: "rejected", code: "both_lists", ids: [bulb] });
    expect(rejectionOf("superseded-without-next-steps", { supersededOutstandingItemIds: [rail] })).toMatchObject({
      outcome: "rejected",
      code: "superseded_without_next_steps",
      ids: [rail],
    });
    expect(
      rejectionOf("applied-and-contradicted", {
        appliedKnowledgeIds: [knowledgeId],
        contradictedKnowledgeIds: [knowledgeId],
      }),
    ).toMatchObject({ outcome: "rejected", code: "knowledge_applied_and_contradicted", ids: [knowledgeId] });
    expect(
      rejectionOf("start-after-completion", {
        startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        completedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      }),
    ).toMatchObject({ outcome: "rejected", code: "started_after_completed", field: "startedAt" });
    expect(store.pendingOutstandingItemsForSessions([source.session.id])).toHaveLength(2);
  });
});
