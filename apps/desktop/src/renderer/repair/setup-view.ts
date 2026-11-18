import type { RepairApi, SetupActionResult, SetupSourceView, SetupState } from "@work-intelligence/desktop-core";
import { errorMessageFor, formatMessage, shellMessages } from "@work-intelligence/desktop-core/shell/i18n";
import { setupMessages, type SetupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { databaseTone, label } from "./badge.js";
import { actions, button, byId, checkbox, element, facts, hint, isChecked, path, section, setLanguage } from "./dom.js";
import { captureFocus, restoreSnapshot } from "./focus.js";
import { legacyBlock } from "./legacy-block.js";
import { legacyDisableControls, legacyDisableOutcome, type LegacyDisableHost } from "./legacy-disable-view.js";
import { createSetupMemory } from "./setup-memory.js";
import { storageRiskNote } from "./storage-risk-card.js";

/**
 * The first-run page (DT-01). "使用預設設定開始" is on the first screen from the first paint, but disabled (with a short
 * hint) until the detection ends: a new database is never created before the user could see what was found. Everything
 * else (an existing database, another file, the advanced facts) is optional. The page sends only opaque ids and booleans.
 */

const FAST_REFRESH_MS = 400;
const REFRESH_MS = 4000;
const LOGIN_ID = "launch-at-login";

type Retry = (startAnyway: boolean) => Promise<SetupActionResult>;

export function mountSetup(
  app: HTMLElement,
  say: (text: string) => void,
  api: RepairApi,
): { refresh(): void; unmount(): void } {
  let current: SetupState | undefined;
  let working = false;
  /** The last start was held back by the old login service: "仍要啟動" repeats it with consent. */
  let heldBack: Retry | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Each read bumps it; only the newest one schedules the next poll, so the polls never double up. */
  let generation = 0;
  /** The first run is over and the page took this view out for good: nothing is read or scheduled any more. */
  let disposed = false;
  const memory = createSetupMemory();

  function launchAtLogin(): boolean {
    return isChecked(app, LOGIN_ID);
  }

  async function act(task: () => Promise<SetupActionResult>, retry?: Retry): Promise<void> {
    if (!current || working) return;
    const text = setupMessages(current.locale);
    working = true;
    say(text.setupStarting);
    render(current);
    try {
      const result = await task();
      if (result.ok) {
        heldBack = undefined;
        current = result.state;
        say("");
      } else if (result.reason === "legacy-service") {
        heldBack = retry;
        if (result.state) current = result.state;
        say(text.legacyBlocked);
      } else if (result.reason === "cancelled") {
        say("");
      } else {
        if (result.state) current = result.state;
        say(
          result.message ??
            (result.errorCode
              ? errorMessageFor(shellMessages(current.locale), result.errorCode).title
              : text.setupFailed),
        );
      }
    } catch {
      say(text.setupFailed);
    } finally {
      working = false;
      await refresh();
    }
  }

  function useDefaults(): void {
    const login = launchAtLogin();
    const run: Retry = (startAnyway) => api.setupUseDefaults(login, startAnyway);
    void act(() => run(false), run);
  }

  function useSource(source: SetupSourceView): void {
    const login = launchAtLogin();
    const allowMigration = source.needsMigration ? isChecked(app, `migrate:${source.id}`) : undefined;
    const acknowledgeStorageRisk = source.storageRisk?.consent ? isChecked(app, `risk:${source.id}`) : undefined;
    const run: Retry = (startAnyway) =>
      api.setupUseSource({
        sourceId: source.id,
        launchAtLogin: login,
        ...(allowMigration === undefined ? {} : { allowMigration }),
        ...(acknowledgeStorageRisk === undefined ? {} : { acknowledgeStorageRisk }),
        ...(startAnyway ? { startAnyway } : {}),
      });
    void act(() => run(false), run);
  }

  function startAnyway(text: SetupMessages): void {
    const retry = heldBack;
    if (!retry || !window.confirm(text.legacyStartAnywayConfirm)) return;
    void act(() => retry(true), retry);
  }

  function copyToLocal(source: SetupSourceView): void {
    const login = launchAtLogin();
    void act(() => api.setupCopyToLocal(source.id, login));
  }

  function sourceCard(
    state: SetupState,
    source: SetupSourceView,
    text: SetupMessages,
    recommended: boolean,
  ): HTMLElement {
    const shell = shellMessages(state.locale);
    const rows: [string, Node | string][] = [
      [text.setupDatabase, path(source.display)],
      [text.setupFoundBy, source.kinds.map((kind) => text.sourceKinds[kind]).join("、")],
      [
        shell.databaseStatusLabel,
        label(
          source.errorCode ? errorMessageFor(shell, source.errorCode).title : text.sourceStatus[source.status],
          source.errorCode ? "danger" : databaseTone(source.status),
        ),
      ],
    ];
    if (source.projectCount !== undefined) {
      const names = source.projectNames.length > 0 ? `：${source.projectNames.join("、")}` : "";
      rows.push([
        shell.repairProjectCountLabel,
        `${formatMessage(text.setupProjectCount, { count: String(source.projectCount) })}${names}`,
      ]);
    }
    const card = element("div", { className: recommended ? "source recommended" : "source" }, [facts(...rows)]);
    card.dataset.source = source.id;
    if (source.storageRisk) card.append(storageRiskNote(source.storageRisk));
    const busy = state.busy || working;
    // The way out of a source the storage forbids; it is there even when "use" is not (the note points at it).
    if (source.storageRisk?.canCopyToLocal) {
      card.append(
        actions(button(text.storageCopyToLocal, `copy-to-local:${source.id}`, !busy, () => copyToLocal(source))),
      );
    }
    if (!source.canUse) return card;
    if (source.needsMigration) {
      card.append(checkbox(text.setupMigrationConsent, `migrate:${source.id}`, memory.consent(source.id), !busy));
    }
    const riskConsent = source.storageRisk?.consent;
    if (riskConsent) {
      card.append(checkbox(riskConsent, `risk:${source.id}`, memory.consent(`risk:${source.id}`), !busy));
    }
    const useLabel = recommended ? text.setupKeepThisData : text.setupUseThis;
    const use = button(useLabel, `use:${source.id}`, !busy, () => useSource(source), recommended);
    card.append(actions(use));
    // The button only works once the user agreed to every consent it needs: the schema update and the risky storage.
    const boxes = [
      ...(source.needsMigration ? [`migrate:${source.id}`] : []),
      ...(riskConsent ? [`risk:${source.id}`] : []),
    ].map((id) => ({ id, box: byId<HTMLInputElement>(card, id) }));
    const allTicked = (): boolean => boxes.every(({ box }) => box?.checked === true);
    use.disabled = busy || !allTicked();
    for (const { id, box } of boxes) {
      box?.addEventListener("change", () => {
        memory.setConsent(id === `migrate:${source.id}` ? source.id : id, box.checked);
        use.disabled = busy || !allTicked();
      });
    }
    return card;
  }

  function disableHost(text: SetupMessages): LegacyDisableHost {
    return {
      api,
      text,
      rerender: () => {
        if (current) render(current);
      },
      refresh: () => void refresh(),
    };
  }

  function render(state: SetupState): void {
    const text = setupMessages(state.locale);
    const focus = captureFocus(app);
    setLanguage(state.locale);
    const busy = state.busy || working;
    const login = byId(app, LOGIN_ID) ? launchAtLogin() : state.defaults.launchAtLogin;
    const blocks: Node[] = [];
    memory.keepConsentFor(state.sources.flatMap((source) => [source.id, `risk:${source.id}`]));

    if (state.phase === "done") {
      blocks.push(
        section(
          text.setupHeading,
          element("p", { className: "intro", text: text.setupDone }),
          hint(text.setupNextAgents),
          actions(
            button(text.setupOpenAgents, "open-agents", true, () => void api.showAgents(), true),
            button(text.setupClose, "close", true, () => void api.setupLater()),
          ),
        ),
      );
      app.replaceChildren(...blocks);
      app.setAttribute("aria-busy", "false");
      restoreSnapshot(app, focus);
      return;
    }

    const intro =
      state.phase === "detecting"
        ? text.setupDetecting
        : state.screen === "new"
          ? text.setupNewIntro
          : state.screen === "existing"
            ? text.setupExistingIntro
            : state.reason === "conflict"
              ? text.setupChooseConflict
              : state.reason === "blocked"
                ? text.setupChooseBlocked
                : text.setupChooseIntro;
    blocks.push(element("p", { className: "intro", text: intro }));

    if (state.errorCode) {
      const message = errorMessageFor(shellMessages(state.locale), state.errorCode);
      const failed = section(text.setupFailed, element("strong", { text: message.title }), hint(message.hint));
      failed.classList.add("card--danger");
      blocks.push(failed);
    }

    if (state.pathProblem) blocks.push(hint(state.pathProblem));

    const conflictShown = state.defaults.legacyConflict || state.sources.some((source) => source.legacyConflict);
    if (state.legacy && (conflictShown || heldBack)) {
      const extra: Node[] = heldBack
        ? [actions(button(text.legacyStartAnyway, "start-anyway", !busy, () => startAnyway(text)))]
        : [];
      extra.push(...legacyDisableControls(disableHost(text), state.legacy.canDisable, !busy));
      blocks.push(legacyBlock(api, text, { ...state.legacy, blocked: heldBack !== undefined }, extra));
    } else if (!state.legacy) {
      const outcome = legacyDisableOutcome(disableHost(text));
      if (outcome) blocks.push(outcome);
    }

    const recommended = state.sources.find((source) => source.id === state.recommendedId);
    if (state.phase !== "detecting" && recommended && state.screen === "existing") {
      blocks.push(sourceCard(state, recommended, text, true));
    }
    if (state.phase !== "detecting" && state.screen === "choose") {
      const list = element("div", { className: "sources" });
      for (const source of state.sources) list.append(sourceCard(state, source, text, false));
      blocks.push(list);
    }

    // The defaults are one click from the first paint; on the "existing" screen they are the second choice.
    const primaryDefaults = state.screen === "new" || state.phase === "detecting";
    const defaults = button(
      text.setupUseDefaults,
      "use-defaults",
      !busy && state.canUseDefaults,
      useDefaults,
      primaryDefaults,
    );
    const advanced = element("details", { className: "advanced" }, [
      element("summary", { text: text.setupAdvanced }),
      facts(
        [text.setupDatabase, path(state.defaults.databaseDisplay)],
        [text.setupUrl, state.defaults.url],
        [text.setupBackups, path(state.defaults.backupDisplay)],
      ),
    ]);
    advanced.open = memory.advancedOpen();
    advanced.addEventListener("toggle", () => memory.setAdvancedOpen(advanced.open));
    blocks.push(
      actions(
        defaults,
        button(text.setupUseExisting, "browse", !busy, () => void act(() => api.setupChooseFile())),
        button(text.setupLater, "later", !busy, () => void api.setupLater()),
      ),
      checkbox(text.setupLaunchAtLogin, LOGIN_ID, login, !busy),
      advanced,
    );
    if (!state.canUseDefaults) blocks.push(hint(text.setupDetectingHint));
    if (state.phase === "starting") blocks.push(hint(text.setupStarting));

    app.replaceChildren(...blocks);
    app.setAttribute("aria-busy", state.phase === "ready" ? "false" : "true");
    restoreSnapshot(app, focus);
  }

  async function refresh(): Promise<void> {
    if (timer) clearTimeout(timer);
    if (disposed) return;
    const mine = (generation += 1);
    // Another tab is open: this view is out of the page (its state stays here) and only waits to be shown again.
    if (!app.isConnected) {
      timer = setTimeout(() => void refresh(), REFRESH_MS);
      return;
    }
    try {
      const next = await api.setupGetState();
      if (disposed) return;
      current = next;
      if (!working) render(current);
    } catch {
      if (!disposed) say("…");
    }
    if (mine !== generation) return;
    const fast = !current || current.phase === "detecting" || current.phase === "starting";
    timer = setTimeout(() => void refresh(), fast ? FAST_REFRESH_MS : REFRESH_MS);
  }

  void refresh();
  return {
    refresh: () => void refresh(),
    unmount: () => {
      disposed = true;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
