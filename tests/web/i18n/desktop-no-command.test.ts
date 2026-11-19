import { describe, expect, it } from "vitest";

/**
 * The desktop-managed window never shows a command (M-15). The web tests run without a DOM, so the guard is structural:
 * the command and its copy button of the Agent hint and of the first-run checklist sit only behind a "not desktop-managed"
 * condition, and the desktop branch has its own command-free sentence in both languages.
 */

const SOURCES = import.meta.glob(
  [
    "../../../apps/web/src/views/SystemStatusView.vue",
    "../../../apps/web/src/views/DashboardView.vue",
    "../../../apps/web/src/components/domain/FirstRunChecklist.vue",
    "../../../apps/web/src/components/domain/BackupSection.vue",
    "../../../apps/web/src/i18n/locales/*.json",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const read = (relative: string): string => {
  const text = SOURCES[relative];
  if (text === undefined) throw new Error(`source not loaded: ${relative}`);
  return text;
};
const statusView = read("../../../apps/web/src/views/SystemStatusView.vue");
const checklist = read("../../../apps/web/src/components/domain/FirstRunChecklist.vue");
const backups = read("../../../apps/web/src/components/domain/BackupSection.vue");
const dashboard = read("../../../apps/web/src/views/DashboardView.vue");

describe("desktop-managed pages show no command", () => {
  it("the status page's Agent hint has a command-free desktop branch before the command branch", () => {
    const desktopBranch = statusView.indexOf('v-if="agentIssueCount > 0 && status.desktop?.managed"');
    const commandBranch = statusView.indexOf('v-else-if="agentIssueCount > 0"');
    expect(desktopBranch).toBeGreaterThan(-1);
    expect(commandBranch).toBeGreaterThan(desktopBranch);
    const desktopMarkup = statusView.slice(desktopBranch, commandBranch);
    expect(desktopMarkup).toContain("agentsInOtherProjectsNeedDesktop");
    expect(desktopMarkup).not.toMatch(/SETUP_COMMAND|UiCopyButton|copyCommand/);
    // The command is only ever rendered in the branch that follows.
    expect(statusView.indexOf("<code>{{ SETUP_COMMAND }}</code>")).toBeGreaterThan(commandBranch);
    expect(statusView.indexOf(':text="SETUP_COMMAND"')).toBeGreaterThan(commandBranch);
  });

  it("the first-run checklist hides its copy button when desktop-managed, and the Dashboard tells it so", () => {
    expect(checklist).toMatch(/<UiCopyButton\s+v-if="!desktopManaged"/);
    expect(checklist.match(/<UiCopyButton/g)).toHaveLength(1);
    expect(dashboard).toContain(':desktop-managed="systemStatus?.desktop?.managed === true"');
  });

  it("the page subtitle, the maintenance hint and the restore steps each have a command-free desktop branch", () => {
    expect(statusView).toMatch(
      /status\?\.desktop\?\.managed\s*\?\s*'systemStatus\.localServiceStatusDesktop'\s*:\s*'systemStatus\.localServiceDatabaseBackupMaintenance'/,
    );
    expect(statusView).toMatch(
      /status\.desktop\?\.managed\s*\?\s*'systemStatus\.recentResultsAppearAfterMaintenance'\s*:\s*'systemStatus\.recentResultsAppearAfterRunning'/,
    );
    const desktopBranch = backups.indexOf('v-if="desktopManaged"');
    const commandBranch = backups.indexOf("<template v-else>");
    expect(desktopBranch).toBeGreaterThan(-1);
    expect(commandBranch).toBeGreaterThan(desktopBranch);
    expect(backups.slice(desktopBranch, commandBranch)).not.toMatch(/restoreCommand|pnpm|UiCopyButton/);
    expect(backups.indexOf("<code>{{ restoreCommand }}</code>")).toBeGreaterThan(commandBranch);
  });

  it("the desktop sentence exists in both languages and holds no command wording", () => {
    for (const file of ["zh-TW", "en-US"]) {
      const messages = JSON.parse(read(`../../../apps/web/src/i18n/locales/${file}.json`)) as {
        systemStatus: Record<string, string>;
      };
      const text = messages.systemStatus.agentsInOtherProjectsNeedDesktop;
      expect(text, file).toBeTruthy();
      expect(text, file).not.toMatch(/\b(?:pnpm|npm|npx|yarn)\b|終端|指令|命令|terminal|command/i);
    }
  });
});
