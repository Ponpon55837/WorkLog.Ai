import { describe, expect, it } from "vitest";
import { describeAgentSetupMutations, type AgentSetupPlan } from "@work-intelligence/agent-setup";

function planOf(...changes: [before: string | null, after: string | null][]): AgentSetupPlan {
  return {
    mode: "install",
    actions: [],
    conflicts: [],
    findings: [],
    mutations: changes.map(([before, after], index) => ({
      path: `/home/synthetic/file-${index}.txt`,
      label: `fixture ${index}`,
      before: before === null ? null : Buffer.from(before, "utf8"),
      after: after === null ? null : Buffer.from(after, "utf8"),
      mode: 0o600,
      beforeFingerprint: "x",
      afterFingerprint: "y",
    })),
  };
}

function numbered(count: number, prefix = "line"): string[] {
  return Array.from({ length: count }, (_value, index) => `${prefix} ${index + 1}`);
}

function render(plan: AgentSetupPlan): string[] {
  return (describeAgentSetupMutations(plan)[0]?.hunks ?? []).flatMap((hunk) =>
    hunk.lines.map((line) => `${{ context: " ", add: "+", remove: "-", note: "!" }[line.type]}${line.text}`),
  );
}

describe("describeAgentSetupMutations", () => {
  it("names the path, label and kind of change for create, update and delete", () => {
    const described = describeAgentSetupMutations(planOf([null, "a\n"], ["a\n", "b\n"], ["a\n", null]));
    expect(described.map((item) => [item.label, item.change])).toEqual([
      ["fixture 0", "create"],
      ["fixture 1", "update"],
      ["fixture 2", "delete"],
    ]);
    expect(described[0]?.path).toBe("/home/synthetic/file-0.txt");
    expect(described[0]?.hunks).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [{ type: "add", text: "a" }] },
    ]);
    expect(described[2]?.hunks).toEqual([
      { oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: [{ type: "remove", text: "a" }] },
    ]);
  });

  it("shows changed lines with two lines of context and unified-diff line numbers", () => {
    const before = numbered(10);
    const after = [...before];
    after[4] = "line 5 changed";
    const [description] = describeAgentSetupMutations(planOf([before.join("\n") + "\n", after.join("\n") + "\n"]));
    expect(description?.hunks).toEqual([
      {
        oldStart: 3,
        oldLines: 5,
        newStart: 3,
        newLines: 5,
        lines: [
          { type: "context", text: "line 3" },
          { type: "context", text: "line 4" },
          { type: "remove", text: "line 5" },
          { type: "add", text: "line 5 changed" },
          { type: "context", text: "line 6" },
          { type: "context", text: "line 7" },
        ],
      },
    ]);
  });

  it("splits distant changes into separate hunks and merges close ones", () => {
    const before = numbered(30);
    const far = [...before];
    far[2] = "A";
    far[25] = "B";
    expect(describeAgentSetupMutations(planOf([before.join("\n"), far.join("\n")]))[0]?.hunks.length).toBe(2);
    const near = [...before];
    near[2] = "A";
    near[7] = "B";
    const merged = describeAgentSetupMutations(planOf([before.join("\n"), near.join("\n")]))[0]?.hunks;
    expect(merged?.length).toBe(1);
    expect(merged?.[0]).toMatchObject({ oldStart: 1, oldLines: 10, newStart: 1, newLines: 10 });
  });

  it("handles insertions and deletions at the start and end of a file", () => {
    expect(render(planOf(["b\nc\n", "a\nb\nc\nd\n"]))).toEqual(["+a", " b", " c", "+d"]);
    expect(render(planOf(["a\nb\nc\nd\n", "b\nc\n"]))).toEqual(["-a", " b", " c", "-d"]);
  });

  it("ignores line endings and a final newline: a CRLF-only change has no hunks", () => {
    const [crlf] = describeAgentSetupMutations(planOf(["a\nb\nc\n", "a\r\nb\r\nc\r\n"]));
    expect(crlf?.change).toBe("update");
    expect(crlf?.hunks).toEqual([]);
    expect(render(planOf(["a\r\nb\r\n", "a\r\nx\r\nb\r\n"]))).toEqual([" a", "+x", " b"]);
  });

  it("masks secret values in JSON before and after lines, and in unchanged context lines", () => {
    const before = ["{", '  "apiKey": "sk-before-1234",', '  "name": "keep",', '  "token": "old-token"', "}"].join(
      "\n",
    );
    const after = ["{", '  "apiKey": "sk-after-5678",', '  "name": "keep",', '  "token": "new-token"', "}"].join("\n");
    const lines = render(planOf([before, after]));
    expect(lines).toEqual([
      " {",
      '-  "apiKey": ***,',
      '+  "apiKey": ***,',
      '   "name": "keep",',
      '-  "token": ***',
      '+  "token": ***',
      " }",
    ]);
    const joined = lines.join("\n");
    for (const secret of ["sk-before-1234", "sk-after-5678", "old-token", "new-token"]) {
      expect(joined).not.toContain(secret);
    }
  });

  it("masks every sensitive key name, case-insensitively, in TOML and JSON", () => {
    const keys = [
      "secret",
      "PASSWORD",
      "passwd",
      "api_key",
      "api-key",
      "apikey",
      "Authorization",
      "bearerToken",
      "session_cookie",
      "credentials",
      "private_key",
      "privateKey",
    ];
    const toml = keys.map((key) => `${key} = "hunter2"`).join("\n");
    const json = `{ ${keys.map((key) => `"${key}": "hunter2"`).join(", ")}, "plain": "visible" }`;
    const text = render(planOf([null, `${toml}\n[env]\nINNER_TOKEN = 'abc123'\nplain = "visible"\n${json}\n`])).join(
      "\n",
    );
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abc123");
    expect(text).toContain('plain = "visible"');
    expect(text).toContain('"plain": "visible"');
    expect(text).toContain("INNER_TOKEN = ***");
  });

  it("masks the values of secret-style arguments, as one string or as separate array elements", () => {
    const text = render(
      planOf([
        null,
        [
          'command = "node server.js --token tok-one --api-key=key-two --password pw-three --port 8080"',
          'args = ["--token", "tok-four", "--secret=sec-five", "--name", "visible-name"]',
          '  "args": ["--password", "pw-six"]',
          "args = [",
          '  "--api-key",',
          '  "key-seven",',
          '  "--mode",',
          '  "visible-mode",',
          "]",
        ].join("\n"),
      ]),
    ).join("\n");
    for (const secret of ["tok-one", "key-two", "pw-three", "tok-four", "sec-five", "pw-six", "key-seven"]) {
      expect(text).not.toContain(secret);
    }
    for (const visible of ["--port 8080", "visible-name", "visible-mode"]) expect(text).toContain(visible);
    expect(text).toContain("--token ***");
    expect(text).toContain("--api-key=***");
  });

  it("masks secret query parameters inside values and keeps the others", () => {
    const text = render(
      planOf([
        null,
        [
          'url = "https://example.test/v1?apiKey=qk-one&page=2&token=qk-two&access_token=qk-three"',
          '{ "endpoint": "https://example.test/?q=1&password=qk-four#frag" }',
        ].join("\n"),
      ]),
    ).join("\n");
    for (const secret of ["qk-one", "qk-two", "qk-three", "qk-four"]) expect(text).not.toContain(secret);
    expect(text).toContain("page=2");
    expect(text).toContain("q=1");
    expect(text).toContain("#frag");
  });

  it("masks env keys that end in _PAT, _TOKEN, _SECRET, _KEY, _DSN or name a PASSWORD or DATABASE_URL", () => {
    const masked = [
      "GITHUB_PAT",
      "NPM_TOKEN",
      "CLIENT_SECRET",
      "SIGNING_KEY",
      "DB_PASSWORD",
      "DATABASE_URL",
      "SENTRY_DSN",
    ];
    const text = render(planOf([null, masked.map((key) => `${key} = "value-${key}"`).join("\n")])).join("\n");
    for (const key of masked) {
      expect(text).not.toContain(`value-${key}`);
      expect(text).toContain(`${key} = ***`);
    }
  });

  it("matches _KEY only as a whole trailing word: MONKEY_MODE, KEYBOARD and KEY_PATH stay visible", () => {
    const text = render(
      planOf([null, ['MONKEY_MODE = "banana"', 'KEYBOARD = "qwerty"', 'KEY_PATH = "/tmp/x"'].join("\n")]),
    ).join("\n");
    expect(text).toContain('MONKEY_MODE = "banana"');
    expect(text).toContain('KEYBOARD = "qwerty"');
    expect(text).toContain('KEY_PATH = "/tmp/x"');
  });

  it("masks Bearer values wherever they appear", () => {
    const lines = render(
      planOf(["", 'curl -H "Authorization: Bearer abc.def-123" https://example.test\nBearer topsecret\n']),
    );
    const text = lines.join("\n");
    expect(text).not.toContain("abc.def-123");
    expect(text).not.toContain("topsecret");
    expect(text).toContain("Bearer ***");
  });

  it("masks the lines of a multi-line secret object or array", () => {
    const text = render(
      planOf([
        null,
        ["{", '  "credentials": {', '    "user": "alice",', '    "pass": "p4ss"', "  },", '  "other": 1', "}"].join(
          "\n",
        ),
      ]),
    ).join("\n");
    expect(text).not.toContain("alice");
    expect(text).not.toContain("p4ss");
    expect(text).toContain('"other": 1');
  });

  it("still shows that a secret changed, without showing either value", () => {
    const lines = render(planOf(['token = "one"\n', 'token = "two"\n']));
    expect(lines).toEqual(["-token = ***", "+token = ***"]);
  });

  it("returns a single note instead of a diff for a file that is too large", () => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const [bytes] = describeAgentSetupMutations(planOf([null, big]));
    expect(bytes?.tooLarge).toBe(true);
    expect(bytes?.hunks).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [{ type: "note", text: "檔案過大，無法顯示差異" }] },
    ]);
    const lines = Array.from({ length: 20_001 }, () => "a").join("\n");
    expect(describeAgentSetupMutations(planOf([lines, "b"]))[0]?.tooLarge).toBe(true);
    expect(
      describeAgentSetupMutations(planOf([Array.from({ length: 20_000 }, () => "a").join("\n"), "b"]))[0]?.tooLarge,
    ).toBe(false);
  });

  it("diffs a few thousand lines quickly and exactly", () => {
    const before = numbered(3000);
    const after = before.filter((_line, index) => index % 100 !== 0);
    after.splice(1500, 0, "inserted");
    const [description] = describeAgentSetupMutations(planOf([before.join("\n"), after.join("\n")]));
    const removed = description?.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.type === "remove") ?? [];
    const added = description?.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.type === "add") ?? [];
    expect(removed.length).toBe(30);
    expect(added).toEqual([{ type: "add", text: "inserted" }]);
  });
});
