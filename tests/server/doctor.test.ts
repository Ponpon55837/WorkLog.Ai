import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDatabaseReadOnly, inspectGlobalHooks } from "../../apps/server/src/doctor.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "work-intelligence-doctor-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("pnpm doctor read-only checks", () => {
  it("checks database integrity and schema metadata without changing the database", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "synthetic.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL);" +
        "INSERT INTO schema_migrations VALUES (12, 'synthetic', '2026-09-25T00:00:00.000Z');" +
        "CREATE TABLE database_maintenance_runs (id TEXT, started_at TEXT, completed_at TEXT, status TEXT, " +
        "backup_file_name TEXT, indexed_sessions INTEGER, indexed_knowledge INTEGER, indexed_chunks INTEGER, " +
        "indexed_paths INTEGER, failure_code TEXT);" +
        "INSERT INTO database_maintenance_runs VALUES ('synthetic', '2026-09-25T01:00:00.000Z', " +
        "'2026-09-25T01:01:00.000Z', 'completed', 'synthetic-backup.sqlite', 3, 1, 8, 2, NULL);",
    );
    database.close();
    const before = createHash("sha256").update(readFileSync(databasePath)).digest("hex");

    await expect(inspectDatabaseReadOnly(databasePath)).resolves.toMatchObject({
      state: "ok",
      integrity: "ok",
      schemaVersion: 12,
      maintenance: {
        status: "completed",
        backupFileName: "synthetic-backup.sqlite",
        indexedSessions: 3,
        indexedKnowledge: 1,
      },
    });

    const after = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
    expect(after).toBe(before);
  });

  it("checks only global hook configuration and requires both Codex events", () => {
    const directory = temporaryDirectory();
    const homeDirectory = join(directory, "home");
    const repositoryRoot = join(directory, "repository");
    const claudeHook = resolve(repositoryRoot, "apps/mcp/dist/finalize-reminder.js");
    const codexHook = resolve(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js");
    mkdirSync(join(homeDirectory, ".claude"), { recursive: true });
    mkdirSync(join(homeDirectory, ".codex"), { recursive: true });
    const claudeSettingsPath = join(homeDirectory, ".claude", "settings.json");
    const codexHooksPath = join(homeDirectory, ".codex", "hooks.json");
    const claudeSettings = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "node " + JSON.stringify(claudeHook) }] }],
      },
    });
    const codexHooks = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: "^(apply_patch|.*work_finalize_session)$",
            hooks: [{ type: "command", command: "node " + JSON.stringify(codexHook) }],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "node " + JSON.stringify(codexHook) }] }],
      },
    });
    writeFileSync(claudeSettingsPath, claudeSettings);
    writeFileSync(codexHooksPath, codexHooks);

    expect(inspectGlobalHooks(homeDirectory, repositoryRoot)).toEqual({
      claudeConfigured: true,
      codexConfigured: true,
    });

    writeFileSync(
      codexHooksPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "^(apply_patch|.*work_finalize_session)$",
              hooks: [{ type: "command", command: "node " + JSON.stringify(codexHook) }],
            },
          ],
        },
      }),
    );
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot).codexConfigured).toBe(false);
    expect(readFileSync(claudeSettingsPath, "utf8")).toBe(claudeSettings);
  });

  it("recognizes a Claude Stop hook written in exec form with the script in args", () => {
    const directory = temporaryDirectory();
    const homeDirectory = join(directory, "home");
    const repositoryRoot = join(directory, "repository");
    const claudeHook = resolve(repositoryRoot, "apps/mcp/dist/finalize-reminder.js");
    mkdirSync(join(homeDirectory, ".claude"), { recursive: true });
    const claudeSettingsPath = join(homeDirectory, ".claude", "settings.json");
    const settingsWith = (args: string[]) =>
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/node", args }] }] } });

    writeFileSync(claudeSettingsPath, settingsWith([claudeHook]));
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot).claudeConfigured).toBe(true);

    writeFileSync(claudeSettingsPath, settingsWith([resolve(directory, "other/finalize-reminder.js")]));
    expect(inspectGlobalHooks(homeDirectory, repositoryRoot).claudeConfigured).toBe(false);
  });
});
