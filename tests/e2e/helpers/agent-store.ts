import { WorkIntelligenceStore } from "../../../packages/storage/dist/index.js";

type KnowledgePageSave = Parameters<WorkIntelligenceStore["saveKnowledgePage"]>[0];

export function withAgentStore<T>(task: (store: WorkIntelligenceStore) => T): T {
  const databasePath = process.env.WORK_INTELLIGENCE_E2E_DB;
  if (!databasePath) {
    throw new Error("WORK_INTELLIGENCE_E2E_DB is not set; run the suite through playwright.config.ts.");
  }
  const store = new WorkIntelligenceStore(databasePath, { backup: { directory: `${databasePath}-agent-backups` } });
  try {
    return task(store);
  } finally {
    store.close();
  }
}

export function saveKnowledgePageAfterReading(store: WorkIntelligenceStore, input: KnowledgePageSave) {
  const context = store.getKnowledgePageContext({ projectRoot: input.projectRoot, slug: input.slug });
  if (context.outcome !== "knowledge_page_context") throw new Error("Expected the Knowledge page context.");
  return store.saveKnowledgePage({ ...input, reviewToken: context.reviewToken });
}
