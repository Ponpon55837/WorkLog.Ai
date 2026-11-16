/**
 * electron-builder configuration of the desktop App (design R4 §7.1, ADR-03, DT-33, DT-34).
 *
 * Built by `scripts/package.mjs`, which stages a clean app directory (no node_modules: the shell is one esbuild bundle) and
 * the runtime bundle first and passes their paths here. Decisions that are not obvious from the keys:
 *
 *  - No publishing and no updater. electron-builder 26 has no Ed25519-signed update manifests (that is v27, still `next`),
 *    so `latest.yml` alone would not protect the update metadata; auto-update stays out of this stage (R4 §7.1). `publish`
 *    is null, nothing writes `latest*.yml`, and electron-updater is not a dependency.
 *  - The runtime bundle is an `extraResources` copy outside the asar: the launcher executes the Node binary from disk and
 *    verifies every file against the runtime manifest, so the bytes must stay exactly as built.
 *  - Fuses make the packaged Electron a closed shell: no ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect, and only the
 *    integrity-checked app.asar loads.
 *  - macOS is ad-hoc signed (`identity: "-"`) because flipping fuses invalidates the arm64 signature and an unsigned arm64
 *    binary does not start. Notarization and the hardened runtime stay off until a Developer ID exists; users must
 *    approve the first launch in Gatekeeper. The runtime bundle is excluded from signing (`signIgnore`) so the official
 *    Node binary keeps its own signature and its bytes keep matching the manifest.
 *  - Windows is unsigned (no certificate yet): SmartScreen will warn on first run.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const APP_ID = "ai.worklog.workintelligence";
export const PRODUCT_NAME = "Work Intelligence";
/** Languages the shell speaks (shell/i18n.ts: zh-* reads Traditional Chinese, everything else English). */
export const ELECTRON_LANGUAGES = ["en-US", "zh-TW"];
export const COMPRESSION_CHOICES = ["store", "normal", "maximum"];
export const DMG_FORMAT_CHOICES = ["UDZO", "ULFO"];
/** Installer targets by platform; Linux builds an unpacked directory only, for local verification. */
export const TARGETS_BY_PLATFORM = {
  win32: ["nsis"],
  darwin: ["dmg", "zip"],
  linux: ["dir"],
};
export const ARCHITECTURES_BY_PLATFORM = {
  win32: ["x64"],
  darwin: ["arm64", "x64"],
  linux: ["x64", "arm64"],
};

/** The pinned Electron version of this workspace: the staged app has no dependencies to read it from. */
export function pinnedElectronVersion() {
  return require(join(desktopDirectory, "package.json")).devDependencies.electron;
}

/**
 * @param {object} options
 * @param {string} options.stageDirectory staged app directory (package.json + dist/)
 * @param {string} options.runtimeBundleDirectory the runtime bundle to copy into resources/runtime-bundle
 * @param {string} options.outputDirectory where electron-builder writes
 * @param {string} options.version
 * @param {"store" | "normal" | "maximum"} options.compression
 * @param {"UDZO" | "ULFO"} options.dmgFormat
 * @param {boolean} [options.baseline] keep every Electron locale and source maps (the size baseline only)
 * @param {string} [options.electronDist] a local Electron distribution instead of a download
 */
export function createBuilderConfig(options) {
  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    copyright: "MIT License",
    electronVersion: pinnedElectronVersion(),
    ...(options.electronDist ? { electronDist: options.electronDist } : {}),
    directories: {
      app: options.stageDirectory,
      buildResources: join(desktopDirectory, "build"),
      output: options.outputDirectory,
    },
    files: options.baseline ? ["package.json", "dist/**/*"] : ["package.json", "dist/**/*", "!**/*.map"],
    extraResources: [{ from: options.runtimeBundleDirectory, to: "runtime-bundle" }],
    asar: true,
    compression: options.compression,
    ...(options.baseline ? {} : { electronLanguages: ELECTRON_LANGUAGES }),
    publish: null,
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    },
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      artifactName: "Work-Intelligence-${version}-win-${arch}-setup.${ext}",
    },
    nsis: {
      // One click, per user: installs under %LOCALAPPDATA%\Programs without a UAC prompt or wizard pages. The App needs
      // nothing machine-wide, and a per-machine choice would add an elevation path to every later repair install.
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      // DT-34: the uninstaller removes program files only; settings, the database and backups are never touched.
      deleteAppDataOnUninstall: false,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      differentialPackage: false,
      include: join(desktopDirectory, "build/installer.nsh"),
    },
    mac: {
      category: "public.app-category.developer-tools",
      identity: "-",
      hardenedRuntime: false,
      gatekeeperAssess: false,
      notarize: false,
      signIgnore: ["/Contents/Resources/runtime-bundle/"],
      artifactName: "Work-Intelligence-${version}-mac-${arch}.${ext}",
    },
    dmg: { format: options.dmgFormat, writeUpdateInfo: false },
    linux: { target: "dir" },
  };
}
