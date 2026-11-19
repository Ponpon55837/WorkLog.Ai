import { describe, expect, it } from "vitest";
import {
  buildDiagnostics,
  clipText,
  collectDiagnostics,
  createCountingRedactor,
  createRedactor,
  DIAGNOSTICS_MAX_BYTES,
  DiagnosticsError,
  diagnosticsMessages,
  diagnosticsSummaryLines,
  dropErrorDetail,
  isOwnOutputLine,
  scanText,
  type DiagnosticsBuildInputs,
  type DiagnosticsReport,
} from "../../packages/desktop-core/src/index.js";

// Every value is synthetic: no real user, path, address or credential.
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzeW50aGV0aWMtdXNlciJ9.c3ludGhldGljLXNpZ25hdHVyZS12YWx1ZQ";
const PEM_BLOCK = [
  "-----BEGIN RSA PRIVATE" + " KEY-----",
  "MIIBOgIBAAJBAKsyntheticsyntheticsyntheticsyntheticsyntheticsynthetic",
  "-----END RSA PRIVATE" + " KEY-----",
].join("\n");
const AWS_ACCESS = ["AKI" + "A", "IOSFODNN7EXAMPLE"].join("");
const AWS_SESSION = ["ASIA", "IOSFODNN7EXAMPLE"].join("");
// Assembled at run time so the source never holds a literal in the shape secret scanners flag.
const SLACK = ["xoxb", "123456789012", "synthetictoken"].join("-");
const GITHUB = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
const OPENAI = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz"].join("-");
const AWS_SECRET_WITH_SLASHES = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

function inputs(overrides: Partial<DiagnosticsBuildInputs> = {}): DiagnosticsBuildInputs {
  return {
    platform: "linux",
    homeDirectory: "/home/current",
    userName: "current",
    appVersion: "1.2.3",
    arch: "x64",
    locale: "en-US",
    owner: "NEEDS_REPAIR",
    backend: "crashed",
    databaseStatus: "missing",
    recentErrors: [{ code: "DB_MISSING", at: "2026-01-01T00:00:00.000Z" }],
    lastBackup: { status: "known", at: "2026-01-01T00:00:00Z" },
    generatedAt: new Date(Date.UTC(2026, 0, 2)),
    recentOutput: [],
    ...overrides,
  };
}

function build(lines: readonly string[], overrides: Partial<DiagnosticsBuildInputs> = {}) {
  return buildDiagnostics(inputs({ recentOutput: lines.map((line) => `[shell] ${line}`), ...overrides }));
}

function outputOf(text: string): string[] {
  return (JSON.parse(text) as { recentOutput: string[] }).recentOutput;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("diagnostics collect", () => {
  it("keeps only the App's own output lines and counts the rest", () => {
    const own = [
      "[shell] backend started pid=1 port=3210",
      "[backend] ready",
      "[desktop-child] dropped a message (invalid)",
      "[work-intelligence] API request failed",
      "Work Intelligence API listening on http://127.0.0.1:3210",
      "SQLite database: [redacted]",
      "Database backup written: work-automatic-20260101T000000Z.sqlite",
      "Work summary update history pruned: 3 rows",
      "History prune failed: busy",
    ];
    const foreign = [
      "Session 4: rewrote the orchard irrigation schedule for the synthetic client",
      "    at Object.<anonymous> (/synthetic/app/server.js:10:5)",
      "(node:1) Warning: something",
      "",
      " [shell] indented is not ours",
      "shell: no brackets",
    ];
    const document = collectDiagnostics(
      inputs({ recentOutput: [...foreign.slice(0, 3), ...own, ...foreign.slice(3)] }),
    );
    expect(document.recentOutput).toEqual(own);
    expect(document.omittedOutputLines).toBe(foreign.length);
    expect(own.every(isOwnOutputLine)).toBe(true);
    expect(foreign.some(isOwnOutputLine)).toBe(false);
  });

  it("copies only the allow-listed fields", () => {
    const hostile = {
      ...inputs(),
      environment: { SYNTHETIC_API_KEY: "synthetic-env-value" },
      agentConfig: { command: "synthetic-agent-config" },
      mcpOutput: "synthetic-mcp-output",
      recentErrors: [{ code: "DB_MISSING", at: "2026-01-01T00:00:00.000Z", message: "synthetic-message", path: "/x" }],
    } as unknown as DiagnosticsBuildInputs;
    const text = buildDiagnostics(hostile).text;
    for (const value of ["synthetic-env-value", "synthetic-agent-config", "synthetic-mcp-output", "synthetic-message"])
      expect(text).not.toContain(value);
    expect(JSON.parse(text)).toMatchObject({
      generatedAt: "2026-01-02T00:00:00.000Z",
      app: { version: "1.2.3" },
      platform: { name: "linux", arch: "x64", locale: "en-US" },
      state: { owner: "NEEDS_REPAIR", backend: "crashed", databaseStatus: "missing" },
      recentErrors: [{ code: "DB_MISSING", at: "2026-01-01T00:00:00.000Z" }],
      omittedOutputLines: 0,
    });
  });
});

describe("diagnostics redaction", () => {
  const posix = createRedactor({ platform: "linux", homeDirectory: "/home/current", userName: "current" });
  const windows = createRedactor({ platform: "win32", homeDirectory: "C:\\Users\\Current", userName: "Current" });

  it.each([
    ["the current user's POSIX home", "/home/current/work/notes.md", "current"],
    ["another user's Linux home", "/home/alice/Projects/ClientX/notes.md", "alice"],
    ["another user's macOS home", "/Users/bob/Library/Application Support/x", "bob"],
    ["root's home", "/root/.ssh/config", ".ssh"],
    ["a tilde path", "~/Documents/ClientX/plan.md", "ClientX"],
    ["another user's Windows home", "C:\\Users\\Carol\\Documents\\ClientX\\plan.docx", "Carol"],
    ["a Windows home on another drive", "D:\\Users\\Dave\\Desktop\\ClientX\\plan.docx", "Dave"],
    ["a Windows home with forward slashes", "c:/users/erin/ClientX/plan.docx", "erin"],
    ["a Windows home in another case", "e:\\USERS\\FRANK\\ClientX", "FRANK"],
    ["an old Windows profile folder", "C:\\Documents and Settings\\Grace\\ClientX", "Grace"],
    ["a UNC share", "\\\\fileserver\\share\\team\\ClientX\\plan.xlsx", "fileserver"],
    ["a WSL share", "\\\\wsl$\\Ubuntu\\home\\heidi\\ClientX", "heidi"],
  ])("masks %s on both platforms", (_name, path, secret) => {
    for (const redact of [posix, windows]) {
      const text = redact(`opening ${path} now`);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("ClientX");
      expect(text).toMatch(/^opening \[redacted(?: path)?]/);
      expect(text).toMatch(/now$/);
    }
  });

  it("masks the JSON-escaped form of any user's Windows and share paths", () => {
    for (const path of [
      "C:\\Users\\Ivan\\Documents\\ClientX\\plan.docx",
      "d:\\users\\judy\\ClientX",
      "\\\\fileserver\\share\\ClientX\\plan.xlsx",
    ]) {
      const json = JSON.stringify({ line: `opening ${path}` });
      expect(json).toContain("\\\\");
      const text = posix(json);
      expect(text).not.toMatch(/Ivan|judy|ClientX|fileserver/i);
      expect(JSON.parse(text)).toEqual({ line: expect.stringContaining("[redacted path]") });
    }
  });

  it.each([
    ["a Windows home", "C:\\Users\\Jane Doe\\AppData\\Local\\x"],
    ["a macOS home", "/Users/Jane Doe/Library/x"],
    ["a Linux home", "/home/Jane Doe/work/x"],
  ])("masks a user name with a space in %s, plain and JSON-escaped", (_name, path) => {
    for (const redact of [posix, windows]) {
      for (const text of [redact(`opening ${path}`), redact(JSON.stringify({ line: `opening ${path}` }))]) {
        expect(text).not.toMatch(/Jane|Doe|AppData|Library|work/);
        expect(text).toContain("[redacted path]");
      }
      expect(JSON.parse(redact(JSON.stringify({ line: `opening ${path}` })))).toEqual({
        line: "opening [redacted path]",
      });
    }
  });

  it("stops a spaced user name at a quote so the surrounding text survives", () => {
    const text = posix('{"p":"/Users/Jane Doe/Library/x","after":"keep"}');
    expect(text).not.toMatch(/Jane|Doe/);
    expect(JSON.parse(text)).toEqual({ p: "[redacted path]", after: "keep" });
  });

  it("masks every secret shape and keeps the harmless words around it", () => {
    const text = posix(
      [
        `jwt ${JWT} end`,
        `pem ${PEM_BLOCK} end`,
        `aws ${AWS_ACCESS} and ${AWS_SESSION} end`,
        `slack ${SLACK} end`,
        `github ${GITHUB} end`,
        `openai ${OPENAI} end`,
        `header Bearer abc.def-ghi_jkl123456 end`,
      ].join("\n"),
    );
    for (const secret of [
      JWT,
      "MIIBOgIBAAJBAK",
      "-----BEGIN",
      "-----END",
      AWS_ACCESS,
      AWS_SESSION,
      SLACK,
      GITHUB,
      OPENAI,
      "abc.def-ghi_jkl123456",
    ])
      expect(text).not.toContain(secret);
    expect(text.split("\n").map((line) => line.split(" ")[0])).toEqual([
      "jwt",
      "pem",
      "aws",
      "slack",
      "github",
      "openai",
      "header",
    ]);
    expect(text).toContain("end");
  });

  it("masks a private-key block whose end line was cut, to the end of the text", () => {
    const text = posix(`before\n-----BEGIN PRIVATE${""} KEY-----\nMIIBsyntheticsyntheticsyntheticsynthetic`);
    expect(text).toBe("before\n[redacted]");
  });

  it("leaves a public certificate header alone", () => {
    expect(posix("-----BEGIN CERTIFICATE----- abc")).toContain("-----BEGIN CERTIFICATE-----");
  });

  it("masks query-string, fragment and credential secrets in addresses", () => {
    const text = posix(
      [
        "https://example.test/cb?code=abc123&state=zzz789&page=2",
        "https://example.test/cb?access_token=tok-abc&x=1",
        "https://example.test/cb#access_token=fragmenttoken&token_type=bearer",
        "https://example.test/#/projects/ClientX",
        "http://127.0.0.1:3210/#wi-handoff=eyJ2IjoxfQ",
        "see wi-handoff=eyJ2IjoxfQ here",
        "https://user:synthetic-password@example.test/repo",
      ].join("\n"),
    );
    for (const secret of [
      "abc123",
      "zzz789",
      "tok-abc",
      "fragmenttoken",
      "ClientX",
      "eyJ2IjoxfQ",
      "synthetic-password",
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain("page=2");
    expect(text).toContain("https://example.test/cb?code=[redacted]&state=[redacted]&page=2");
    expect(text).toContain("http://127.0.0.1:3210/#[redacted]");
  });

  it("leaves a bare hash in prose alone", () => {
    expect(posix("fixed in #123 and see ## Heading")).toBe("fixed in #123 and see ## Heading");
  });

  it("masks e-mail addresses", () => {
    const text = posix("from alice.smith+tag@example.test and bob@mail.example.test, not an @mention or a@b");
    expect(text).toBe("from [redacted email] and [redacted email], not an @mention or a@b");
  });

  it("masks values by key name, in text and in JSON", () => {
    const text = posix(
      `password=hunter2 {"api_key": "synthetic-key-value", "note": "kept"} Authorization: Bearer synthetic.bearer.value cookie: sid=1`,
    );
    for (const secret of ["hunter2", "synthetic-key-value", "synthetic.bearer.value", "sid=1"])
      expect(text).not.toContain(secret);
    expect(text).toContain('"note": "kept"');
  });

  it("does not mask a value twice", () => {
    const redactor = createCountingRedactor({
      platform: "linux",
      homeDirectory: "/home/current",
      secrets: ["s3cretvalue"],
    });
    expect(redactor.redact("token=s3cretvalue")).toBe("token=[redacted]");
    expect(redactor.counts.tokens).toBe(1);
  });

  it("counts what it masked per category, exactly", () => {
    const redactor = createCountingRedactor({
      platform: "linux",
      homeDirectory: "/home/current",
      userName: "current",
      paths: ["/data/work.sqlite"],
      secrets: ["run-id-synthetic-0123456789"],
    });
    redactor.redact("db /data/work.sqlite and /home/alice/a and /Users/bob/b and \\\\host\\share\\c"); // 4 paths
    redactor.redact("https://example.test/cb?code=1&state=2#frag"); // 2 query values + 1 fragment (the fragment goes first)
    redactor.redact(`run run-id-synthetic-0123456789 ${GITHUB} ${JWT} ${PEM_BLOCK} ${AWS_ACCESS}`); // 5 tokens
    redactor.redact("mail a@example.test b@example.test"); // 2 emails
    expect(redactor.counts).toEqual({ paths: 4, authCodes: 3, tokens: 5, emails: 2 });
  });
});

describe("diagnostics scan", () => {
  it("finds nothing in redacted text, and ignores the redactor's markers", () => {
    const text = "[redacted] [redacted path] [redacted email] token=[redacted] Bearer [redacted] ?code=[redacted]";
    expect(scanText(text)).toEqual({ text, found: { paths: 0, authCodes: 0, tokens: 0, emails: 0 }, total: 0 });
  });

  it("masks and counts what is left, by category, without returning a value", () => {
    const result = scanText(
      [
        "home /home/zed/x",
        "mail zed@example.test",
        "token=synthetic-value",
        `secret ${AWS_SECRET_WITH_SLASHES}`,
        "https://example.test/#fragmentvalue",
        "?code=synthetic-code",
      ].join("\n"),
    );
    expect(result.found).toEqual({ paths: 1, authCodes: 2, tokens: 2, emails: 1 });
    expect(result.total).toBe(6);
    expect(result.text).not.toMatch(/zed|synthetic|fragmentvalue|wJalr/);
  });

  it("reports what only the second pass found", () => {
    // The redactor's key-like runs stop at `/`, so a standard base64 secret is left for the scan.
    const built = build([`aws ${AWS_SECRET_WITH_SLASHES}`]);
    expect(built.text).not.toContain("wJalrXUtnFEMI");
    expect(built.report).toMatchObject({ maskedInScan: 1, categories: { tokens: 1 } });
  });

  it("refuses to make a file when a last pass still finds something", () => {
    // A rule whose mask is what it matches can never clear the text: the final pass finds it again.
    const stuck = [{ category: "tokens", pattern: /SYNTHETIC-LEAK/g, mask: "SYNTHETIC-LEAK" }] as const;
    let error: unknown;
    try {
      buildDiagnostics(inputs({ recentOutput: ["[shell] SYNTHETIC-LEAK"] }), { scanRules: stuck });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DiagnosticsError);
    expect((error as DiagnosticsError).code).toBe("DIAGNOSTICS_SCAN_FAILED");
    expect((error as DiagnosticsError).message).not.toContain("SYNTHETIC-LEAK");
  });

  it("does not refuse when the scan can clear what it finds", () => {
    const clearing = [{ category: "tokens", pattern: /SYNTHETIC-LEAK/g }] as const;
    const built = buildDiagnostics(inputs({ recentOutput: ["[shell] SYNTHETIC-LEAK"] }), { scanRules: clearing });
    expect(built.text).not.toContain("SYNTHETIC-LEAK");
    expect(built.report.maskedInScan).toBe(1);
  });
});

describe("diagnostics build", () => {
  it("drops work-content lines, keeps the App's own and reports exact counts", () => {
    const own = [
      "[shell] opened /home/alice/work/a.txt",
      "[work-intelligence] callback https://example.test/cb?code=abc123&state=zzz789",
      `[backend] token=${GITHUB}`,
      "[shell] mail bob@example.test",
      "[shell] backend started pid=1 port=3210",
    ];
    const foreign = [
      "Session summary: rewrote the synthetic orchard schedule",
      "    at run (/home/alice/app/server.js:1:1)",
      "SYNTHETIC-WORK-CONTENT",
    ];
    const built = buildDiagnostics(inputs({ recentOutput: [foreign[0]!, ...own, foreign[1]!, foreign[2]!] }));
    expect(outputOf(built.text)).toEqual([
      "[shell] opened [redacted path]",
      "[work-intelligence] callback https://example.test/cb?code=[redacted]&state=[redacted]",
      "[backend] token=[redacted]",
      "[shell] mail [redacted email]",
      "[shell] backend started pid=1 port=3210",
    ]);
    expect(built.text).not.toContain("orchard");
    expect(built.text).not.toContain("SYNTHETIC-WORK-CONTENT");
    expect(built.report).toEqual({
      categories: { paths: 1, authCodes: 2, tokens: 1, emails: 1 },
      maskedInScan: 0,
      omittedOutputLines: 3,
      truncatedBytes: 0,
    });
    expect(JSON.parse(built.text)).toMatchObject({ omittedOutputLines: 3, truncated: { outputLines: 0, errors: 0 } });
  });

  it("never contains a matched value in the report", () => {
    const built = build([`token=${GITHUB} ${JWT} /home/alice/x alice@example.test`]);
    const report = JSON.stringify(built.report);
    for (const secret of [GITHUB, "eyJ", "alice", "example"]) expect(report).not.toContain(secret);
  });

  it("keeps JSON valid when a mask meets an escape sequence", () => {
    const built = build(['C:\\Users\\Kim\\a"b and \\\\host\\share\\x"y', 'quote " and slash \\ end']);
    expect(() => JSON.parse(built.text)).not.toThrow();
    expect(built.text).not.toContain("Kim");
  });

  it("stays under 1 MiB and keeps the newest lines when the output is too long", () => {
    const lines = Array.from({ length: 6000 }, (_unused, index) => `line ${index} ${"x ".repeat(120)}`);
    const built = build(lines);
    const bytes = Buffer.byteLength(built.text, "utf8");
    expect(bytes).toBeLessThanOrEqual(DIAGNOSTICS_MAX_BYTES);
    const kept = outputOf(built.text);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(lines.length);
    expect(kept.at(-1)).toBe(`[shell] ${lines.at(-1)}`);
    expect(kept[0]).toBe(`[shell] ${lines[lines.length - kept.length]}`);
    const document = JSON.parse(built.text) as { truncated: { outputLines: number; errors: number } };
    expect(document.truncated).toEqual({ outputLines: lines.length - kept.length, errors: 0 });
    expect(built.report.truncatedBytes).toBeGreaterThan(0);
  });

  it("drops the oldest errors only after all the output", () => {
    const errors = Array.from({ length: 50 }, (_unused, index) => ({
      code: `SYNTHETIC_CODE_${index}`,
      at: "2026-01-01T00:00:00.000Z",
    }));
    const built = buildDiagnostics(inputs({ recentErrors: errors, recentOutput: ["[shell] a", "[shell] b"] }), {
      maxBytes: 1200,
    });
    const document = JSON.parse(built.text) as {
      recentOutput: string[];
      recentErrors: { code: string }[];
      truncated: { outputLines: number; errors: number };
    };
    expect(Buffer.byteLength(built.text)).toBeLessThanOrEqual(1200);
    expect(document.recentOutput).toEqual([]);
    expect(document.recentErrors.at(-1)?.code).toBe("SYNTHETIC_CODE_49");
    expect(document.recentErrors.length).toBeLessThan(50);
    expect(document.truncated).toEqual({ outputLines: 2, errors: 50 - document.recentErrors.length });
  });

  it("cuts a very long line without splitting a surrogate pair and stays valid JSON", () => {
    for (const unit of ["😀", "a😀", "aa😀"]) {
      const built = build([unit.repeat(8000)]);
      expect(() => JSON.parse(built.text)).not.toThrow();
      expect(built.text).not.toMatch(LONE_SURROGATE);
      expect(outputOf(built.text)[0]).toMatch(/…$/);
      expect(built.report.truncatedBytes).toBeGreaterThan(0);
    }
  });

  it("clips text on a code point boundary", () => {
    expect(clipText("abc", 3)).toBe("abc");
    expect(clipText("abcdef", 4)).toBe("abc…");
    // The cut would fall between the two halves of the emoji: it moves back before it.
    expect(clipText("ab😀cd", 4)).toBe("ab…");
    expect(clipText("😀😀😀", 4)).not.toMatch(LONE_SURROGATE);
    for (let max = 1; max < 12; max += 1) expect(clipText("a😀b😀c😀d", max)).not.toMatch(LONE_SURROGATE);
  });
});

describe("diagnostics summary", () => {
  const report: DiagnosticsReport = {
    categories: { paths: 4, authCodes: 1, tokens: 0, emails: 0 },
    maskedInScan: 0,
    omittedOutputLines: 12,
    truncatedBytes: 0,
  };

  it("says what was masked and skipped, in both languages", () => {
    expect(diagnosticsSummaryLines(diagnosticsMessages("zh-TW"), report)).toEqual([
      "已遮蔽：路徑 4、授權碼 1、權杖 0、電子郵件 0；略過 12 行非本 App 的輸出",
    ]);
    expect(diagnosticsSummaryLines(diagnosticsMessages("en"), report)).toEqual([
      "Masked: paths 4, auth codes 1, tokens 0, e-mail addresses 0; skipped 12 lines of output that were not this App's",
    ]);
  });

  it("adds the scan and truncation notes only when they apply", () => {
    const lines = diagnosticsSummaryLines(diagnosticsMessages("zh-TW"), {
      ...report,
      maskedInScan: 2,
      truncatedBytes: 4096,
    });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("2");
    expect(lines[2]).toContain("4096");
  });
});

describe("diagnostics final check", () => {
  it.each([
    ["a carriage-return escape written with literal backslashes", "[backend] wrote \\r\\n separators"],
    ["a Windows-style path with single backslashes", "[backend] loaded \\dist\\server.js"],
    ["a single backslash before a letter", "[shell] key \\n is not a newline here"],
  ])("exports %s unchanged", (_name, line) => {
    const built = buildDiagnostics(inputs({ recentOutput: [line] }));
    expect(outputOf(built.text)).toEqual([line]);
    expect(built.report.maskedInScan).toBe(0);
  });

  it("still masks a real share and refuses when a string still matches after masking", () => {
    const built = build(["opened \\\\fileserver\\share\\ClientX\\plan.xlsx"]);
    expect(outputOf(built.text)).toEqual(["[shell] opened [redacted path]"]);
    const stuck = [{ category: "paths", pattern: /\\dist/g, mask: "\\dist" }] as const;
    expect(() =>
      buildDiagnostics(inputs({ recentOutput: ["[shell] loaded \\dist\\x"] }), { scanRules: stuck }),
    ).toThrow(DiagnosticsError);
  });
});

describe("diagnostics paths with spaces", () => {
  const posix = createRedactor({ platform: "linux", homeDirectory: "/home/current", userName: "current" });
  const windows = createRedactor({ platform: "win32", homeDirectory: "C:\\Users\\Current", userName: "Current" });

  it.each([
    ["C:\\Users\\Alice Example\\Client Acme Plan\\notes.db", "Acme|Alice|notes"],
    ["/Users/alice/Library/Application Support/Acme Client/db.sqlite", "Support|Acme|sqlite"],
    ["path=C:/Users/alice/My Stuff/a.txt", "Stuff|a\\.txt"],
    ["/home/alice/My Documents/Acme Plan v2/final report.pdf", "Documents|Acme|report"],
  ])("masks all of %s", (path, leaked) => {
    for (const redact of [posix, windows]) {
      const text = redact(`opening ${path}`);
      expect(text).not.toMatch(new RegExp(leaked));
      expect(text).toMatch(/^opening (?:path=)?\[redacted path]$/);
    }
    expect(scanText(path).text).not.toMatch(new RegExp(leaked));
  });

  it("stops at a hard delimiter and keeps what follows", () => {
    for (const [text, after] of [
      ['"/Users/alice/My Stuff/a.txt" next', '" next'],
      ["(/Users/alice/My Stuff/a.txt) next", ") next"],
      ["[C:\\Users\\a b\\c d\\e.txt], next", "], next"],
      ["`/home/a/b c/d.md`; next", "`; next"],
      ["/home/a/b c/d.md|next", "|next"],
    ] as const)
      expect(posix(text)).toContain(`[redacted path]${after}`);
    expect(posix("a\n/home/a/b c/d\nafter")).toBe("a\n[redacted path]\nafter");
  });

  it("keeps the second pass in step: the scan masks a spaced path too", () => {
    const result = scanText('x /Users/alice/My Stuff/a.txt" y');
    expect(result.found.paths).toBe(1);
    expect(result.text).toBe('x [scan-masked]" y');
  });
});

describe("diagnostics own lines keep fixed text only", () => {
  it("drops the error detail of the real server line and counts it", () => {
    const built = buildDiagnostics(
      inputs({
        recentOutput: [
          "[work-intelligence] API request failed Error: project 'Acme merger plan' not found",
          "[work-intelligence] API request failed after the response started TypeError: title 'Acme' is bad",
          "Database backup failed: SqliteError: SQLITE_BUSY: database is locked while saving 'Acme merger plan'",
          "History prune failed: busy",
          "[shell] start failed: ENOENT: no such file for client Acme",
          "[shell] storage verdict not applied: project Acme merger plan not found",
          "[shell] quit failed: unknown error",
          "[shell] backend started pid=1 port=3210",
        ],
      }),
    );
    expect(outputOf(built.text)).toEqual([
      "[work-intelligence] API request failed",
      "[work-intelligence] API request failed after the response started",
      "Database backup failed: (SQLITE_BUSY)",
      "History prune failed: busy",
      "[shell] start failed: (ENOENT)",
      "[shell] storage verdict not applied:",
      "[shell] quit failed: unknown error",
      "[shell] backend started pid=1 port=3210",
    ]);
    expect(built.text).not.toMatch(/Acme|merger/);
    expect(built.report.droppedDetails).toBe(5);
  });

  it("drops a second line of an own line and keeps the report free of the field when nothing was dropped", () => {
    const dropped = dropErrorDetail("[shell] opened\nSession: Acme merger plan");
    expect(dropped).toEqual({ line: "[shell] opened", droppedDetail: true });
    const built = build(["backend started"]);
    expect(built.report).not.toHaveProperty("droppedDetails");
  });

  it("says how many details were dropped, in both languages, only when some were", () => {
    const base: DiagnosticsReport = {
      categories: { paths: 0, authCodes: 0, tokens: 0, emails: 0 },
      maskedInScan: 0,
      omittedOutputLines: 0,
      truncatedBytes: 0,
    };
    expect(diagnosticsSummaryLines(diagnosticsMessages("en"), base)).toHaveLength(1);
    for (const locale of ["en", "zh-TW"] as const) {
      const lines = diagnosticsSummaryLines(diagnosticsMessages(locale), { ...base, droppedDetails: 3 });
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("3");
    }
  });
});

describe("diagnostics other absolute paths, case and key names", () => {
  const linux = createRedactor({ platform: "linux", homeDirectory: "/home/current", userName: "current" });
  const mac = createRedactor({ platform: "darwin", homeDirectory: "/Users/Current", userName: "Current" });

  it.each([
    "D:\\Projects\\Acme\\plan.docx",
    "E:/Work/Acme/plan.docx",
    "/Volumes/External Disk/Acme/plan.docx",
    "/private/var/folders/xx/Acme/T/plan.docx",
    "/var/lib/acme/plan.db",
    "/tmp/acme-plan/work.db",
    "/mnt/c/Acme/plan.docx",
    "/media/alice/Acme/plan.docx",
    "/opt/acme/plan.db",
    "/srv/acme/plan.db",
    "/run/user/1000/acme.sock",
    "/Library/Application Support/Acme/plan.db",
    "/Applications/Acme.app/Contents/x",
    "/root/.ssh/config",
    "/etc/acme/plan.conf",
    "/usr/local/share/acme/plan.db",
    "/data/acme/plan.db",
    "/workspace/acme/plan.db",
    "/nix/store/abc-acme/bin/acme",
  ])("masks %s", (path) => {
    const text = linux(`opening ${path}`);
    expect(text).toBe("opening [redacted path]");
    expect(scanText(path).found.paths).toBe(1);
  });

  it.each(["\\\\?\\C:\\Users\\Alice\\Acme\\plan.db", "\\\\.\\D:\\Acme\\plan.db"])(
    "masks the extended-length prefix with the path: %s",
    (path) => {
      expect(
        createRedactor({ platform: "win32", homeDirectory: "C:\\Users\\Current", userName: "Current" })(`at ${path}`),
      ).toBe("at [redacted path]");
      expect(scanText(path).found.paths).toBe(1);
    },
  );

  it("leaves URL paths, relative paths and bare folder words alone", () => {
    for (const text of [
      "GET https://example.test/api/projects?x=1",
      "https://example.test/home/x and http://127.0.0.1:3210/var/log/tmp/x",
      "see src/home/x.ts and ./var/x and a/tmp/b",
      "use /tmp or the var folder; 12:30/45 ratio",
    ]) {
      expect(linux(text)).toBe(text);
      expect(scanText(text).found.paths).toBe(0);
    }
    expect(linux("file:///Users/bob/x.txt")).toBe("file://[redacted path]");
  });

  it("matches the current user's home and known paths in any case on macOS and Windows, not on Linux", () => {
    const options = {
      homeDirectory: "/Users/Current",
      userName: "Current",
      paths: ["/Users/Current/Data/work.sqlite"],
    };
    for (const platform of ["darwin", "win32"] as const) {
      const redact = createRedactor({ platform, ...options });
      const text = redact("db /users/current/data/WORK.sqlite and home /USERS/CURRENT and name CURRENT");
      expect(text).not.toMatch(/current|work\.sqlite/i);
    }
    const strict = createRedactor({ platform: "linux", ...options, homeDirectory: "/synthetic/home/Current" });
    expect(strict("name CURRENT here")).toBe("name CURRENT here");
    expect(mac("/users/bob/x")).toBe("[redacted path]");
  });

  it("masks the new secret key names, and keeps prose that only starts like them", () => {
    const text = linux(
      [
        "pwd=hunter2 passphrase: correct-horse credential=abc1 credentials: abc2",
        'pass=hunter3 {"pass": "hunter4"} {"credentials":"abc5"} PASS:hunter6',
      ].join("\n"),
    );
    for (const secret of ["hunter", "correct-horse", "abc1", "abc2", "abc5"]) expect(text).not.toContain(secret);
    for (const prose of [
      "the test passed = fine",
      "pass rate: 5",
      "pass : 3",
      "bypass=1 compass: 2",
      "passed=1 and passes: 4",
    ])
      expect(linux(prose)).toBe(prose);
    expect(scanText("pwd=abc passphrase=abc credential=abc credentials: abc pass=abc").found.tokens).toBe(5);
    expect(scanText("pass rate: 5 passed=1").total).toBe(0);
  });

  it("masks an address glued to a long run in the first pass, as the scan does", () => {
    const glued = `${"a".repeat(100)}@mail.example.test`;
    const redactor = createCountingRedactor({ platform: "linux", homeDirectory: "/home/current" });
    expect(redactor.redact(`from ${glued} end`)).not.toContain("@mail");
    expect(redactor.counts.emails).toBe(1);
  });
});
