import type { AppTab, RepairState } from "@work-intelligence/desktop-core";

/**
 * The service needs repair because of its database: the file cannot be used, other databases were found to choose from,
 * or its storage is risky. Then Status shows the whole database card (and the candidates) so nobody has to look for it.
 */
export function isBlockingDatabase(state: Pick<RepairState, "owner" | "database" | "candidates">): boolean {
  if (state.owner !== "NEEDS_REPAIR") return false;
  return state.database.status !== "ok" || state.candidates.length > 0 || state.database.storageRisk !== undefined;
}

/**
 * What a tab's panel is drawn from, and nothing else: the page redraws the panel only when this changes. The retry id
 * is a fresh value in every snapshot and is read when a button is pressed, so it is left out; the sections with their
 * own tab (port, update, shell) are left out of the tabs that do not show them.
 */
export function panelInputs(tab: AppTab, state: RepairState): unknown {
  if (tab === "settings") return { locale: state.locale, port: state.port, update: state.update };
  const { retryOperationId: _retry, port: _port, update: _update, shell: _shell, ...rest } = state;
  return rest;
}
