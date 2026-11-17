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
 *  - electron-builder signs nothing (`mac.identity: null`; it also skips signing on GitHub pull_request runs, which would
 *    leave the fuse-flipped app with Electron's broken original signature). The `afterPack` hook (scripts/after-pack.mjs)
 *    owns the rest, identically on pull-request and release builds: it flips the fuses (scripts/app-fuses.mjs; a closed
 *    shell: no ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect, only the integrity-checked app.asar loads) and, on macOS,
 *    ad-hoc signs the app inside-out (scripts/mac-ad-hoc-sign.mjs). Notarization and the hardened runtime stay off until
 *    a Developer ID exists; users must approve the first launch in Gatekeeper. The runtime bundle is never signed or
 *    touched, so the official Node binary keeps its own signature and its bytes keep matching the manifest. The installer
 *    builds run from the packed app (`prepackaged`), where the hook does not run again.
 *  - The icon is original artwork (build/icon.svg); icon.ico, icon.icns and icon.png are generated from it and committed.
 *  - Windows is unsigned (no certificate yet): SmartScreen will warn on first run.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import afterPack from "./scripts/after-pack.mjs";

const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const APP_ID = "ai.worklog.workintelligence";
export const PRODUCT_NAME = "Work Intelligence";
/** Languages the shell speaks (shell/i18n.ts: zh-* reads Traditional Chinese, everything else English). */
/** The App icon files, all generated from build/icon.svg by `scripts/generate-icons.mjs`. */
export const ICON_FILES = {
  ico: join(desktopDirectory, "build/icon.ico"),
  icns: join(desktopDirectory, "build/icon.icns"),
  png: join(desktopDirectory, "build/icon.png"),
};
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

/** electron-builder `beforeBuild`: nothing to install or rebuild, and no node_modules to collect. */
async function skipDependencies() {
  return false;
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
    // The staged app has no node_modules (the shell is one esbuild bundle). A `beforeBuild` that resolves false tells
    // electron-builder dependencies are handled outside it, so it neither rebuilds them nor spends seconds searching
    // the workspace for node_modules. It only runs while npmRebuild is on, so npmRebuild stays at its default here.
    beforeBuild: skipDependencies,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    afterPack,
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      artifactName: "Work-Intelligence-${version}-win-${arch}-setup.${ext}",
      icon: ICON_FILES.ico,
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
      installerIcon: ICON_FILES.ico,
      uninstallerIcon: ICON_FILES.ico,
    },
    mac: {
      category: "public.app-category.developer-tools",
      identity: null,
      notarize: false,
      artifactName: "Work-Intelligence-${version}-mac-${arch}.${ext}",
      icon: ICON_FILES.icns,
    },
    dmg: { format: options.dmgFormat, writeUpdateInfo: false },
    linux: { target: "dir", icon: ICON_FILES.png },
  };
}
