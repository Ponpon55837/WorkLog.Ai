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
  previewDiagnostics: "repair:preview-diagnostics",
  saveDiagnostics: "repair:save-diagnostics",
  startAnyway: "repair:start-anyway",
  getTab: "app:get-tab",
  rememberTab: "app:remember-tab",
  copyCommand: "app:copy-command",
  setupGetState: "setup:get-state",
  setupUseDefaults: "setup:use-defaults",
  setupUseSource: "setup:use-source",
  setupChooseFile: "setup:choose-file",
  setupCopyToLocal: "setup:copy-to-local",
  setupLater: "setup:later",
  showView: "app:show-view",
  agentsGetState: "agents:get-state",
  agentsPreview: "agents:preview",
  agentsRemovePreview: "agents:remove-preview",
  agentsApply: "agents:apply",
  agentsDiscard: "agents:discard",
  agentsUndo: "agents:undo",
  agentsSelfTest: "agents:self-test",
  agentsUseCheckoutDatabase: "agents:use-checkout-database",
  legacyDisablePreview: "legacy:disable-preview",
  legacyDisableConfirm: "legacy:disable-confirm",
  legacyStartNow: "legacy:start-now",
  portChange: "port:change",
  copyToLocal: "repair:copy-to-local",
  updateCheck: "update:check",
  updateOpenLink: "update:open-link",
  updateChanged: "update:changed",
  selectTab: "app:select-tab",
};

const api: RepairApi = {
  getState: () => ipcRenderer.invoke(channels.getState),
  retryStart: (operationId) => ipcRenderer.invoke(channels.retryStart, { operationId }),
  chooseDatabase: () => ipcRenderer.invoke(channels.chooseDatabase, {}),
  confirmDatabase: (candidateId, allowMigration, acknowledgeStorageRisk) =>
    ipcRenderer.invoke(channels.confirmDatabase, {
      candidateId,
      ...(allowMigration === undefined ? {} : { allowMigration }),
      ...(acknowledgeStorageRisk === undefined ? {} : { acknowledgeStorageRisk }),
    }),
  copyToLocal: (candidateId) =>
    ipcRenderer.invoke(channels.copyToLocal, candidateId === undefined ? {} : { candidateId }),
  openFolder: (target) => ipcRenderer.invoke(channels.openFolder, { target }),
  previewDiagnostics: () => ipcRenderer.invoke(channels.previewDiagnostics, {}),
  saveDiagnostics: (previewId) => ipcRenderer.invoke(channels.saveDiagnostics, { previewId }),
  startAnyway: (operationId) => ipcRenderer.invoke(channels.startAnyway, { operationId }),
  getTab: () => ipcRenderer.invoke(channels.getTab),
  rememberTab: (tab) => ipcRenderer.invoke(channels.rememberTab, { tab }),
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
      ...(input.acknowledgeStorageRisk === undefined ? {} : { acknowledgeStorageRisk: input.acknowledgeStorageRisk }),
      ...(input.startAnyway === undefined ? {} : { startAnyway: input.startAnyway }),
    }),
  setupChooseFile: () => ipcRenderer.invoke(channels.setupChooseFile, {}),
  setupCopyToLocal: (sourceId, launchAtLogin) =>
    ipcRenderer.invoke(channels.setupCopyToLocal, {
      sourceId,
      ...(launchAtLogin === undefined ? {} : { launchAtLogin }),
    }),
  setupLater: () => ipcRenderer.invoke(channels.setupLater, {}),
  showAgents: () => ipcRenderer.invoke(channels.showView, { view: "agents" }),
  agentsGetState: () => ipcRenderer.invoke(channels.agentsGetState),
  agentsPreview: (adopt) => ipcRenderer.invoke(channels.agentsPreview, { adopt }),
  agentsRemovePreview: () => ipcRenderer.invoke(channels.agentsRemovePreview, {}),
  agentsApply: (previewId, acknowledgeUndiffable) =>
    ipcRenderer.invoke(channels.agentsApply, {
      previewId,
      ...(acknowledgeUndiffable === undefined ? {} : { acknowledgeUndiffable }),
    }),
  agentsDiscard: () => ipcRenderer.invoke(channels.agentsDiscard, {}),
  agentsUndo: () => ipcRenderer.invoke(channels.agentsUndo, {}),
  agentsSelfTest: () => ipcRenderer.invoke(channels.agentsSelfTest, {}),
  agentsUseCheckoutDatabase: (agent) => ipcRenderer.invoke(channels.agentsUseCheckoutDatabase, { agent }),
  legacyDisablePreview: () => ipcRenderer.invoke(channels.legacyDisablePreview, {}),
  legacyDisableConfirm: (previewId, continueWhileBusy) =>
    ipcRenderer.invoke(channels.legacyDisableConfirm, {
      previewId,
      ...(continueWhileBusy === undefined ? {} : { continueWhileBusy }),
    }),
  legacyStartNow: () => ipcRenderer.invoke(channels.legacyStartNow, {}),
  portChange: (port) => ipcRenderer.invoke(channels.portChange, { port }),
  checkForUpdates: () => ipcRenderer.invoke(channels.updateCheck, {}),
  openUpdateLink: (target) => ipcRenderer.invoke(channels.updateOpenLink, { target }),
  onSelectTab: (listener) => {
    // Forwarded as sent; the page checks the id against the tab list before it switches.
    ipcRenderer.on(channels.selectTab, (_event, tab: unknown) => {
      if (typeof tab === "string") listener(tab as Parameters<typeof listener>[0]);
    });
  },
  onUpdateChanged: (listener) => {
    // The event carries nothing: the page reads the state through `getState`.
    ipcRenderer.on(channels.updateChanged, () => listener());
  },
};

contextBridge.exposeInMainWorld("workIntelligenceRepair", api);
