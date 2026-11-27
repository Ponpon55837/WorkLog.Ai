export interface CliOptionSpec {
  flags?: readonly string[];
  valued?: readonly string[];
}

export const CLI_DASH_HELP = "路徑若以 - 開頭，請寫成 ./-name；選項的值若以 - 開頭，請寫成 --選項=-值。";

const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);

function looksLikeOption(arg: string): boolean {
  return arg.startsWith("-");
}

export function isHelpFlag(arg: string | undefined): boolean {
  return arg !== undefined && HELP_FLAGS.has(arg);
}

export interface ParsedCliArgs {
  kind: "ok";
  flags: ReadonlySet<string>;
  values: ReadonlyMap<string, readonly string[]>;
  positionals: readonly string[];
}

export type CliArgsCheck = ParsedCliArgs | { kind: "help" } | { kind: "error"; message: string };

export function parseCliArgs(
  args: readonly string[],
  spec: CliOptionSpec,
): ParsedCliArgs | { kind: "error"; message: string } {
  const knownFlags = new Set(spec.flags ?? []);
  const valued = new Set(spec.valued ?? []);
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!looksLikeOption(arg)) {
      if (!arg) return { kind: "error", message: "參數不可以是空字串。" };
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (valued.has(name)) {
      let value: string | undefined;
      if (equals > 0) {
        value = arg.slice(equals + 1);
      } else {
        value = args[index + 1];
        index += 1;
        if (value !== undefined && looksLikeOption(value)) {
          return {
            kind: "error",
            message: `${name} 的值不可以像選項：${value}（若值以 - 開頭，請寫成 ${name}=${value}）`,
          };
        }
      }
      if (!value) return { kind: "error", message: `${name} 需要一個值。` };
      const existing = values.get(name);
      if (existing) existing.push(value);
      else values.set(name, [value]);
    } else if (knownFlags.has(arg)) {
      flags.add(arg);
    } else {
      return { kind: "error", message: `看不懂的選項：${arg}（若這是以 - 開頭的路徑或名稱，請寫成 ./${arg}）` };
    }
  }
  return { kind: "ok", flags, values, positionals };
}

export function checkCliArgs(args: readonly string[], spec: CliOptionSpec): CliArgsCheck {
  if (args.some(isHelpFlag)) return { kind: "help" };
  return parseCliArgs(args, spec);
}
