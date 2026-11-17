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
  startAnyway: "repair:start-anyway",
  getView: "app:get-view",
  copyCommand: "app:copy-command",
  setupGetState: "setup:get-state",
  setupUseDefaults: "setup:use-defaults",
  setupUseSource: "setup:use-source",
  setupChooseFile: "setup:choose-file",
  setupLater: "setup:later",
  showView: "app:show-view",
  agentsGetState: "agents:get-state",
  agentsPreview: "agents:preview",
  agentsApply: "agents:apply",
  agentsDiscard: "agents:discard",
  agentsUndo: "agents:undo",
  agentsSelfTest: "agents:self-test",
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
  startAnyway: (operationId) => ipcRenderer.invoke(channels.startAnyway, { operationId }),
  getView: () => ipcRenderer.invoke(channels.getView),
  copyCommand: (target) => ipcRenderer.invoke(channels.copyCommand, { target }),
  setupGetState: () => ipcRenderer.invoke(channels.setupGetState),
  setupUseDefaults: (launchAtLogin, startAnyway) =>
    ipcRenderer.invoke(channels.setupUseDefaults, {
      launchAtLogin,
      ...(startAnyway === undefined ? {} : { startAnyway }),
    }),
  setupUseSource: (input) =>
    ipcRenderer.invoke(channels.setupUseSource, {
      sourceId: input.sourceId,
      launchAtLogin: input.launchAtLogin,
      ...(input.allowMigration === undefined ? {} : { allowMigration: input.allowMigration }),
      ...(input.startAnyway === undefined ? {} : { startAnyway: input.startAnyway }),
    }),
  setupChooseFile: () => ipcRenderer.invoke(channels.setupChooseFile, {}),
  setupLater: () => ipcRenderer.invoke(channels.setupLater, {}),
  showAgents: () => ipcRenderer.invoke(channels.showView, { view: "agents" }),
  agentsGetState: () => ipcRenderer.invoke(channels.agentsGetState),
  agentsPreview: (adopt) => ipcRenderer.invoke(channels.agentsPreview, { adopt }),
  agentsApply: (previewId) => ipcRenderer.invoke(channels.agentsApply, { previewId }),
  agentsDiscard: () => ipcRenderer.invoke(channels.agentsDiscard, {}),
  agentsUndo: () => ipcRenderer.invoke(channels.agentsUndo, {}),
  agentsSelfTest: () => ipcRenderer.invoke(channels.agentsSelfTest, {}),
};

contextBridge.exposeInMainWorld("workIntelligenceRepair", api);
