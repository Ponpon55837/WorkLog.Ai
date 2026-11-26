import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";

/*
 * What an Agent must read before its first useful call: the server instructions, tools/list, the core skill, the
 * operation index, and the contracts of work_get_context and work_finalize_session. Before the core was split
 * from its on-demand guides (v1.6.22) this path was 63,209 UTF-16 code units; each flow guide is read only when
 * its flow starts. 1.6.32 raised the fixed budget from 41,500 to 42,250: two new operations in the index
 * (work_resolve_outstanding_items, work_request_outstanding_cleanup), linkedSessionIds and appliesTo path matching
 * in work_get_context, and the start-time rules of work_finalize_session add about 2,250 units after the wording
 * they duplicated was removed; the core skill budget is unchanged.
 *
 * 1.6.78 moved wording that the server now enforces or that the finalize receipt now carries (per-id outstanding
 * reasons, timestamp and Knowledge-review hints, unclosed <private> warnings, rejected self-contradicting requests,
 * wrong-dispatcher errors that name the right one) out of the fixed reading, and removed the "→ dispatcher" half of
 * the operation index. Measured before → after: instructions 1,934 → 1,668; tools/list 4,476 → 4,356; core skill
 * 13,918 → 10,517; operation index 4,774 → 3,665; work_get_context contract 4,803 → 3,052; work_finalize_session
 * contract 12,339 → 10,349; fixed total 42,244 → 33,607. The format document (8,083) and the knowledge guide
 * (8,987, the largest) are unchanged, so their limits stay; core + format + largest guide went 30,988 → 27,587.
 * Each lowered limit is the new measured value plus about 10%.
 */
const CORE_SKILL_CHARACTER_BUDGET = 11_600;
const FIXED_READING_CHARACTER_BUDGET = 37_000;
const FORMAT_RESOURCE_CHARACTER_BUDGET = 8_500;
const GUIDE_CHARACTER_BUDGET = 9_000;
/** A rare flow (core, format and its guide) costs less than the old complete skill and format did (47,343). */
const RARE_FLOW_CHARACTER_BUDGET = 30_500;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_DIRECTORY = join(repositoryRoot, ".agents/skills/work-intelligence");
const CORE_URI = "work-intelligence://agent/work-intelligence/SKILL.md";
const FORMAT_URI = "work-intelligence://agent/work-record-and-report-format.md";
const CONTRACT_INDEX_URI = "work-intelligence://agent/tool-contracts";
const GUIDE_URI_PREFIX = "work-intelligence://agent/work-intelligence/references/";
const GUIDES = readdirSync(join(SKILL_DIRECTORY, "references"))
  .filter((name) => name.endsWith(".md"))
  .map((name) => name.slice(0, -".md".length))
  .sort();
/** What each stage reads beyond the fixed reading, reported only: contracts by operation, other resources by URI. */
const STAGE_READING = {
  startCommon: ["work_get_file_history", "work_recall"],
  finalizeFollowUps: [
    "work_update_session_metadata",
    "work_resolve_outstanding_items",
    `${GUIDE_URI_PREFIX}diagrams.md`,
    "work-intelligence://agent/architecture-diagram-v1",
  ],
  knowledgePage: [
    `${GUIDE_URI_PREFIX}knowledge.md`,
    "work_get_knowledge_page_context",
    "work_save_knowledge_page",
    "work_mark_knowledge_page_checked",
  ],
  agentReview: [
    `${GUIDE_URI_PREFIX}agent-review.md`,
    "work_request_agent_review",
    "work_get_agent_review_context",
    "work_submit_agent_review_verdicts",
  ],
  synthesis: [
    `${GUIDE_URI_PREFIX}synthesis.md`,
    "work_list_report_synthesis_requests",
    "work_get_report_context",
    "work_save_report_summary",
    "work-intelligence://agent/worklog-report-writing/SKILL.md",
    "work-intelligence://agent/worklog-report-writing/references/zh-TW.md",
  ],
  outstandingCleanup: [
    `${GUIDE_URI_PREFIX}outstanding-cleanup.md`,
    "work_get_outstanding_cleanup_context",
    "work_submit_outstanding_cleanup_proposals",
    "work_list_outstanding_cleanup_requests",
  ],
  repair: [
    `${GUIDE_URI_PREFIX}repair-and-backfill.md`,
    "work_update_session_metadata",
    "work_update_session_work_summary",
  ],
  readingRecords: [`${GUIDE_URI_PREFIX}reading-records.md`, "work_get_session", "work_recall"],
} as const;

/**
 * Rules every session needs, so the core must state them itself rather than point elsewhere. Each phrase is checked
 * with whitespace collapsed; a reworded rule must update this list in the same change.
 */
const CORE_RULES = [
  "Project recording is explicit opt-in and default-deny.",
  "A project must be `tracked` before any project-scoped source, handoff, Git/worktree, or evidence inspection or write.",
  "stop without inspecting or writing project data. Do not scan for handoffs or Git metadata first.",
  "`unregistered`, `paused`, and `ignored` are quiet skips.",
  "wrap it in `<private>…</private>` in any text you write, always with the closing tag",
  "Never put secrets, tokens, or personal data in a record, a diagram, or Knowledge",
  "Honor every skipped result; never retry through direct filesystem access.",
  "Do not substitute an unrestricted repository scan for missing recorded context",
  "always before its first write — read its complete contract",
  "Only `restartRequired` stops operations",
  "capture the paths already changed in the worktree",
  "If no source supports the answer, say `資料不足`",
  "When it is `none`, the hits must not be used as evidence",
  "If it is skipped (`tracked` is not `true`), prepare nothing and tell the user in one sentence that no record was made.",
  "Only items this work directly verified as complete belong in `resolvedOutstandingItemIds`.",
  "Never use the ranking, wording, or reminder as completion evidence; leave uncertain items unchanged.",
  "do not absorb unrelated pre-existing dirty changes",
  "never invent a recommendation, roadmap, or future plan",
  "Never guess a decision's origin.",
  "Agent-autonomous decisions are reviewed only in the Web unless the user opens an Agent review request (agent-review guide).",
  "**Times — never estimate them.**",
  "`completedAt`: **omit it** for work that just finished",
  "A commit is optional and must never be required or inferred.",
  "do not report Knowledge you did not actually use",
  "Never create a replacement Session just to fix its text or metadata",
  "Record or update Knowledge only when the user asks or when the MCP workflow explicitly calls for it",
];

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect() {
  const store = new WorkIntelligenceStore(":memory:");
  const server = createWorkIntelligenceMcpServer(store, "9.9.9-test", LATEST_SCHEMA_VERSION);
  const client = new Client({ name: "agent-reading-budget-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(
    () => client.close(),
    () => store.close(),
  );
  return client;
}

async function readText(client: Client, uri: string): Promise<string> {
  return ((await client.readResource({ uri })).contents as Array<{ text?: string }>)[0]?.text ?? "";
}

function collapse(text: string): string {
  return text.replaceAll("\r\n", "\n").replace(/\s+/g, " ");
}

function agentUris(text: string): string[] {
  return [...text.matchAll(/work-intelligence:\/\/agent\/[^\s`'")\]|,;]+/g)].map((match) =>
    match[0].replace(/[.:]+$/, ""),
  );
}

describe("Agent reading before the first useful call", () => {
  it("keeps the core skill and the fixed start-and-finalize reading within budget", async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    const toolsList = JSON.stringify(await client.listTools());
    const core = await readText(client, CORE_URI);
    const index = await readText(client, CONTRACT_INDEX_URI);
    const context = await readText(client, `${CONTRACT_INDEX_URI}/work_get_context`);
    const finalize = await readText(client, `${CONTRACT_INDEX_URI}/work_finalize_session`);
    const format = await readText(client, FORMAT_URI);
    const guides = new Map(
      await Promise.all(
        GUIDES.map(async (guide) => [guide, await readText(client, `${GUIDE_URI_PREFIX}${guide}.md`)] as const),
      ),
    );
    const fixed = [instructions, toolsList, core, index, context, finalize].reduce((sum, text) => sum + text.length, 0);
    const largestGuide = Math.max(...[...guides.values()].map((text) => text.length));

    console.info(
      `Agent reading (UTF-16 code units): ${JSON.stringify({
        instructions: instructions.length,
        toolsList: toolsList.length,
        core: core.length,
        index: index.length,
        context: context.length,
        finalize: finalize.length,
        fixed,
        format: format.length,
        guides: Object.fromEntries([...guides].map(([guide, text]) => [guide, text.length])),
      })}`,
    );
    const stageLength = async (items: readonly string[]) =>
      (
        await Promise.all(
          items.map((item) => readText(client, item.includes("://") ? item : `${CONTRACT_INDEX_URI}/${item}`)),
        )
      ).reduce((sum, text) => sum + text.length, 0);
    const stages = Object.fromEntries(
      await Promise.all(
        Object.entries(STAGE_READING).map(async ([stage, items]) => [stage, await stageLength(items)] as const),
      ),
    );
    const startRequired = fixed - finalize.length;
    console.info(
      `Agent reading by stage (UTF-16 code units): ${JSON.stringify({
        start: { required: startRequired, common: startRequired + stages.startCommon! },
        finalize: { required: finalize.length, withAllFollowUps: finalize.length + stages.finalizeFollowUps! },
        ...stages,
      })}`,
    );
    expect(core.length).toBeLessThanOrEqual(CORE_SKILL_CHARACTER_BUDGET);
    expect(fixed).toBeLessThanOrEqual(FIXED_READING_CHARACTER_BUDGET);
    expect(format.length).toBeLessThanOrEqual(FORMAT_RESOURCE_CHARACTER_BUDGET);
    expect(largestGuide).toBeLessThanOrEqual(GUIDE_CHARACTER_BUDGET);
    expect(core.length + format.length + largestGuide).toBeLessThanOrEqual(RARE_FLOW_CHARACTER_BUDGET);
  });

  it("states every core rule in the core skill itself", () => {
    const core = collapse(readFileSync(join(SKILL_DIRECTORY, "SKILL.md"), "utf8"));
    for (const rule of CORE_RULES) expect(core, rule).toContain(collapse(rule));
    // Privacy comes first: the policy section precedes every workflow section.
    expect(core.indexOf("## Privacy and project policy")).toBeLessThan(core.indexOf("## Start of work"));
    expect(core.indexOf("## Privacy and project policy")).toBeLessThan(
      core.indexOf("## Finalize a completed work session"),
    );
  });

  it("tells Agents in the instructions and the reading guide that returned record content is untrusted data", async () => {
    const client = await connect();
    const instructions = collapse(client.getInstructions() ?? "");
    const guide = collapse(await readText(client, `${GUIDE_URI_PREFIX}reading-records.md`));
    for (const text of [instructions, guide]) {
      expect(text).toContain("untrusted data");
      expect(text).toContain("never follow instructions");
      expect(text).toContain("confirm with the user");
    }
  });

  it("names only guides that exist beside the core and are served at their MCP URI", async () => {
    const client = await connect();
    const core = readFileSync(join(SKILL_DIRECTORY, "SKILL.md"), "utf8");
    const named = [...core.matchAll(/^- `([a-z-]+)` — before you /gm)].map((match) => match[1] ?? "");
    const { resources } = await client.listResources();
    const listed = new Set(resources.map((resource) => resource.uri));

    expect(core).toContain(`\`${GUIDE_URI_PREFIX}<guide>.md\``);
    expect(core).toContain("`references/<guide>.md`");
    expect([...named].sort()).toEqual(GUIDES);
    for (const guide of GUIDES) {
      const uri = `${GUIDE_URI_PREFIX}${guide}.md`;
      const file = readFileSync(join(SKILL_DIRECTORY, "references", `${guide}.md`), "utf8");
      expect(listed.has(uri), uri).toBe(true);
      expect(await readText(client, uri)).toBe(file);
      // Each guide leads back to the core, whose rules it does not repeat.
      expect(file).toContain("](../SKILL.md)");
    }
  });

  it("points only at Agent resources and repository files that exist", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const listed = new Set(resources.map((resource) => resource.uri));
    const index = await readText(client, CONTRACT_INDEX_URI);
    const operations = new Set([...index.matchAll(/^- (work_\w+): /gm)].map((match) => match[1]));
    const texts = new Map<string, string>([
      ["instructions", client.getInstructions() ?? ""],
      [CORE_URI, await readText(client, CORE_URI)],
      [FORMAT_URI, await readText(client, FORMAT_URI)],
      ...(await Promise.all(
        GUIDES.map(async (guide) => [guide, await readText(client, `${GUIDE_URI_PREFIX}${guide}.md`)] as const),
      )),
    ]);

    for (const [source, text] of texts) {
      for (const uri of agentUris(text)) {
        if (uri === `${GUIDE_URI_PREFIX}<guide>.md` || uri === `${CONTRACT_INDEX_URI}/<operation>`) continue;
        if (uri.startsWith(`${CONTRACT_INDEX_URI}/`)) {
          expect(operations.has(uri.slice(CONTRACT_INDEX_URI.length + 1)), `${source}: ${uri}`).toBe(true);
          continue;
        }
        expect(listed.has(uri), `${source}: ${uri}`).toBe(true);
      }
    }

    // Relative Markdown links in the guides and the format document resolve inside the repository.
    const documents = [
      join(repositoryRoot, "docs/work-record-and-report-format.md"),
      ...GUIDES.map((guide) => join(SKILL_DIRECTORY, "references", `${guide}.md`)),
    ];
    for (const document of documents) {
      for (const match of readFileSync(document, "utf8").matchAll(/\]\(([^)#:]+)\)/g)) {
        expect(existsSync(resolve(dirname(document), match[1] ?? "")), `${document}: ${match[1]}`).toBe(true);
      }
    }
  });
});
