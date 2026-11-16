import path from "node:path";
import { RuntimeError } from "./errors.js";
import { readCurrentRuntimeId } from "./layout.js";
import { isRuntimeAction, type RuntimeAction, type RuntimeManifest } from "./manifest.js";
import { verifyRuntime, type VerifyRuntimeOptions } from "./verify.js";

/** A process to start: argv array and environment, never a shell command line. */
export interface LaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Throws unless `action` is one of the fixed actions; checked before any file is read. */
export function assertAllowedAction(action: string): asserts action is RuntimeAction {
  if (!isRuntimeAction(action)) {
    throw new RuntimeError("RUNTIME_ACTION_NOT_ALLOWED", "不允許的 action", {
      expected: "mcp、serve 或 *-finalize-reminder",
      actual: action,
    });
  }
}

/**
 * The process that runs `action` for an already verified runtime: the bundled executable, the action's entry script,
 * the action's fixed arguments and then `argv`. Electron runtimes get `ELECTRON_RUN_AS_NODE=1` so Electron behaves as Node.
 */
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
    env: manifest.runtimeKind === "electron-run-as-node" ? { ...baseEnv, ELECTRON_RUN_AS_NODE: "1" } : { ...baseEnv },
  };
}

/** Reads `current`, verifies that runtime completely and plans how to start `action` in it. */
export async function planLaunch(
  root: string,
  action: string,
  argv: readonly string[],
  options: VerifyRuntimeOptions & { readonly env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<LaunchPlan> {
  assertAllowedAction(action);
  const verified = await verifyRuntime(root, await readCurrentRuntimeId(root), options);
  return buildLaunchPlan(verified.runtimeDirectory, verified.manifest, action, argv, options.env);
}
