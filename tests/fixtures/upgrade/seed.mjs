// Seeds a new database through the public store API of the build that is checked out in <worktreeRoot>.
// Run by scripts/generate-upgrade-fixtures.mjs only. Synthetic data only: no real paths, names or emails.
// Usage: node seed.mjs <worktreeRoot> <databasePath> <privateBlocks: 0|1>
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import console from "node:console";

const [worktreeRoot, databasePath, privateFlag] = process.argv.slice(2);
const privateBlocks = privateFlag === "1";
const { WorkIntelligenceStore, LATEST_SCHEMA_VERSION } = await import(
  pathToFileURL(join(worktreeRoot, "packages/storage/dist/index.js")).href
);

const TOKEN = "zebrafixturetoken";
const PRIVATE = privateBlocks ? ` <private>zephyrquill secret plan</private>` : "";
const roots = { alpha: join("/", "synthetic", "alpha"), beta: join("/", "synthetic", "beta") };

function must(result, outcome) {
  if (!result || result.outcome !== outcome) {
    throw new Error(`Expected outcome ${outcome}, got ${JSON.stringify(result)?.slice(0, 300)}`);
  }
  return result;
}

const store = new WorkIntelligenceStore(databasePath);
try {
  const sessionIds = [];
  for (const [name, root] of Object.entries(roots)) {
    const project = store.addProject(`Synthetic ${name}`, root);
    store.updateProject(project.id, { status: "tracked" });
    for (let index = 0; index < 3; index += 1) {
      const result = must(
        store.finalizeSession({
          projectRoot: root,
          idempotencyKey: `${name}-session-${index}`,
          title: `Synthetic ${name} step ${index}`,
          summary: `Tuned the ${TOKEN} valve lease in ${name}, part ${index}.${index === 0 ? PRIVATE : ""}`,
          workSummary: {
            outcomes: [`Lease ${index} holds.`],
            scope: ["src/valve.ts"],
            decisions: [`Keep the lease under ${index + 2} minutes because the coil overheats.`],
            verification: ["pnpm test passed."],
            nextSteps: [`Check valve ${index} after rain.`, `Review zone ${index} wiring.`],
          },
          changedFiles: ["src/valve.ts", `src/zone-${index}.ts`],
          verification: { status: "passed" },
          git: { branch: "main", commitSha: `${name === "alpha" ? "a" : "b"}${index}`.repeat(4).padEnd(40, "c") },
          events: [
            { type: "execution", summary: `Ran valve tests ${index}`, details: { exitCode: 0 } },
            { type: "note", summary: `Chose a short lease ${index}` },
          ],
          handoffContent: `# Handoff\nThe ${TOKEN} valve ${index} sticks when cold.${index === 0 ? PRIVATE : ""}\nVisible tail`,
        }),
        "finalized",
      );
      sessionIds.push({ root, name, id: result.session.id });
    }
    must(
      store.recordKnowledge({
        projectRoot: root,
        idempotencyKey: `${name}-lease-rule`,
        kind: "gotcha",
        title: `Valve lease must stay short (${name})`,
        body: `The ${TOKEN} valve lease must stay under three minutes or the coil overheats.`,
        sessionId: sessionIds.find((entry) => entry.name === name).id,
      }),
      "knowledge_recorded",
    );
  }

  const alpha = sessionIds.filter((entry) => entry.name === "alpha");
  must(
    store.attachEvidence({ sessionId: alpha[0].id, kind: "test", reference: "ci://run/1", summary: "Passed" }),
    "evidence_attached",
  );
  store.linkSessions({ sessionId: alpha[0].id, relatedSessionId: alpha[2].id, relation: "related", linked: true });

  store.requestKnowledgePageUpdate({ projectRoot: roots.alpha, slug: "architecture" });
  for (const version of [1, 2]) {
    store.saveKnowledgePage({
      projectRoot: roots.alpha,
      slug: "architecture",
      idempotencyKey: `page-${version}`,
      sections: [
        {
          heading: "Modules",
          content: `Valve driver ${TOKEN}, revision ${version}.${version === 1 ? PRIVATE : ""}`,
          sourceSessionIds: [alpha[0].id],
        },
      ],
    });
    store.requestKnowledgePageUpdate({ projectRoot: roots.alpha, slug: "architecture" });
  }

  if (typeof store.requestKnowledgeCandidates === "function") {
    const request = must(store.requestKnowledgeCandidates(roots.alpha), "knowledge_candidate_request");
    store.getKnowledgeCandidateContext?.({ requestId: request.request.id });
    const submitted = must(
      store.submitKnowledgeCandidates({
        requestId: request.request.id,
        candidates: ["Valve lease must stay short", "Drip line clogs in frost", "Hose reel jams"].map((title) => ({
          sourceSessionId: alpha[0].id,
          kind: "gotcha",
          title,
          body: `${title}: the valve lease must stay under three minutes or the coil overheats.`,
          rationale: "The handoff describes it.",
        })),
      }),
      "knowledge_candidates_submitted",
    );
    store.decideKnowledgeCandidate({ candidateId: submitted.candidates[1].id, decision: "accept" });
    store.decideKnowledgeCandidate({ candidateId: submitted.candidates[2].id, decision: "reject" });
  }

  const items = store.listOutstandingItems({ projectRoot: roots.alpha, status: "pending" });
  if (items.outcome === "outstanding_items" && items.items.length > 0) {
    store.updateOutstandingItemStatus(items.items[0].id, "completed");
  }

  // Exercise the search index so the FTS tables are populated, then check the token is findable.
  const hits = store.search(TOKEN);
  if (!Array.isArray(hits) || hits.length === 0) throw new Error("Seeded token is not searchable.");
  const summary = store.getDashboardSummary();
  if (summary.finalizedSessions !== 6) throw new Error(`Unexpected finalizedSessions: ${summary.finalizedSessions}`);
  console.log(JSON.stringify({ latestSchemaVersion: LATEST_SCHEMA_VERSION, hits: hits.length }));
} finally {
  store.close();
}
