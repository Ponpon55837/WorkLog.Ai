import type { AppTab, RepairApi, RepairState } from "@work-intelligence/desktop-core";
import { APP_TABS, isAppTab } from "@work-intelligence/desktop-core/shell/app-tabs";
import { shellMessages, type ShellLocale } from "@work-intelligence/desktop-core/shell/i18n";
import { createActions } from "./actions.js";
import type { ViewActions, ViewContext } from "./context.js";
import { createChangeTracker } from "./diff.js";
import { element, setLanguage } from "./dom.js";
import { captureFocus, forgetFocus, restoreSnapshot } from "./focus.js";
import { mountAgents } from "./agents-view.js";
import { buildPanel, drawsFromRepairState } from "./panels.js";
import { mountSetup } from "./setup-view.js";
import { createTabStrip, tabButtonId, tabPanelId, type TabStripModel } from "./tabs.js";
import { followSystemTheme, LIGHT_SCHEME_QUERY } from "./theme.js";
import { restoreNotesScroll, saveNotesScroll } from "./update-view.js";
import { panelInputs } from "./view-model.js";

declare global {
  interface Window {
    readonly workIntelligenceRepair: RepairApi;
  }
}

interface MountedView {
  readonly container: HTMLElement;
  readonly refresh: () => void;
  readonly unmount?: () => void;
}

const REFRESH_MS = 4000;

// Before anything is drawn, so the first paint has the right colours.
followSystemTheme(document.documentElement, window.matchMedia(LIGHT_SCHEME_QUERY));

const riskTicked = new Set<string>();
const changes = createChangeTracker();
const panels = new Map<AppTab, HTMLElement>();
const mounted = new Map<AppTab, MountedView>();
const scrolls = new Map<AppTab, number>();
const tabStrip = createTabStrip((tab) => selectTab(tab));

let api: RepairApi;
let app: HTMLElement;
let statusRegion: HTMLElement;
let current: RepairState | undefined;
let working = false;
let selected: AppTab = "status";
let shown = false;
let ready = false;
let pendingTab: AppTab | undefined;
let fixingTab = false;
let focusPending = false;
let setupFinished = false;
let fallbackTabs: readonly AppTab[] = APP_TABS.filter((tab) => tab !== "setup");

function setupInTabs(state: RepairState | undefined): boolean {
  return state?.shell.tabs.includes("setup") ?? false;
}

function say(text: string): void {
  statusRegion.textContent = text;
}

function currentLocale(): ShellLocale {
  return current?.locale ?? (navigator.language.startsWith("zh") ? "zh-TW" : "en");
}

function availableTabs(): readonly AppTab[] {
  return current?.shell.tabs ?? fallbackTabs;
}

function stripModel(): TabStripModel {
  const messages = shellMessages(currentLocale());
  const tabs = availableTabs();
  return {
    tabs,
    selected,
    badges:
      current?.shell.badges ??
      (Object.fromEntries(APP_TABS.map((tab) => [tab, { attention: false, busy: false }])) as TabStripModel["badges"]),
    labels: messages.tabLabels,
    listLabel: messages.tabListLabel,
    attentionLabel: messages.tabAttentionLabel,
    busyLabel: messages.tabBusyLabel,
  };
}

function panelOf(tab: AppTab): HTMLElement {
  const panel = panels.get(tab);
  if (!panel) throw new Error(`no panel for ${tab}`);
  return panel;
}

/** After the diagnostics dialog closed and its button was redrawn: back to that button, or else to the tab. */
function returnFocus(): void {
  const target = panelOf(selected).querySelector<HTMLElement>('[data-id="export-diagnostics"]');
  if (target) target.focus();
  else tabStrip.focusTab(selected);
}

const actions = createActions({
  get api() {
    return api;
  },
  current: () => current,
  isWorking: () => working,
  setWorking: (value) => {
    working = value;
  },
  say,
  rerender: () => renderPanel(true),
  refresh: () => refresh(),
  riskTicked,
  returnFocus,
});

function viewActions(): ViewActions {
  return {
    api,
    perform: (id) => void actions.perform(id),
    confirm: (id, migrate, consent) => void actions.confirm(id, migrate, consent),
    copyToLocal: (id) => void actions.copyToLocal(id),
    openTab: (tab) => {
      selectTab(tab);
      tabStrip.focusTab(tab);
    },
    openAgents: () => {
      setupFinished = false;
      viewActions().openTab("agent");
    },
    dismissFinished: () => {
      setupFinished = false;
      renderPanel(true);
    },
    acknowledgeRecovery: (id) => {
      void api.acknowledgeRecovery(id).then(() => refresh());
    },
    rerender: () => renderPanel(true),
    refresh: () => void refresh(),
  };
}

/** Draws the open panel from the last state: only when forced or when what it is drawn from changed. */
function renderPanel(force: boolean): void {
  const state = current;
  const tab = selected;
  if (!state || !shown || !drawsFromRepairState(tab)) return;
  const finished = setupFinished && tab === "status";
  const changed = changes.changed(tab, { inputs: panelInputs(tab, state), busy: working, finished });
  if (!force && !changed) return;
  const panel = panelOf(tab);
  const context: ViewContext = {
    state,
    messages: shellMessages(state.locale),
    busy: working,
    riskTicked,
    setupFinished: finished,
    focusPort: focusPending,
    act: viewActions(),
  };
  const focus = captureFocus(panel);
  const top = app.scrollTop;
  saveNotesScroll(panel);
  panel.replaceChildren(...buildPanel(tab, context));
  restoreNotesScroll(panel);
  app.scrollTop = top;
  restoreSnapshot(panel, focus);
  // The request for the port input was answered by this drawing: it is not asked again.
  if (tab === "settings" && state.port?.focus) focusPending = false;
  app.setAttribute("aria-busy", "false");
}

/** Puts a tab's panel in the page. The first-run and Agent views are created once and moved back in afterwards. */
function enterPanel(tab: AppTab): void {
  const panel = panelOf(tab);
  panel.hidden = false;
  if (drawsFromRepairState(tab)) {
    renderPanel(true);
  } else {
    const view = mounted.get(tab);
    if (view) {
      panel.replaceChildren(view.container);
      view.refresh();
    } else {
      const container = element("div", { className: "view-host" });
      panel.replaceChildren(container);
      if (tab === "setup") {
        const handle = mountSetup(container, say, api);
        mounted.set(tab, { container, refresh: handle.refresh, unmount: handle.unmount });
      } else {
        mounted.set(tab, { container, refresh: mountAgents(container, say, api).refresh });
      }
    }
    app.setAttribute("aria-busy", "false");
  }
  app.scrollTop = scrolls.get(tab) ?? 0;
}

/** Takes a tab's panel out of the page; the first-run and Agent views stay alive in `mounted`. */
function leavePanel(tab: AppTab): void {
  const panel = panelOf(tab);
  scrolls.set(tab, app.scrollTop);
  panel.hidden = true;
  panel.replaceChildren();
  changes.forget(tab);
}

function selectTab(tab: AppTab, remember = true): void {
  if (!isAppTab(tab) || !availableTabs().includes(tab)) return;
  if (shown && tab === selected) return;
  // Focus inside the panel that goes away, or on the tab strip, follows to the new tab; focus elsewhere is left alone.
  const active = document.activeElement;
  const carryFocus =
    shown &&
    active instanceof HTMLElement &&
    active !== document.body &&
    (panelOf(selected).contains(active) || tabStrip.element.contains(active));
  if (shown) {
    forgetFocus(panelOf(selected));
    leavePanel(selected);
  }
  selected = tab;
  shown = true;
  // What the page said about the last tab (a status line) is not about this one.
  say("");
  tabStrip.update(stripModel());
  enterPanel(tab);
  if (carryFocus) tabStrip.focusTab(tab);
  if (remember) void api.rememberTab(tab).catch(() => undefined);
}

/** The tab on screen is gone (the first run finished): main says which one to show now. */
async function chooseAnotherTab(): Promise<void> {
  if (fixingTab) return;
  fixingTab = true;
  const selection = await api.getTab().catch(() => undefined);
  fixingTab = false;
  const next = selection?.tab ?? availableTabs()[0];
  if (next && next !== selected) selectTab(next, false);
}

/** The Setup tab went away in this window (the settings were committed): its view is put away and Status carries on. */
function setupFinishedHere(): void {
  if (selected === "setup" && availableTabs().includes("status")) selectTab("status", false);
  setupFinished = true;
  mounted.get("setup")?.unmount?.();
  mounted.delete("setup");
}

/** The page language, the window title and the hidden page heading, in the state's language. */
function applyLocale(locale: ShellLocale): void {
  const { appName } = shellMessages(locale);
  setLanguage(locale);
  document.title = appName;
  const title = document.getElementById("app-title");
  if (title && title.textContent !== appName) title.textContent = appName;
}

function applyState(state: RepairState): void {
  const hadSetup = setupInTabs(current);
  current = state;
  applyLocale(state.locale);
  if (hadSetup && !setupInTabs(state)) setupFinishedHere();
  if (!availableTabs().includes(selected)) void chooseAnotherTab();
  tabStrip.update(stripModel());
  // The tray item or the Dashboard's link asked for the port section: it is on Settings, which comes forward for it.
  if (state.port?.focus) {
    focusPending = true;
    if (selected !== "settings") selectTab("settings");
  }
  if (!working) renderPanel(false);
}

async function refresh(): Promise<void> {
  try {
    applyState(await api.getState());
  } catch {
    if (current) say(shellMessages(current.locale).repairFailedGeneric);
  }
}

/** Builds the page's frame: the tab strip and one empty panel per tab (only the open one is shown and filled). */
function buildFrame(): void {
  app = document.getElementById("app") as HTMLElement;
  statusRegion = document.getElementById("status") as HTMLElement;
  (document.getElementById("tabs") as HTMLElement).append(tabStrip.element);
  for (const tab of APP_TABS) {
    const panel = element("div", { className: "panel" });
    panel.id = tabPanelId(tab);
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tabButtonId(tab));
    panel.tabIndex = -1;
    panel.hidden = true;
    panels.set(tab, panel);
    app.append(panel);
  }
}

/** Main decides which tab this window shows and tells the page when it changes; the page follows and never reloads. */
async function start(): Promise<void> {
  api = window.workIntelligenceRepair;
  buildFrame();
  // The user moving the keyboard or the pointer ends a pending request for the port input: a poll never takes the focus after that.
  for (const type of ["keydown", "pointerdown"]) document.addEventListener(type, () => (focusPending = false), true);
  api.onSelectTab((tab) => {
    if (!isAppTab(tab)) return;
    if (ready) {
      selectTab(tab);
      // A pending request (the port input) or a new database candidate comes with the next state: read it now, not in 4 s.
      void refresh();
    } else pendingTab = tab;
  });
  // Main tells the page when an update check starts or ends (the tray item starts one without the page), so it shows at once.
  api.onUpdateChanged(() => void refresh());
  const [selection, state] = await Promise.all([
    api.getTab().catch(() => undefined),
    api.getState().catch(() => undefined),
  ]);
  if (selection) fallbackTabs = selection.tabs;
  if (state) {
    current = state;
    applyLocale(state.locale);
  }
  ready = true;
  // The first drawing may already be the Settings tab with the port request in the state: the flag comes first.
  focusPending = state?.port?.focus === true;
  selectTab(pendingTab ?? selection?.tab ?? availableTabs()[0] ?? "status", false);
  app.setAttribute("aria-busy", "false");
  if (focusPending && selected !== "settings") selectTab("settings");
  setInterval(() => void refresh(), REFRESH_MS);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void start());
else void start();
