#!/usr/bin/env node
/**
 * `pnpm build:standalone` packs the whole product (API server, Web UI, MCP server, CLI) for people without a checkout:
 *
 *   dist/standalone/work-intelligence-<version>/       the package
 *     bin/work-intelligence.mjs                        the `work-intelligence` command
 *     libexec/apps/{server,mcp}/dist/*.js              bundles with no node_modules (all dependencies are pure JS)
 *     libexec/{.agents,docs}/…, libexec/package.json   what the bundles read relative to themselves
 *     web/                                             a copy of apps/web/dist
 *     package.json, README.md, LICENSE
 *   dist/standalone/work-intelligence-<version>.tgz    the same folder as a tarball (the release asset)
 *
 * The bundles run with __WORK_INTELLIGENCE_STANDALONE__ = true: the database lives under ~/.work-intelligence and the
 * Web UI is served from the package's web/ folder. Needs `pnpm build` first (for apps/web/dist). The package.json is
 * private, so an accidental `npm publish` is refused.
 *
 * Usage: node scripts/build-standalone.mjs [outputDirectory]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { AGENT_RESOURCES, bundleOptions, filesUnder } from "./build-plugin.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The server bundle's entry points. backup-worker is started by file name next to the bundle (see BackupWorkerClient). */
const SERVER_ENTRIES = ["standalone-cli", "backup-worker"];
const MCP_ENTRIES = ["index", "finalize-reminder", "codex-finalize-reminder"];
/** 2000-01-01T00:00:00Z: every tar entry gets this date so the same input gives the same bytes. */
const TAR_MTIME = 946684800;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function bundle(app, entries, outdir) {
  return build({
    ...bundleOptions,
    entryPoints: entries.map((name) => join(repositoryRoot, `apps/${app}/src/${name}.ts`)),
    outdir,
  });
}

function packageManifest(version, nodeRange, plugin) {
  return {
    name: "work-intelligence",
    version,
    description: "Local-first work records for coding agents, as one package that needs no checkout.",
    license: "MIT",
    private: true,
    type: "module",
    homepage: plugin.homepage,
    repository: plugin.repository,
    bin: { "work-intelligence": "bin/work-intelligence.mjs" },
    engines: { node: nodeRange },
  };
}

function packageReadme(version) {
  return `# Work Intelligence ${version}（獨立套件）

不需要 git checkout、pnpm 或 build。需要 Node.js（見 package.json 的 engines.node）。

\`\`\`sh
node bin/work-intelligence.mjs --help      # 或把 bin/ 加入 PATH 後直接執行 work-intelligence
node bin/work-intelligence.mjs start       # 啟動 Web 介面與 API，預設 http://127.0.0.1:3210
node bin/work-intelligence.mjs track <資料夾>
node bin/work-intelligence.mjs check
\`\`\`

資料預設存在 ~/.work-intelligence/data；WORK_INTELLIGENCE_CONFIG_DIR 可改目錄，WORK_INTELLIGENCE_DB 可指定資料庫檔。
完整說明見 docs/standalone.md：https://github.com/Ponpon55837/WorkLog.Ai/blob/main/docs/standalone.md
`;
}

/** Writes one ustar header block; throws instead of truncating a name that cannot be represented. */
function tarHeader(name, size, mode) {
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(base) > 100) {
    const slash = name.indexOf("/", name.length - 100);
    prefix = slash > 0 ? name.slice(0, slash) : "";
    base = slash > 0 ? name.slice(slash + 1) : name;
    if (!prefix || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(base) > 100) {
      throw new Error(`Path too long for a tar entry: ${name}`);
    }
  }
  const header = Buffer.alloc(512);
  const field = (value, offset, length) => header.write(value, offset, length, "utf8");
  const octal = (value, offset, length) => field(value.toString(8).padStart(length - 1, "0"), offset, length - 1);
  field(base, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(TAR_MTIME, 136, 12);
  header.fill(0x20, 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  field(prefix, 345, 155);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  field(checksum.toString(8).padStart(6, "0"), 148, 6);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/**
 * A gzip-compressed tar of `sourceDirectory` under one top-level folder (npm and `tar -xzf` both accept it).
 * Entries are sorted and dated alike, so the same input gives the same bytes.
 */
export function writeTarGz(sourceDirectory, topLevelName, outputPath) {
  const blocks = [];
  for (const file of filesUnder(sourceDirectory)) {
    const name = `${topLevelName}/${relative(sourceDirectory, file).replaceAll("\\", "/")}`;
    const data = readFileSync(file);
    const executable = name.startsWith(`${topLevelName}/bin/`);
    blocks.push(tarHeader(name, data.length, executable ? 0o755 : 0o644), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(outputPath, gzipSync(Buffer.concat(blocks), { level: 9 }));
}

function directoryBytes(directory) {
  return filesUnder(directory).reduce((total, file) => total + statSync(file).size, 0);
}

export async function buildStandalone(outputDirectory = join(repositoryRoot, "dist/standalone")) {
  const rootPackage = readJson(join(repositoryRoot, "package.json"));
  const version = rootPackage.version;
  const webSource = join(repositoryRoot, "apps/web/dist");
  if (!existsSync(join(webSource, "index.html"))) {
    throw new Error("apps/web/dist is missing; run `pnpm build` first.");
  }
  const plugin = readJson(join(repositoryRoot, "plugins/work-intelligence/.claude-plugin/plugin.json"));
  const name = `work-intelligence-${version}`;
  const packageDirectory = join(outputDirectory, name);
  const tarball = join(outputDirectory, `${name}.tgz`);
  rmSync(packageDirectory, { recursive: true, force: true });
  rmSync(tarball, { force: true });

  // libexec keeps the repository layout: APP_VERSION, the agent resources and the doctor read paths relative to
  // the bundles, and libexec/package.json is where the bundled APP_VERSION finds the version.
  const libexec = join(packageDirectory, "libexec");
  await bundle("server", SERVER_ENTRIES, join(libexec, "apps/server/dist"));
  await bundle("mcp", MCP_ENTRIES, join(libexec, "apps/mcp/dist"));
  writeFileSync(
    join(libexec, "package.json"),
    `${JSON.stringify({ name: "work-intelligence-libexec", version, private: true, type: "module" }, null, 2)}\n`,
  );
  for (const file of AGENT_RESOURCES) {
    mkdirSync(dirname(join(libexec, file)), { recursive: true });
    cpSync(join(repositoryRoot, file), join(libexec, file));
  }
  cpSync(webSource, join(packageDirectory, "web"), { recursive: true });

  mkdirSync(join(packageDirectory, "bin"), { recursive: true });
  for (const file of ["work-intelligence.mjs", "node-range.mjs"]) {
    cpSync(join(repositoryRoot, "scripts/standalone", file), join(packageDirectory, "bin", file));
  }
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify(packageManifest(version, rootPackage.engines.node, plugin), null, 2)}\n`,
  );
  writeFileSync(join(packageDirectory, "README.md"), packageReadme(version));
  cpSync(join(repositoryRoot, "LICENSE"), join(packageDirectory, "LICENSE"));

  writeTarGz(packageDirectory, name, tarball);
  return {
    version,
    packageDirectory,
    tarball,
    tarballBytes: statSync(tarball).size,
    unpackedBytes: directoryBytes(packageDirectory),
    fileCount: filesUnder(packageDirectory).length,
  };
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const output = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const result = await buildStandalone(output);
  const kib = (bytes) => `${(bytes / 1024).toFixed(0)} KiB`;
  console.log(`directory: ${result.packageDirectory}`);
  console.log(`tarball: ${result.tarball}`);
  console.log(
    `size: tarball ${kib(result.tarballBytes)}, unpacked ${kib(result.unpackedBytes)}, ${result.fileCount} files`,
  );
}
