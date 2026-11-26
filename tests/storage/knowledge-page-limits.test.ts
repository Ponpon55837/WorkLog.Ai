import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_PAGE_SPLIT_GUIDANCE, type KnowledgePageSection } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const SLUG = "architecture";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-knowledge-page-limits-"));
  tempDirs.push(root);
  const projectRoot = join(root, "lighthouse");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Lighthouse", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2031, 2, 1));
  const finalized = store.finalizeSession({
    projectRoot,
    idempotencyKey: "lamp-session",
    title: "Lamp maintenance",
    summary: "Checked the lamp rotation.",
    workSummary: { outcomes: ["The lamp turns."], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: [],
    verification: { status: "passed" },
  });
  if (finalized.outcome !== "finalized") throw new Error("Expected finalize");
  const sessionId = finalized.session.id;
  vi.setSystemTime(Date.UTC(2031, 2, 2));
  store.requestKnowledgePageUpdate({ projectRoot, slug: SLUG });
  const target = { projectRoot, slug: SLUG };
  const sections = (lengths: readonly number[]): KnowledgePageSection[] =>
    lengths.map((length, index) => ({
      heading: `Topic ${index}`,
      content: `${index}`.padEnd(length, "."),
      sourceSessionIds: [sessionId],
    }));
  const token = () => {
    const read = store.getKnowledgePageContext({ ...target, headings: ["Topic 0"] });
    if (read.outcome !== "knowledge_page_context") throw new Error(`Expected a read, got ${read.outcome}`);
    return read.reviewToken;
  };
  const save = (key: string, lengths: readonly number[]) =>
    store.saveKnowledgePage({ ...target, idempotencyKey: key, reviewToken: token(), sections: sections(lengths) });
  const upsert = (key: string, lengths: readonly number[], first = 0) =>
    store.saveKnowledgePage({
      ...target,
      idempotencyKey: key,
      reviewToken: token(),
      upsertSections: sections([...Array.from({ length: first }, () => 1), ...lengths]).slice(first),
    });
  return { store, target, save, upsert };
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Knowledge page split suggestions", () => {
  it("adds no size or suggestion to saves and reads of a page below the thresholds", () => {
    const { store, target, save } = setup();
    const saved = save("small", [3_000, 4_000, 199]);
    expect(saved.outcome).toBe("knowledge_page_saved");
    expect(saved).not.toHaveProperty("splitSuggestion");
    expect(saved).not.toHaveProperty("size");
    for (const query of [{}, { query: "Topic" }, { headings: ["Topic 1"] }]) {
      const read = store.getKnowledgePageContext({ ...target, ...query });
      expect(read).not.toHaveProperty("splitSuggestion");
      expect(read).not.toHaveProperty("size");
    }
    const reviewOnly = store.getKnowledgePageContext({ ...target, reviewOnly: true });
    expect(reviewOnly).toMatchObject({ size: { sectionCount: 3, contentChars: 7_199 } });
    expect(reviewOnly).not.toHaveProperty("splitSuggestion");
  });

  it("suggests the largest sections on a save whose content is near the limit, and on every read", () => {
    const { store, target, save } = setup();
    const expected = {
      size: { sectionCount: 4, maxSections: 12, contentChars: 7_300, maxContentChars: 8_000 },
      splitSuggestion: {
        near: ["content"],
        headings: ["Topic 1", "Topic 2", "Topic 0"],
        splitWith: KNOWLEDGE_PAGE_SPLIT_GUIDANCE,
      },
    };
    expect(save("content-near", [1_000, 3_000, 3_000, 300])).toMatchObject({
      outcome: "knowledge_page_saved",
      ...expected,
    });
    for (const query of [{}, { query: "Topic" }, { headings: ["Topic 3"] }, { reviewOnly: true }]) {
      expect(store.getKnowledgePageContext({ ...target, ...query })).toMatchObject(expected);
    }
  });

  it("suggests splitting a page with one section slot left, and names both limits when both are near", () => {
    const { save } = setup();
    expect(
      save(
        "sections-near",
        Array.from({ length: 11 }, (_, index) => 20 + index),
      ),
    ).toMatchObject({
      size: { sectionCount: 11, contentChars: 275 },
      splitSuggestion: { near: ["sections"], headings: ["Topic 10", "Topic 9", "Topic 8"] },
    });
    expect(
      save(
        "both-near",
        Array.from({ length: 12 }, () => 650),
      ),
    ).toMatchObject({
      size: { sectionCount: 12, contentChars: 7_800 },
      splitSuggestion: { near: ["sections", "content"], headings: ["Topic 0", "Topic 1", "Topic 2"] },
    });
  });

  it("suggests splitting after a section update brings the page near the limit, and on its replay", () => {
    const { save, upsert } = setup();
    save("base", [3_000, 3_000]);
    const updated = upsert("grow", [1_500], 2);
    expect(updated).toMatchObject({
      outcome: "knowledge_page_saved",
      sectionChanges: { added: ["Topic 2"] },
      size: { sectionCount: 3, contentChars: 7_500 },
      splitSuggestion: { near: ["content"], headings: ["Topic 0", "Topic 1"] },
    });
    expect(upsert("grow", [1_500], 2)).toMatchObject({ duplicate: true, splitSuggestion: { near: ["content"] } });
  });

  it("points a refused save over the limits to a custom page with the sections to move", () => {
    const { save, upsert } = setup();
    save(
      "base",
      Array.from({ length: 12 }, () => 100),
    );
    const tooMany = upsert("too-many", [100], 12);
    expect(tooMany).toMatchObject({
      outcome: "page_limit_exceeded",
      sectionCount: 13,
      maxSections: 12,
      reason: expect.stringMatching(/First remove what no longer answers the page question.*move sections to a custom page/),
      splitSuggestion: { near: ["sections"], headings: ["Topic 0", "Topic 1", "Topic 2"] },
    });
    const tooLong = upsert("too-long", [4_000, 4_000], 0);
    expect(tooLong).toMatchObject({
      outcome: "page_limit_exceeded",
      contentChars: 9_000,
      reason: expect.stringMatching(/9000 characters .*custom page/),
      splitSuggestion: { near: ["sections", "content"], headings: ["Topic 0", "Topic 1", "Topic 2"] },
    });
  });
});
