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
 * Compression defaults, chosen from the 1.6.45 CI comparison (size in MiB / build seconds; a manual run with
 * `compare-compression` records the alternative next to the default again):
 *
 *  - NSIS `normal`: 120.63 / 132.9 against `maximum` 120.63 / 264.3 on win32-x64. The same size for twice the time.
 *  - zip `normal`: 146.51 / 62.3 against `maximum` 145.89 / 440.1 on darwin-arm64 (x64: 154.63 / 118.3 against
 *    154.00 / 634.8). Under 0.5% smaller for five to seven times the time.
 *  - DMG `ULFO` (lzfse): 148.93 / 9.0 against `UDZO` (zlib) 151.87 / 48.3 on darwin-arm64 (x64: 156.88 / 11.8 against
 *    159.97 / 38.8). Smaller and three to five times faster. lzfse images open on macOS 10.11 and later; Electron 45
 *    already needs macOS 12, so no supported Mac loses anything.
 */
export const DEFAULT_COMPRESSION = "normal";
export const DEFAULT_DMG_FORMAT = "ULFO";
