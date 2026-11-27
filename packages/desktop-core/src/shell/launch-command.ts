import { z } from "zod";

export const QUIT_FLAG = "--quit";

export const OPEN_DASHBOARD_FLAG = "--open-dashboard";

export const OPEN_AGENT_SETUP_FLAG = "--open-agent-setup";

export const QUIT_SECOND_INSTANCE_DATA = Object.freeze({ action: "quit" as const });

export const OPEN_DASHBOARD_SECOND_INSTANCE_DATA = Object.freeze({ action: "open-dashboard" as const });

export const OPEN_AGENT_SETUP_SECOND_INSTANCE_DATA = Object.freeze({ action: "open-agent-setup" as const });

export const LAUNCH_EXIT_OK = 0;

const quitDataSchema = z.strictObject({ action: z.literal("quit") });
const openDashboardDataSchema = z.strictObject({ action: z.literal("open-dashboard") });
const openAgentSetupDataSchema = z.strictObject({ action: z.literal("open-agent-setup") });
const emptyDataSchema = z.strictObject({});

export type SecondInstanceCommand =
  | { readonly command: "quit" }
  | { readonly command: "open-dashboard" }
  | { readonly command: "open-agent-setup" }
  | { readonly command: "open"; readonly rejected: boolean };

export function interpretSecondInstanceData(data: unknown): SecondInstanceCommand {
  if (quitDataSchema.safeParse(data).success) return { command: "quit" };
  if (openDashboardDataSchema.safeParse(data).success) return { command: "open-dashboard" };
  if (openAgentSetupDataSchema.safeParse(data).success) return { command: "open-agent-setup" };
  if (data === undefined || data === null || emptyDataSchema.safeParse(data).success) {
    return { command: "open", rejected: false };
  }
  return { command: "open", rejected: true };
}

export function isQuitLaunch(argv: readonly string[]): boolean {
  return argv.includes(QUIT_FLAG);
}

export function isOpenDashboardLaunch(argv: readonly string[]): boolean {
  return argv.includes(OPEN_DASHBOARD_FLAG);
}

export function isOpenAgentSetupLaunch(argv: readonly string[]): boolean {
  return argv.includes(OPEN_AGENT_SETUP_FLAG);
}

export type LaunchDecision = "run" | "exit-without-starting" | "hand-over-and-exit";

export interface LaunchDecisionInputs {
  readonly quitRequested: boolean;
  readonly gotLock: boolean;
}

export function decideLaunch(inputs: LaunchDecisionInputs): LaunchDecision {
  if (!inputs.gotLock) return "hand-over-and-exit";
  return inputs.quitRequested ? "exit-without-starting" : "run";
}
