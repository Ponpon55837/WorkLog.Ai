import { describe, expect, it } from "vitest";
import {
  combineRedactionSummaries,
  redactJsonText,
  redactPrivateBlocksText,
  redactText,
  redactValue,
} from "../../packages/storage/src/secret-redaction.js";

const PRIVATE_MARKER = "[REDACTED:private_block]";

describe("secret redaction", () => {
  it("masks supported token classes without returning token fragments", () => {
    const cases = [
      { kind: "github_token", value: `ghp_${"A".repeat(36)}` },
      { kind: "github_token", value: `github_pat_${"B".repeat(50)}` },
      { kind: "openai_token", value: `sk-${"C".repeat(24)}` },
      { kind: "anthropic_token", value: `sk-ant-api03-${"D".repeat(24)}` },
      { kind: "slack_token", value: `xoxb-${"1234567890-".repeat(2)}${"E".repeat(12)}` },
      { kind: "google_api_key", value: `AIza${"F".repeat(35)}` },
      { kind: "aws_access_key", value: `AKIA${"G".repeat(16)}` },
      { kind: "aws_access_key", value: `ASIA${"H".repeat(16)}` },
      { kind: "aws_secret_key", value: `aws_secret_access_key=${"J".repeat(40)}` },
      {
        kind: "private_key",
        value: `-----BEGIN PRIVATE KEY-----\n${"K".repeat(64)}\n-----END PRIVATE KEY-----`,
      },
      { kind: "jwt", value: `eyJ${"a".repeat(18)}.${"b".repeat(20)}.${"c".repeat(20)}` },
      { kind: "connection_string_password", value: `postgres://worker:${"M".repeat(20)}@db.local/work` },
      { kind: "environment_secret", value: `API_KEY=${"N".repeat(20)}` },
    ] as const;

    for (const entry of cases) {
      const result = redactText(`設定 ${entry.value} 完成`);
      expect(result.value).not.toContain(entry.value);
      expect(result.value).toContain(`[REDACTED:${entry.kind}]`);
      expect(result.redactions).toMatchObject({ total: 1, byKind: { [entry.kind]: 1 } });
    }
  });

  it("does not mask commit identifiers, UUIDs, or common placeholders", () => {
    const commit = "a1b2c3d4e5f678901234567890abcdef12345678";
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const input = `commit ${commit}; id ${uuid}; API_KEY=changeme`;
    expect(redactText(input)).toEqual({ value: input, redactions: { total: 0, byKind: {} } });
  });

  it("keeps near-miss values for every supported detector unchanged", () => {
    const incompletePrivateKey = `-----BEGIN PRIVATE KEY-----\n${"K".repeat(64)}\nnot a key footer`;
    const cases = [
      `ghp_${"A".repeat(35)}`,
      `github_pat_${"B".repeat(49)}`,
      `sk-${"C".repeat(19)}`,
      `sk-ant-${"D".repeat(19)}`,
      "xoxb-short",
      `AIza${"F".repeat(29)}`,
      `AKIA${"G".repeat(15)}`,
      `aws_secret_access_key=${"J".repeat(39)}`,
      incompletePrivateKey,
      `eyJ${"a".repeat(18)}.${"b".repeat(20)}`,
      "postgres://worker:short@db.local/work",
      "PASSWORD=short",
      "/Users/example/project/src/config.ts",
      "This is an ordinary English sentence.",
    ];

    for (const value of cases) {
      expect(redactText(value)).toEqual({ value, redactions: { total: 0, byKind: {} } });
    }
  });

  it("redacts nested values and combines count-only summaries", () => {
    const githubToken = `gho_${"Q".repeat(36)}`;
    const apiToken = `TOKEN=${"R".repeat(16)}`;
    const result = redactValue({ summary: githubToken, events: [{ details: apiToken }] });
    expect(JSON.stringify(result.value)).not.toContain(githubToken);
    expect(JSON.stringify(result.value)).not.toContain("R".repeat(16));
    expect(result.redactions.total).toBe(2);
    expect(combineRedactionSummaries(result.redactions, result.redactions).total).toBe(4);
  });

  describe("private blocks", () => {
    it("removes each block, case-insensitively and across lines, and counts only private_block", () => {
      const result = redactText("before <private>alpha\r\nbeta</private> middle <PRIVATE>gamma</Private> after");
      expect(result.value).toBe(`before ${PRIVATE_MARKER} middle ${PRIVATE_MARKER} after`);
      expect(result.redactions).toEqual({ total: 2, byKind: { private_block: 2 } });
    });

    it("counts a credential inside a block once, as private_block", () => {
      const token = `ghp_${"P".repeat(36)}`;
      const result = redactText(`deploy <private>token ${token}</private> then ${token}`);
      expect(result.value).toBe(`deploy ${PRIVATE_MARKER} then [REDACTED:github_token]`);
      expect(result.redactions).toEqual({ total: 2, byKind: { private_block: 1, github_token: 1 } });
    });

    it("handles empty, adjacent, nested, and code-fenced blocks", () => {
      expect(redactText("a<private></private>b").value).toBe(`a${PRIVATE_MARKER}b`);
      expect(redactText("<private>x</private><private>y</private>")).toEqual({
        value: `${PRIVATE_MARKER}${PRIVATE_MARKER}`,
        redactions: { total: 2, byKind: { private_block: 2 } },
      });
      expect(redactText("keep <private>outer <private>inner</private> tail</private> end")).toEqual({
        value: `keep ${PRIVATE_MARKER} end`,
        redactions: { total: 1, byKind: { private_block: 1 } },
      });
      expect(redactText("```\n<private>secret</private>\n```").value).toBe(`\`\`\`\n${PRIVATE_MARKER}\n\`\`\``);
    });

    it("keeps an unclosed opening tag and a stray closing tag as written", () => {
      const title = "1.6.9：<private> 不保存標記";
      expect(redactText(title)).toEqual({ value: title, redactions: { total: 0, byKind: {} } });
      expect(redactText("a <private>x</private> b <private>never closed <private>inner</private> tail")).toEqual({
        value: `a ${PRIVATE_MARKER} b <private>never closed ${PRIVATE_MARKER} tail`,
        redactions: { total: 2, byKind: { private_block: 2 } },
      });
      const stray = "stray </private> text";
      expect(redactText(stray)).toEqual({ value: stray, redactions: { total: 0, byKind: {} } });
      expect(redactText("</private><private>x</private></private>").value).toBe(
        `</private>${PRIVATE_MARKER}</private>`,
      );
    });

    it("leaves near-miss tags unchanged", () => {
      for (const value of ["< private>x</private>", "<private >x</private>", "<privacy>x</privacy>", "private x"]) {
        expect(redactText(value)).toEqual({ value, redactions: { total: 0, byKind: {} } });
      }
    });

    it("masks blocks inside JSON string values without breaking the JSON", () => {
      const stored = JSON.stringify({
        outcomes: ['done <private>a "quoted" secret</private>', "<private> tag named", "next</private> visible"],
      });
      const result = redactJsonText(stored);
      expect(JSON.parse(result.value)).toEqual({
        outcomes: [`done ${PRIVATE_MARKER}`, "<private> tag named", "next</private> visible"],
      });
      expect(result.redactions).toEqual({ total: 1, byKind: { private_block: 1 } });
      const spanning = JSON.stringify({ outcomes: ["<private> opened here", "closed here </private>"] });
      expect(redactJsonText(spanning)).toEqual({ value: spanning, redactions: { total: 0, byKind: {} } });
      expect(redactJsonText('{"plain":"text"}').value).toBe('{"plain":"text"}');
      expect(redactJsonText("not json <private>x</private>").value).toBe(`not json ${PRIVATE_MARKER}`);
    });

    it("scans a large input with many blocks and an unclosed tag in linear time", () => {
      const block = `${"word ".repeat(40)}<private>${"secret ".repeat(20)}</private>`;
      const blocks = Math.ceil(1_000_000 / block.length);
      const tail = `<private>${"tail ".repeat(10_000)}`;
      const started = performance.now();
      const result = redactText(`${block.repeat(blocks)}${tail}`);
      const elapsed = performance.now() - started;
      expect(result.value).not.toContain("secret");
      expect(result.value.endsWith(tail)).toBe(true);
      expect(result.redactions.byKind.private_block).toBe(blocks);
      expect(elapsed).toBeLessThan(1_000);

      for (const input of [
        "<private>".repeat(100_000),
        `${"<private>".repeat(50_000)}${"</private>".repeat(50_000)}`,
        "<private>x</private>".repeat(50_000),
      ]) {
        const inputStarted = performance.now();
        redactText(input);
        expect(performance.now() - inputStarted).toBeLessThan(1_000);
      }
      expect(redactText("<private>".repeat(100_000)).redactions.total).toBe(0);
      expect(redactText(`${"<private>".repeat(3)}${"</private>".repeat(3)}`).value).toBe(PRIVATE_MARKER);
    });

    it("removes only private blocks for callers that cut text afterwards", () => {
      expect(redactPrivateBlocksText(`<private>x</private> API_KEY=${"N".repeat(20)}`)).toEqual({
        value: `${PRIVATE_MARKER} API_KEY=${"N".repeat(20)}`,
        redactions: { total: 1, byKind: { private_block: 1 } },
      });
    });
  });
});
