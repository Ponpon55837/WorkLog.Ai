import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextResult } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
interface ServiceInternals {
  inferTaskPaths: boolean;
  searchIndex: { knowledgeForWeightedPaths: (...args: unknown[]) => unknown };
}

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const filler = "The fictional lantern ledger keeps its verified wick spacing window and its source notes. ";
/** Long enough that its pointer needs more room than the heavy fixture leaves under the budget. */
const BURNER_TITLE = `Burner tolerance rule ${"for the valve and dial assembly ".repeat(10)}`.trim();
const TASK = "rework swarm frame splitting";
/** Excerpts long enough that reducing a recentKnowledge record to its title saves room. */
const LONG_FILLER = "x ".repeat(60);

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
  extra: { burnerTitle?: string; matchedRecentTitle?: string; fillerBody?: string } = {},
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
    fixture.record(
      `filler-${index}`,
      `Candle storage note ${index}`,
      extra.fillerBody ?? "Store candles away from the window.",
      [],
    );
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

/** The response the product would give without the feature (the replay experiment's `off` variant). */
function withFeatureOff<T>(service: ServiceInternals, run: () => T): T {
  service.inferTaskPaths = false;
  try {
    return run();
  } finally {
    service.inferTaskPaths = true;
  }
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

  it("returns byte-identical responses for calls with paths or without a task, with the feature on or off", () => {
    for (const heavyCount of [0, 1, 5]) {
      const { store, root, service } = lanternFixture(true, heavyCount, { matchedRecentTitle: "Valve seat rule" });
      const focuses = [{ task: TASK, paths: ["src/burner/valve.ts"] }, { paths: ["src/other/file.ts"] }, {}];
      const off = withFeatureOff(service, () => focuses.map((focus) => JSON.stringify(contextOf(store, root, focus))));
      expect(focuses.map((focus) => JSON.stringify(contextOf(store, root, focus)))).toEqual(off);
    }
  });

  it("keeps the rest of a budget-tight response identical to the response without the feature", () => {
    const { store, root, service } = lanternFixture(true);
    const on = contextOf(store, root, { task: TASK });
    const off = withFeatureOff(service, () => contextOf(store, root, { task: TASK }));

    expect(JSON.stringify(withoutSupplements(on))).toBe(JSON.stringify(withoutSupplements(off)));
    expect(JSON.stringify(on).length).toBeLessThanOrEqual(9_800);
    // The budget is tight: the pointer was dropped last and only counted in its own omission entry.
    expect(on.omitted?.some((omission) => omission.section === "relevant.supplements")).toBe(true);
    expect((off.relevant?.supplements ?? []).some((item) => item.includedBecause.kind === "inferred_path")).toBe(false);
  });

  it("offers a Knowledge only when at least two similar Sessions support it", () => {
    const { store, root, record, finalize, scoped } = lanternFixture();
    const solo = record("solo", "Gear mesh rule", "Keep the gears meshed.", ["src/solo/**"]);
    finalize("solo-1", "Swarm frame splitting solo gear", ["src/solo/gear.ts"]);
    const ids = () => (contextOf(store, root, { task: TASK }).relevant?.supplements ?? []).map((item) => item.id);

    // The valve Knowledge has two supporting Sessions; the gear one has only one.
    expect(ids()).toContain(scoped.id);
    expect(ids()).not.toContain(solo.id);
    finalize("solo-2", "Swarm frame splitting solo gear again", ["src/solo/gear.ts"]);
    expect(ids()).toContain(solo.id);
  });

  it("labels the pointer with the inferred file and the Sessions to read first", () => {
    const { store, root, scoped } = lanternFixture();
    const pointer = contextOf(store, root, { task: TASK }).relevant?.supplements?.find((item) => item.id === scoped.id);
    expect(pointer?.includedBecause.kind).toBe("inferred_path");
    if (pointer?.includedBecause.kind !== "inferred_path") throw new Error("Expected an inferred path.");
    expect(pointer.includedBecause.path).toBe("src/burner/valve.ts");
    expect(pointer.includedBecause.sourceSessionIds.length).toBeGreaterThan(0);
  });
});

describe("work_get_context inferred-path budget yield", () => {
  /** One heavy Session leaves the page 10-12 characters short of the pointer, with recentKnowledge still present. */
  it("shortens unmatched recentKnowledge to titles before popping any, and changes nothing else", () => {
    const { store, root, scoped, service } = lanternFixture(true, 1, { fillerBody: LONG_FILLER });
    const on = contextOf(store, root, { task: TASK });
    const off = withFeatureOff(service, () => contextOf(store, root, { task: TASK }));

    expect(on.relevant?.supplements?.map((item) => item.id)).toEqual([scoped.id]);
    expect(JSON.stringify(on).length).toBeLessThanOrEqual(9_800);
    expect(JSON.stringify(withoutRecentAndSupplements(on))).toBe(JSON.stringify(withoutRecentAndSupplements(off)));
    // Nothing was popped: the same records stay, the usual omission is untouched, and the last ones lost their excerpts.
    expect(on.recentKnowledge.map((item) => item.id)).toEqual(off.recentKnowledge.map((item) => item.id));
    expect(on.omitted?.find((omission) => omission.section === "recentKnowledge")).toEqual(
      off.omitted?.find((omission) => omission.section === "recentKnowledge"),
    );
    const shortened = on.recentKnowledge.filter((item) => item.excerpt === "");
    expect(shortened.length).toBeGreaterThan(0);
    expect(shortened.every((item) => item.excerptTruncated === true)).toBe(true);
    // From the end: every record after the first shortened one is shortened too, and the ones before are untouched.
    const firstShortened = on.recentKnowledge.findIndex((item) => item.excerpt === "");
    expect(on.recentKnowledge.slice(firstShortened).every((item) => item.excerpt === "")).toBe(true);
    expect(on.recentKnowledge.slice(0, firstShortened)).toEqual(off.recentKnowledge.slice(0, firstShortened));
  });

  it("pops recentKnowledge only when every unmatched record is already title-only and the pointer still does not fit", () => {
    const { store, root, scoped, service } = lanternFixture(true, 2, {
      burnerTitle: "Burner rule",
      fillerBody: LONG_FILLER,
    });
    const on = contextOf(store, root, { task: TASK });
    const off = withFeatureOff(service, () => contextOf(store, root, { task: TASK }));

    expect(on.relevant?.supplements?.map((item) => item.id)).toContain(scoped.id);
    expect(JSON.stringify(on).length).toBeLessThanOrEqual(9_800);
    expect(on.recentKnowledge.length).toBeLessThan(off.recentKnowledge.length);
    expect(on.recentKnowledge.every((item) => item.excerpt === "" && item.excerptTruncated === true)).toBe(true);
    const before = off.omitted?.find((omission) => omission.section === "recentKnowledge");
    const after = on.omitted?.find((omission) => omission.section === "recentKnowledge");
    expect(after?.count).toBe((before?.count ?? 0) + off.recentKnowledge.length - on.recentKnowledge.length);
    expect(after?.reasons).toContain("預算限制：較低優先 Knowledge");
  });

  it("never exceeds the budget and keeps first-round content", () => {
    for (const heavyCount of [0, 1, 2, 3, 5]) {
      const { store, root, service } = lanternFixture(true, heavyCount, { matchedRecentTitle: "Valve seat rule" });
      const off = withFeatureOff(service, () => contextOf(store, root, { task: TASK }));
      const on = contextOf(store, root, { task: TASK });
      expect(JSON.stringify(on).length).toBeLessThanOrEqual(9_800);
      expect(JSON.stringify(on.relevant?.knowledge)).toBe(JSON.stringify(off.relevant?.knowledge));
      expect(JSON.stringify(on.relevant?.sessions)).toBe(JSON.stringify(off.relevant?.sessions));
    }
  });

  it("promotes a matched recentKnowledge record into one labelled pointer and never shortens or pops it", () => {
    for (const heavyCount of [0, 1]) {
      const { store, root, scoped, matchedRecent, service } = lanternFixture(true, heavyCount, {
        matchedRecentTitle: "Valve seat rule",
      });
      const off = withFeatureOff(service, () => contextOf(store, root, { task: TASK }));
      expect(off.recentKnowledge.map((item) => item.id)).toContain(matchedRecent!.id);

      const on = contextOf(store, root, { task: TASK });
      const pointers = (on.relevant?.supplements ?? []).map((item) => item.id);
      expect(pointers).toContain(matchedRecent!.id);
      expect(pointers).toContain(scoped.id);
      // Counted once: the labelled pointer replaced the recent record, and no omission names it.
      expect(on.recentKnowledge.map((item) => item.id)).not.toContain(matchedRecent!.id);
      expect(JSON.stringify(on.omitted)).not.toContain(matchedRecent!.id);
      expect(JSON.stringify(on).length).toBeLessThanOrEqual(9_800);
    }
  });

  it("brings back a record budget trimming took out of recentKnowledge and keeps the omission counts consistent", () => {
    const { store, root, scoped, matchedRecent, service } = lanternFixture(true, 5, {
      burnerTitle: "Burner rule",
      matchedRecentTitle: "Valve seat rule",
    });
    // Only the recent record is left to match, so its short pointer is the one that has to fit.
    store.updateKnowledge({ projectRoot: root, knowledgeId: scoped.id, status: "archived" });
    const off = withFeatureOff(service, () => contextOf(store, root, { task: TASK }));
    const on = contextOf(store, root, { task: TASK });

    const omission = (context: ContextResult) => context.omitted?.find((item) => item.section === "recentKnowledge");
    expect((on.relevant?.supplements ?? []).map((item) => item.id)).toContain(matchedRecent!.id);
    const kept = omission(on);
    expect(kept?.count).toBe((omission(off)?.count ?? 0) - 1);
    expect(kept?.ids ?? []).not.toContain(matchedRecent!.id);
    expect((kept?.ids?.length ?? 0) + (kept?.moreIds ?? 0)).toBe(kept?.count);
    expect(JSON.stringify(on).length).toBeLessThanOrEqual(9_800);
  });
});
