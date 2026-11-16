/** What a subcommand accepts, so anything else that looks like an option can be refused before the command acts. */
export interface CliOptionSpec {
  /** Options that take no value, such as `--dry-run`. */
  flags?: readonly string[];
  /** Options that take a value, as `--out <value>` or `--out=<value>`. */
  valued?: readonly string[];
}

export type CliArgsCheck = { kind: "ok" } | { kind: "help" } | { kind: "error"; message: string };

const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);

/** Anything that starts with `-` (including a lone `-` and `--`) is an option, never a path or a value. */
function looksLikeOption(arg: string): boolean {
  return arg.startsWith("-");
}

export function isHelpFlag(arg: string | undefined): boolean {
  return arg !== undefined && HELP_FLAGS.has(arg);
}

export interface ParsedCliArgs {
  kind: "ok";
  /** Declared flags that were present. */
  flags: ReadonlySet<string>;
  /** Values of each declared valued option, in order (a repeated option keeps every value). */
  values: ReadonlyMap<string, readonly string[]>;
  /** Arguments that are neither options nor option values; never start with `-`. */
  positionals: readonly string[];
}

/**
 * Splits a subcommand's arguments into flags, option values and positionals, or says why they cannot be read.
 * An argument that looks like an option must be declared; a valued option needs a non-empty value that does not itself
 * look like an option (`--out --all` and a trailing `--out` are errors, `--out=-x` is the way to pass such a value);
 * and a positional never starts with `-`, so a mistyped option can never be taken as a path or a name.
 */
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
          return { kind: "error", message: `${name} 的值不可以像選項：${value}` };
        }
      }
      if (!value) return { kind: "error", message: `${name} 需要一個值。` };
      values.set(name, [...(values.get(name) ?? []), value]);
    } else if (knownFlags.has(arg)) {
      flags.add(arg);
    } else {
      return { kind: "error", message: `看不懂的選項：${arg}` };
    }
  }
  return { kind: "ok", flags, values, positionals };
}

/**
 * Checks a subcommand's arguments before it touches the database or the filesystem. `--help` / `-h` anywhere wins;
 * otherwise the arguments must parse (see `parseCliArgs`). Positional arguments are left to the command.
 */
export function checkCliArgs(args: readonly string[], spec: CliOptionSpec): CliArgsCheck {
  if (args.some(isHelpFlag)) return { kind: "help" };
  const parsed = parseCliArgs(args, spec);
  return parsed.kind === "error" ? parsed : { kind: "ok" };
}
