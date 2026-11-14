import { describe, expect, it } from "vitest";
import { MAX_HANDOFF_CONTENT_LENGTH, parseHandoffContent } from "../../packages/storage/src/handoff-parser.js";

const FULL_LENGTH = MAX_HANDOFF_CONTENT_LENGTH;
const HALF_LENGTH = FULL_LENGTH / 2;
const MAX_MILLISECONDS = 200;
// Doubling the input should about double the time; a quadratic parser quadruples it.
const MAX_DOUBLING_RATIO = 3.2;
const RATIO_BASELINE_FLOOR_MS = 10;

// Each shape made one of the former multiline regexes (`^\s*...$` with `\s*` running across line breaks, or a lazy
// `.+?\s*$` over a long whitespace run) rescan the same characters from every start position.
function adversarialInputs(length: number): Record<string, string> {
  return Object.fromEntries(
    Object.entries(shapes(length)).map(([name, text]) => [name, text.padEnd(length, "x").slice(0, length)]),
  );
}

function shapes(length: number): Record<string, string> {
  const repeat = (unit: string): string => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  const padded = (head: string, fill: string, tail = "x"): string =>
    head + fill.repeat(length - head.length - tail.length) + tail;
  return {
    "all newlines": "\n".repeat(length),
    "all CRLF": repeat("\r\n"),
    "all lone CR": "\r".repeat(length),
    "all U+2028": " ".repeat(length),
    "blank lines then a trailing character": `${repeat(" \n").slice(0, length - 1)}x`,
    "leading spaces then a trailing character": padded("", " "),
    "leading tabs then a trailing character": padded("", "\t"),
    "title with many inner spaces": padded("# a", " "),
    "hash then spaces": padded("#", " "),
    "hash then newlines": `#${"\n".repeat(length - 1)}`,
    "hash lines": repeat("#\n"),
    "empty headings": repeat("# \n"),
    "changed files heading repeated": repeat("## changed files\n"),
    "changed files heading without a space repeated": repeat("##changed files\n"),
    "changed files heading with CR repeated": repeat("##changed files\r"),
    "changed files heading and file repeated": repeat("##changed files\n- a.ts\n"),
    "changed files heading then spaces": padded("## changed files", " "),
    "changed files heading, colon, then spaces": padded("## changed files:", " "),
    "status colon then spaces": padded("status:", " "),
    "status value with many inner spaces": padded("status: a", " "),
    "status without a delimiter then spaces": padded("status", " "),
    "status colon lines": repeat("status:\n"),
    "status heading lines": repeat("## status\n"),
    "status heading then spaces": padded("## status", " "),
    "hashes then spaces": padded("######", " "),
    "test repeated": repeat("test "),
    "test failure repeated": repeat("test fail "),
    "test error then spaces": padded("test error", " "),
    "build repeated": repeat("build"),
    "verification then spaces": padded("verification", " "),
    "verification colon then spaces": padded("verification:", " "),
    "recorded then spaces": padded("recorded", " "),
    "recorded repeated": repeat("recorded "),
    "recorded colon then spaces": padded("recorded:", " "),
    "inline changed files opening repeated": repeat("changedFiles: ["),
    "inline changed files then spaces": padded("changedFiles:", " ", "["),
    "list marker then spaces": padded("## changed files\n- ", " ", "a\rb"),
    "file line with many backticks": padded("## changed files\na", "`", "b.ts"),
    "file line with a long gap before the description": padded("## changed files\na.ts", " "),
    "backtick file lines": `## changed files\n${repeat("`a`\n").slice(0, length - 17)}`,
    "CR headings then a space tail": `${repeat("##changed files\r").slice(0, length / 2)}${" ".repeat(length / 2 - 1)}x`,
    "CR headings then a backtick tail": `${repeat("##changed files\r").slice(0, length / 2)}${"`".repeat(length / 2)}`,
    "CR headings then a tab tail": `${repeat("##changed files\r").slice(0, length / 2)}${"\t".repeat(length / 2 - 1)}x`,
    "CR headings then a tail of tabs and spaces": `${repeat("##changed files\r").slice(0, length / 2)}${" \t".repeat(length / 4 - 1)}x`,
    "U+2028 headings then a space tail": `${repeat("##changed files\u2028").slice(0, length / 2)}${" ".repeat(length / 2 - 1)}x`,
    "U+2028 headings then a backtick tail": `${repeat("##changed files\u2028").slice(0, length / 2)}${"`".repeat(length / 2)}`,
    "arrow early in the line, CR headings, then a tail": `## changed files\n- a =>${repeat("##changed files\r").slice(0, length / 2)}${" ".repeat(length / 2 - 30)}x`,
    "arrow at the end, CR headings, then backticks": `## changed files\n- a =>${repeat("##changed files\r").slice(0, length / 2)}${"`".repeat(length / 2 - 30)}`,
    "list marker, CR headings, then a long tail": `## changed files\n- ${repeat("##changed files\r").slice(0, length / 2)}${"x".repeat(length / 2 - 30)}`,
    "list marker, spaces, CR headings, then a long tail": `## changed files\n-    ${repeat("##changed files\r").slice(0, length / 2)}${"y.ts ".repeat(length / 10 - 10)}`,
    "checkbox and status prefix, CR headings, then a tail": `## changed files\n[x] M ${repeat("##changed files\r").slice(0, length / 2)}${" ".repeat(length / 2 - 40)}x`,
    "CR headings then a long description gap": `${repeat("##changed files\r").slice(0, length / 2)}a.ts${" ".repeat(length / 2 - 10)}- x`,
    "mixed Unicode whitespace": repeat(" \t  \n"),
    "empty list items": repeat("- \n"),
    "numbered list markers": repeat("1. "),
    "unclosed fences": repeat("```\n"),
  };
}

function bestOfThree(input: string): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    parseHandoffContent(input, "/fictional/orchard-project", ".openspec/handoffs/adversarial.md");
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe("handoff parser linear time", () => {
  it("parses 200,000 characters of every adversarial shape quickly", () => {
    for (const [shape, input] of Object.entries(adversarialInputs(FULL_LENGTH))) {
      expect(input.length, shape).toBe(FULL_LENGTH);
      expect(bestOfThree(input), shape).toBeLessThan(MAX_MILLISECONDS);
    }
  });

  it("takes about twice as long when the input doubles", () => {
    const half = adversarialInputs(HALF_LENGTH);
    const full = adversarialInputs(FULL_LENGTH);
    for (const shape of Object.keys(full)) {
      const halfTime = Math.max(bestOfThree(half[shape] ?? ""), RATIO_BASELINE_FLOOR_MS);
      expect(bestOfThree(full[shape] ?? ""), shape).toBeLessThan(halfTime * MAX_DOUBLING_RATIO);
    }
  });
});
