/**
 * The Electron fuses of the packaged App (a closed shell: no ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect, and only the
 * integrity-checked app.asar loads). One table feeds both the afterPack hook that flips them and the read-back gate in
 * `package.mjs`, so the two can never disagree. Keys are electron-builder's friendly names (`generateFuseConfig`).
 */
export const APP_FUSES = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
};
