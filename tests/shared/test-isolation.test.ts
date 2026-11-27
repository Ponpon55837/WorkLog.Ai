import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_PORT, isolatedEnvironment, SENTINEL_PORT } from "../helpers/isolated-environment.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function sourceFiles(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(path, extensions);
    }
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

function relativePath(path: string): string {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

describe("test isolation guard (runtime)", () => {
  it("points the home directory at a fresh temp directory instead of the real home", () => {
    expect(os.homedir()).toBe(isolatedEnvironment.home);
    expect(os.homedir()).not.toBe(isolatedEnvironment.realHome);
    expect(isInside(os.tmpdir(), os.homedir()) || isInside(isolatedEnvironment.root, os.homedir())).toBe(true);
    expect(isInside(isolatedEnvironment.realHome, isolatedEnvironment.root)).toBe(false);
  });

  it("redirects every Agent, config and platform location the code reads into the temp root", () => {
    const names = [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "WORK_INTELLIGENCE_CONFIG_DIR",
    ];
    for (const name of names) {
      const value = process.env[name] ?? "";
      expect(value, name).not.toBe("");
      expect(value === isolatedEnvironment.home || isInside(isolatedEnvironment.home, value), name).toBe(true);
    }
  });

  it("drops database and checkout overrides from the developer shell and pins the port to a sentinel", () => {
    expect(process.env.WORK_INTELLIGENCE_DB).toBeUndefined();
    expect(process.env.WORK_INTELLIGENCE_HOME).toBeUndefined();
    expect(process.env.WORK_INTELLIGENCE_BACKUP_DIR).toBeUndefined();
    expect(process.env.WORK_INTELLIGENCE_PORT).toBe(SENTINEL_PORT);
    expect(Number(SENTINEL_PORT)).not.toBe(FORBIDDEN_PORT);
  });

  it("lets child processes inherit the isolated home", () => {
    const result = spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"], {
      encoding: "utf8",
      env: process.env,
    });
    expect(result.stdout).toBe(isolatedEnvironment.home);
  });

  it("refuses to listen on or connect to port 3210 in this process", () => {
    expect(() => new net.Server().listen(FORBIDDEN_PORT, "127.0.0.1")).toThrow(/port 3210/);
    expect(() => net.connect({ port: FORBIDDEN_PORT, host: "127.0.0.1" })).toThrow(/port 3210/);
    expect(() => net.connect(FORBIDDEN_PORT)).toThrow(/port 3210/);
  });

  it("still allows ephemeral ports", async () => {
    const server = net.createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    expect(address && typeof address === "object" ? address.port : 0).not.toBe(FORBIDDEN_PORT);
    await new Promise<void>((done) => server.close(() => done()));
  });
});

describe("test isolation guard (static)", () => {
  // 3210 may appear as plain data (the default value in settings, printed URLs, listen-error text): those lines
  // only assert or format the constant. What is forbidden is using it where a socket is opened or a port is injected.
  const socketUse = /\b(listen|connect|createConnection|fetch|request)\s*\(|WORK_INTELLIGENCE_PORT|--port/;

  it("never uses the literal port 3210 (or DEFAULT_SERVER_PORT) to open a socket or configure a server", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(repositoryRoot, "tests"), [".ts", ".mjs", ".js"])) {
      const path = relativePath(file);
      if (path === "tests/shared/test-isolation.test.ts" || path === "tests/helpers/isolated-environment.ts") {
        continue;
      }
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line) || !socketUse.test(line)) {
            return;
          }
          if (/\b3210\b/.test(line) || /\bDEFAULT_SERVER_PORT\b/.test(line)) {
            offenders.push(`${path}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("registers the isolation setup in every vitest config and keeps a fallback for config-less test scripts", () => {
    const configs = [
      ...["packages", "apps"].flatMap((group) =>
        readdirSync(join(repositoryRoot, group)).flatMap((name) => {
          const directory = join(repositoryRoot, group, name);
          return existsSync(directory) && readdirSync(directory).some((file) => file.startsWith("vitest"))
            ? readdirSync(directory)
                .filter((file) => file.startsWith("vitest") && file.endsWith(".ts"))
                .map((file) => join(directory, file))
            : [];
        }),
      ),
      join(repositoryRoot, "vitest.config.ts"),
    ];
    expect(configs.length).toBeGreaterThanOrEqual(12);
    const missing = configs.filter((file) => !readFileSync(file, "utf8").includes("isolatedEnvironmentSetup]"));
    expect(missing.map(relativePath)).toEqual([]);

    for (const group of ["packages", "apps"]) {
      for (const name of readdirSync(join(repositoryRoot, group))) {
        const manifest = join(repositoryRoot, group, name, "package.json");
        if (!existsSync(manifest)) {
          continue;
        }
        const script = (JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> }).scripts
          ?.test;
        if (script?.includes("vitest")) {
          const usesConfig = script.includes("--config");
          expect(usesConfig || existsSync(join(repositoryRoot, "vitest.config.ts")), `${group}/${name}`).toBe(true);
        }
      }
    }
  });

  it("keeps the Playwright run on a temp home, a temp database and a non-default port", () => {
    const config = readFileSync(join(repositoryRoot, "playwright.config.ts"), "utf8");
    expect(config).not.toMatch(/\b3210\b/);
    expect(config).toContain("os.tmpdir()");
    for (const name of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "WORK_INTELLIGENCE_CONFIG_DIR",
      "WORK_INTELLIGENCE_DB",
      "WORK_INTELLIGENCE_PORT",
    ]) {
      expect(config, name).toMatch(new RegExp(`\\b${name}:`));
    }
    expect(readFileSync(join(repositoryRoot, "scripts/run-e2e.mjs"), "utf8")).not.toMatch(/\b3210\b/);
  });
});
