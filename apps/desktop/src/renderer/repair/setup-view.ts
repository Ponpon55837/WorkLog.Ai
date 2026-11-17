import type { RepairApi, SetupActionResult, SetupSourceView, SetupState } from "@work-intelligence/desktop-core";
import { errorMessageFor, formatMessage, shellMessages } from "@work-intelligence/desktop-core/shell/i18n";
import { setupMessages, type SetupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { button, checkbox, element, fact, focusedId, isChecked, restoreFocus, section, setLanguage } from "./dom.js";
import { legacyBlock } from "./legacy-block.js";

/**
 * The first-run page (DT-01). "使用預設設定開始" is on the first screen from the first paint, also while the detection
 * still runs; everything else (an existing database, another file, the advanced facts) is optional. The page sends
 * only opaque ids and booleans.
 */

const FAST_REFRESH_MS = 400;
const REFRESH_MS = 4000;
const LOGIN_ID = "launch-at-login";

type Retry = (startAnyway: boolean) => Promise<SetupActionResult>;

export function mountSetup(app: HTMLElement, say: (text: string) => void, api: RepairApi): void {
  let current: SetupState | undefined;
  let working = false;
  /** The last start was held back by the old login service: "仍要啟動" repeats it with consent. */
  let heldBack: Retry | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

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
          result.errorCode ? errorMessageFor(shellMessages(current.locale), result.errorCode).title : text.setupFailed,
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
    const run: Retry = (startAnyway) =>
      api.setupUseSource({
        sourceId: source.id,
        launchAtLogin: login,
        ...(allowMigration === undefined ? {} : { allowMigration }),
        ...(startAnyway ? { startAnyway } : {}),
      });
    void act(() => run(false), run);
  }

  function startAnyway(text: SetupMessages): void {
    const retry = heldBack;
    if (!retry || !window.confirm(text.legacyStartAnywayConfirm)) return;
    void act(() => retry(true), retry);
  }

  function sourceCard(
    state: SetupState,
    source: SetupSourceView,
    text: SetupMessages,
    recommended: boolean,
  ): HTMLElement {
    const shell = shellMessages(state.locale);
    const facts = element("dl", { className: "facts" });
    facts.append(
      ...fact(text.setupDatabase, element("span", { className: "path", text: source.display })),
      ...fact(text.setupFoundBy, source.kinds.map((kind) => text.sourceKinds[kind]).join("、")),
      ...fact(
        shell.databaseStatusLabel,
        source.errorCode ? errorMessageFor(shell, source.errorCode).title : text.sourceStatus[source.status],
      ),
    );
    if (source.projectCount !== undefined) {
      const names = source.projectNames.length > 0 ? `：${source.projectNames.join("、")}` : "";
      facts.append(
        ...fact(
          shell.repairProjectCountLabel,
          `${formatMessage(text.setupProjectCount, { count: String(source.projectCount) })}${names}`,
        ),
      );
    }
    const card = element("div", { className: recommended ? "source recommended" : "source" }, [facts]);
    card.dataset.source = source.id;
    if (!source.canUse) return card;
    const busy = state.busy || working;
    if (source.needsMigration) {
      card.append(checkbox(text.setupMigrationConsent, `migrate:${source.id}`, false, !busy));
    }
    const label = recommended ? text.setupKeepThisData : text.setupUseThis;
    const use = button(label, `use:${source.id}`, !busy, () => useSource(source), recommended);
    card.append(element("div", { className: "actions" }, [use]));
    if (source.needsMigration) {
      // The button only works once the user agreed to the schema update.
      const box = card.querySelector<HTMLInputElement>(`input[data-id="migrate:${CSS.escape(source.id)}"]`);
      use.disabled = busy || !box?.checked;
      box?.addEventListener("change", () => {
        use.disabled = busy || !box.checked;
      });
    }
    return card;
  }

  function render(state: SetupState): void {
    const text = setupMessages(state.locale);
    const focus = focusedId();
    setLanguage(state.locale, text.setupWindowTitle);
    const busy = state.busy || working;
    const login = app.querySelector(`input[data-id="${LOGIN_ID}"]`) ? launchAtLogin() : state.defaults.launchAtLogin;
    const blocks: Node[] = [element("h1", { text: text.setupHeading })];

    if (state.phase === "done") {
      blocks.push(
        section(
          text.setupHeading,
          element("p", { className: "intro", text: text.setupDone }),
          element("p", { className: "hint", text: text.setupNextAgents }),
          element("div", { className: "actions" }, [
            button(text.setupOpenAgents, "open-agents", true, () => void api.showAgents(), true),
            button(text.setupClose, "close", true, () => void api.setupLater()),
          ]),
        ),
      );
      app.replaceChildren(...blocks);
      app.setAttribute("aria-busy", "false");
      restoreFocus(app, focus);
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
      blocks.push(
        element("section", { className: "card error" }, [
          element("h2", { text: text.setupFailed }),
          element("strong", { text: message.title }),
          element("p", { className: "hint", text: message.hint }),
        ]),
      );
    }

    const conflictShown = state.defaults.legacyConflict || state.sources.some((source) => source.legacyConflict);
    if (state.legacy && (conflictShown || heldBack)) {
      const extra = heldBack
        ? [
            element("div", { className: "actions" }, [
              button(text.legacyStartAnyway, "start-anyway", !busy, () => startAnyway(text)),
            ]),
          ]
        : [];
      blocks.push(legacyBlock(api, text, { ...state.legacy, blocked: heldBack !== undefined }, extra));
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
    const defaults = button(text.setupUseDefaults, "use-defaults", !busy, useDefaults, primaryDefaults);
    const advanced = element("details", { className: "advanced" }, [
      element("summary", { text: text.setupAdvanced }),
      element("dl", { className: "facts" }, [
        ...fact(text.setupDatabase, element("span", { className: "path", text: state.defaults.databaseDisplay })),
        ...fact(text.setupUrl, state.defaults.url),
        ...fact(text.setupBackups, element("span", { className: "path", text: state.defaults.backupDisplay })),
      ]),
    ]);
    blocks.push(
      element("div", { className: "actions" }, [
        defaults,
        button(text.setupUseExisting, "browse", !busy, () => void act(() => api.setupChooseFile())),
        button(text.setupLater, "later", !busy, () => void api.setupLater()),
      ]),
      checkbox(text.setupLaunchAtLogin, LOGIN_ID, login, !busy),
      advanced,
    );
    if (state.phase === "starting") blocks.push(element("p", { className: "hint", text: text.setupStarting }));

    app.replaceChildren(...blocks);
    app.setAttribute("aria-busy", state.phase === "ready" ? "false" : "true");
    restoreFocus(app, focus);
  }

  async function refresh(): Promise<void> {
    if (timer) clearTimeout(timer);
    try {
      current = await api.setupGetState();
      if (!working) render(current);
    } catch {
      say("…");
    }
    const fast = !current || current.phase === "detecting" || current.phase === "starting";
    timer = setTimeout(() => void refresh(), fast ? FAST_REFRESH_MS : REFRESH_MS);
  }

  void refresh();
}
