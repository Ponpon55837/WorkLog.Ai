import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packagedExecutable, programDirectory } from "./helpers.js";

/** What the packaged bundle contains and, on macOS, how it is signed. */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const FORBIDDEN = ["__workIntelligenceDesktopTest", "WORK_INTELLIGENCE_DESKTOP_"];

function resourcesPath(executable: string): string {
  return process.platform === "darwin"
    ? join(dirname(dirname(executable)), "Resources")
    : join(dirname(executable), "resources");
}

function asarPath(executable: string): string {
  return join(resourcesPath(executable), "app.asar");
}

function readBytes(descriptor: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  readSync(descriptor, buffer, 0, length, position);
  return buffer;
}

interface AsarNode {
  files?: Record<string, AsarNode>;
  offset?: string;
  size?: number;
  unpacked?: boolean;
}

/**
 * Every packed file of an asar as `[path, content]`, read from the format directly (a 16-byte pickle prefix, the JSON
 * header, then the file bytes it points to), so the test needs no asar library.
 */
function* asarFiles(file: string): Generator<[string, Buffer]> {
  const descriptor = openSync(file, "r");
  try {
    const prefix = readBytes(descriptor, 0, 16);
    const headerSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    const header = JSON.parse(readBytes(descriptor, 16, jsonLength).toString("utf8")) as AsarNode;
    const contentStart = 8 + headerSize;
    const stack: Array<[string, AsarNode]> = [["", header]];
    while (stack.length > 0) {
      const [path, node] = stack.pop() as [string, AsarNode];
      for (const [name, child] of Object.entries(node.files ?? {})) {
        if (child.files) stack.push([`${path}/${name}`, child]);
        else if (!child.unpacked && child.offset !== undefined) {
          yield [`${path}/${name}`, readBytes(descriptor, contentStart + Number(child.offset), child.size ?? 0)];
        }
      }
    }
  } finally {
    closeSync(descriptor);
  }
}

test("app.asar contains no test hook and no test environment variable", () => {
  let scanned = 0;
  for (const [path, content] of asarFiles(asarPath(packagedExecutable()))) {
    scanned += 1;
    for (const text of FORBIDDEN) expect(content.includes(text), `${path} contains ${text}`).toBe(false);
  }
  // A parse that read nothing would pass the loop above.
  expect(scanned).toBeGreaterThan(5);
});

test("the packaged main bundle keeps DevTools tied to the App not being packaged", () => {
  // The packaged App cannot be driven, so this reads the one place the window's `devTools` option is set: it must be
  // derived from `isPackaged` (so false here), never a literal true. The unpackaged smoke asserts the runtime side.
  const main = [...asarFiles(asarPath(packagedExecutable()))].filter(([path]) =>
    /\/dist\/main\/index\.mjs$/.test(path),
  );
  expect(main.length).toBeGreaterThan(0);
  for (const [path, content] of main) {
    const text = content.toString("utf8");
    expect(text, path).toMatch(/devTools:\s*!\s*[\w$]+\.isPackaged/);
    expect(text, path).not.toMatch(/devTools:\s*(!0|true)\b/);
  }
});

test("the Agent skill ships once, beside the asar, exactly as the repository has it", () => {
  // The Agent page installs this file (main/config.ts skillSourceFile); a missing one would only fail at "套用變更".
  const shipped = join(resourcesPath(packagedExecutable()), "skills", "work-intelligence", "SKILL.md");
  expect(existsSync(shipped)).toBe(true);
  const source = join(repositoryRoot, ".agents", "skills", "work-intelligence", "SKILL.md");
  expect(readFileSync(shipped)).toEqual(readFileSync(source));
  for (const [path] of asarFiles(asarPath(packagedExecutable()))) expect(path).not.toMatch(/\/skills\//);
});

test("the .app passes codesign and its Gatekeeper assessment is recorded", async ({
  browserName: _browserName,
}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS only");
  const app = programDirectory(packagedExecutable());
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
  expect(verify.status, verify.stderr).toBe(0);
  // Ad-hoc signed and not notarized: Gatekeeper is expected to reject it, so this is only recorded.
  const assess = spawnSync("spctl", ["--assess", "--type", "execute", "-vv", app], { encoding: "utf8" });
  testInfo.annotations.push({
    type: "spctl",
    description: `exit ${assess.status}: ${`${assess.stdout}${assess.stderr}`.trim()}`,
  });
});
