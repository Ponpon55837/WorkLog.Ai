import { describe, expect, it } from "vitest";
import { combineRedactionSummaries, redactText, redactValue } from "../../packages/storage/src/secret-redaction.js";

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
});
