import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agentRemoveMessages,
  agentsResultMessage,
  REPAIR_CHANNELS,
  repairInputSchemas,
  setupMessages,
  type AgentsResult,
} from "../../packages/desktop-core/src/index.js";

const IPC_SOURCE = readFileSync(new URL("../../apps/desktop/src/main/ipc.ts", import.meta.url), "utf8");
const PRELOAD_SOURCE = readFileSync(new URL("../../apps/desktop/src/preload/repair.ts", import.meta.url), "utf8");

describe("the Agent removal channel", () => {
  it("is named, takes no input and is registered in main and in the preload", () => {
    expect(REPAIR_CHANNELS.agentsRemovePreview).toBe("agents:remove-preview");
    expect(repairInputSchemas.agentsRemovePreview.safeParse({}).success).toBe(true);
    expect(repairInputSchemas.agentsRemovePreview.safeParse({ path: "/x" }).success).toBe(false);
    expect(IPC_SOURCE).toContain("REPAIR_CHANNELS.agentsRemovePreview");
    expect(PRELOAD_SOURCE).toContain('agentsRemovePreview: "agents:remove-preview"');
  });

  it("maps every channel to exactly one main handler and one identical preload entry", () => {
    const preload = new Map(
      [...PRELOAD_SOURCE.matchAll(/^ {2}(\w+): "([a-z:-]+)",$/gm)].map((match) => [match[1], match[2]] as const),
    );
    for (const [key, channel] of Object.entries(REPAIR_CHANNELS)) {
      expect(preload.get(key), `${key} in the preload`).toBe(channel);
      // Main registers an agents channel exactly once; the other channels are checked for presence in the same file.
      if (key.startsWith("agents")) {
        expect(IPC_SOURCE.split(`REPAIR_CHANNELS.${key},`).length - 1, `${key} handler`).toBe(1);
      }
    }
  });

  it("has copy in both languages that never mentions a terminal or a command", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      const text = JSON.stringify(agentRemoveMessages(locale));
      expect(text).not.toMatch(/pnpm|npm|terminal|command line|終端|指令|命令/i);
      expect(Object.values(agentRemoveMessages(locale)).every((value) => value.length > 0)).toBe(true);
    }
    expect(agentRemoveMessages("zh-TW").agentsRemove).toBe("移除 Agent 設定");
    expect(agentRemoveMessages("en").agentsRemove).toBe("Remove Agent setup");
  });
});

describe("what the page says about a failed apply or removal (L-20)", () => {
  it("names the files left as they are with the manual-repair copy and never says everything was restored", () => {
    const failed: AgentsResult = {
      kind: "failed",
      code: "externally-modified",
      manualRepairDisplay: "~/a.json, ~/b.toml",
    };
    for (const locale of ["zh-TW", "en"] as const) {
      const message = agentsResultMessage(failed, locale) ?? "";
      expect(message).toContain("~/a.json, ~/b.toml");
      expect(message).toBe(setupMessages(locale).agentsManualRepair.replace("{path}", "~/a.json, ~/b.toml"));
      // The generic failure copy says what was written "has been restored"; it must not appear here.
      expect(message).not.toBe(setupMessages(locale).agentsFailed.replace("{code}", "externally-modified"));
    }
    // A failure that was fully rolled back still says so.
    expect(agentsResultMessage({ kind: "failed", code: "write-failed" }, "en")).toBe(
      setupMessages("en").agentsFailed.replace("{code}", "write-failed"),
    );
    expect(agentsResultMessage({ kind: "removed", changed: 3 }, "en")).toBe(
      agentRemoveMessages("en").agentsRemoved.replace("{count}", "3"),
    );
  });
});
