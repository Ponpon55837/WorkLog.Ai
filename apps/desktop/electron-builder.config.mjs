/**
 * - The runtime bundle is an extraResources copy outside the asar: the launcher verifies every file against the manifest, so the bytes must stay as built.
 * - electron-builder signs nothing (it also skips signing on pull_request runs, leaving Electron's broken original signature); the afterPack hook flips the fuses and, on macOS, ad-hoc signs inside-out.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import afterPack from "./scripts/after-pack.mjs";

const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const APP_ID = "ai.worklog.workintelligence";
export const PRODUCT_NAME = "Work Intelligence";
export const ICON_FILES = {
  ico: join(desktopDirectory, "build/icon.ico"),
  icns: join(desktopDirectory, "build/icon.icns"),
  png: join(desktopDirectory, "build/icon.png"),
};
export const SKILL_RESOURCE = "skills/work-intelligence/SKILL.md";
export const ELECTRON_LANGUAGES = ["en-US", "zh-TW"];
export const COMPRESSION_CHOICES = ["store", "normal", "maximum"];
export const DMG_FORMAT_CHOICES = ["UDZO", "ULFO"];
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

export function pinnedElectronVersion() {
  return require(join(desktopDirectory, "package.json")).devDependencies.electron;
}

async function skipDependencies() {
  return false;
}

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
    files: options.baseline
      ? ["package.json", "dist/**/*", "!dist/skills/**"]
      : ["package.json", "dist/**/*", "!**/*.map", "!dist/skills/**"],
    extraResources: [
      { from: options.runtimeBundleDirectory, to: "runtime-bundle" },
      { from: join(options.stageDirectory, "dist", "skills", "work-intelligence", "SKILL.md"), to: SKILL_RESOURCE },
    ],
    asar: true,
    compression: options.compression,
    ...(options.baseline ? {} : { electronLanguages: ELECTRON_LANGUAGES }),
    // No updater: electron-builder 26 cannot sign update manifests, so a bare latest.yml would be unprotected.
    publish: null,
    // The staged app has no node_modules: a `beforeBuild` returning false stops electron-builder from rebuilding or searching for them.
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
      // One-click per-user install (no UAC): a per-machine install would add an elevation path to every repair install.
      oneClick: true,
      perMachine: false,
      allowElevation: false,
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
