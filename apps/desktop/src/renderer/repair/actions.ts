import type { RepairActionId, RepairApi, RepairState } from "@work-intelligence/desktop-core";
import { errorMessageFor, shellMessages, type ShellMessages } from "@work-intelligence/desktop-core/shell/i18n";
import { diagnosticsMessages } from "@work-intelligence/desktop-core/shell/diagnostics-i18n";
import { setupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { requestDiagnosticsPreview } from "./diagnostics-view.js";

/**
 * The things a button on the repair-style tabs does. Each one runs through `guarded`: while one runs, no other starts
 * (a redraw, a second click or a tab change cannot start it twice), the buttons wait, and the page reads the state again
 * when it ends.
 */
export interface ActionHost {
  readonly api: RepairApi;
  current(): RepairState | undefined;
  isWorking(): boolean;
  setWorking(value: boolean): void;
  say(text: string): void;
  /** Draws the open panel again. */
  rerender(): void;
  refresh(): Promise<void>;
  /** The candidates whose storage-risk checkbox is ticked. */
  readonly riskTicked: Set<string>;
  /** Puts focus back on the export button's place after the diagnostics dialog closed. */
  returnFocus(): void;
}

export interface Actions {
  perform(id: RepairActionId): Promise<void>;
  confirm(candidateId: string, allowMigration: boolean, riskConsent: boolean): Promise<void>;
  copyToLocal(candidateId: string | undefined): Promise<void>;
}

function failureText(messages: ShellMessages, errorCode: string | undefined): string {
  return errorCode ? errorMessageFor(messages, errorCode).title : messages.repairFailedGeneric;
}

/** The answer to a request that did not succeed: a restart in progress is shown as such, never as an error. */
function failedAnswer(
  messages: ShellMessages,
  result: { readonly reason: string; readonly errorCode?: string },
): string {
  return result.reason === "busy" ? messages.repairRestarting : failureText(messages, result.errorCode);
}

export function createActions(host: ActionHost): Actions {
  async function guarded(task: (messages: ShellMessages, state: RepairState) => Promise<void>): Promise<void> {
    const state = host.current();
    if (!state || host.isWorking()) return;
    const messages = shellMessages(state.locale);
    host.setWorking(true);
    host.say(messages.repairBusy);
    host.rerender();
    try {
      await task(messages, state);
    } catch {
      host.say(messages.repairFailedGeneric);
    } finally {
      host.setWorking(false);
      await host.refresh();
    }
  }

  async function confirm(candidateId: string, allowMigration: boolean, riskConsent: boolean): Promise<void> {
    await guarded(async (messages) => {
      const result = await host.api.confirmDatabase(
        candidateId,
        allowMigration,
        riskConsent ? host.riskTicked.has(candidateId) : undefined,
      );
      if (result.ok) host.riskTicked.delete(candidateId);
      host.say(result.ok ? messages.repairDone : (result.message ?? failedAnswer(messages, result)));
    });
  }

  async function copyToLocal(candidateId: string | undefined): Promise<void> {
    await guarded(async (messages, state) => {
      const text = setupMessages(state.locale);
      host.say(text.copyWorking);
      const result = await host.api.copyToLocal(candidateId);
      if (result.ok) host.say(text.copyDone);
      else host.say(result.reason === "cancelled" ? "" : (result.message ?? failedAnswer(messages, result)));
    });
  }

  async function perform(id: RepairActionId): Promise<void> {
    await guarded(async (messages, state) => {
      // The retry id is the newest one main handed out, read when the button is pressed, not when it was drawn.
      const retryId = host.current()?.retryOperationId ?? state.retryOperationId;
      if (id === "start-anyway") {
        // Starting next to the old login service is the user's explicit choice, asked once more in plain words.
        if (!window.confirm(setupMessages(state.locale).legacyStartAnywayConfirm)) return;
        const result = await host.api.startAnyway(retryId);
        host.say(result.ok ? messages.repairDone : failedAnswer(messages, result));
      } else if (id === "retry-start") {
        const result = await host.api.retryStart(retryId);
        host.say(result.ok ? messages.repairDone : failedAnswer(messages, result));
      } else if (id === "choose-database") {
        const result = await host.api.chooseDatabase();
        host.say(result.ok || result.reason === "cancelled" ? "" : (result.message ?? messages.repairFailedGeneric));
      } else if (id === "export-diagnostics") {
        // The dialog opens over the page and stays after this action ends; saving happens inside it.
        await requestDiagnosticsPreview({
          api: host.api,
          text: diagnosticsMessages(state.locale),
          say: host.say,
          returnFocus: host.returnFocus,
        });
      } else {
        const target = id === "open-database-folder" ? "database" : id === "open-backups-folder" ? "backups" : "logs";
        const result = await host.api.openFolder(target);
        host.say(result.ok ? "" : messages.repairFailedGeneric);
      }
    });
  }

  return { perform, confirm, copyToLocal };
}
