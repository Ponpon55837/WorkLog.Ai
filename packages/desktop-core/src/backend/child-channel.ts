import { parseDesktopChildMessage, type DesktopChildMessage } from "@work-intelligence/schema";
import { BackendFailure } from "./errors.js";
import type { BackendSupervisorDependencies, SupervisedChild } from "./types.js";

/** How a child process ended. A spawn that never started has neither. */
export interface ChildExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

type MessageOfType<T extends DesktopChildMessage["type"]> = Extract<DesktopChildMessage, { type: T }>;

interface Waiter {
  readonly type: DesktopChildMessage["type"];
  readonly resolve: (message: DesktopChildMessage) => void;
  readonly reject: (failure: BackendFailure) => void;
  readonly timer: unknown;
}

/** Messages kept for a later `expect` (a child may answer before the parent waits); older ones are dropped. */
const MAX_PENDING_MESSAGES = 32;

type ChannelTimers = Pick<BackendSupervisorDependencies, "setTimer" | "clearTimer">;

function describeExit(exitCode: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `the backend was ended by ${signal}` : `the backend exited with code ${exitCode ?? "unknown"}`;
}

/**
 * The parent's end of one child's private IPC channel. Every message is parsed with the shared zod schema (an unknown or
 * malformed one is logged and dropped), and the parent waits for a message type with `expect`, which fails with a
 * {@link BackendFailure} when the child reports `failed`, exits, or stays silent past the deadline.
 */
export class ChildChannel {
  /** Resolves when the child process exits (or fails to spawn); never rejects. */
  readonly exited: Promise<ChildExit>;
  /** The code of the last `failed` message the child sent, if any. */
  lastReportedFailure: BackendFailure | undefined;
  private readonly child: SupervisedChild;
  private readonly timers: ChannelTimers;
  private readonly log: (line: string) => void;
  private readonly pending: DesktopChildMessage[] = [];
  private readonly waiters = new Set<Waiter>();
  /** Sticky: once the child failed or ended, every later `expect` fails the same way. */
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
      // 'error' alone does not mean the process ended: a failed kill() or send() emits it too. Only a child that never
      // got a pid failed to spawn (ENOENT, EACCES...); for any other 'error' the process may still run, so `exited`
      // stays unresolved until the 'exit' event.
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

  /** Why the channel ended (the child's own `failed`, its exit, or a spawn failure), or undefined while it is open. */
  get endedFailure(): BackendFailure | undefined {
    return this.ended;
  }

  /** What the child's exit looked like, once it has exited. */
  get exitInfo(): ChildExit | undefined {
    return this.exit;
  }

  /** The next message of `type`, or a {@link BackendFailure} (the child's own, `CHILD_EXITED`, or a timeout). */
  expect<T extends DesktopChildMessage["type"]>(type: T, timeoutMs: number): Promise<MessageOfType<T>> {
    const index = this.pending.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(this.pending.splice(index, 1)[0] as MessageOfType<T>);
    if (this.ended) return Promise.reject(this.ended);
    return new Promise<MessageOfType<T>>((resolve, reject) => {
      const waiter: Waiter = {
        type,
        resolve: (message) => resolve(message as MessageOfType<T>),
        reject,
        timer: this.timers.setTimer(() => {
          this.waiters.delete(waiter);
          reject(new BackendFailure("CHILD_START_TIMEOUT", `no ${type} message within ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  /** Sends one parent message; rejects when the channel is already closed. */
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

  private receive(raw: unknown): void {
    const parsed = parseDesktopChildMessage(raw);
    if (!parsed.ok) {
      this.log(`[backend] dropped a child message (${parsed.reason})`);
      return;
    }
    const message = parsed.message;
    if (message.type === "failed") {
      this.lastReportedFailure = new BackendFailure(message.code, message.detail);
      this.end(this.lastReportedFailure);
      return;
    }
    const waiter = [...this.waiters].find((candidate) => candidate.type === message.type);
    if (waiter) {
      this.waiters.delete(waiter);
      this.timers.clearTimer(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.pending.push(message);
    if (this.pending.length > MAX_PENDING_MESSAGES) this.pending.shift();
  }

  private end(failure: BackendFailure): void {
    this.ended ??= failure;
    for (const waiter of this.waiters) {
      this.timers.clearTimer(waiter.timer);
      waiter.reject(this.ended);
    }
    this.waiters.clear();
  }
}
