// Synthetic task-cost evidence. Run before and after in separate Node processes.
import console from "node:console";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const sourceRoot = resolve(process.env.WI_PROJECTION_SOURCE_ROOT ?? ".");
const { WorkIntelligenceStore, LATEST_SCHEMA_VERSION } = await import(
  pathToFileURL(join(sourceRoot, "packages/storage/dist/index.js"))
);
const { createWorkIntelligenceMcpServer } = await import(pathToFileURL(join(sourceRoot, "apps/mcp/dist/server.js")));
const projected = process.argv.includes("--projected");
const root = mkdtempSync(join(tmpdir(), "wi-projection-cost-"));
const store = new WorkIntelligenceStore(":memory:");
const project = store.addProject("Synthetic projection cost", root);
store.updateProject(project.id, { status: "tracked" });
const rows = [];
const count = Number(process.env.WI_PROJECTION_REPEATS ?? 15);
const textBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const summarize = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.ceil(sorted.length * 0.9) - 1] };
};
try {
  const sessions = [];
  for (const heavy of [false, true]) {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: `cost-${heavy}`,
      title: `Synthetic ${heavy ? "heavy" : "small"} Session`,
      summary: "Implementation complete; real-device checks remain pending.",
      workSummary: {
        outcomes: ["Completed implementation"],
        scope: ["src/example.ts"],
        decisions: [{ text: "Keep manual zoom", origin: "user_requested" }],
        verification: ["Synthetic automated checks passed; physical device checks pending"],
        nextSteps: ["Run physical device checks"],
      },
      changedFiles: ["src/example.ts"],
      verification: { status: "in_progress", summary: "Physical verification pending" },
      ...(heavy
        ? {
            handoffContent: "Synthetic raw snapshot 😀\n".repeat(2000),
            events: Array.from({ length: 100 }, (_, i) => ({
              type: "execution",
              summary: `Synthetic event ${i}`,
              details: { body: "Synthetic detail ".repeat(100) },
            })),
          }
        : {}),
    });
    if (result.outcome !== "finalized") throw new Error("Synthetic fixture failed");
    sessions.push({ heavy, id: result.session.id });
    if (heavy) {
      for (let i = 0; i < 30; i++)
        store.attachEvidence({
          sessionId: result.session.id,
          kind: "test",
          reference: `synthetic:${i}`,
          summary: "Synthetic evidence ".repeat(150),
        });
      for (let i = 0; i < 10; i++)
        store.recordKnowledge({
          projectRoot: root,
          sessionId: result.session.id,
          idempotencyKey: `cost-knowledge-${i}`,
          kind: "gotcha",
          title: `Synthetic gotcha ${i}`,
          body: "Synthetic Knowledge detail ".repeat(100),
          appliesTo: ["src/example.ts"],
        });
      store.attachDiagram({
        sessionId: result.session.id,
        idempotencyKey: "cost-native",
        title: "Synthetic native diagram",
        kind: "architecture",
        formatVersion: 1,
        source: JSON.stringify({ version: 1, nodes: [{ id: "entry", label: "Entry" }], edges: [] }),
      });
    }
  }
  const server = createWorkIntelligenceMcpServer(store, "test-cost", LATEST_SCHEMA_VERSION);
  const client = new Client({ name: "synthetic-cost-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const wire = [];
  let captureWire = true;
  for (const [direction, transport] of [
    ["request", clientTransport],
    ["response", serverTransport],
  ]) {
    const send = transport.send.bind(transport);
    transport.send = (message, ...args) => {
      if (captureWire) wire.push({ direction, message });
      return send(message, ...args);
    };
  }
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const resourceInput = { uri: "work-intelligence://agent/tool-contracts/work_get_session" };
  const contract = await client.readResource(resourceInput);
  const tools = await client.listTools();
  const index = await client.readResource({ uri: "work-intelligence://agent/tool-contracts" });
  const skill = await client.readResource({ uri: "work-intelligence://agent/work-intelligence/SKILL.md" });
  const startup = { instructions: client.getInstructions(), tools, index, skill };
  const startupWire = wire.splice(0);
  captureWire = false;

  for (const fixture of sessions) {
    for (const task of ["completion", "handoff", "changed-files"]) {
      const calls = [
        {
          sessionId: fixture.id,
          ...(projected
            ? task === "changed-files"
              ? { select: ["session.changedFiles", "evidence"] }
              : { view: task }
            : {}),
        },
      ];
      // Handoff requires file evidence too: count the extra read rather than hiding it.
      if (projected && task === "handoff")
        calls.push({ sessionId: fixture.id, select: ["session.changedFiles", "evidence"] });
      for (let warmup = 0; warmup < 3; warmup++) {
        for (const args of calls)
          await client.callTool({ name: "work_read", arguments: { operation: "work_get_session", arguments: args } });
      }
      const samples = [],
        sqlCounts = [],
        inputs = [],
        results = [];
      const prepare = store.db.prepare.bind(store.db);
      for (let n = 0; n < count; n++) {
        captureWire = n === 0;
        let sqlCount = 0;
        store.db.prepare = (...args) => {
          sqlCount++;
          return prepare(...args);
        };
        const start = performance.now();
        const result = [];
        const input = [];
        for (const args of calls) {
          const wireInput = { name: "work_read", arguments: { operation: "work_get_session", arguments: args } };
          input.push(wireInput);
          result.push(await client.callTool(wireInput));
        }
        samples.push(performance.now() - start);
        sqlCounts.push(sqlCount);
        store.db.prepare = prepare;
        if (n === 0) {
          inputs.push(...input);
          results.push(...result);
        }
      }
      captureWire = false;
      const callWire = wire.splice(0);
      const texts = results.flatMap((r) => r.content.filter((c) => c.type === "text").map((c) => c.text));
      const modelText =
        JSON.stringify(startup) +
        JSON.stringify(resourceInput) +
        JSON.stringify(contract) +
        JSON.stringify(inputs) +
        texts.join("");
      let tokenCount = null;
      if (process.env.WI_PROJECTION_TOKENIZER_PYTHON) {
        const tokenized = spawnSync(
          process.env.WI_PROJECTION_TOKENIZER_PYTHON,
          ["scripts/measure-reference-tokens.py"],
          {
            input: JSON.stringify({
              text: modelText,
              envelope: JSON.stringify({ startup, contractInput: resourceInput, contract, inputs, results }),
            }),
            encoding: "utf8",
          },
        );
        if (tokenized.status !== 0) throw new Error("Reference tokenizer failed; no token claim will be recorded.");
        tokenCount = JSON.parse(tokenized.stdout);
      }
      rows.push({
        fixture: fixture.heavy ? "heavy" : "small",
        task,
        toolCalls: calls.length,
        latencyMs: summarize(samples),
        sqlPreparations: summarize(sqlCounts),
        textUtf16: texts.reduce((s, t) => s + t.length, 0),
        textUtf8: texts.reduce((s, t) => s + Buffer.byteLength(t), 0),
        resultEnvelopeUtf8: textBytes(results),
        taskEnvelopeUtf8: textBytes({ startup, contractInput: resourceInput, contract, inputs, results }),
        jsonRpcFramesUtf8: [...startupWire, ...callWire].reduce((sum, frame) => sum + textBytes(frame.message) + 1, 0),
        firstContractAndStartupUtf8: textBytes({ startup, resourceInput, contract }),
        resourceReads: 3,
        instructionMode:
          "independent task includes initialize instructions, tools/list, operation index, full skill and operation contract once",
        modelTextUtf8: Buffer.byteLength(modelText),
        structuredContentUtf8: results.reduce((s, r) => s + textBytes(r.structuredContent ?? null), 0),
        tokenCount,
      });
    }
  }
  await client.close();
  await server.close();
  const output = {
    version: 1,
    mode: projected ? "projected" : "full",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    repeats: count,
    warmupPerWorkflow: 3,
    fixture: "fictional small/heavy Sessions; never private data",
    tokenizer: process.env.WI_PROJECTION_TOKENIZER_PYTHON
      ? "tiktoken 0.12.0 / o200k_base reference encoding; not an actual Codex billing measurement"
      : "not measured; UTF-8/envelope sizes are not tokens",
    clientInjection: "SDK in-memory response; actual Codex model injection is not observable here",
    maxRssKiB: process.resourceUsage().maxRSS,
    rows,
  };
  if (process.env.WI_PROJECTION_OUTPUT)
    writeFileSync(process.env.WI_PROJECTION_OUTPUT, JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify(output, null, 2));
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
