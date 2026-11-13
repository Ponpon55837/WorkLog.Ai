/** What a subcommand accepts, so anything else that looks like an option can be refused before the command acts. */
export interface CliOptionSpec {
  /** Options that take no value, such as `--dry-run`. */
  flags?: readonly string[];
  /** Options that take a value, as `--out <value>` or `--out=<value>`. */
  valued?: readonly string[];
}

export type CliArgsCheck = { kind: "ok" } | { kind: "help" } | { kind: "error"; message: string };

const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);

function looksLikeOption(arg: string): boolean {
  return arg.length > 1 && arg.startsWith("-");
}

export function isHelpFlag(arg: string | undefined): boolean {
  return arg !== undefined && HELP_FLAGS.has(arg);
}

/**
 * Checks a subcommand's arguments before it touches the database or the filesystem. `--help` / `-h` anywhere wins;
 * otherwise an argument that looks like an option must be one the command declares, and the value of a valued
 * option must not itself look like an option (so `--out --foo` never writes a file called `--foo`).
 * Positional arguments are left to the command.
 */
export function checkCliArgs(args: readonly string[], spec: CliOptionSpec): CliArgsCheck {
  if (args.some(isHelpFlag)) return { kind: "help" };
  const flags = new Set(spec.flags ?? []);
  const valued = new Set(spec.valued ?? []);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!looksLikeOption(arg)) continue;
    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (valued.has(name)) {
      if (equals > 0) continue;
      const value = args[index + 1];
      if (value !== undefined && looksLikeOption(value)) {
        return { kind: "error", message: `${name} 的值不可以像選項：${value}` };
      }
      index += 1;
    } else if (!flags.has(arg)) {
      return { kind: "error", message: `看不懂的選項：${arg}` };
    }
  }
  return { kind: "ok" };
}
