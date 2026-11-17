import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentSetupPlanOptions } from "@work-intelligence/agent-setup";

export interface SetupFixture {
  temporaryRoot: string;
  options: AgentSetupPlanOptions;
  paths: {
    manifest: string;
    journal: string;
    codexConfig: string;
    codexHooks: string;
    claudeJson: string;
    claudeSettings: string;
    codexSkill: string;
    skillSource: string;
  };
}

const temporaryRoots: string[] = [];

/** A synthetic home, a checkout with the build outputs setup requires, and a seeded user config. */
export function createFixture(): SetupFixture {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "work-intelligence-agent-setup-package-"));
  temporaryRoots.push(temporaryRoot);
  const homeDirectory = join(temporaryRoot, "home");
  const repositoryRoot = join(temporaryRoot, "repo with space's name");
  const skillSource = join(repositoryRoot, ".agents", "skills", "work-intelligence", "SKILL.md");
  mkdirSync(dirname(skillSource), { recursive: true });
  mkdirSync(join(repositoryRoot, "apps", "mcp", "dist"), { recursive: true });
  mkdirSync(join(homeDirectory, ".codex"), { recursive: true });
  writeFileSync(skillSource, "# Work Intelligence\n\nFixture skill.\n");
  for (const filename of ["index.js", "launcher.js", "finalize-reminder.js", "codex-finalize-reminder.js"]) {
    writeFileSync(join(repositoryRoot, "apps", "mcp", "dist", filename), `// fixture ${filename}\n`);
  }
  const paths = {
    manifest: join(homeDirectory, ".work-intelligence-agent-setup.json"),
    journal: join(homeDirectory, ".work-intelligence-agent-setup.journal.json"),
    codexConfig: join(homeDirectory, ".codex", "config.toml"),
    codexHooks: join(homeDirectory, ".codex", "hooks.json"),
    claudeJson: join(homeDirectory, ".claude.json"),
    claudeSettings: join(homeDirectory, ".claude", "settings.json"),
    codexSkill: join(homeDirectory, ".agents", "skills", "work-intelligence", "SKILL.md"),
    skillSource,
  };
  writeFileSync(paths.codexConfig, '# prefs\nmodel = "fixture-model"\n');
  writeFileSync(
    paths.claudeJson,
    JSON.stringify({ mcpServers: { existing: { command: "node", args: ["existing.js"] } } }, null, 2) + "\n",
  );
  return {
    temporaryRoot,
    options: { homeDirectory, repositoryRoot, now: new Date("2026-09-28T12:34:56.000Z"), platform: "linux" },
    paths,
  };
}

export function removeFixtures(): void {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
