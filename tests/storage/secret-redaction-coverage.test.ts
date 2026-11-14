import { describe, expect, it } from "vitest";
import { redactJsonText, redactText } from "../../packages/storage/src/secret-redaction.js";
import { bestOfMs, doublingGrowth, scaledLimit } from "../helpers/timing.js";
import { redactionReferenceText } from "./fixtures/redaction-reference.js";
import { BENIGN_TEXTS, SECRET_CORPUS, type CorpusSample } from "./fixtures/secret-corpus.js";

const LONG_INPUT_LENGTH = 200_000;
const MAX_MILLISECONDS = 1_000;
// The normal time of redactText on ordinary text of the same size, rounded up; the limit scales when a machine is slower.
const REFERENCE_BUDGET_MS = 20;

function marker(kind: string): string {
  return `[REDACTED:${kind}]`;
}

/** Repeats `unit` to exactly `length` characters, the last of which come from `tail`. */
function repeatTo(unit: string, length: number, tail = ""): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length - tail.length) + tail;
}

function samplesOf(category: string): readonly CorpusSample[] {
  return SECRET_CORPUS.filter((entry) => entry.category === category);
}

function expectRedacted(entry: CorpusSample): void {
  for (const wrapped of [entry.text, `記錄：${entry.text}\n之後的文字`]) {
    const result = redactText(wrapped);
    for (const secret of entry.secrets) {
      expect(result.value, wrapped).not.toContain(secret);
    }
    expect(result.redactions.total, wrapped).toBeGreaterThan(0);
  }
}

/** Shapes that made a scanner re-read the rest of the text from many start positions. */
function adversarialInputs(length: number): Record<string, string> {
  return {
    "repeated DB_PASSWORD=": repeatTo("DB_PASSWORD=", length, "<"),
    "repeated password=password=": repeatTo("password=", length, "<"),
    "repeated accessToken:": repeatTo("accessToken:", length),
    "repeated quoted password": repeatTo(`password="`, length),
    "repeated single-quoted token": repeatTo(`token='`, length),
    "repeated alternating quotes": repeatTo(`password="a'b\`c token='d `, length),
    "repeated JSON key": repeatTo(`{"api_key": "`, length),
    "repeated escaped JSON key": repeatTo(`\\"password\\":\\"`, length),
    "keyword then long quoted value": `password="${"x".repeat(length - 10)}`,
    "keyword then long unquoted value": `password=${"x".repeat(length - 10)}<`,
    "keyword then separators": `password${"=".repeat(length - 8)}`,
    "keyword then spaces": `password:${" ".repeat(length - 10)}x`,
    "keyword then backslashes": `password="${"\\".repeat(length - 10)}`,
    "repeated pwd=": repeatTo(" pwd=/", length),
    "repeated secret_access_key": repeatTo(`"secret_access_key": "`, length),
    "repeated ?a=&password=": repeatTo("?a=&password=", length),
    "repeated Authorization: Bearer": repeatTo("Authorization: Bearer ", length),
    "repeated Authorization:Bearer": repeatTo("authorization:bearer ", length),
    "authorization then spaces": `Authorization:${" ".repeat(length - 15)}x`,
    "Bearer then a long value": `Authorization: Bearer ${"a".repeat(length - 22)}`,
    "repeated Cookie:": repeatTo("Cookie: a", length),
    "Cookie then a long line": `Set-Cookie: ${"a".repeat(length - 12)}`,
    "repeated sk_live_": repeatTo(" sk_live_", length),
    "sk_live_ then a long body": `sk_live_${"a".repeat(length - 8)}`,
    "repeated glpat-": repeatTo(" glpat-", length),
    "repeated glpat-glpat-": repeatTo("glpat-", length),
    "repeated npm_": repeatTo(" npm_", length),
    "repeated SG.": repeatTo(" SG.", length),
    "repeated SG.id.": repeatTo(" SG.aaaaaaaaaaaaaaaaaaaa.", length),
    "repeated ya29.": repeatTo(" ya29.", length),
    "repeated GOCSPX-": repeatTo(" GOCSPX-", length),
    "repeated xapp-1-": repeatTo(" xapp-1-", length),
    "repeated hf_": repeatTo(" hf_", length),
    "repeated SK": repeatTo(" SKabcdef", length),
    "repeated webhook prefix": repeatTo(" hooks.slack.com/services/T00/B00/", length),
    "repeated a://u:p@": repeatTo("a://u:pppppppp@", length),
    "repeated a://u:pw/": repeatTo("a://u:pppppppp/", length),
    "scheme user then @ run": `a://u:${"@".repeat(length - 6)}`,
    "scheme user then p@ run": `a://u:${"p@".repeat((length - 6) / 2)}`,
    "scheme user then slash run": `a://u:${"/".repeat(length - 6)}`,
    "repeated ?access_token=": repeatTo("?access_token=", length),
    "repeated &key=": repeatTo("&key=", length),
    "query then a long value": `?key=${"a".repeat(length - 5)}`,
    "repeated X-Amz-Signature=": repeatTo("?X-Amz-Signature=", length),
    "repeated AccountKey=": repeatTo("AccountKey=", length),
    "AccountKey then a long value": `AccountKey=${"a".repeat(length - 11)}`,
    "repeated PuTTY header": repeatTo("PuTTY-User-Key-File-2: x", length),
    "repeated lowercase PEM header": repeatTo("-----begin private key-----a", length),
    "repeated PGP header": repeatTo("-----BEGIN PGP PRIVATE KEY BLOCK-----a", length),
    "repeated PGP header and footer-less body": `-----BEGIN PGP PRIVATE KEY BLOCK-----${repeatTo("a\n", length - 37)}`,
    "repeated masked aws id": repeatTo("[REDACTED:aws_access_key] ", length),
    "repeated masked aws id and run": repeatTo(`[REDACTED:aws_access_key] ${"A".repeat(39)}`, length),
    "repeated glued AKIA": repeatTo("_AKIAAAAAAAAAAAAAAAAA_", length),
    "repeated AKIA then long run": repeatTo(`AKIAAAAAAAAAAAAAAAAA ${"A".repeat(60)} `, length),
  };
}

function limitMs(): number {
  const reference = redactionReferenceText(LONG_INPUT_LENGTH);
  return scaledLimit({
    limitMs: MAX_MILLISECONDS,
    reference: () => redactText(reference),
    referenceBudgetMs: REFERENCE_BUDGET_MS,
  }).limitMs;
}

describe("secret redaction coverage", () => {
  describe("fictional corpus", () => {
    it("holds at least 113 samples across the baseline and the nine categories", () => {
      expect(SECRET_CORPUS.length).toBeGreaterThanOrEqual(113);
      for (const category of ["env-prefix", "camel-case", "json", "special", "header", "prefix", "url", "pem", "aws"]) {
        expect(samplesOf(category).length, category).toBeGreaterThanOrEqual(3);
      }
    });

    it("redacts every sample completely", () => {
      const leaking = SECRET_CORPUS.filter((entry) => {
        const value = redactText(entry.text).value;
        return entry.secrets.some((secret) => value.includes(secret));
      });
      expect(leaking.map((entry) => entry.text)).toEqual([]);
    });

    it.each([
      ["env-prefix", "environment names with an underscore prefix"],
      ["camel-case", "camelCase names"],
      ["json", "JSON key/value pairs"],
      ["special", "passwords with special characters or spaces"],
      ["header", "HTTP headers"],
      ["prefix", "third-party token prefixes"],
      ["url", "connection strings and query parameters"],
      ["pem", "private key variants"],
      ["aws", "AWS secret and key id variants"],
    ])("redacts %s samples (%s), alone and inside surrounding text", (category) => {
      for (const entry of samplesOf(category)) {
        expectRedacted(entry);
      }
    });
  });

  describe("what is masked", () => {
    it("keeps the key name, separator and quotes and masks only the value", () => {
      const cases: Array<[string, string]> = [
        ["DB_PASSWORD=hunter2hunter2", `DB_PASSWORD=${marker("environment_secret")}`],
        ['accessToken: "abcdEFGH1234"', `accessToken: "${marker("environment_secret")}"`],
        ['{"password": "pa ss\\"word99"}', `{"password": "${marker("environment_secret")}"}`],
        ["password=abcdefgh1234, user=ann", `password=${marker("environment_secret")}, user=ann`],
        ["Authorization: Bearer abcdEFGH12345", `Authorization: Bearer ${marker("environment_secret")}`],
        [
          'curl -H "Authorization: Bearer abcdEFGH12345" https://x.test',
          `curl -H "Authorization: Bearer ${marker("environment_secret")}" https://x.test`,
        ],
        ["Cookie: a=b1234567; c=d1234567\nnext", `Cookie: ${marker("environment_secret")}\nnext`],
        ["?access_token=abcdEFGH1234&page=2", `?access_token=${marker("environment_secret")}&page=2`],
        ["https://u:p@ss/word99@db.test/main", `https://u:${marker("connection_string_password")}@db.test/main`],
        [
          "https://u:p@ss/word99@db.test/main?email=a@b.test",
          `https://u:${marker("connection_string_password")}@db.test/main?email=a@b.test`,
        ],
        ["KEY_AKIAIOSFODNN7EXAMPLE_x", `KEY_${marker("aws_access_key")}_x`],
      ];
      for (const [input, expected] of cases) {
        expect(redactText(input).value, input).toBe(expected);
      }
    });

    it("takes a bare 40-character AWS secret only next to an access key id or an AWS secret name", () => {
      const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      expect(redactText(`AKIAIOSFODNN7EXAMPLE ${secret}`).value).toBe(
        `${marker("aws_access_key")} ${marker("aws_secret_key")}`,
      );
      expect(redactText(`secretAccessKey: ${secret}`).value).toBe(`secretAccessKey: ${marker("environment_secret")}`);
      expect(redactText(`secret ${secret} and more`).value).toBe(`secret ${secret} and more`);
      expect(redactText(`see ${secret} in prose`).value).toBe(`see ${secret} in prose`);
    });

    it("counts each secret once", () => {
      const result = redactText(
        "Authorization: Bearer ghp_" +
          "A".repeat(36) +
          " and postgres://u:abcdefgh12@h/x and ?key=sk-" +
          "B".repeat(24),
      );
      expect(result.redactions).toEqual({
        total: 3,
        byKind: { github_token: 1, connection_string_password: 1, openai_token: 1 },
      });
    });
  });

  describe("JSON text", () => {
    it("masks key/value pairs inside stored JSON and keeps it valid", () => {
      const stored = JSON.stringify({
        config: { password: "hunter2hunter2", api_key: "abcdEFGH12345678", note: "token count is fine" },
        list: [{ token: "zyxwvuTSRQ1234" }, { aws_secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }],
        text: "DB_PASSWORD=hunter2hunter2 in prose",
      });
      const result = redactJsonText(stored);
      const parsed = JSON.parse(result.value) as Record<string, unknown>;
      expect(result.value).not.toContain("hunter2hunter2");
      expect(result.value).not.toContain("abcdEFGH12345678");
      expect(result.value).not.toContain("zyxwvuTSRQ1234");
      expect(result.value).not.toContain("wJalrXUtnFEMI");
      expect(JSON.stringify(parsed)).toContain("token count is fine");
      expect(result.redactions.total).toBe(5);
    });

    it("keeps JSON valid for every JSON corpus sample", () => {
      for (const entry of SECRET_CORPUS) {
        let valid = true;
        try {
          JSON.parse(entry.text);
        } catch {
          valid = false;
        }
        if (!valid) continue;
        const result = redactJsonText(entry.text);
        expect(() => JSON.parse(result.value), entry.text).not.toThrow();
        for (const secret of entry.secrets) {
          expect(result.value, entry.text).not.toContain(secret);
        }
      }
    });

    it("keeps a secret that ends with a backslash or quote from breaking the JSON", () => {
      for (const value of ['abc\\"def12345', "abcdefgh\\", 'a"b"cdefgh12']) {
        const stored = JSON.stringify({ message: `password=${value} next`, password: value });
        const result = redactJsonText(stored);
        expect(() => JSON.parse(result.value), stored).not.toThrow();
        expect(result.redactions.total).toBeGreaterThan(0);
      }
    });
  });

  describe("false positives", () => {
    it.each(BENIGN_TEXTS.map((text) => [text]))("leaves %j unchanged", (text) => {
      expect(redactText(text)).toEqual({ value: text, redactions: { total: 0, byKind: {} } });
      expect(redactJsonText(JSON.stringify({ note: text })).redactions.total).toBe(0);
    });

    it("leaves a long ordinary document unchanged", () => {
      const prose = [
        "The tokenizer splits text before the model counts tokens; secretary notes list who owns each password reset.",
        "設定頁會要求輸入密碼，權杖用量顯示在右上角。Commit 3f2a9c1d7b4e5f60718293a4b5c6d7e8f9012345 fixed it.",
        "Use --token only in CI. Keep API keys out of logs: see docs/security.md and the key rotation checklist.",
      ].join("\n");
      expect(redactText(prose.repeat(200)).redactions.total).toBe(0);
    });
  });

  describe("linear time", () => {
    it("masks 200,000 characters of every adversarial shape quickly", () => {
      const limit = limitMs();
      for (const [shape, input] of Object.entries(adversarialInputs(LONG_INPUT_LENGTH))) {
        expect(input.length, shape).toBe(LONG_INPUT_LENGTH);
        // Same threshold as the existing detectors in secret-redaction.test.ts.
        expect(
          bestOfMs(() => redactText(input)),
          shape,
        ).toBeLessThan(limit);
      }
    });

    it("takes about twice as long for twice the input on every adversarial shape", () => {
      const small = adversarialInputs(LONG_INPUT_LENGTH / 2);
      const large = adversarialInputs(LONG_INPUT_LENGTH);
      for (const [shape, input] of Object.entries(large)) {
        const { smallMs: half, largeMs: full } = doublingGrowth({
          small: () => redactText(small[shape]!),
          large: () => redactText(input),
          floorMs: 5,
          withinLimit: (smallMs, largeMs) => largeMs < smallMs * 3.5 + 50,
        });
        // Quadratic work would take four times as long (or far more); the slack absorbs timer and GC noise.
        expect(full, shape).toBeLessThan(half * 3.5 + 50);
      }
    });

    it("masks many secrets in one large text quickly", () => {
      const line = "DB_PASSWORD=hunter2hunter2 Authorization: Bearer abcdEFGH12345 ?api_key=abcdEFGH12345 ";
      const input = line.repeat(Math.ceil(LONG_INPUT_LENGTH / line.length));
      const limit = limitMs();
      const result = redactText(input);
      expect(bestOfMs(() => redactText(input))).toBeLessThan(limit);
      expect(result.value).not.toContain("hunter2hunter2");
      expect(result.redactions.total).toBeGreaterThan(1_000);
    });
  });
});
