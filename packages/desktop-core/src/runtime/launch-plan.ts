import path from "node:path";
import { RuntimeError } from "./errors.js";
import { readCurrentRuntimeId } from "./layout.js";
import { isRuntimeAction, type RuntimeAction, type RuntimeKind, type RuntimeManifest } from "./manifest.js";
import { verifyRuntime, type VerifyRuntimeOptions } from "./verify.js";

export interface LaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

export const ELECTRON_AS_NODE_ENV: Readonly<Record<string, string>> = {
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_NO_ASAR: "1",
};

export function assertAllowedAction(action: string): asserts action is RuntimeAction {
  if (!isRuntimeAction(action)) {
    throw new RuntimeError("RUNTIME_ACTION_NOT_ALLOWED", "不允許的 action", {
      expected: "mcp、serve 或 *-finalize-reminder",
      actual: action,
    });
  }
}

export function buildLaunchPlan(
  runtimeDirectory: string,
  manifest: RuntimeManifest,
  action: string,
  argv: readonly string[],
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): LaunchPlan {
  assertAllowedAction(action);
  const spec = manifest.actions[action];
  if (spec === undefined) {
    throw new RuntimeError("RUNTIME_ACTION_NOT_ALLOWED", "這個 runtime 沒有提供該 action", {
      expected: Object.keys(manifest.actions).join("、"),
      actual: action,
    });
  }
  return {
    command: path.join(runtimeDirectory, manifest.executable),
    args: [path.join(runtimeDirectory, spec.entry), ...(spec.args ?? []), ...argv],
    env: manifest.runtimeKind === "electron-run-as-node" ? { ...baseEnv, ...ELECTRON_AS_NODE_ENV } : { ...baseEnv },
  };
}

export interface PlanLaunchOptions extends VerifyRuntimeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly requiredRuntimeKind?: RuntimeKind;
}

export async function planLaunch(
  root: string,
  action: string,
  argv: readonly string[],
  options: PlanLaunchOptions = {},
): Promise<LaunchPlan> {
  assertAllowedAction(action);
  const verified = await verifyRuntime(root, await readCurrentRuntimeId(root), options);
  const { runtimeKind } = verified.manifest;
  if (options.requiredRuntimeKind !== undefined && runtimeKind !== options.requiredRuntimeKind) {
    throw new RuntimeError("RUNTIME_KIND_NOT_ALLOWED", "這個 runtime 的類型不能啟動此程序", {
      expected: options.requiredRuntimeKind,
      actual: runtimeKind,
    });
  }
  return buildLaunchPlan(verified.runtimeDirectory, verified.manifest, action, argv, options.env);
}
