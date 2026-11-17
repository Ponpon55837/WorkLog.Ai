import { z } from "zod";

/** The command-line flag that asks the running App to quit without any dialog (an installer or updater uses it). */
export const QUIT_FLAG = "--quit";

/**
 * The command-line flag that asks the App to open the Dashboard: a first launch opens it once the backend is ready, a
 * second launch makes the running instance open it at its current port. An Agent's plugin starts the App with it.
 */
export const OPEN_DASHBOARD_FLAG = "--open-dashboard";

/**
 * The command-line flag that asks the App to open its Agent page ("設定 Agent…"): the Web status page's button and the
 * tray reach the same page. It only opens a window; nothing is written until the user confirms there.
 */
export const OPEN_AGENT_SETUP_FLAG = "--open-agent-setup";

/** The payload of a `--quit` launch to the running instance: `{ action: "quit" }`. */
export const QUIT_SECOND_INSTANCE_DATA = Object.freeze({ action: "quit" as const });

/** The payload of an `--open-dashboard` launch to the running instance: `{ action: "open-dashboard" }`. */
export const OPEN_DASHBOARD_SECOND_INSTANCE_DATA = Object.freeze({ action: "open-dashboard" as const });

/** The payload of an `--open-agent-setup` launch to the running instance: `{ action: "open-agent-setup" }`. */
export const OPEN_AGENT_SETUP_SECOND_INSTANCE_DATA = Object.freeze({ action: "open-agent-setup" as const });

/** Exit code of a launch that did its job without starting anything (also of a `--quit` that found no running App). */
export const LAUNCH_EXIT_OK = 0;

/** Strict: a missing field, an extra field or another action all fail, so nothing but a quit request is ever acted on. */
const quitDataSchema = z.strictObject({ action: z.literal("quit") });
const openDashboardDataSchema = z.strictObject({ action: z.literal("open-dashboard") });
const openAgentSetupDataSchema = z.strictObject({ action: z.literal("open-agent-setup") });
/** What a normal second launch sends: nothing, or an empty object. */
const emptyDataSchema = z.strictObject({});

/** What the running instance should do with a second launch. `rejected` is true for data it did not understand. */
export type SecondInstanceCommand =
  | { readonly command: "quit" }
  | { readonly command: "open-dashboard" }
  | { readonly command: "open-agent-setup" }
  | { readonly command: "open"; readonly rejected: boolean };

/**
 * Reads the `additionalData` of a `second-instance` event. Exactly `{ action: "quit" }` is a quit request, exactly
 * `{ action: "open-dashboard" }` a request for the Dashboard; nothing or `{}` is a normal second launch; anything else (extra fields, another action, a non-object) is NOT interpreted: it
 * counts as a normal second launch that the caller logs. No other argument of the second launch is ever forwarded.
 */
export function interpretSecondInstanceData(data: unknown): SecondInstanceCommand {
  if (quitDataSchema.safeParse(data).success) return { command: "quit" };
  if (openDashboardDataSchema.safeParse(data).success) return { command: "open-dashboard" };
  if (openAgentSetupDataSchema.safeParse(data).success) return { command: "open-agent-setup" };
  if (data === undefined || data === null || emptyDataSchema.safeParse(data).success) {
    return { command: "open", rejected: false };
  }
  return { command: "open", rejected: true };
}

/** Whether this launch was started with `--quit`. */
export function isQuitLaunch(argv: readonly string[]): boolean {
  return argv.includes(QUIT_FLAG);
}

/** Whether this launch was started with `--open-dashboard`. */
export function isOpenDashboardLaunch(argv: readonly string[]): boolean {
  return argv.includes(OPEN_DASHBOARD_FLAG);
}

/** Whether this launch was started with `--open-agent-setup`. */
export function isOpenAgentSetupLaunch(argv: readonly string[]): boolean {
  return argv.includes(OPEN_AGENT_SETUP_FLAG);
}

/** What the launch itself does, decided before any runtime install or backend start. */
export type LaunchDecision = "run" | "exit-without-starting" | "hand-over-and-exit";

export interface LaunchDecisionInputs {
  readonly quitRequested: boolean;
  /** `app.requestSingleInstanceLock(...)` succeeded: no other instance owns this user's data. */
  readonly gotLock: boolean;
}

/**
 * - No lock: another instance runs; this launch hands over (the lock call already delivered its data) and exits.
 * - Lock and `--quit`: nothing runs, so there is nothing to quit; exit at once with code 0 without starting anything.
 * - Lock: start normally.
 */
export function decideLaunch(inputs: LaunchDecisionInputs): LaunchDecision {
  if (!inputs.gotLock) return "hand-over-and-exit";
  return inputs.quitRequested ? "exit-without-starting" : "run";
}
