/**
 * Downloads the official Node.js and Electron distributions for this platform and checks them against a SHA-256.
 * Node.js is checked against the hashes pinned in node-checksums.mjs, so the shipped runtime does not depend on the
 * origin's own SHASUMS256.txt. Electron (only the rejected comparison runtime) is checked against the SHASUMS256.txt
 * published next to it, which catches corruption but is not an independent trust root. Downloads are untrusted until
 * the hash matches, and they are extracted into a directory of their own that nothing is executed from.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DEFAULT_NODE_VERSION } from "./common.mjs";
import { pinnedNodeSha256 } from "./node-checksums.mjs";

const NODE_DIST = "https://nodejs.org/dist";
const ELECTRON_RELEASES = "https://github.com/electron/electron/releases/download";

async function fetchOk(url) {
  const response = await globalThis.fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return response;
}

/** Parses `<sha256>  <file>` lines (`*` marks binary mode in some tools). */
export function parseShasums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match) sums.set(match[2].replace(/^\.\//, ""), match[1]);
  }
  return sums;
}

async function sha256Of(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Downloads `url` to `destination` unless a file with the expected hash is already there. */
async function downloadVerified(url, expectedSha256, destination) {
  if (existsSync(destination) && (await sha256Of(destination)) === expectedSha256) return false;
  const partial = `${destination}.partial`;
  const response = await fetchOk(url);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const actual = await sha256Of(partial);
  if (actual !== expectedSha256) {
    rmSync(partial, { force: true });
    throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
  }
  await rename(partial, destination);
  return true;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.error}`);
  }
}

/**
 * Extracts `archive` into the new, empty `destination`. Windows uses the system bsdtar (it reads zip); macOS uses
 * `ditto` for zip, which keeps symlinks and extended attributes of an app bundle; Linux uses `unzip` or `tar`.
 */
export function extractArchive(archive, destination) {
  if (existsSync(destination) && readdirSync(destination).length > 0) {
    throw new Error(`${destination} must be empty before extracting into it`);
  }
  mkdirSync(destination, { recursive: true });
  const isZip = archive.endsWith(".zip");
  if (process.platform === "win32") {
    run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "-C", destination]);
  } else if (isZip && process.platform === "darwin") {
    run("ditto", ["-x", "-k", archive, destination]);
  } else if (isZip) {
    run("unzip", ["-q", archive, "-d", destination]);
  } else {
    // --no-same-owner: as root, tar would otherwise keep the archive's uid, and the launcher rejects foreign owners.
    run("tar", ["-xzf", archive, "-C", destination, "--no-same-owner"]);
  }
}

/** The newest LTS release of Node.js major `request` ("24"), or the exact version ("v24.22.3"). */
async function resolveNodeVersion(request) {
  if (/^v\d+\.\d+\.\d+$/.test(request)) return request;
  if (!/^\d+$/.test(request)) throw new Error(`--node-version must be a major ("24") or a version ("v24.22.3")`);
  const index = await (await fetchOk(`${NODE_DIST}/index.json`)).json();
  const release = index.find((entry) => entry.lts && entry.version.startsWith(`v${request}.`));
  if (!release) throw new Error(`no LTS release of Node.js ${request} in ${NODE_DIST}/index.json`);
  return release.version;
}

/** The Node.js binary of this platform, downloaded, verified and unpacked under `workDirectory`. */
export async function prepareNode({ version = DEFAULT_NODE_VERSION, cacheDirectory, workDirectory }) {
  const resolved = await resolveNodeVersion(version);
  const windows = process.platform === "win32";
  const platform = windows ? "win" : process.platform;
  const stem = `node-${resolved}-${platform}-${process.arch}`;
  const archiveName = `${stem}.${windows ? "zip" : "tar.gz"}`;
  const expected = pinnedNodeSha256(resolved, archiveName);
  if (!expected) {
    throw new Error(`${archiveName} has no pinned SHA-256; add it to node-checksums.mjs (see the comment there)`);
  }
  mkdirSync(cacheDirectory, { recursive: true });
  const archive = join(cacheDirectory, archiveName);
  const downloaded = await downloadVerified(`${NODE_DIST}/${resolved}/${archiveName}`, expected, archive);
  const extracted = join(workDirectory, "node-extract");
  extractArchive(archive, extracted);
  const base = join(extracted, stem);
  return {
    version: resolved.slice(1),
    downloaded,
    archiveSha256: expected,
    // Only the binary and the licence are kept; npm, headers and docs are not needed to run the bundles.
    keep: [
      { from: join(base, windows ? "node.exe" : join("bin", "node")), to: windows ? "node/node.exe" : "node/bin/node" },
      { from: join(base, "LICENSE"), to: "node/LICENSE" },
    ],
    executable: windows ? "node/node.exe" : "node/bin/node",
  };
}

/** The official Electron build of this platform, downloaded, verified and unpacked under `workDirectory`. */
export async function prepareElectron({ version, cacheDirectory, workDirectory }) {
  const archiveName = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  const base = `${ELECTRON_RELEASES}/v${version}`;
  const sums = parseShasums(await (await fetchOk(`${base}/SHASUMS256.txt`)).text());
  const expected = sums.get(archiveName);
  if (!expected) throw new Error(`${archiveName} is not listed in ${base}/SHASUMS256.txt`);
  mkdirSync(cacheDirectory, { recursive: true });
  const archive = join(cacheDirectory, archiveName);
  const downloaded = await downloadVerified(`${base}/${archiveName}`, expected, archive);
  const extracted = join(workDirectory, "electron-extract");
  extractArchive(archive, extracted);
  const executables = {
    win32: "electron/electron.exe",
    darwin: "electron/Electron.app/Contents/MacOS/Electron",
    linux: "electron/electron",
  };
  return {
    version,
    downloaded,
    archiveSha256: expected,
    // The whole distribution is kept: Electron needs its .pak, .dll, .so and framework files to start, even as Node.
    keepDirectory: { from: extracted, to: "electron" },
    executable: executables[process.platform],
  };
}
