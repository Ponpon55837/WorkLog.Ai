import type {
  AgentCardView,
  AgentsActionResult,
  AgentsPreview,
  AgentsState,
  RepairApi,
} from "@work-intelligence/desktop-core";
import { formatMessage } from "@work-intelligence/desktop-core/shell/i18n";
import { setupMessages, type SetupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { button, element, fact, focusedId, restoreFocus, section, setLanguage } from "./dom.js";

/**
 * The Agent page. Nothing is written by looking at it: "預覽變更" (or "改由桌面 App 管理…") computes a plan and shows its
 * diff; only "套用變更" writes, and only that very plan. "復原上次變更" undoes the last apply.
 */

const REFRESH_MS = 5000;

function resultText(state: AgentsState, text: SetupMessages): string | undefined {
  const { result } = state;
  if (!result) return undefined;
  if (result.kind === "applied") return formatMessage(text.agentsApplied, { count: String(result.changed) });
  if (result.kind === "undone") return text.agentsUndone;
  if (result.kind === "nothing-to-undo") return text.agentsNothingToUndo;
  if (result.manualRepairDisplay) return formatMessage(text.agentsManualRepair, { path: result.manualRepairDisplay });
  return formatMessage(text.agentsFailed, { code: result.code });
}

function selfTestText(state: AgentsState, text: SetupMessages): string {
  const { selfTest } = state;
  if (selfTest.outcome === "ok") return formatMessage(text.agentsSelfTestOk, { ms: String(selfTest.elapsedMs ?? 0) });
  if (selfTest.outcome === "failed") return formatMessage(text.agentsSelfTestFailed, { code: selfTest.code ?? "?" });
  return text.agentsSelfTestNotRun;
}

function agentCard(card: AgentCardView, text: SetupMessages): HTMLElement {
  const facts = element("dl", { className: "facts" });
  facts.append(
    ...fact(text.agentsMcp, text.agentOwners[card.mcp]),
    ...fact(text.agentsHooks, text.agentOwners[card.hooks]),
  );
  if (card.checkoutDisplay) {
    facts.append(...fact(text.agentsCheckout, element("span", { className: "path", text: card.checkoutDisplay })));
  }
  const node = element("section", { className: "card agent" }, [
    element("h2", {}, [
      text.agentNames[card.id],
      " ",
      element("span", { className: "badge", text: text.agentStates[card.state] }),
    ]),
    facts,
  ]);
  node.dataset.agent = card.id;
  if (card.checkoutMissing) node.append(element("p", { className: "hint", text: text.agentsCheckoutMissing }));
  if (card.adoptable) node.append(element("p", { className: "hint", text: text.agentsAdoptHint }));
  if (card.notAdoptableReason) {
    node.append(element("p", { className: "hint", text: `${text.agentsNotAdoptable}${card.notAdoptableReason}` }));
  }
  return node;
}

function previewBlock(
  preview: AgentsPreview,
  text: SetupMessages,
  busy: boolean,
  apply: () => void,
  discard: () => void,
) {
  const content: Node[] = [];
  if (preview.files.length === 0 && preview.conflicts.length === 0) {
    content.push(element("p", { className: "hint", text: text.agentsNoChanges }));
  }
  if (preview.conflicts.length > 0) {
    content.push(
      element("div", { className: "error" }, [
        element("strong", { text: text.agentsConflicts }),
        element(
          "ul",
          { className: "list" },
          preview.conflicts.map((line) => element("li", { text: line })),
        ),
      ]),
    );
  }
  for (const file of preview.files) {
    const lines = element("pre", { className: "diff" });
    for (const hunk of file.hunks) {
      lines.append(element("span", { className: "diff-hunk", text: `@@ -${hunk.oldStart} +${hunk.newStart} @@\n` }));
      for (const line of hunk.lines) {
        const sign = line.type === "add" ? "+" : line.type === "remove" ? "-" : line.type === "note" ? "!" : " ";
        lines.append(element("span", { className: `diff-${line.type}`, text: `${sign} ${line.text}\n` }));
      }
    }
    content.push(
      element("details", { className: "file", ...{} }, [
        element("summary", {}, [
          element("span", { className: "badge", text: text.agentsChange[file.change] }),
          " ",
          element("span", { className: "path", text: file.display }),
          " ",
          element("span", { className: "hint", text: file.label }),
        ]),
        file.tooLarge ? element("p", { className: "hint", text: "…" }) : lines,
      ]),
    );
  }
  const canApply = !busy && preview.conflicts.length === 0 && preview.files.length > 0;
  content.push(
    element("div", { className: "actions" }, [
      button(text.agentsApply, "apply", canApply, apply, true),
      button(text.agentsDiscard, "discard", !busy, discard),
    ]),
  );
  const block = section(text.agentsPreviewHeading, ...content);
  block.id = "agents-preview";
  // The first file opens by itself, so the user sees what changes without a click.
  block.querySelector("details")?.setAttribute("open", "");
  return block;
}

export function mountAgents(app: HTMLElement, say: (text: string) => void, api: RepairApi): void {
  let current: AgentsState | undefined;
  let working = false;

  async function act(task: () => Promise<AgentsActionResult>): Promise<void> {
    if (!current || working) return;
    const text = setupMessages(current.locale);
    working = true;
    say(text.agentsBusy);
    render(current);
    try {
      const result = await task();
      if (result.state) current = result.state;
      say(result.ok ? (resultText(current, text) ?? "") : (resultText(current, text) ?? text.setupFailed));
    } catch {
      say(text.setupFailed);
    } finally {
      working = false;
      await refresh();
    }
  }

  function render(state: AgentsState): void {
    const text = setupMessages(state.locale);
    const focus = focusedId();
    setLanguage(state.locale, text.agentsWindowTitle);
    const busy = state.busy || working;
    const blocks: Node[] = [
      element("h1", { text: text.agentsHeading }),
      element("p", { className: "intro", text: text.agentsIntro }),
    ];
    if (!state.launcherReady) blocks.push(element("p", { className: "hint", text: text.agentsLauncherNotReady }));
    blocks.push(...state.cards.map((card) => agentCard(card, text)));
    const outcome = resultText(state, text);
    if (outcome) blocks.push(element("p", { className: "result", text: outcome }));
    if (state.preview) {
      blocks.push(
        previewBlock(
          state.preview,
          text,
          busy,
          () => {
            const id = state.preview?.id;
            if (id) void act(() => api.agentsApply(id));
          },
          () => void act(() => api.agentsDiscard()),
        ),
      );
    }
    const adoptable = state.cards.some((card) => card.adoptable);
    blocks.push(
      section(
        text.agentsSelfTest,
        element("p", { className: "hint", text: selfTestText(state, text) }),
        element("div", { className: "actions" }, [
          button(
            text.agentsPreview,
            "preview",
            !busy && state.launcherReady,
            () => void act(() => api.agentsPreview(false)),
            !adoptable,
          ),
          ...(adoptable
            ? [
                button(
                  text.agentsPreviewAdopt,
                  "preview-adopt",
                  !busy && state.launcherReady,
                  () => void act(() => api.agentsPreview(true)),
                  true,
                ),
              ]
            : []),
          button(
            text.agentsSelfTest,
            "self-test",
            !busy && state.launcherReady,
            () => void act(() => api.agentsSelfTest()),
          ),
          button(text.agentsUndo, "undo", !busy && state.undoAvailable, () => void act(() => api.agentsUndo())),
        ]),
      ),
    );
    app.replaceChildren(...blocks);
    app.setAttribute("aria-busy", busy ? "true" : "false");
    restoreFocus(app, focus);
  }

  async function refresh(): Promise<void> {
    try {
      current = await api.agentsGetState();
      if (!working) render(current);
    } catch {
      say("…");
    }
  }

  void refresh();
  setInterval(() => {
    // A preview stays as it was shown; re-reading while it is open would not change the plan, only the cards.
    if (!working) void refresh();
  }, REFRESH_MS);
}
