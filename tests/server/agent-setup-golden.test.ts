import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentSetupCli, type AgentSetupCliDependencies } from "../../apps/server/src/agent-setup.js";

interface GoldenFixture {
  temporaryRoot: string;
  dependencies: AgentSetupCliDependencies;
  output: string[];
}

const temporaryRoots: string[] = [];

/** The fixture repository's directory name: a space and an apostrophe, so quoting is pinned too. */
const REPOSITORY_NAME = "repo with space's name";

/** `text` escaped as inside a JSON (or TOML basic) string, `times` times: a TOML block stored in JSON is escaped twice. */
function escaped(text: string, times: number): string {
  return times === 0 ? text : escaped(JSON.stringify(text).slice(1, -1), times - 1);
}

/**
 * Every form the repository name takes in a written file or transcript, longest first: raw or POSIX shell-quoted
 * (`'\\''`), escaped zero to two times. Windows separators are rewritten only around them, so the shell escape's
 * backslash is never taken for a path separator.
 */
const REPOSITORY_NAME_FORMS = [2, 1, 0]
  .flatMap((times) => [escaped(REPOSITORY_NAME.replaceAll("'", "'\\''"), times), escaped(REPOSITORY_NAME, times)])
  .map((form, index) => ({ form, placeholder: `\u0000repository-${index}\u0000` }));
/** A path under `<TMP>` or `~` with Windows separators: a run of backslashes (raw, or escaped once or twice). */
const WINDOWS_PATH = /(<TMP>|~)(\\+[^\\\s"'`,()（）[\]]+)+/g;

function createGoldenFixture(): GoldenFixture {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "work-intelligence-agent-setup-golden-"));
  temporaryRoots.push(temporaryRoot);
  const homeDirectory = join(temporaryRoot, "home");
  const repositoryRoot = join(temporaryRoot, REPOSITORY_NAME);
  mkdirSync(join(homeDirectory, ".codex"), { recursive: true });
  mkdirSync(join(homeDirectory, ".claude"), { recursive: true });
  mkdirSync(join(repositoryRoot, ".agents", "skills", "work-intelligence"), { recursive: true });
  mkdirSync(join(repositoryRoot, "apps", "mcp", "dist"), { recursive: true });
  writeFileSync(join(repositoryRoot, ".agents", "skills", "work-intelligence", "SKILL.md"), "# Work Intelligence\n");
  for (const filename of ["index.js", "launcher.js", "finalize-reminder.js", "codex-finalize-reminder.js"]) {
    writeFileSync(join(repositoryRoot, "apps", "mcp", "dist", filename), `// fixture ${filename}\n`);
  }
  writeFileSync(join(homeDirectory, ".codex", "config.toml"), '# prefs\nmodel = "fixture-model"\n');
  writeFileSync(
    join(homeDirectory, ".claude.json"),
    JSON.stringify({ mcpServers: { existing: { command: "node", args: ["existing.js"] } } }, null, 2) + "\n",
  );
  const output: string[] = [];
  return {
    temporaryRoot,
    output,
    dependencies: {
      homeDirectory,
      repositoryRoot,
      now: new Date("2026-09-28T12:34:56.000Z"),
      platform: "linux",
      print: (message) => output.push(message),
      confirm: async () => true,
    },
  };
}

/**
 * On Windows the CLI prints and writes native paths (`~\\.codex\\config.toml`); the goldens are the same on every host, so
 * the separators of the paths it already rewrites (`<TMP>` and home-relative `~` paths) become `/`. Nothing else changes:
 * a backslash anywhere else stays and still has to match.
 */
function portablePaths(text: string): string {
  if (process.platform !== "win32") return text;
  let protectedText = text;
  for (const { form, placeholder } of REPOSITORY_NAME_FORMS)
    protectedText = protectedText.replaceAll(form, placeholder);
  const portable = protectedText.replaceAll(WINDOWS_PATH, (match) => match.replaceAll(/\\+/g, "/"));
  return REPOSITORY_NAME_FORMS.reduce(
    (result, { form, placeholder }) => result.replaceAll(placeholder, form),
    portable,
  );
}

function normalize(text: string, fixture: GoldenFixture): string {
  // A backup name carries the hash of the file it copies, and an installed config embeds the temporary root (in JSON
  // and TOML on Windows with its backslashes escaped, twice for a TOML block stored in JSON).
  const roots = [2, 1, 0].map((times) => escaped(fixture.temporaryRoot, times));
  return portablePaths(
    roots
      .reduce((result, root) => result.replaceAll(root, "<TMP>"), text)
      .replaceAll(/(backup-\d{8}T\d{9}Z)-[0-9a-f]{8}/g, "$1-<HASH>"),
  );
}

function snapshotFiles(directory: string, fixture: GoldenFixture): string {
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        entries.push(
          normalize(`=== ${relative(directory, path).split(sep).join("/")}\n${readFileSync(path, "utf8")}`, fixture),
        );
    }
  };
  walk(directory);
  // Sorted after normalizing: the raw backup names carry hashes that depend on the temporary root.
  return entries.sort().join("\n");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("setup:agents golden output", () => {
  it("pins the install transcript, exit code and every written file", async () => {
    const fixture = createGoldenFixture();
    const exitCode = await runAgentSetupCli([], fixture.dependencies);
    expect(exitCode).toBe(0);
    await expect(normalize(fixture.output.join("\n"), fixture)).toMatchFileSnapshot("./__golden__/install-output.txt");
    await expect(snapshotFiles(join(fixture.temporaryRoot, "home"), fixture)).toMatchFileSnapshot(
      "./__golden__/install-files.txt",
    );
  });

  it("pins the no-op rerun and the uninstall transcript", async () => {
    const fixture = createGoldenFixture();
    await runAgentSetupCli([], fixture.dependencies);
    fixture.output.length = 0;
    expect(await runAgentSetupCli([], fixture.dependencies)).toBe(0);
    await expect(normalize(fixture.output.join("\n"), fixture)).toMatchFileSnapshot("./__golden__/rerun-output.txt");
    fixture.output.length = 0;
    expect(await runAgentSetupCli(["--uninstall"], fixture.dependencies)).toBe(0);
    await expect(normalize(fixture.output.join("\n"), fixture)).toMatchFileSnapshot(
      "./__golden__/uninstall-output.txt",
    );
    await expect(snapshotFiles(join(fixture.temporaryRoot, "home"), fixture)).toMatchFileSnapshot(
      "./__golden__/uninstall-files.txt",
    );
  });

  it("pins the conflict, plugin, declined and bad-argument transcripts with their exit codes", async () => {
    const fixture = createGoldenFixture();
    rmSync(join(fixture.dependencies.repositoryRoot, "apps", "mcp", "dist", "launcher.js"));
    expect(await runAgentSetupCli([], fixture.dependencies)).toBe(1);
    const transcripts = [normalize(fixture.output.join("\n"), fixture)];
    expect(existsSync(join(fixture.temporaryRoot, "home", ".work-intelligence-agent-setup.json"))).toBe(false);

    const plugin = createGoldenFixture();
    writeFileSync(
      join(plugin.temporaryRoot, "home", ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "work-intelligence@fixture": true } }),
    );
    expect(await runAgentSetupCli([], plugin.dependencies)).toBe(0);
    transcripts.push(normalize(plugin.output.join("\n"), plugin));

    const declined = createGoldenFixture();
    expect(await runAgentSetupCli([], { ...declined.dependencies, confirm: async () => false })).toBe(0);
    transcripts.push(normalize(declined.output.join("\n"), declined));

    const bad = createGoldenFixture();
    expect(await runAgentSetupCli(["--bogus"], bad.dependencies)).toBe(1);
    transcripts.push(normalize(bad.output.join("\n"), bad));

    await expect(transcripts.join("\n#####\n")).toMatchFileSnapshot("./__golden__/other-output.txt");
  });
});
