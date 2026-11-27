import { emptyDiagnosticsCounts, type DiagnosticsCategory, type DiagnosticsCounts } from "./diagnostics-redact.js";

export const SCAN_MASK = "[scan-masked]";

export interface ScanRule {
  readonly category: DiagnosticsCategory;
  readonly pattern: RegExp;
  readonly mask?: string;
}

export interface ScanResult {
  readonly text: string;
  readonly found: DiagnosticsCounts;
  readonly total: number;
}

const NOT_REDACTED = String.raw`(?!\[redacted)`;

const HARD = String.raw`"'\x60)\]},;|<>\r\n`;
const PATH_TAIL = String.raw`[^\s${HARD}][^${HARD}]*`;
const POSIX_START = String.raw`(?:(?<![A-Za-z0-9_.~)\]/\\-])|(?<=file://))`;
const POSIX_DIRECTORIES =
  "Users|home|Volumes|private|var|tmp|mnt|media|opt|srv|run|Library|Applications|etc|usr|data|bin|sbin|lib|lib64|snap|nix|proc|sys|dev|boot|workspace|workspaces|projects|repos";

export const SCAN_RULES: readonly ScanRule[] = [
  {
    category: "paths",
    pattern: new RegExp(
      String.raw`(?:(?<![\\:A-Za-z0-9_.])\\{2,4}[?.]\\{1,2})?(?<![A-Za-z0-9])[A-Za-z]:[\\/]+${PATH_TAIL}`,
      "g",
    ),
  },
  {
    category: "paths",
    pattern: new RegExp(
      String.raw`${POSIX_START}/(?:root(?![A-Za-z0-9_.-])[^${HARD}]*|(?:${POSIX_DIRECTORIES})/${PATH_TAIL})`,
      "gi",
    ),
  },
  { category: "paths", pattern: new RegExp(String.raw`(?<![A-Za-z0-9_.])~[/\\]${PATH_TAIL}`, "g") },
  {
    category: "paths",
    pattern: new RegExp(String.raw`(?<![\\:A-Za-z0-9_.])\\{2,4}[A-Za-z0-9_.$-]{1,255}\\+${PATH_TAIL}`, "g"),
  },
  {
    category: "authCodes",
    pattern: new RegExp(
      String.raw`[?&#;](?:access_token|refresh_token|id_token|client_secret|api_?key|signature|session_?id|session|password|secret|ticket|token|auth|authorization|code|state|nonce|otp|sig|key)=${NOT_REDACTED}[^\s&#"']+`,
      "gi",
    ),
  },
  { category: "authCodes", pattern: new RegExp(String.raw`wi-handoff=${NOT_REDACTED}[^\s"']+`, "g") },
  { category: "authCodes", pattern: /#(?<=:\/\/[^\s"'<>#]{0,256}#)(?!\[redacted\])[^\s"'<>]+/g },
  { category: "tokens", pattern: /:\/\/(?!\[redacted\]@)[^\s/@"'<>]{1,128}@/g },
  { category: "tokens", pattern: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g },
  { category: "tokens", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g },
  { category: "tokens", pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  { category: "tokens", pattern: /xox[a-z]-[A-Za-z0-9-]{6,}/g },
  { category: "tokens", pattern: /gh[pousr]_[A-Za-z0-9]{6,}|github_pat_[A-Za-z0-9_]{6,}/g },
  { category: "tokens", pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}/g },
  { category: "tokens", pattern: new RegExp(String.raw`Bearer[ \t]+${NOT_REDACTED}[^\s"']+`, "gi") },
  {
    category: "tokens",
    pattern: new RegExp(
      String.raw`(?:(?:token|secret|password|passwd|passphrase|pwd|credentials?|authorization|cookie|api[-_]?key)[A-Za-z0-9_.-]{0,32}["']?[ \t]{0,8}|(?<![A-Za-z0-9_])pass["']?)[:=][ \t]{0,8}["']?${NOT_REDACTED}[^\s"',;&}\]]+`,
      "gi",
    ),
  },
  { category: "tokens", pattern: /[A-Za-z0-9+/=_-]{40,}/g },
  {
    category: "emails",
    pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,1024}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g,
  },
];

export function scanText(text: string, rules: readonly ScanRule[] = SCAN_RULES): ScanResult {
  const found = emptyDiagnosticsCounts();
  let result = text;
  for (const rule of rules) {
    result = result.replace(rule.pattern, () => {
      found[rule.category] += 1;
      return rule.mask ?? SCAN_MASK;
    });
  }
  return { text: result, found, total: found.paths + found.authCodes + found.tokens + found.emails };
}
