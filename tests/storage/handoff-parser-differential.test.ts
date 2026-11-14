import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractChangedFiles,
  fileTokenFromLine,
  findStatusSignals,
  parseHandoffContent,
  parseRecordedDate,
  parseVerification,
  stripFencedCodeBlocks,
  summaryFromContent,
  titleFromContent,
} from "../../packages/storage/src/handoff-parser.js";

type StrippedExpectation = string | { length: number; sha256: string };

interface DifferentialCase {
  name: string;
  content?: string;
  // Large documents are stored as [unit, repeat count] pairs instead of their full text.
  parts?: Array<[string, number]>;
  projectRoot: string;
  sourcePath: string;
  expected: {
    parsed: unknown;
    stripped: StrippedExpectation;
    statusSignals: string[];
    changedFiles: string[];
    summary: string;
    title: string;
    recordedDate: string | null;
    verification: unknown;
  };
}

interface DifferentialFixture {
  cases: DifferentialCase[];
  tokenCases: Array<{ line: string; expected: string | null }>;
}

// The expected values were recorded from the regex-based parser before it was rewritten as per-line scans; they pin
// its exact output (CRLF, lone CR and U+2028 breaks, tabs, odd heading depths, empty sections, Unicode). The documents
// are fictional.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/handoff-parser-differential.json", import.meta.url), "utf8"),
) as DifferentialFixture;

function documentOf(testCase: DifferentialCase): string {
  return testCase.content ?? (testCase.parts ?? []).map(([unit, times]) => unit.repeat(times)).join("");
}

function strippedMatches(actual: string, expected: StrippedExpectation): void {
  if (typeof expected === "string") {
    expect(actual).toBe(expected);
    return;
  }
  expect({ length: actual.length, sha256: createHash("sha256").update(actual).digest("hex") }).toEqual(expected);
}

describe("handoff parser differential corpus", () => {
  it("covers a broad corpus", () => {
    expect(fixture.cases.length).toBeGreaterThan(400);
    expect(fixture.cases.filter((testCase) => testCase.expected.changedFiles.length > 0).length).toBeGreaterThan(150);
    expect(fixture.cases.filter((testCase) => testCase.expected.statusSignals.length > 0).length).toBeGreaterThan(200);
  });

  it("returns the recorded result for every document, bit for bit", () => {
    for (const testCase of fixture.cases) {
      const content = documentOf(testCase);
      const { expected, projectRoot, sourcePath } = testCase;
      // JSON round trip mirrors how the expectations were stored (undefined fields disappear).
      const parsed: unknown = JSON.parse(JSON.stringify(parseHandoffContent(content, projectRoot, sourcePath)));
      expect(parsed, `${testCase.name}: parseHandoffContent`).toEqual(expected.parsed);
      strippedMatches(stripFencedCodeBlocks(content), expected.stripped);
      expect(findStatusSignals(content), `${testCase.name}: findStatusSignals`).toEqual(expected.statusSignals);
      expect(extractChangedFiles(content, projectRoot), `${testCase.name}: extractChangedFiles`).toEqual(
        expected.changedFiles,
      );
      expect(summaryFromContent(content, sourcePath), `${testCase.name}: summaryFromContent`).toBe(expected.summary);
      expect(titleFromContent(content, sourcePath), `${testCase.name}: titleFromContent`).toBe(expected.title);
      expect(parseRecordedDate(content) ?? null, `${testCase.name}: parseRecordedDate`).toBe(expected.recordedDate);
      expect(JSON.parse(JSON.stringify(parseVerification(content))), `${testCase.name}: parseVerification`).toEqual(
        expected.verification,
      );
    }
  });

  it("returns the recorded file token for every line shape", () => {
    for (const { line, expected } of fixture.tokenCases) {
      expect(fileTokenFromLine(line) ?? null, JSON.stringify(line)).toBe(expected);
    }
  });
});
