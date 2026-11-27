#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build, transformSync } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

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
  // A sandboxed preload cannot be ESM and may only require "electron".
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

/**
 * Copies a stylesheet into the page folder. The release bundle passes it through esbuild's CSS minifier (same rules, fewer
 * bytes: comments and whitespace go, custom properties and selectors keep their names); the smoke build copies it as it is
 * so a failure can be debugged against the source.
 */
function copyStylesheet(source, target) {
  if (!production) {
    cpSync(source, target);
    return;
  }
  const { code } = transformSync(readFileSync(source, "utf8"), {
    loader: "css",
    minify: true,
    target: "chrome140",
    legalComments: "none",
  });
  writeFileSync(target, code);
}

copyStylesheet(join(root, "src/renderer/repair/repair.css"), join(dist, "renderer/repair/repair.css"));
// The design tokens shared with the web UI (packages/ui-tokens); the page loads them before repair.css.
copyStylesheet(join(root, "..", "..", "packages", "ui-tokens", "tokens.css"), join(dist, "renderer/repair/tokens.css"));
mkdirSync(join(dist, "skills", "work-intelligence"), { recursive: true });
cpSync(
  join(root, "..", "..", ".agents", "skills", "work-intelligence", "SKILL.md"),
  join(dist, "skills", "work-intelligence", "SKILL.md"),
);
for (const file of ["tray.png", "trayTemplate.png", "trayTemplate@2x.png"])
  cpSync(join(root, "build", file), join(dist, "assets", file));
process.stdout.write(`desktop shell built (${production ? "production" : "smoke"})\n`);
