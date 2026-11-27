import type { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

export const RELEASE_FILES = ["CHANGELOG.md", "package.json", "docs/status.md", "docs/releases/notes.md"];
export const SECTIONED_PAGE_SECTIONS = 12;
const CITED_PER_SECTION = 10;

export const sectionFile = (section: number) => `src/topic-${section}.ts`;

/** 12 sections near the page limit, each citing 10 Sessions of its own file; RELEASE_FILES change in about 10% of them. */
export function seedSectionedPage(
  store: WorkIntelligenceStore,
  projectRoot: string,
  finalize: (key: string, changedFiles: string[]) => string,
  slug = "architecture",
) {
  const cited = Array.from({ length: SECTIONED_PAGE_SECTIONS }, (_, section) =>
    Array.from({ length: CITED_PER_SECTION }, (__, index) =>
      finalize(`sectioned-${section}-${index}`, [
        sectionFile(section),
        ...(index < RELEASE_FILES.length ? [RELEASE_FILES[index]!] : []),
      ]),
    ),
  );
  store.requestKnowledgePageUpdate({ projectRoot, slug });
  const read = store.getKnowledgePageContext({ projectRoot, slug });
  if (read.outcome !== "knowledge_page_context" || !("mode" in read)) throw new Error("Expected a full read");
  const saved = store.saveKnowledgePage({
    projectRoot,
    slug,
    idempotencyKey: `sectioned-${slug}`,
    reviewToken: read.reviewToken,
    sections: cited.map((sourceSessionIds, section) => ({
      heading: `Topic ${section}`,
      content: `Topic ${section}: ${"The verified rule for this fictional topic stays small and cites its sources. ".repeat(8)}`,
      sourceSessionIds,
    })),
  });
  if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
  store.markKnowledgePageChecked({ projectRoot, slug, throughSessionId: cited.at(-1)!.at(-1)! });
  return { cited };
}
