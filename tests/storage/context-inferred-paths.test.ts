import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextResult } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
interface InferredPathOptions {
  pointerLimit: number;
  yieldRecent: boolean;
  promoteRecent: boolean;
  allowRecentOmitted: boolean;
  minScoreShare: number;
  minTopRatio: number;
  minSessions: number;
  skipHighConfidence: boolean;
}

interface ServiceInternals {
  inferredPathOptions: InferredPathOptions;
  shouldInferTaskPaths: (knowledgeHitCount: number, confidence: string) => boolean;
  searchIndex: { knowledgeForWeightedPaths: (...args: unknown[]) => unknown };
}

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const filler = "The fictional lantern ledger keeps its verified wick spacing window and its source notes. ";
/** Long enough that its pointer needs more room than the heavy fixture leaves under the budget. */
const BURNER_TITLE = `Burner tolerance rule ${"for the valve and dial assembly ".repeat(10)}`.trim();
const TASK = "rework swarm frame splitting";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-inferred-paths-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Fictional Lantern Works", root);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2031, 2, 1));
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  const record = (key: string, title: string, body: string, appliesTo: string[]) => {
    tick();
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: key,
      kind: "pattern",
      title,
      body,
      appliesTo,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    return result.knowledge;
  };
  const finalize = (key: string, title: string, changedFiles: string[], heavy = false) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title,
      summary: heavy ? filler.repeat(6) : `${title} touched lantern files.`,
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: heavy ? [filler.repeat(3)] : [],
        verification: [],
        nextSteps: heavy ? [filler.repeat(3)] : [],
      },
      changedFiles,
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
    return result.session;
  };
  const service = (store as unknown as { contextRecallService: ServiceInternals }).contextRecallService;
  return { store, root, record, finalize, service };
}

function contextOf(
  store: WorkIntelligenceStore,
  root: string,
  focus: { task?: string; paths?: string[] },
): ContextResult {
  const context = store.getContext(root, focus);
  if (context.outcome !== "context") throw new Error("Expected context.");
  return context;
}

/** The scoped Knowledge shares no word with the task; only the files the similar Sessions changed reach it. */
function lanternFixture(
  heavy = false,
  heavyCount = 5,
  extra: { burnerTitle?: string; matchedRecentTitle?: string } = {},
) {
  const fixture = setup();
  const scoped = fixture.record("scoped", extra.burnerTitle ?? BURNER_TITLE, "Keep the burner within tolerance.", [
    "src/burner/**",
  ]);
  const first = fixture.finalize("s1", "Rework swarm frame splitting", ["src/burner/valve.ts"], heavy);
  fixture.finalize("s2", "Swarm frame splitting follow up", ["src/burner/valve.ts", "src/burner/dial.ts"], heavy);
  for (let index = 0; heavy && index < heavyCount; index += 1) {
    fixture.finalize(`h${index}`, `Swarm frame splitting heavy ${index}`, ["src/burner/valve.ts"], true);
  }
  // Recorded after the Sessions (so no later change flags it) and before the fillers, so it is the oldest of the 12 newest records: the first one budget trimming takes out.
  const matchedRecent = extra.matchedRecentTitle
    ? fixture.record("matched-recent", extra.matchedRecentTitle, "Seat the valve evenly.", ["src/burner/valve.ts"])
    : undefined;
  // The 12 newest Knowledge records fill recentKnowledge, so the scoped record is reachable only by its path.
  for (let index = 0; index < (matchedRecent ? 11 : 12); index += 1) {
    fixture.record(`filler-${index}`, `Candle storage note ${index}`, "Store candles away from the window.", []);
  }
  return { ...fixture, scoped, first, matchedRecent };
}

function withoutSupplements(context: ContextResult): unknown {
  const copy = structuredClone(context);
  delete copy.relevant?.supplements;
  copy.omitted = copy.omitted?.filter((omission) => omission.section !== "relevant.supplements");
  if (copy.omitted?.length === 0) delete copy.omitted;
  return copy;
}

/** The response without what yielding may change: recentKnowledge, its omission, and the supplements. */
function withoutRecentAndSupplements(context: ContextResult): unknown {
  const copy = structuredClone(withoutSupplements(context) as ContextResult);
  copy.recentKnowledge = [];
  copy.omitted = copy.omitted?.filter((omission) => omission.section !== "recentKnowledge");
  if (copy.omitted?.length === 0) delete copy.omitted;
  return copy;
}

function withOptions(service: ServiceInternals, options: Partial<InferredPathOptions>): void {
  service.inferredPathOptions = { ...service.inferredPathOptions, ...options };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("work_get_context inferred-path Knowledge supplements", () => {
  it("surfaces appliesTo-scoped Knowledge for a task without paths through the files of similar Sessions", () => {
    const { store, root, scoped, first } = lanternFixture();
    const context = contextOf(store, root, { task: TASK });

    expect(context.relevant?.knowledge.map((item) => item.id)).not.toContain(scoped.id);
    const pointer = context.relevant?.supplements?.find((item) => item.id === scoped.id);
    expect(pointer).toMatchObject({ type: "knowledge", title: BURNER_TITLE });
    expect(pointer?.includedBecause.kind).toBe("inferred_path");
    if (pointer?.includedBecause.kind !== "inferred_path") throw new Error("Expected an inferred path.");
    expect(pointer.includedBecause.path).toBe("src/burner/valve.ts");
    expect(pointer.includedBecause.sourceSessionIds).toContain(first.id);
    expect(pointer.includedBecause.sourceSessionIds.length).toBeLessThanOrEqual(2);
  });

  it("does no inference and no extra ranking for calls with paths or without a task", () => {
    const { store, root, service } = lanternFixture();
    const spy = vi.spyOn(service.searchIndex, "knowledgeForWeightedPaths");

    const withPaths = contextOf(store, root, { task: TASK, paths: ["src/other/file.ts"] });
    const pathsOnly = contextOf(store, root, { paths: ["src/other/file.ts"] });
    const noFocus = contextOf(store, root, {});

    expect(spy).not.toHaveBeenCalled();
    for (const context of [withPaths, pathsOnly, noFocus]) {
      const kinds = (context.relevant?.supplements ?? []).map((item) => item.includedBecause.kind);
      expect(kinds).not.toContain("inferred_path");
    }
    contextOf(store, root, { task: TASK });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns byte-identical responses for calls with paths or without a task, whatever the knobs", () => {
    const { store, root, service } = lanternFixture(true, 1);
    const focuses = [{ task: TASK, paths: ["src/burner/valve.ts"] }, { paths: ["src/other/file.ts"] }, {}];
    service.shouldInferTaskPaths = () => false;
    const off = focuses.map((focus) => JSON.stringify(contextOf(store, root, focus)));
    service.shouldInferTaskPaths = () => true;
    for (let flags = 0; flags < 8; flags += 1) {
      withOptions(service, {
        yieldRecent: Boolean(flags & 1),
        promoteRecent: Boolean(flags & 2),
        allowRecentOmitted: Boolean(flags & 4),
      });
      expect(focuses.map((focus) => JSON.stringify(contextOf(store, root, focus)))).toEqual(off);
    }
  });

  it("keeps the rest of a budget-tight response identical to the response without the feature", () => {
    const { store, root, service } = lanternFixture(true);
    const on = contextOf(store, root, { task: TASK });
    service.shouldInferTaskPaths = () => false;
    const off = contextOf(store, root, { task: TASK });

    expect(JSON.stringify(withoutSupplements(on))).toBe(JSON.stringify(withoutSupplements(off)));
    expect(JSON.stringify(on).length).toBeLessThanOrEqual(9_800);
    // The budget is tight: the pointer was dropped last and only counted in its own omission entry.
    expect(on.omitted?.some((omission) => omission.section === "relevant.supplements")).toBe(true);
    expect((off.relevant?.supplements ?? []).some((item) => item.includedBecause.kind === "inferred_path")).toBe(false);
  });

  it("does not infer when the page already holds a full set of Knowledge", () => {
    const { store, root, record, service } = lanternFixture();
    const gate = vi.fn(service.shouldInferTaskPaths.bind(service));
    service.shouldInferTaskPaths = gate;
    for (let index = 0; index < 5; index += 1) {
      record(`swarm-${index}`, `Swarm frame splitting rule ${index}`, "Swarm frame splitting needs care.", []);
    }
    const context = contextOf(store, root, { task: TASK });

    expect(context.relevant?.knowledge).toHaveLength(5);
    expect(gate).toHaveBeenCalledWith(5, expect.any(String));
    expect(gate.mock.results.at(-1)?.value).toBe(false);
    expect((context.relevant?.supplements ?? []).map((item) => item.includedBecause.kind)).not.toContain(
      "inferred_path",
    );
  });
});

describe("work_get_context inferred-path knobs", () => {
  /** One heavy Session leaves the page 10-12 characters short of the pointer, with recentKnowledge still present. */
  it("yields unmatched recentKnowledge to make room for a pointer and changes nothing else", () => {
    const { store, root, scoped, service } = lanternFixture(true, 1);
    withOptions(service, { yieldRecent: false });
    const noYield = contextOf(store, root, { task: TASK });
    withOptions(service, { yieldRecent: true });
    const on = contextOf(store, root, { task: TASK });
    service.shouldInferTaskPaths = () => false;
    const off = contextOf(store, root, { task: TASK });

    expect(noYield.relevant?.supplements).toBeUndefined();
    expect(on.relevant?.supplements?.map((item) => item.id)).toEqual([scoped.id]);
    expect(JSON.stringify(on).length).toBeLessThanOrEqual(9_800);
    expect(JSON.stringify(withoutRecentAndSupplements(on))).toBe(JSON.stringify(withoutRecentAndSupplements(off)));
    // Recent records were trimmed from the end, and the usual omission counts them.
    expect(on.recentKnowledge.length).toBeLessThan(off.recentKnowledge.length);
    expect(on.recentKnowledge.map((item) => item.id)).toEqual(
      off.recentKnowledge.slice(0, on.recentKnowledge.length).map((item) => item.id),
    );
    const trimmed = off.recentKnowledge.length - on.recentKnowledge.length;
    const before = off.omitted?.find((omission) => omission.section === "recentKnowledge");
    const after = on.omitted?.find((omission) => omission.section === "recentKnowledge");
    expect(after?.count).toBe((before?.count ?? 0) + trimmed);
    expect(after?.reasons).toContain("預算限制：較低優先 Knowledge");
    expect(on.omitted?.some((omission) => omission.section === "relevant.supplements")).toBe(false);
  });

  it("never exceeds the budget for any option combination and keeps first-round content", () => {
    for (const heavyCount of [0, 1, 2, 3, 5]) {
      const { store, root, service } = lanternFixture(true, heavyCount, { matchedRecentTitle: "Valve seat rule" });
      service.shouldInferTaskPaths = () => false;
      const off = contextOf(store, root, { task: TASK });
      service.shouldInferTaskPaths = () => true;
      for (let flags = 0; flags < 8; flags += 1) {
        withOptions(service, {
          yieldRecent: Boolean(flags & 1),
          promoteRecent: Boolean(flags & 2),
          allowRecentOmitted: Boolean(flags & 4),
        });
        const on = contextOf(store, root, { task: TASK });
        expect(JSON.stringify(on).length).toBeLessThanOrEqual(9_800);
        expect(JSON.stringify(on.relevant?.knowledge)).toBe(JSON.stringify(off.relevant?.knowledge));
        expect(JSON.stringify(on.relevant?.sessions)).toBe(JSON.stringify(off.relevant?.sessions));
      }
    }
  });

  it("does not trim recentKnowledge records the inference matched, and skips them unless promoted", () => {
    const { store, root, scoped, matchedRecent, service } = lanternFixture(true, 1, {
      matchedRecentTitle: "Valve seat rule",
    });
    const off = (() => {
      service.shouldInferTaskPaths = () => false;
      const result = contextOf(store, root, { task: TASK });
      delete (service as { shouldInferTaskPaths?: unknown }).shouldInferTaskPaths;
      return result;
    })();
    expect(off.recentKnowledge.map((item) => item.id)).toContain(matchedRecent!.id);

    withOptions(service, { yieldRecent: true, promoteRecent: false });
    const skipped = contextOf(store, root, { task: TASK });
    expect(skipped.recentKnowledge.map((item) => item.id)).toContain(matchedRecent!.id);
    expect((skipped.relevant?.supplements ?? []).map((item) => item.id)).not.toContain(matchedRecent!.id);

    withOptions(service, { promoteRecent: true });
    const promoted = contextOf(store, root, { task: TASK });
    const ids = (promoted.relevant?.supplements ?? []).map((item) => item.id);
    expect(ids).toContain(matchedRecent!.id);
    expect(ids).toContain(scoped.id);
    // Counted once: the labelled pointer replaced the recent record.
    expect(promoted.recentKnowledge.map((item) => item.id)).not.toContain(matchedRecent!.id);
    expect(JSON.stringify(promoted).length).toBeLessThanOrEqual(9_800);
  });

  it("brings back a record budget trimming took out of recentKnowledge and keeps the omission counts consistent", () => {
    const { store, root, scoped, matchedRecent, service } = lanternFixture(true, 5, {
      burnerTitle: "Burner rule",
      matchedRecentTitle: "Valve seat rule",
    });
    // Only the recent record is left to match, so its short pointer is the one that has to fit.
    store.updateKnowledge({ projectRoot: root, knowledgeId: scoped.id, status: "archived" });
    withOptions(service, { yieldRecent: false });
    const without = contextOf(store, root, { task: TASK });
    withOptions(service, { allowRecentOmitted: true });
    const allowed = contextOf(store, root, { task: TASK });

    const omission = (context: ContextResult) => context.omitted?.find((item) => item.section === "recentKnowledge");
    const pointers = (allowed.relevant?.supplements ?? []).map((item) => item.id);
    expect(pointers).toContain(matchedRecent!.id);
    expect((without.relevant?.supplements ?? []).map((item) => item.id)).not.toContain(matchedRecent!.id);
    const kept = omission(allowed);
    expect(kept?.count).toBe((omission(without)?.count ?? 0) - 1);
    expect(kept?.ids ?? []).not.toContain(matchedRecent!.id);
    expect((kept?.ids?.length ?? 0) + (kept?.moreIds ?? 0)).toBe(kept?.count);
    expect(JSON.stringify(allowed).length).toBeLessThanOrEqual(9_800);
  });

  it("scores every file of the similar Sessions and names the weighted file", () => {
    const { store, root, scoped } = lanternFixture();
    const context = contextOf(store, root, { task: TASK });
    const pointer = context.relevant?.supplements?.find((item) => item.id === scoped.id);
    expect(pointer?.includedBecause.kind).toBe("inferred_path");
    if (pointer?.includedBecause.kind !== "inferred_path") throw new Error("Expected an inferred path.");
    expect(pointer.includedBecause.path).toBe("src/burner/valve.ts");
  });

  it("drops pointers below the precision thresholds", () => {
    const { store, root, scoped, service } = lanternFixture();
    const has = () =>
      (contextOf(store, root, { task: TASK }).relevant?.supplements ?? []).some((item) => item.id === scoped.id);
    expect(has()).toBe(true);
    // Two similar Sessions changed the files the Knowledge covers.
    withOptions(service, { minSessions: 2 });
    expect(has()).toBe(true);
    withOptions(service, { minSessions: 3 });
    expect(has()).toBe(false);
    withOptions(service, { minSessions: 1, minTopRatio: 1 });
    expect(has()).toBe(true);
    withOptions(service, { minTopRatio: 1.01 });
    expect(has()).toBe(false);
    withOptions(service, { minTopRatio: 0, minScoreShare: 0.01 });
    expect(has()).toBe(true);
    withOptions(service, { minScoreShare: 1.01 });
    expect(has()).toBe(false);
  });

  it("skips inference only for high first-round confidence when skipHighConfidence is on", () => {
    const { store, root, scoped, service } = lanternFixture();
    const confidence = contextOf(store, root, { task: TASK }).relevant?.confidence;
    withOptions(service, { skipHighConfidence: true });
    const pointers = (contextOf(store, root, { task: TASK }).relevant?.supplements ?? []).map((item) => item.id);
    expect(pointers.includes(scoped.id)).toBe(confidence !== "high");
  });
});
