import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(repositoryRoot, "scripts", "prepare-release.mjs");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runPreparation({
  tag = "v1.0.0",
  version = "1.0.0",
  changelog = "## [Unreleased]\n\n## [1.0.0] - 2026-09-30\n\n### Added\n\n- Released feature.\n\n## [0.9.0] - 2026-09-01\n\nOlder notes.\n",
}: {
  tag?: string;
  version?: string;
  changelog?: string;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-release-test-"));
  temporaryDirectories.push(directory);
  const runnerTemp = join(directory, "runner-temp");
  const packagePath = join(directory, "package.json");
  const changelogPath = join(directory, "CHANGELOG.md");
  const outputPath = join(directory, "github-output");
  writeFileSync(packagePath, JSON.stringify({ version }), "utf8");
  writeFileSync(changelogPath, changelog, "utf8");

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REF_NAME: tag,
      GITHUB_OUTPUT: outputPath,
      RELEASE_CHANGELOG: changelogPath,
      RELEASE_PACKAGE_JSON: packagePath,
      RUNNER_TEMP: runnerTemp,
    },
  });

  return { ...result, outputPath };
}

describe("release preparation", () => {
  it("runs only for version tags and waits for all checks before publishing", () => {
    const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");

    expect(workflow).toContain('      - "v*"');
    expect(workflow).not.toMatch(/^\s+(pull_request|workflow_dispatch):/m);
    expect(workflow).toContain("needs: [quality, e2e]");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("--verify-tag");
  });

  it("extracts only the dated section matching the application tag", () => {
    const result = runPreparation();

    expect(result.status).toBe(0);
    const output = readFileSync(result.outputPath, "utf8");
    expect(output).toContain("version=1.0.0");
    const notesPath = output.match(/release_notes_file=(.+)\n/)?.[1];
    expect(notesPath).toBeTruthy();

    const notes = readFileSync(notesPath!, "utf8");
    expect(notes).toContain("- Released feature.");
    expect(notes).not.toContain("Older notes.");
    expect(notes).not.toContain("Unreleased");
  });

  it("rejects a tag that does not match package.json", () => {
    const result = runPreparation({ tag: "v0.9.0" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must match the root package.json version");
  });

  it("rejects a release without a dated matching changelog section", () => {
    const result = runPreparation({ changelog: "## [Unreleased]\n\nNo version section yet.\n" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exactly one dated heading");
  });

  it("rejects malformed semantic versions", () => {
    const result = runPreparation({ tag: "v01.0.0", version: "01.0.0" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must match the root package.json version");
  });
});
