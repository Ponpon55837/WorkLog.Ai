#!/usr/bin/env node
/**
 * Builds the desktop shell into dist/ with esbuild. No Electron binary is needed.
 *
 *   dist/main/index.mjs            main process, ESM (Electron 45 loads an ESM main; `electron` stays external, everything else
 *                                  is bundled so the shell does not depend on node_modules at run time)
 *   dist/preload/repair.cjs        sandboxed preload, CommonJS (a sandboxed preload cannot be ESM and may only require "electron")
 *   dist/renderer/repair/          repair page: index.html and repair.css copied, repair.js bundled as an IIFE
 *   dist/assets/tray.png           generated tray icon
 *
 * Flags:
 *   --production                      the release bundle: minified, no source maps, and `__WI_TEST_BUILD__` is false, so the
 *                                     test hook and every test environment variable are compiled out (see
 *                                     check-production-bundle.mjs). Without it the build is the smoke-test build.
 *   --bundled-runtime-sha256 <hex>    SHA-256 of the bundled runtime's runtime-manifest.json, baked into the main bundle
 *                                     as `__WI_BUNDLED_RUNTIME_SHA256__`; required with --production.
 */
import { Buffer } from "node:buffer";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** A small round, accent-coloured icon: enough for a tray; the real artwork replaces it with the installer work. */
function trayIcon(size) {
  const rows = [];
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const inside = Math.hypot(x - centre, y - centre) <= size / 2 - 1;
      row.set(inside ? [0x1f, 0x6f, 0xeb, 0xff] : [0, 0, 0, 0], 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "assets"), { recursive: true });
mkdirSync(join(dist, "renderer", "repair"), { recursive: true });

function parseArguments(argv) {
  const options = { production: false, bundledRuntimeSha256: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--production") options.production = true;
    else if (argument === "--bundled-runtime-sha256")
      options.bundledRuntimeSha256 = (argv[(index += 1)] ?? "").toLowerCase();
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.bundledRuntimeSha256 !== "" && !/^[0-9a-f]{64}$/.test(options.bundledRuntimeSha256)) {
    throw new Error("--bundled-runtime-sha256 must be 64 hex characters");
  }
  if (options.production && options.bundledRuntimeSha256 === "") {
    throw new Error("--production needs --bundled-runtime-sha256 <hex>");
  }
  return options;
}

const { production, bundledRuntimeSha256 } = parseArguments(process.argv.slice(2));

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: "info", target: "node22" };
const define = {
  __WI_TEST_BUILD__: String(!production),
  __WI_BUNDLED_RUNTIME_SHA256__: JSON.stringify(bundledRuntimeSha256),
};

await build({
  ...common,
  entryPoints: [join(root, "src/main/index.ts")],
  outfile: join(dist, "main/index.mjs"),
  platform: "node",
  format: "esm",
  external: ["electron"],
  define,
  // Bundled CommonJS dependencies still call `require`; give the ESM output one.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});

await build({
  ...common,
  entryPoints: [join(root, "src/preload/repair.ts")],
  outfile: join(dist, "preload/repair.cjs"),
  platform: "node",
  format: "cjs",
  external: ["electron"],
});

await build({
  ...common,
  entryPoints: [join(root, "src/renderer/repair/repair.ts")],
  outfile: join(dist, "renderer/repair/repair.js"),
  platform: "browser",
  format: "iife",
  target: "chrome140",
});

cpSync(join(root, "src/renderer/repair/index.html"), join(dist, "renderer/repair/index.html"));
cpSync(join(root, "src/renderer/repair/repair.css"), join(dist, "renderer/repair/repair.css"));
writeFileSync(join(dist, "assets/tray.png"), trayIcon(32));
process.stdout.write(`desktop shell built (${production ? "production" : "smoke"})\n`);
