const MIB = 1024 * 1024;

// Each gate is the measured size plus headroom: big enough for patch-release growth, small enough to catch a leaked node_modules or a second runtime copy.
export const SIZE_GATES = {
  // Measured locally on Linux x64 plus about 15%.
  "linux-x64": { unpackedBytes: 460 * MIB, runtimeBundleBytes: 150 * MIB, asarBytes: 2 * MIB },
  "linux-arm64": { unpackedBytes: 460 * MIB, runtimeBundleBytes: 150 * MIB, asarBytes: 2 * MIB },
  // Windows and macOS: estimates from the official Electron and Node archives plus 25-30%, until CI measurements replace them.
  "win32-x64": {
    unpackedBytes: 460 * MIB,
    runtimeBundleBytes: 120 * MIB,
    asarBytes: 2 * MIB,
    installerBytes: 170 * MIB,
  },
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

// From a CI comparison: `maximum` NSIS and zip are at most 0.5% smaller for two to seven times the build time.
// DMG `ULFO` (lzfse) is smaller and faster than UDZO and opens on macOS 10.11+; Electron 45 already needs macOS 12.
export const DEFAULT_COMPRESSION = "normal";
export const DEFAULT_DMG_FORMAT = "ULFO";
