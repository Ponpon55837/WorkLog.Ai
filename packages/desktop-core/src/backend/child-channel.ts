import { parseDesktopChildMessage, type DesktopChildMessage } from "@work-intelligence/schema";
import { BackendFailure } from "./errors.js";
import type { BackendSupervisorDependencies, SupervisedChild } from "./types.js";

export interface ChildExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type MessageOfType<T extends DesktopChildMessage["type"]> = Extract<DesktopChildMessage, { type: T }>;

interface Waiter {
  readonly type: DesktopChildMessage["type"];
  readonly resolve: (message: DesktopChildMessage) => void;
  readonly reject: (failure: BackendFailure) => void;
  readonly timer: unknown | undefined;
}

const MAX_PENDING_MESSAGES = 32;

type ChannelTimers = Pick<BackendSupervisorDependencies, "setTimer" | "clearTimer">;

function describeExit(exitCode: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `the backend was ended by ${signal}` : `the backend exited with code ${exitCode ?? "unknown"}`;
}

export class ChildChannel {
  readonly exited: Promise<ChildExit>;
  lastReportedFailure: BackendFailure | undefined;
  private readonly child: SupervisedChild;
  private readonly timers: ChannelTimers;
  private readonly log: (line: string) => void;
  private readonly pending: DesktopChildMessage[] = [];
  private readonly waiters = new Set<Waiter>();
  private backupListener: ((at: string) => void) | undefined;
  private changedListener: (() => void) | undefined;
  private openAgentSetupListener: (() => void) | undefined;
  private setLanguageListener: ((locale: "zh-TW" | "en") => void) | undefined;
  private openPortSettingsListener: ((request: { preferences?: unknown; route?: string }) => void) | undefined;
  private ended: BackendFailure | undefined;
  private exit: ChildExit | undefined;

  constructor(child: SupervisedChild, timers: ChannelTimers, log: (line: string) => void) {
    this.child = child;
    this.timers = timers;
    this.log = log;
    this.exited = new Promise<ChildExit>((resolve) => {
      const finish = (exit: ChildExit, failure: BackendFailure): void => {
        this.exit ??= exit;
        this.end(failure);
        resolve(this.exit);
      };
      child.on("exit", (exitCode: number | null, signal: NodeJS.Signals | null) =>
        finish({ exitCode, signal }, new BackendFailure("CHILD_EXITED", describeExit(exitCode, signal))),
      );
      // 'error' alone does not mean the process ended (a failed kill() or send() emits it too); only a child without a pid
      // failed to spawn. `exited` stays unresolved until 'exit'.
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (child.pid !== undefined) {
          this.log(`[backend] the child process reported an error (${error.code ?? "error"}); it has not exited`);
          return;
        }
        finish(
          { exitCode: null, signal: null },
          new BackendFailure("RUNTIME_MISSING", `the runtime could not be started (${error.code ?? "error"})`),
        );
      });
    });
    child.on("message", (raw: unknown) => this.receive(raw));
  }

  get endedFailure(): BackendFailure | undefined {
    return this.ended;
  }

  get exitInfo(): ChildExit | undefined {
    return this.exit;
  }

  expect<T extends DesktopChildMessage["type"]>(type: T, timeoutMs: number | null): Promise<MessageOfType<T>> {
    const index = this.pending.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(this.pending.splice(index, 1)[0] as MessageOfType<T>);
    if (this.ended) return Promise.reject(this.ended);
    return new Promise<MessageOfType<T>>((resolve, reject) => {
      const waiter: Waiter = {
        type,
        resolve: (message) => resolve(message as MessageOfType<T>),
        reject,
        timer:
          timeoutMs === null
            ? undefined
            : this.timers.setTimer(() => {
                this.waiters.delete(waiter);
                reject(new BackendFailure("CHILD_START_TIMEOUT", `no ${type} message within ${timeoutMs} ms`));
              }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  send(message: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const closed = (): BackendFailure => new BackendFailure("CHILD_PROTOCOL_ERROR", "the channel is closed");
      try {
        this.child.send(message, (error) => (error ? reject(closed()) : resolve()));
      } catch {
        reject(closed());
      }
    });
  }

  onBackupCompleted(listener: (at: string) => void): void {
    this.backupListener = listener;
  }

  onBackupsChanged(listener: () => void): void {
    this.changedListener = listener;
  }

  onOpenAgentSetup(listener: () => void): void {
    this.openAgentSetupListener = listener;
  }

  onOpenPortSettings(listener: (request: { preferences?: unknown; route?: string }) => void): void {
    this.openPortSettingsListener = listener;
  }

  onSetLanguage(listener: (locale: "zh-TW" | "en") => void): void {
    this.setLanguageListener = listener;
  }

  private receive(raw: unknown): void {
    const parsed = parseDesktopChildMessage(raw);
    if (!parsed.ok) {
      this.log(`[backend] dropped a child message (${parsed.reason})`);
      return;
    }
    const message = parsed.message;
    if (message.type === "backup-completed") {
      this.backupListener?.(message.at);
      return;
    }
    if (message.type === "backups-changed") {
      this.changedListener?.();
      return;
    }
    if (message.type === "open-agent-setup") {
      this.openAgentSetupListener?.();
      return;
    }
    if (message.type === "open-port-settings") {
      this.openPortSettingsListener?.({
        ...(message.preferences === undefined ? {} : { preferences: message.preferences }),
        ...(message.route === undefined ? {} : { route: message.route }),
      });
      return;
    }
    if (message.type === "set-language") {
      this.setLanguageListener?.(message.locale);
      return;
    }
    if (message.type === "failed") {
      this.lastReportedFailure = new BackendFailure(message.code, message.detail);
      this.end(this.lastReportedFailure);
      return;
    }
    const waiter = [...this.waiters].find((candidate) => candidate.type === message.type);
    if (waiter) {
      this.waiters.delete(waiter);
      if (waiter.timer !== undefined) this.timers.clearTimer(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.pending.push(message);
    if (this.pending.length > MAX_PENDING_MESSAGES) this.pending.shift();
  }

  private end(failure: BackendFailure): void {
    this.ended ??= failure;
    for (const waiter of this.waiters) {
      if (waiter.timer !== undefined) this.timers.clearTimer(waiter.timer);
      waiter.reject(this.ended);
    }
    this.waiters.clear();
  }
}
