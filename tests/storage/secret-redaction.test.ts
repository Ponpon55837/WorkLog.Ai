import { describe, expect, it } from "vitest";
import {
  combineRedactionSummaries,
  redactJsonText,
  redactPrivateBlocksText,
  redactText,
  redactValue,
} from "../../packages/storage/src/secret-redaction.js";

const PRIVATE_MARKER = "[REDACTED:private_block]";
const LONG_INPUT_LENGTH = 200_000;
const JWT = `eyJ${"a".repeat(18)}.${"b".repeat(20)}.${"c".repeat(20)}`;
const PASSWORD = "M".repeat(20);
const VALUE = "N".repeat(12);

function marker(kind: string): string {
  return `[REDACTED:${kind}]`;
}

/** Repeats `unit` to exactly `length` characters, the last of which come from `tail`. */
function repeatTo(unit: string, length: number, tail = ""): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length - tail.length) + tail;
}

/** Inputs that made a detector re-scan or backtrack through the rest of the text from many start positions. */
function adversarialInputs(length: number): Record<string, string> {
  return {
    "one long word": "x".repeat(length),
    "digits and dots": repeatTo("1.", length),
    whitespace: " ".repeat(length),
    "repeated token= without a terminator": repeatTo("token=", length, "<"),
    "repeated password:": repeatTo("password:", length, "<"),
    "repeated x-api-key:": repeatTo("x-api-key:", length, "<"),
    "keyword then whitespace": `password${" ".repeat(length - 9)}<`,
    "aws key then whitespace": `aws_secret_access_key=${" ".repeat(length - 23)}<`,
    "repeated aws_secret_access_key=": repeatTo("aws_secret_access_key=", length, "<"),
    "scheme then a long host": `a://${"b".repeat(length - 4)}`,
    "scheme and user then a long password": `a://u:${"p".repeat(length - 6)}`,
    "scheme then colons": `a://${"u".repeat(length / 2 - 4)}${":".repeat(length / 2)}`,
    "repeated ://": repeatTo("://", length),
    "repeated a://u:": repeatTo("a://u:", length),
    "eyJ then a long word": `eyJ${"a".repeat(length - 3)}`,
    "repeated .eyJ": repeatTo(".eyJ", length),
    "repeated JWT-like segments": repeatTo("-eyJaaaaaaaaaaaa.aaaaaaaaaaaa", length),
    "repeated -xoxb-": repeatTo("-xoxb-", length),
    "repeated -sk-": repeatTo("-sk-", length),
    "repeated -sk-ant-": repeatTo("-sk-ant-", length),
    "repeated ghp_": repeatTo(" ghp_", length),
    "repeated github_pat_": repeatTo(" github_pat_", length),
    "repeated -AIza": repeatTo("-AIza", length),
    "repeated AKIA": repeatTo(" AKIA", length),
    "repeated private key headers": repeatTo("-----BEGIN PRIVATE KEY-----a", length),
    "repeated <private>": repeatTo("<private>", length),
    "opening then closing tags": `${"<private>".repeat(length / 20)}${"</private>".repeat(length / 20)}${" ".repeat(length / 20)}`,
  };
}

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
      // The case-insensitive rules are found through their keywords in any case, not only as written above.
      { kind: "aws_secret_key", value: `AWS_Secret_Access_Key: ${"J".repeat(40)}` },
      {
        kind: "private_key",
        value: `-----BEGIN PRIVATE KEY-----\n${"K".repeat(64)}\n-----END PRIVATE KEY-----`,
      },
      { kind: "jwt", value: `eyJ${"a".repeat(18)}.${"b".repeat(20)}.${"c".repeat(20)}` },
      { kind: "connection_string_password", value: `postgres://worker:${"M".repeat(20)}@db.local/work` },
      { kind: "environment_secret", value: `API_KEY=${"N".repeat(20)}` },
      { kind: "environment_secret", value: `Password: ${"N".repeat(20)}` },
      { kind: "environment_secret", value: `apiKey=${"N".repeat(20)}` },
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

  describe("boundaries", () => {
    it("masks credentials next to punctuation, at either end, inside URLs, and in quoted values", () => {
      const cases: Array<[string, string]> = [
        [`ghp_${"A".repeat(36)}`, marker("github_token")],
        [`(ghp_${"A".repeat(36)}), next`, `(${marker("github_token")}), next`],
        [`https://example.com/?key=sk-${"C".repeat(24)}&x=1`, `https://example.com/?key=${marker("openai_token")}&x=1`],
        [`"xoxb-${"1234567890-".repeat(2)}EEEE"`, `"${marker("slack_token")}"`],
        [`key-AIza${"F".repeat(35)}`, `key-${marker("google_api_key")}`],
        [`https://app.example/cb?jwt=${JWT}&next=1`, `https://app.example/cb?jwt=${marker("jwt")}&next=1`],
        [`aws_secret_access_key: "${"J".repeat(40)}"`, `aws_secret_access_key: "${marker("aws_secret_key")}"`],
      ];
      for (const [input, expected] of cases) {
        expect(redactText(input).value).toBe(expected);
      }
    });

    it("masks an assigned value only when the whole value ends at a terminator", () => {
      const cases: Array<[string, string]> = [
        [`x-api-key: "${VALUE}"`, `x-api-key: "${marker("environment_secret")}"`],
        [`password=${VALUE};`, `password=${marker("environment_secret")};`],
        [`run --token=${VALUE}`, `run --token=${marker("environment_secret")}`],
        [`{secret: '${VALUE}'}`, `{secret: '${marker("environment_secret")}'}`],
        [`PASSWORD=password=${VALUE} done`, `PASSWORD=${marker("environment_secret")} done`],
        [`token=${VALUE}<`, `token=${VALUE}<`],
        [`token=token=token=${VALUE}<`, `token=token=token=${VALUE}<`],
        ["secret: 'short'", "secret: 'short'"],
      ];
      for (const [input, expected] of cases) {
        expect(redactText(input).value).toBe(expected);
      }
    });

    it("masks connection-string passwords for any scheme and keeps the rest of the URL", () => {
      const cases: Array<[string, string]> = [
        [
          `postgres://user:${PASSWORD}@db.local/work`,
          `postgres://user:${marker("connection_string_password")}@db.local/work`,
        ],
        [
          `mongodb+srv://svc:${PASSWORD}@cluster0.example.net/app?retryWrites=true`,
          `mongodb+srv://svc:${marker("connection_string_password")}@cluster0.example.net/app?retryWrites=true`,
        ],
        [
          `see (redis://cache:${PASSWORD}@10.0.0.5:6379)`,
          `see (redis://cache:${marker("connection_string_password")}@10.0.0.5:6379)`,
        ],
        [`9postgres://u:${PASSWORD}@h`, `9postgres://u:${marker("connection_string_password")}@h`],
        [`url=db-postgres://u:${PASSWORD}@h`, `url=db-postgres://u:${marker("connection_string_password")}@h`],
        [`postgres://u:${PASSWORD}/db`, `postgres://u:${PASSWORD}/db`],
        [`123://u:${PASSWORD}@h`, `123://u:${PASSWORD}@h`],
      ];
      for (const [input, expected] of cases) {
        expect(redactText(input).value).toBe(expected);
      }
    });

    it("masks the password, not a user name that equals it", () => {
      expect(redactText("postgres://abcdefgh12:abcdefgh12@db.local/work").value).toBe(
        `postgres://abcdefgh12:${marker("connection_string_password")}@db.local/work`,
      );
    });

    it("masks a credentials key only when the keyword is the whole key or follows a separator", () => {
      const value = "Zq7KdLm2XwRt9Pv";
      expect(redactText(`db_credentials=${value}`).value).toBe(`db_credentials=${marker("environment_secret")}`);
      expect(redactText(`CREDENTIALS: ${value}`).value).toBe(`CREDENTIALS: ${marker("environment_secret")}`);
      expect(redactText(`withCredentials=${value}`).value).toBe(`withCredentials=${value}`);
    });

    it("keeps a type annotation but masks a value that only starts like a type name", () => {
      for (const text of [
        "password: string|null",
        "token: string | null",
        "secret: Uint8Array",
        "password: undefined",
        "`account: string`, `password: string|undefined`, `fileName: string`",
        "password?: string",
        "secret: number|string[]|null",
        'password: str = ""',
        "api_key=unknown",
        "Password string",
      ]) {
        expect(redactText(text).value).toBe(text);
      }
      for (const value of ["stringent-Pa55word", "String123xyz!", "string-Pa55word99", "string|Pa55word99xyz"]) {
        expect(redactText(`password: ${value}`).value).toBe(`password: ${marker("environment_secret")}`);
      }
    });

    it("ends an unquoted value at a backtick or full-width punctuation", () => {
      const secret = "Pa55word-xyz123";
      expect(redactText(`\`password: ${secret}\`、\`fileName: x\``).value).toBe(
        `\`password: ${marker("environment_secret")}\`、\`fileName: x\``,
      );
      expect(redactText(`password: ${secret}，token: x`).value).toBe(
        `password: ${marker("environment_secret")}，token: x`,
      );
      expect(redactText(`密碼 password=${secret}。`).value).toBe(`密碼 password=${marker("environment_secret")}。`);
    });

    it("masks a quoted bare JSON token only when it looks like a credential", () => {
      expect(redactJsonText(`{"token":"Zq7KdLm2XwRt9Pv"}`).value).toBe(`{"token":"${marker("environment_secret")}"}`);
      expect(redactJsonText(`{"token":"internationalization","token_id":"x"}`).value).toBe(
        `{"token":"internationalization","token_id":"x"}`,
      );
    });

    it("masks a spaced JSON key but not a key followed by the next attribute", () => {
      expect(redactText(`{"password" : "Zq7KdLm2XwRt9Pv"}`).value).toBe(
        `{"password" : "${marker("environment_secret")}"}`,
      );
      expect(redactText(`"password" :aria-label="Zq7KdLm2XwRt9Pv"`).value).toBe(
        `"password" :aria-label="Zq7KdLm2XwRt9Pv"`,
      );
    });

    it("leaves already redacted text unchanged when it is redacted again", () => {
      const once = redactText(`token=Zq7KdLm2XwRt9Pv password: "Zq7KdLm2XwRt9Pv" ghp_${"Zq7KdLm2".repeat(5)}`).value;
      expect(redactText(once).value).toBe(once);
      expect(redactJsonText(JSON.stringify({ text: once })).value).toBe(JSON.stringify({ text: once }));
    });

    it("masks each private key from its header to the first footer after it", () => {
      expect(
        redactText(
          "-----BEGIN PRIVATE KEY-----\nx\n-----BEGIN RSA PRIVATE KEY-----\ny\n-----END RSA PRIVATE KEY----- tail",
        ).value,
      ).toBe(`${marker("private_key")} tail`);
      expect(
        redactText(
          "-----BEGIN PRIVATE KEY-----a-----END PRIVATE KEY----- and -----BEGIN EC PRIVATE KEY-----b-----END EC PRIVATE KEY-----",
        ).value,
      ).toBe(`${marker("private_key")} and ${marker("private_key")}`);
      const empty = "-----BEGIN PRIVATE KEY----------END PRIVATE KEY-----";
      expect(redactText(empty)).toEqual({ value: empty, redactions: { total: 0, byKind: {} } });
    });
  });

  describe("linear time", () => {
    it("masks 200,000 characters of every adversarial shape quickly", () => {
      for (const [shape, input] of Object.entries(adversarialInputs(LONG_INPUT_LENGTH))) {
        expect(input.length, shape).toBe(LONG_INPUT_LENGTH);
        const started = performance.now();
        redactText(input);
        // Each shape took 1–2 s at 40,000 characters (about 46 s at 200,000) before the detectors became linear.
        expect(performance.now() - started, shape).toBeLessThan(1_000);
      }
    });
  });
});

describe("redactValue on deeply nested values", () => {
  const SECRET = `ghp_${"A".repeat(36)}`;

  /** Builds the nesting with a loop: a recursive builder would overflow the stack itself. */
  function nested(levels: number, leaf: unknown, wrap: (inner: unknown) => unknown): unknown {
    let value = leaf;
    for (let level = 0; level < levels; level += 1) value = wrap(value);
    return value;
  }

  function leafOf(value: unknown, pick: (outer: unknown) => unknown): unknown {
    let current = value;
    while (Array.isArray(current) || (typeof current === "object" && current !== null)) current = pick(current);
    return current;
  }

  it.each([5_000, 50_000])("masks a secret at the bottom of %i nested arrays without overflowing", (levels) => {
    const result = redactValue(nested(levels, `token ${SECRET}`, (inner) => [inner]));
    expect(result.redactions.total).toBe(1);
    expect(leafOf(result.value, (outer) => (outer as unknown[])[0])).toBe(`token ${marker("github_token")}`);
  });

  it.each([5_000, 50_000])("handles %i nested objects with and without a secret", (levels) => {
    const clean = redactValue(nested(levels, "plain", (inner) => ({ child: inner })));
    expect(clean.redactions.total).toBe(0);
    expect(leafOf(clean.value, (outer) => (outer as { child: unknown }).child)).toBe("plain");
    const secret = redactValue(nested(levels, SECRET, (inner) => ({ child: inner })));
    expect(secret.redactions.total).toBe(1);
    expect(leafOf(secret.value, (outer) => (outer as { child: unknown }).child)).toBe(marker("github_token"));
  });

  it("keeps shape, key order and own __proto__ keys, and does not share the input's containers", () => {
    const input = JSON.parse(`{"b":[1,null,"x",{"c":"${SECRET}"}],"a":2,"__proto__":{"k":"v"}}`) as Record<
      string,
      unknown
    >;
    const result = redactValue(input);
    expect(Object.keys(result.value)).toEqual(["b", "a", "__proto__"]);
    expect(JSON.stringify(result.value)).toBe(
      `{"b":[1,null,"x",{"c":"${marker("github_token")}"}],"a":2,"__proto__":{"k":"v"}}`,
    );
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(result.value).not.toBe(input);
  });

  it("allows the same object twice but rejects a cycle instead of looping", () => {
    const shared = { text: "same" };
    expect(redactValue({ a: shared, b: shared }).value).toEqual({ a: shared, b: shared });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redactValue(cyclic)).toThrow(TypeError);
  });

  it("redactJsonText returns a result for a 50,000-level value that cannot be serialized again", () => {
    const text = `${"[".repeat(50_000)}${JSON.stringify(`x ${SECRET}`)}${"]".repeat(50_000)}`;
    expect(() => redactJsonText(text)).not.toThrow();
  });
});
