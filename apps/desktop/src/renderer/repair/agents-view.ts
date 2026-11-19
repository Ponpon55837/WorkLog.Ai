import type {
  AgentCardView,
  AgentsActionResult,
  AgentsPreview,
  AgentsState,
  RepairApi,
  SetupAgentId,
} from "@work-intelligence/desktop-core";
// The renderer bundle may only take values from browser-safe subpaths; the package root pulls in Node modules.
import { canApplyPreview, hasUndiffableFile, isFileOpen } from "@work-intelligence/desktop-core/shell/agents-state";
import { agentRemoveMessages, agentsResultMessage } from "@work-intelligence/desktop-core/shell/agent-remove-i18n";
import { formatMessage, shellMessages } from "@work-intelligence/desktop-core/shell/i18n";
import { setupMessages, type SetupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { label, type Tone } from "./badge.js";
import { captureFocus, restoreSnapshot } from "./focus.js";
import { actions, button, cardBody, checkbox, element, facts, hint, path, section, setLanguage } from "./dom.js";

/**
 * The Agent page. Nothing is written by looking at it: "預覽變更" (or "改由桌面 App 管理…") computes a plan and shows its
 * diff; only "套用變更" writes, and only that very plan. "移除 Agent 設定" is the same path with a removal plan: its
 * preview lists what would be taken out, and only "確認移除" writes. "復原上次變更" undoes the last apply or removal.
 */

const REFRESH_MS = 5000;

function resultText(state: AgentsState): string | undefined {
  return agentsResultMessage(state.result, state.locale);
}

function selfTestText(state: AgentsState, text: SetupMessages): string {
  const { selfTest } = state;
  if (selfTest.outcome === "ok") return formatMessage(text.agentsSelfTestOk, { ms: String(selfTest.elapsedMs ?? 0) });
  if (selfTest.outcome === "failed") return formatMessage(text.agentsSelfTestFailed, { code: selfTest.code ?? "?" });
  return text.agentsSelfTestNotRun;
}

function stateTone(state: AgentCardView["state"]): Tone {
  if (state === "observed-connected") return "success";
  if (state === "conflict" || state === "runtime-incompatible") return "danger";
  if (state === "not-configured" || state === "externally-managed") return "neutral";
  return "attention";
}

function hookText(card: AgentCardView, text: SetupMessages): string {
  if (card.hookState === undefined) return text.agentOwners[card.hooks];
  if (card.hookState === "installed") return text.agentHookInstalled[card.hookSource ?? "checkout"];
  return text.agentHookNotInstalled[card.hookState];
}

function agentCard(
  card: AgentCardView,
  text: SetupMessages,
  controls: {
    readonly busy: boolean;
    readonly selected: boolean;
    readonly select: (card: AgentCardView, selected: boolean) => void;
    readonly useDatabase: (card: AgentCardView) => void;
  },
): HTMLElement {
  const rows: [string, Node | string][] = [
    [text.agentsMcp, text.agentOwners[card.mcp]],
    [text.agentsHooks, hookText(card, text)],
  ];
  if (card.checkoutDisplay) rows.push([text.agentsCheckout, path(card.checkoutDisplay)]);
  const node = section(
    [text.agentNames[card.id], label(text.agentStates[card.state], stateTone(card.state))],
    facts(...rows),
  );
  node.classList.add("agent");
  node.dataset.agent = card.id;
  const body = cardBody(node);
  body.append(
    checkbox(text.agentsSelect, `select-${card.id}`, controls.selected, !controls.busy, (checked) =>
      controls.select(card, checked),
    ),
  );
  if (!card.detected) body.append(hint(text.agentsNotDetected));
  if (card.checkoutMissing) body.append(hint(text.agentsCheckoutMissing));
  if (card.adoptable) body.append(hint(text.agentsAdoptHint));
  if (card.adoptable && card.hookState === "installed" && card.hookSource === "checkout") {
    body.append(hint(text.agentsHookCheckoutNote));
  }
  if (card.duplicateOldHook) body.append(hint(text.agentsDuplicateOldHook));
  if (card.projectHooksNote) body.append(hint(text.agentsProjectHooksNote));
  if (card.pluginHooksDuplicate) body.append(hint(text.agentsPluginHooksDuplicate));
  if (card.notAdoptableReason) body.append(hint(`${text.agentsNotAdoptable}${card.notAdoptableReason}`));
  if (card.otherDatabase) {
    const message = card.otherDatabase.fromCheckoutDefault ? text.agentsOtherDatabaseDefault : text.agentsOtherDatabase;
    body.append(
      hint(formatMessage(message, { path: card.otherDatabase.display })),
      actions(
        button(
          text.agentsUseOtherDatabase,
          `use-database-${card.id}`,
          !controls.busy,
          () => controls.useDatabase(card),
          true,
        ),
      ),
      hint(text.agentsKeepCheckout),
    );
  }
  return node;
}

interface PreviewControls {
  readonly busy: boolean;
  /** Which files the user opened or closed, by path; a file not listed follows the default. */
  readonly chosen: Map<string, boolean>;
  readonly acknowledged: boolean;
  /** An Agent has a hand-written registration the App can take over, so a refused plain preview can point at that. */
  readonly adoptInstead: boolean;
  readonly acknowledge: (value: boolean) => void;
  readonly apply: () => void;
  readonly discard: () => void;
}

function previewBlock(
  preview: AgentsPreview,
  text: SetupMessages,
  locale: AgentsState["locale"],
  controls: PreviewControls,
) {
  const { busy, chosen, acknowledged } = controls;
  const shell = shellMessages(locale);
  const removal = agentRemoveMessages(locale);
  const removing = preview.mode === "uninstall";
  const content: Node[] = [];
  if (removing) content.push(hint(removal.agentsRemoveHint));
  if (preview.files.length === 0 && preview.conflicts.length === 0) {
    content.push(hint(removing ? removal.agentsRemoveNothing : text.agentsNoChanges));
  }
  if (preview.conflicts.length > 0) {
    if (controls.adoptInstead && !preview.adopt && !removing) content.push(hint(text.agentsAdoptInstead));
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
  for (const [index, file] of preview.files.entries()) {
    const lines = element("pre", { className: "diff" });
    for (const hunk of file.hunks) {
      lines.append(element("span", { className: "diff-hunk", text: `@@ -${hunk.oldStart} +${hunk.newStart} @@\n` }));
      for (const line of hunk.lines) {
        const sign = line.type === "add" ? "+" : line.type === "remove" ? "-" : line.type === "note" ? "!" : " ";
        lines.append(element("span", { className: `diff-${line.type}`, text: `${sign} ${line.text}\n` }));
      }
    }
    const details = element("details", { className: "file" }, [
      element("summary", {}, [
        label(text.agentsChange[file.change], file.change === "delete" ? "danger" : "neutral"),
        " ",
        path(file.display),
        " ",
        element("span", { className: "hint", text: file.label }),
      ]),
      file.tooLarge ? hint(shell.agentsTooLargeNote) : lines,
    ]);
    // The first file opens by itself; after that the user's choice stays through every refresh.
    details.open = isFileOpen(chosen, file.display, index);
    details.addEventListener("toggle", () => chosen.set(file.display, details.open));
    content.push(details);
  }
  if (hasUndiffableFile(preview)) {
    content.push(checkbox(shell.agentsAckUndiffable, "ack-undiffable", acknowledged, !busy, controls.acknowledge));
  }
  content.push(
    actions(
      button(
        removing ? removal.agentsRemoveApply : text.agentsApply,
        "apply",
        !busy && canApplyPreview(preview, acknowledged),
        controls.apply,
        true,
      ),
      button(text.agentsDiscard, "discard", !busy, controls.discard),
    ),
  );
  const block = section(removing ? removal.agentsRemovePreviewHeading : text.agentsPreviewHeading, ...content);
  block.id = "agents-preview";
  return block;
}

export function mountAgents(app: HTMLElement, say: (text: string) => void, api: RepairApi): { refresh(): void } {
  let current: AgentsState | undefined;
  let working = false;
  // What belongs to the preview on screen; a new preview starts clean.
  let previewId: string | undefined;
  let chosen = new Map<string, boolean>();
  let acknowledged = false;
  let drawn: string | undefined;
  // The Agents the next preview sets up; until the user chooses, the ones found on this computer (both when none is).
  let selection: Set<SetupAgentId> | undefined;

  function selectedAgents(state: AgentsState): SetupAgentId[] {
    selection ??= new Set(
      state.cards.some((card) => card.detected)
        ? state.cards.filter((card) => card.detected).map((card) => card.id)
        : state.cards.map((card) => card.id),
    );
    return state.cards.map((card) => card.id).filter((id) => selection?.has(id));
  }

  async function act(task: () => Promise<AgentsActionResult>): Promise<void> {
    if (!current || working) return;
    const text = setupMessages(current.locale);
    working = true;
    say(text.agentsBusy);
    render(current);
    try {
      const result = await task();
      if (result.state) current = result.state;
      say(result.ok ? (resultText(current) ?? "") : (resultText(current) ?? text.setupFailed));
    } catch {
      say(text.setupFailed);
    } finally {
      working = false;
      await refresh();
    }
  }

  function render(state: AgentsState): void {
    if (state.preview?.id !== previewId) {
      previewId = state.preview?.id;
      chosen = new Map();
      acknowledged = false;
    }
    // The page polls; the same state draws the same page, so leave it alone (an opened diff keeps its scroll).
    const chosenAgents = selectedAgents(state);
    const key = JSON.stringify([state, working, acknowledged, chosenAgents]);
    if (key === drawn) return;
    drawn = key;
    const text = setupMessages(state.locale);
    const focus = captureFocus(app);
    setLanguage(state.locale);
    const busy = state.busy || working;
    const blocks: Node[] = [element("p", { className: "intro", text: text.agentsIntro })];
    if (!state.launcherReady) blocks.push(hint(text.agentsLauncherNotReady));
    blocks.push(
      ...state.cards.map((card) =>
        agentCard(card, text, {
          busy,
          selected: chosenAgents.includes(card.id),
          select: (picked, value) => {
            if (value) selection?.add(picked.id);
            else selection?.delete(picked.id);
            render(state);
          },
          useDatabase: (chosen) => void act(() => api.agentsUseCheckoutDatabase(chosen.id)),
        }),
      ),
    );
    const outcome = resultText(state);
    if (outcome) blocks.push(element("p", { className: "result", text: outcome }));
    if (state.preview) {
      blocks.push(
        previewBlock(state.preview, text, state.locale, {
          busy,
          chosen,
          acknowledged,
          adoptInstead: state.cards.some((card) => card.adoptable),
          acknowledge: (value) => {
            acknowledged = value;
            render(state);
          },
          apply: () => {
            const id = state.preview?.id;
            if (id) void act(() => api.agentsApply(id, acknowledged));
          },
          discard: () => void act(() => api.agentsDiscard()),
        }),
      );
    }
    const adoptable = state.cards.some((card) => card.adoptable);
    blocks.push(
      section(
        text.agentsSelfTest,
        hint(selfTestText(state, text)),
        actions(
          button(
            text.agentsPreview,
            "preview",
            !busy && state.launcherReady && chosenAgents.length > 0,
            () => void act(() => api.agentsPreview(false, chosenAgents)),
            !adoptable,
          ),
          ...(adoptable
            ? [
                button(
                  text.agentsPreviewAdopt,
                  "preview-adopt",
                  !busy && state.launcherReady && chosenAgents.length > 0,
                  () => void act(() => api.agentsPreview(true, chosenAgents)),
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
          button(
            agentRemoveMessages(state.locale).agentsRemove,
            "remove",
            !busy,
            () => void act(() => api.agentsRemovePreview()),
          ),
          button(text.agentsUndo, "undo", !busy && state.undoAvailable, () => void act(() => api.agentsUndo())),
        ),
      ),
    );
    app.replaceChildren(...blocks);
    app.setAttribute("aria-busy", busy ? "true" : "false");
    restoreSnapshot(app, focus);
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
    // Another tab is open: this view is out of the page (its state stays here) and does not poll until it is back.
    if (!app.isConnected) return;
    // A preview stays as it was shown; re-reading while it is open would not change the plan, only the cards.
    if (!working) void refresh();
  }, REFRESH_MS);
  return {
    refresh: () => {
      if (!working) void refresh();
    },
  };
}
