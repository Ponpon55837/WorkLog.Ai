/**
 * Size gates of `scripts/package.mjs` (PROVISIONAL until the first CI runs on Windows and macOS report real numbers).
 *
 * How the numbers were chosen: a gate is the measured size plus headroom, so an accidental regression (a forgotten
 * node_modules, source maps, every Electron locale, a second runtime copy) fails the run while normal growth (a new Node
 * or Electron patch release, a larger Web UI) does not. Linux numbers were measured locally (about 15% headroom); the
 * Windows and macOS ones are estimates with 25-30% headroom, to be replaced with `measured * 1.15` once
 * `package-results/package-<platform>-<arch>.json` from CI exists. All values are bytes.
 *
 *  - unpackedBytes        the whole unpacked app (Windows: win-unpacked, macOS: the .app, Linux: linux-unpacked)
 *  - runtimeBundleBytes   resources/runtime-bundle: the official Node binary plus the standalone app. One Node binary
 *                         dominates (Linux ~122 MB, Windows node.exe ~85 MB, macOS ~110 MB); a second copy would fail this.
 *  - asarBytes            app.asar: the esbuild shell bundle only (0.63 MiB measured, gate 2 MiB); anything near the
 *                         gate means dependencies or source maps leaked into the package.
 *  - installerBytes       each installer file (NSIS exe, DMG, zip)
 */
const MIB = 1024 * 1024;

export const SIZE_GATES = {
  // Measured on Linux x64 (Electron 45.3.2, Node 24.22.3): unpacked 395.9 MiB, runtime bundle 129.2 MiB, asar 0.63 MiB.
  "linux-x64": { unpackedBytes: 460 * MIB, runtimeBundleBytes: 150 * MIB, asarBytes: 2 * MIB },
  "linux-arm64": { unpackedBytes: 460 * MIB, runtimeBundleBytes: 150 * MIB, asarBytes: 2 * MIB },
  // Estimated: a Windows unpacked build measured 304 MiB for Electron itself; node.exe adds about 90 MiB. The NSIS 7z payload
  // of the Linux-runtime variant was 123 MiB, so the installer is expected near 120 MiB.
  "win32-x64": {
    unpackedBytes: 460 * MIB,
    runtimeBundleBytes: 120 * MIB,
    asarBytes: 2 * MIB,
    installerBytes: 170 * MIB,
  },
  // Estimated from the official macOS Electron and Node archives; the .app and DMG sizes are the least certain.
  "darwin-arm64": {
    unpackedBytes: 520 * MIB,
    runtimeBundleBytes: 190 * MIB,
    asarBytes: 2 * MIB,
    installerBytes: 230 * MIB,
  },
  "darwin-x64": {
    unpackedBytes: 540 * MIB,
    runtimeBundleBytes: 200 * MIB,
    asarBytes: 2 * MIB,
    installerBytes: 240 * MIB,
  },
};

/**
 * Compression defaults, PROVISIONAL until CI reports size and time for both settings (run the workflow with
 * `compare-compression`, which records the alternative next to the default in the results JSON).
 *
 *  - NSIS/zip `normal`: LZMA at the default level. `maximum` usually saves a few percent of a one-time download at the
 *    cost of a slower build and a slightly slower install; switch only if CI shows more than ~5% smaller for under ~60 s.
 *  - DMG `UDZO` (zlib): opens on every macOS version Electron 45 supports. `ULFO` (lzfse) is smaller and mounts faster
 *    but needs macOS 10.15+; Electron 45 already needs macOS 12+, so it is a candidate if CI shows a gain.
 */
export const DEFAULT_COMPRESSION = "normal";
export const DEFAULT_DMG_FORMAT = "UDZO";
