import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextResult } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
interface ServiceInternals {
  shouldInferTaskPaths: (knowledgeHitCount: number, confidence: string) => boolean;
  searchIndex: { knowledgeForPaths: (...args: unknown[]) => unknown };
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
function lanternFixture(heavy = false) {
  const fixture = setup();
  const scoped = fixture.record("scoped", BURNER_TITLE, "Keep the burner within tolerance.", ["src/burner/**"]);
  const first = fixture.finalize("s1", "Rework swarm frame splitting", ["src/burner/valve.ts"], heavy);
  fixture.finalize("s2", "Swarm frame splitting follow up", ["src/burner/valve.ts", "src/burner/dial.ts"], heavy);
  for (let index = 0; heavy && index < 5; index += 1) {
    fixture.finalize(`h${index}`, `Swarm frame splitting heavy ${index}`, ["src/burner/valve.ts"], true);
  }
  // The 12 newest Knowledge records fill recentKnowledge, so the scoped record is reachable only by its path.
  for (let index = 0; index < 12; index += 1) {
    fixture.record(`filler-${index}`, `Candle storage note ${index}`, "Store candles away from the window.", []);
  }
  return { ...fixture, scoped, first };
}

function withoutSupplements(context: ContextResult): unknown {
  const copy = structuredClone(context);
  delete copy.relevant?.supplements;
  copy.omitted = copy.omitted?.filter((omission) => omission.section !== "relevant.supplements");
  if (copy.omitted?.length === 0) delete copy.omitted;
  return copy;
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
    const spy = vi.spyOn(service.searchIndex, "knowledgeForPaths");

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
