import type { AppTab } from "@work-intelligence/desktop-core";
import type { ViewContext } from "./context.js";
import { dataPanel } from "./data-view.js";
import { diagnosticsPanel } from "./diagnostics-tab.js";
import { settingsPanel } from "./settings-view.js";
import { statusPanel } from "./status-view.js";

/**
 * The content of the tabs the page draws itself from the repair state. Setup and Agent have their own views with their
 * own state and polling; they are mounted once and only moved in and out of their panel.
 */
export function drawsFromRepairState(tab: AppTab): boolean {
  return tab !== "setup" && tab !== "agent";
}

export function buildPanel(tab: AppTab, ctx: ViewContext): Node[] {
  switch (tab) {
    case "status":
      return statusPanel(ctx);
    case "settings":
      return settingsPanel(ctx);
    case "data":
      return dataPanel(ctx);
    case "diagnostics":
      return diagnosticsPanel(ctx);
    default:
      return [];
  }
}
