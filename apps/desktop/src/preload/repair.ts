// Sandboxed preload (CommonJS): the only module it may require is "electron". It forwards each call to main and returns
// the answer; it holds no logic. Types are imported for checking only and leave nothing in the bundle.
import type { REPAIR_CHANNELS, RepairApi } from "@work-intelligence/desktop-core";
import { contextBridge, ipcRenderer } from "electron";

// Spelled out because a value import would pull desktop-core into the bundle; the type keeps them identical.
const channels: typeof REPAIR_CHANNELS = {
  getState: "repair:get-state",
  retryStart: "repair:retry-start",
  chooseDatabase: "repair:choose-database",
  confirmDatabase: "repair:confirm-database",
  openFolder: "repair:open-folder",
  exportDiagnostics: "repair:export-diagnostics",
};

const api: RepairApi = {
  getState: () => ipcRenderer.invoke(channels.getState),
  retryStart: (operationId) => ipcRenderer.invoke(channels.retryStart, { operationId }),
  chooseDatabase: () => ipcRenderer.invoke(channels.chooseDatabase, {}),
  confirmDatabase: (candidateId, allowMigration) =>
    ipcRenderer.invoke(channels.confirmDatabase, {
      candidateId,
      ...(allowMigration === undefined ? {} : { allowMigration }),
    }),
  openFolder: (target) => ipcRenderer.invoke(channels.openFolder, { target }),
  exportDiagnostics: () => ipcRenderer.invoke(channels.exportDiagnostics, {}),
};

contextBridge.exposeInMainWorld("workIntelligenceRepair", api);
