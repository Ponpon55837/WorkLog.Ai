#!/usr/bin/env node
/**
 * `pnpm build:plugin` packs Work Intelligence for people without a checkout:
 *
 * - dist/plugin/work-intelligence/                   the Claude Code / Codex plugin with a bundled MCP server
 * - dist/plugin/work-intelligence-plugin-<v>.zip     the same directory, zipped (claude --plugin-url, release asset)
 * - dist/plugin/work-intelligence-<v>.mcpb           a Claude Desktop extension
 *
 * The bundle runs with __WORK_INTELLIGENCE_STANDALONE__ = true: it opens WORK_INTELLIGENCE_DB, else the checkout
 * linked by `pnpm plugin:link`, else ~/.work-intelligence/data. The repository build and plugins/ are not touched.
 * The bundle keeps the repository layout (server/apps/mcp/dist, server/package.json, server/.agents, server/docs)
 * because the MCP reads its version and agent resources relative to its own file.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import { crc32, deflateRawSync } from "node:zlib";
import console from "node:console";
import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY_POINTS = ["index", "finalize-reminder"];
/** Copied beside the bundle at the paths apps/mcp/src/agent-resources.ts reads. */
const AGENT_RESOURCES = [".agents/skills/work-intelligence/SKILL.md", "docs/work-record-and-report-format.md"];
/** node:sqlite without a flag. */
export const MINIMUM_NODE = "22.13.0";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Writes the bundled MCP server and the files it reads into `<target>/server`. */
async function buildServer(target, version) {
  const server = join(target, "server");
  await build({
    entryPoints: ENTRY_POINTS.map((name) => join(repositoryRoot, `apps/mcp/src/${name}.ts`)),
    outdir: join(server, "apps/mcp/dist"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
    legalComments: "none",
    define: { __WORK_INTELLIGENCE_STANDALONE__: "true" },
    // Some dependencies still call require(); give the ESM bundle one.
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module";const require = __createRequire(import.meta.url);',
    },
  });
  writeFileSync(
    join(server, "package.json"),
    `${JSON.stringify({ name: "work-intelligence-server", version, private: true, type: "module" }, null, 2)}\n`,
  );
  for (const file of AGENT_RESOURCES) {
    mkdirSync(dirname(join(server, file)), { recursive: true });
    cpSync(join(repositoryRoot, file), join(server, file));
  }
}

function mcpbManifest(plugin, version) {
  return {
    manifest_version: "0.3",
    name: "work-intelligence",
    display_name: "Work Intelligence",
    version,
    description: "Local-first work records for coding agents: save, recall and report on your work on this computer.",
    author: plugin.author,
    homepage: plugin.homepage,
    repository: { type: "git", url: plugin.repository },
    license: plugin.license,
    keywords: plugin.keywords,
    server: {
      type: "node",
      entry_point: "server/apps/mcp/dist/index.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/apps/mcp/dist/index.js"],
        env: { WORK_INTELLIGENCE_DB: "${user_config.database_path}" },
      },
    },
    user_config: {
      database_path: {
        type: "string",
        title: "Database file (optional)",
        description:
          "Absolute path to an existing work-intelligence.sqlite. Leave empty to use the checkout linked by pnpm plugin:link, or ~/.work-intelligence/data.",
        required: false,
        default: "",
      },
    },
    compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: `>=${MINIMUM_NODE}` } },
  };
}

function filesUnder(directory) {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });
}

/** A plain deflate zip; entries are sorted and dated 1980-01-01 so the same input gives the same bytes. */
export function writeZip(sourceDirectory, outputPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of filesUnder(sourceDirectory)) {
    const name = Buffer.from(relative(sourceDirectory, file).replaceAll("\\", "/"));
    const data = readFileSync(file);
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    const header = (signature, size) => {
      const buffer = Buffer.alloc(size);
      buffer.writeUInt32LE(signature, 0);
      return buffer;
    };
    const local = header(0x04034b50, 30);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = header(0x02014b50, 46);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(outputPath, Buffer.concat([...locals, directory, end]));
}

export async function buildPlugin(outputDirectory = join(repositoryRoot, "dist/plugin")) {
  const version = readJson(join(repositoryRoot, "package.json")).version;
  const pluginSource = join(repositoryRoot, "plugins/work-intelligence");
  const plugin = readJson(join(pluginSource, ".claude-plugin/plugin.json"));
  rmSync(outputDirectory, { recursive: true, force: true });

  const pluginDirectory = join(outputDirectory, "work-intelligence");
  cpSync(pluginSource, pluginDirectory, { recursive: true });
  await buildServer(pluginDirectory, version);

  const extensionDirectory = join(outputDirectory, "mcpb");
  await buildServer(extensionDirectory, version);
  writeFileSync(
    join(extensionDirectory, "manifest.json"),
    `${JSON.stringify(mcpbManifest(plugin, version), null, 2)}\n`,
  );

  const pluginZip = join(outputDirectory, `work-intelligence-plugin-${version}.zip`);
  const extension = join(outputDirectory, `work-intelligence-${version}.mcpb`);
  writeZip(pluginDirectory, pluginZip);
  writeZip(extensionDirectory, extension);
  rmSync(extensionDirectory, { recursive: true, force: true });
  return { pluginDirectory, pluginZip, extension, version };
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
  const result = await buildPlugin(output);
  for (const path of [result.pluginDirectory, result.pluginZip, result.extension]) {
    console.log(relative(process.cwd(), path) || path);
  }
}
