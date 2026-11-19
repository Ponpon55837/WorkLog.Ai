import type { AppTab, AppTabBadge } from "@work-intelligence/desktop-core/shell/app-tabs";
import { stableKey } from "./diff.js";
import { element } from "./dom.js";

/**
 * The tab strip (UiUnderlineNav) as a WAI-ARIA tablist: role=tablist with a label, role=tab buttons with
 * aria-selected / aria-controls / id, a roving tabindex (the selected tab is the one tab stop), and Left / Right (wrap),
 * Home and End that move focus and select at once (automatic activation). The strip is updated in place: a poll that
 * changes nothing touches nothing, and one that changes a badge or the labels patches the buttons it already has, so a
 * focused tab never loses focus to a redraw.
 */
export interface TabStripModel {
  readonly tabs: readonly AppTab[];
  readonly selected: AppTab;
  readonly badges: Readonly<Record<AppTab, AppTabBadge>>;
  readonly labels: Readonly<Record<AppTab, string>>;
  readonly listLabel: string;
  readonly attentionLabel: string;
  readonly busyLabel: string;
}

export interface TabStrip {
  readonly element: HTMLElement;
  update(model: TabStripModel): void;
  focusTab(tab: AppTab): void;
}

export function tabButtonId(tab: AppTab): string {
  return `tab-${tab}`;
}

export function tabPanelId(tab: AppTab): string {
  return `panel-${tab}`;
}

/**
 * The index a key moves to (Left / Right wrap around, Home and End go to the ends), or null for any other key.
 * @internal test-only
 */
export function tabIndexForKey(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

function badgeSlot(kind: "attention" | "busy"): HTMLElement {
  const mark = element("span", { className: kind === "attention" ? "tab-dot" : "tab-spinner" });
  mark.setAttribute("aria-hidden", "true");
  const slot = element("span", { className: `tab-badge tab-badge--${kind}` }, [
    mark,
    element("span", { className: "sr-only" }),
  ]);
  slot.hidden = true;
  return slot;
}

function createButton(tab: AppTab): HTMLButtonElement {
  const node = element("button", { className: "tab" }, [
    element("span", { className: "tab-label" }),
    badgeSlot("attention"),
    badgeSlot("busy"),
  ]);
  node.type = "button";
  node.id = tabButtonId(tab);
  node.dataset.tab = tab;
  node.setAttribute("role", "tab");
  node.setAttribute("aria-controls", tabPanelId(tab));
  return node;
}

function patchBadge(button: HTMLElement, kind: "attention" | "busy", on: boolean, text: string): void {
  const slot = button.querySelector<HTMLElement>(`.tab-badge--${kind}`);
  if (!slot) return;
  slot.hidden = !on;
  slot.title = on ? text : "";
  const hidden = slot.querySelector<HTMLElement>(".sr-only");
  // A leading comma makes a screen reader pause between the tab's name and the mark.
  if (hidden && hidden.textContent !== (on ? `, ${text}` : "")) hidden.textContent = on ? `, ${text}` : "";
}

function patchButton(button: HTMLButtonElement, tab: AppTab, model: TabStripModel): void {
  const selected = tab === model.selected;
  const label = button.querySelector<HTMLElement>(".tab-label");
  if (label && label.textContent !== model.labels[tab]) label.textContent = model.labels[tab];
  button.setAttribute("aria-selected", String(selected));
  button.tabIndex = selected ? 0 : -1;
  button.classList.toggle("is-selected", selected);
  const badge = model.badges[tab];
  patchBadge(button, "attention", badge.attention, model.attentionLabel);
  patchBadge(button, "busy", badge.busy, model.busyLabel);
}

export function createTabStrip(onSelect: (tab: AppTab) => void): TabStrip {
  const list = element("div", { className: "tablist" });
  list.setAttribute("role", "tablist");
  const buttons = new Map<AppTab, HTMLButtonElement>();
  let order: readonly AppTab[] = [];
  let lastKey = "";

  list.addEventListener("click", (event) => {
    const tab = (event.target as HTMLElement | null)?.closest<HTMLElement>("[role=tab]")?.dataset.tab;
    if (tab && buttons.has(tab as AppTab)) onSelect(tab as AppTab);
  });
  list.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const current = (event.target as HTMLElement | null)?.closest<HTMLElement>("[role=tab]")?.dataset.tab;
    const index = order.indexOf(current as AppTab);
    const next = index < 0 ? null : tabIndexForKey(event.key, index, order.length);
    const tab = next === null ? undefined : order[next];
    if (tab === undefined) return;
    event.preventDefault();
    onSelect(tab);
    buttons.get(tab)?.focus();
  });

  function update(model: TabStripModel): void {
    const key = stableKey(model);
    if (key === lastKey) return;
    lastKey = key;
    list.setAttribute("aria-label", model.listLabel);
    for (const [tab, button] of buttons) {
      if (!model.tabs.includes(tab)) {
        button.remove();
        buttons.delete(tab);
      }
    }
    for (const tab of model.tabs) {
      let button = buttons.get(tab);
      if (!button) {
        button = createButton(tab);
        buttons.set(tab, button);
        list.append(button);
      }
      patchButton(button, tab, model);
    }
    // Moving a node blurs it, so the buttons are put in order only when the order really changed.
    if (order.join() !== model.tabs.join()) {
      const active = document.activeElement;
      for (const tab of model.tabs) {
        const button = buttons.get(tab);
        if (button) list.append(button);
      }
      if (active instanceof HTMLElement && list.contains(active)) active.focus();
    }
    order = model.tabs;
    buttons.get(model.selected)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  return {
    element: list,
    update,
    focusTab: (tab) => buttons.get(tab)?.focus(),
  };
}
