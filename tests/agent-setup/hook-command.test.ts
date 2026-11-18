import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_POST_TOOL_USE_MATCHER,
  LEGACY_CODEX_POST_TOOL_USE_MATCHER,
  classifyHookCommand,
  classifyMcpRegistration,
  commandForAgentHook,
  commandForLauncherHook,
  inspectAgentHooks,
  inspectHookInstallation,
  type HookInstallation,
} from "@work-intelligence/agent-setup";
import { createFixture, writeJson } from "./fixture.js";

const CLAUDE_ACTION = "claude-finalize-reminder";
const CODEX_ACTION = "codex-finalize-reminder";
const WINDOWS_SHIM = String.raw`C:\Program Files\Work Intelligence\bin\work-intelligence-launcher.cmd`;
const POSIX_SHIM = "/opt/Work Intelligence's App/bin/work-intelligence-launcher";
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-hook-command-"));
  temporaryRoots.push(root);
  return root;
}

function touch(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "// fixture\n");
  return path;
}

/** A hooks config with one entry per event, each running `command`. */
function hooksWith(events: Record<string, string | { matcher: string; command: string }>): unknown {
  const hooks: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(events)) {
    const { matcher, command } = typeof value === "string" ? { matcher: undefined, command: value } : value;
    hooks[event] = [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] }];
  }
  return { hooks };
}

function stateOf(installation: HookInstallation, event: string): string | undefined {
  return installation.events.find((entry) => entry.event === event)?.state;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("classifyHookCommand", () => {
  it("recognises a checkout script whose path has doubled separators, as a JSON-escaped path does", () => {
    // `node "C:\\repo\\apps\\mcp\\dist\\finalize-reminder.js"`: the old doctor collapsed repeated separators too.
    const doubled = String.raw`node "C:\\repo\\apps\\mcp\\dist\\finalize-reminder.js"`;
    expect(classifyHookCommand(doubled, { platform: "win32" })).toMatchObject({
      kind: "checkout",
      action: CLAUDE_ACTION,
    });
    const unc = String.raw`node \\server\share\repo\apps\mcp\dist\codex-finalize-reminder.js`;
    expect(classifyHookCommand(unc, { platform: "win32" })).toMatchObject({ kind: "checkout" });
    expect(classifyHookCommand("node /repo//apps/mcp//dist/finalize-reminder.js", { platform: "linux" })).toMatchObject(
      {
        kind: "checkout",
        action: CLAUDE_ACTION,
      },
    );
  });

  it("recognises the launcher form with a Windows .cmd shim in a path with spaces", () => {
    const command = commandForLauncherHook(WINDOWS_SHIM, CLAUDE_ACTION, "win32");
    expect(command).toBe(`"${WINDOWS_SHIM}" ${CLAUDE_ACTION}`);

    expect(classifyHookCommand(command, { platform: "win32" })).toEqual({
      kind: "launcher",
      action: CLAUDE_ACTION,
      scriptPath: WINDOWS_SHIM,
      current: true,
    });
    expect(classifyHookCommand(command, { platform: "win32", shimPath: WINDOWS_SHIM })).toMatchObject({
      kind: "launcher",
      current: true,
    });
    expect(
      classifyHookCommand(command, {
        platform: "win32",
        shimPath: String.raw`D:\Other\bin\work-intelligence-launcher.cmd`,
      }),
    ).toMatchObject({ kind: "launcher", current: false });
  });

  it("recognises the launcher form with a POSIX shim whose path has spaces and an apostrophe", () => {
    const command = commandForLauncherHook(POSIX_SHIM, CODEX_ACTION, "linux");
    expect(classifyHookCommand(command, { platform: "linux", shimPath: POSIX_SHIM })).toEqual({
      kind: "launcher",
      action: CODEX_ACTION,
      scriptPath: POSIX_SHIM,
      current: true,
    });
  });

  it("only takes exactly a shim and a known action as the launcher form", () => {
    const shim = `"${WINDOWS_SHIM}"`;
    expect(classifyHookCommand(`${shim} some-other-action`, { platform: "win32" }).kind).toBe("other");
    expect(classifyHookCommand(`${shim} ${CLAUDE_ACTION} --extra`, { platform: "win32" }).kind).toBe("other");
    expect(classifyHookCommand(`"C:\\Tools\\other.cmd" ${CLAUDE_ACTION}`, { platform: "win32" }).kind).toBe("other");
    expect(classifyHookCommand(`${shim} "${CLAUDE_ACTION}`, { platform: "win32" }).kind).toBe("other");
    expect(classifyHookCommand("", { platform: "win32" }).kind).toBe("other");
  });

  it("recognises the checkout form with quoted, unquoted and exec-form script paths", () => {
    const script = "/home/someone/Work Intelligence's repo/apps/mcp/dist/finalize-reminder.js";
    expect(classifyHookCommand(commandForAgentHook(script, "linux"), { platform: "linux" })).toEqual({
      kind: "checkout",
      action: CLAUDE_ACTION,
      scriptPath: script,
    });
    const windowsScript = String.raw`C:\Users\someone\Work Intelligence\apps\mcp\dist\codex-finalize-reminder.js`;
    expect(classifyHookCommand(commandForAgentHook(windowsScript, "win32"), { platform: "win32" })).toEqual({
      kind: "checkout",
      action: CODEX_ACTION,
      scriptPath: windowsScript,
    });
    expect(
      classifyHookCommand(String.raw`node.exe C:\repo\apps\mcp\dist\codex-finalize-reminder.js`, { platform: "win32" }),
    ).toMatchObject({ kind: "checkout", scriptPath: String.raw`C:\repo\apps\mcp\dist\codex-finalize-reminder.js` });
    expect(classifyHookCommand("/usr/local/bin/node", { platform: "linux", args: [script] })).toMatchObject({
      kind: "checkout",
      scriptPath: script,
    });
  });

  it("does not take another script or another runtime for a checkout hook", () => {
    expect(classifyHookCommand("node /repo/apps/mcp/dist/other.js", { platform: "linux" }).kind).toBe("other");
    expect(classifyHookCommand("node /tmp/finalize-reminder.js", { platform: "linux" }).kind).toBe("other");
    expect(classifyHookCommand("python /repo/apps/mcp/dist/finalize-reminder.js", { platform: "linux" }).kind).toBe(
      "other",
    );
    expect(classifyHookCommand("node", { platform: "linux" }).kind).toBe("other");
  });
});

describe("classifyHookCommand without a platform", () => {
  /** Runs `body` as if the process ran on `platform`, which is what the doctor and inspect rely on. */
  function onPlatform(platform: NodeJS.Platform, body: () => void): void {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform });
    try {
      body();
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  }

  it("keeps the backslashes of unquoted Windows paths on win32", () => {
    onPlatform("win32", () => {
      expect(classifyHookCommand(String.raw`node C:\repo\apps\mcp\dist\finalize-reminder.js`)).toEqual({
        kind: "checkout",
        action: CLAUDE_ACTION,
        scriptPath: String.raw`C:\repo\apps\mcp\dist\finalize-reminder.js`,
      });
      expect(
        classifyHookCommand(String.raw`C:\nodejs\node.exe "C:\repo\apps\mcp\dist\codex-finalize-reminder.js"`).kind,
      ).toBe("checkout");
      expect(
        classifyHookCommand(String.raw`C:\Users\me\bin\work-intelligence-launcher.cmd ${CLAUDE_ACTION}`),
      ).toMatchObject({ kind: "launcher", action: CLAUDE_ACTION });
    });
  });

  it("reads an unquoted Windows command through inspectHookInstallation", () => {
    onPlatform("win32", () => {
      const script = String.raw`C:\repo\apps\mcp\dist\finalize-reminder.js`;
      const installation = inspectHookInstallation(hooksWith({ Stop: `node ${script}` }), "claude-code", {
        isFile: (path) => path === script,
      });
      expect(stateOf(installation, "Stop")).toBe("installed");
    });
  });
});

describe("checkout hook commands the older check accepted", () => {
  const script = "/repo/apps/mcp/dist/finalize-reminder.js";

  it.each([
    ["node flags", `node --no-warnings ${script}`],
    ["env prefixes", `ENV=x node ${script}`],
    ["cd and &&", `cd /repo && node ${script}`],
    ["quoted script after flags", `/usr/bin/node --enable-source-maps '${script}'`],
  ])("recognises %s", (_name, command) => {
    expect(classifyHookCommand(command, { platform: "linux" })).toEqual({
      kind: "checkout",
      action: CLAUDE_ACTION,
      scriptPath: script,
    });
    const installation = inspectHookInstallation(hooksWith({ Stop: command }), "claude-code", {
      platform: "linux",
      isFile: (path) => path === script,
    });
    expect(stateOf(installation, "Stop")).toBe("installed");
    expect(
      stateOf(
        inspectHookInstallation(hooksWith({ Stop: command }), "claude-code", {
          platform: "linux",
          isFile: () => false,
        }),
        "Stop",
      ),
    ).toBe("stale");
  });

  it("still needs node before the script", () => {
    expect(classifyHookCommand(`${script} node`, { platform: "linux" }).kind).toBe("other");
    expect(classifyHookCommand(`echo ${script}`, { platform: "linux" }).kind).toBe("other");
  });
});

describe("inspectHookInstallation", () => {
  it("reports a working checkout entry as installed by the checkout, not stale", () => {
    const root = temporaryRoot();
    const script = touch(join(root, "repo", "apps", "mcp", "dist", "finalize-reminder.js"));
    const installation = inspectHookInstallation(hooksWith({ Stop: commandForAgentHook(script) }), "claude-code");

    expect(installation).toMatchObject({ agent: "claude-code", state: "installed", source: "checkout" });
    expect(installation.events[0]).toEqual({
      event: "Stop",
      matcher: null,
      required: true,
      state: "installed",
      source: "checkout",
    });
    expect(installation.events.slice(1).every((event) => event.state === "missing" && !event.required)).toBe(true);
  });

  it("reports a checkout entry whose script is gone as stale", () => {
    const script = join(temporaryRoot(), "moved", "apps", "mcp", "dist", "finalize-reminder.js");
    const installation = inspectHookInstallation(hooksWith({ Stop: commandForAgentHook(script) }), "claude-code");

    expect(installation).toMatchObject({ state: "stale", source: null });
    expect(installation.events[0]).toMatchObject({ state: "stale", reason: "script-missing" });
  });

  it("reports a launcher entry as installed by the App when it runs the current shim", () => {
    const stop = commandForLauncherHook(WINDOWS_SHIM, CLAUDE_ACTION, "win32");
    const installation = inspectHookInstallation(hooksWith({ Stop: stop }), "claude-code", {
      platform: "win32",
      shimPath: WINDOWS_SHIM,
    });

    expect(installation).toMatchObject({ state: "installed", source: "app" });
  });

  it("reports a launcher entry on another or missing shim as stale", () => {
    const stop = commandForLauncherHook(POSIX_SHIM, CLAUDE_ACTION, "linux");
    const otherShim = inspectHookInstallation(hooksWith({ Stop: stop }), "claude-code", {
      platform: "linux",
      shimPath: "/Applications/Work Intelligence/bin/work-intelligence-launcher",
    });
    expect(otherShim.events[0]).toMatchObject({ state: "stale", reason: "shim-differs" });

    const unknownShim = inspectHookInstallation(hooksWith({ Stop: stop }), "claude-code", { platform: "linux" });
    expect(unknownShim.events[0]).toMatchObject({ state: "stale", reason: "shim-differs" });

    const shim = touch(join(temporaryRoot(), "bin", "work-intelligence-launcher"));
    const existing = inspectHookInstallation(
      hooksWith({ Stop: commandForLauncherHook(shim, CLAUDE_ACTION, "linux") }),
      "claude-code",
      { platform: "linux" },
    );
    expect(existing).toMatchObject({ state: "installed", source: "app" });
  });

  it("prefers the App when the same event has both an App and a checkout entry", () => {
    const script = touch(join(temporaryRoot(), "apps", "mcp", "dist", "finalize-reminder.js"));
    const config = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: commandForAgentHook(script) }] },
          { hooks: [{ type: "command", command: commandForLauncherHook(POSIX_SHIM, CLAUDE_ACTION, "linux") }] },
        ],
      },
    };
    const installation = inspectHookInstallation(config, "claude-code", { platform: "linux", shimPath: POSIX_SHIM });
    expect(installation.source).toBe("app");
  });

  it("ignores other tools' hooks next to ours and does not change the config", () => {
    const script = touch(join(temporaryRoot(), "apps", "mcp", "dist", "finalize-reminder.js"));
    const config = {
      theme: "dark",
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "notify-send done" }] },
          {
            hooks: [
              { type: "command", command: commandForAgentHook(script) },
              { type: "command", command: "echo x" },
            ],
          },
        ],
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint-on-save" }] }],
      },
    };
    const before = JSON.stringify(config);

    expect(inspectHookInstallation(config, "claude-code")).toMatchObject({ state: "installed", source: "checkout" });
    expect(JSON.stringify(config)).toBe(before);

    const onlyOthers = { hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }] } };
    expect(inspectHookInstallation(onlyOthers, "claude-code").state).toBe("missing");
  });

  it("requires both Codex events and reports the legacy PostToolUse matcher as stale", () => {
    const script = touch(join(temporaryRoot(), "apps", "mcp", "dist", "codex-finalize-reminder.js"));
    const command = commandForAgentHook(script);
    const current = hooksWith({ Stop: command, PostToolUse: { matcher: CODEX_POST_TOOL_USE_MATCHER, command } });
    const installed = inspectHookInstallation(current, "codex");
    expect(installed).toMatchObject({ state: "installed", source: "checkout" });
    expect(installed.events.find((event) => event.event === "PostToolUse")).toMatchObject({
      matcher: CODEX_POST_TOOL_USE_MATCHER,
      required: true,
      state: "installed",
    });

    const legacy = hooksWith({ Stop: command, PostToolUse: { matcher: LEGACY_CODEX_POST_TOOL_USE_MATCHER, command } });
    const stale = inspectHookInstallation(legacy, "codex");
    expect(stale.state).toBe("stale");
    expect(stale.events.find((event) => event.event === "PostToolUse")).toMatchObject({
      state: "stale",
      reason: "matcher-outdated",
    });

    const withoutPostToolUse = inspectHookInstallation(hooksWith({ Stop: command }), "codex");
    expect(withoutPostToolUse.state).toBe("missing");
    const otherMatcher = hooksWith({ Stop: command, PostToolUse: { matcher: "^Bash$", command } });
    expect(stateOf(inspectHookInstallation(otherMatcher, "codex"), "PostToolUse")).toBe("missing");
  });

  it("lets a current matcher entry win over a legacy one for the same event", () => {
    const script = touch(join(temporaryRoot(), "apps", "mcp", "dist", "codex-finalize-reminder.js"));
    const command = commandForAgentHook(script);
    const config = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command }] }],
        PostToolUse: [
          { matcher: LEGACY_CODEX_POST_TOOL_USE_MATCHER, hooks: [{ type: "command", command }] },
          { matcher: CODEX_POST_TOOL_USE_MATCHER, hooks: [{ type: "command", command }] },
        ],
      },
    };
    expect(inspectHookInstallation(config, "codex").state).toBe("installed");
  });

  it("reports the optional events separately without letting them decide the state", () => {
    const script = touch(join(temporaryRoot(), "apps", "mcp", "dist", "finalize-reminder.js"));
    const command = commandForAgentHook(script);
    const installation = inspectHookInstallation(
      hooksWith({
        Stop: command,
        PreCompact: command,
        SessionStart: { matcher: "compact", command },
        PreToolUse: { matcher: "^mcp__.*(work_finalize_session|work_write_idempotent)$", command },
      }),
      "claude-code",
    );
    expect(installation.events.map((event) => [event.event, event.required, event.state])).toEqual([
      ["Stop", true, "installed"],
      ["PreCompact", false, "installed"],
      ["SessionStart", false, "installed"],
      ["PreToolUse", false, "installed"],
    ]);

    const startup = hooksWith({ Stop: command, SessionStart: { matcher: "startup", command } });
    expect(stateOf(inspectHookInstallation(startup, "claude-code"), "SessionStart")).toBe("missing");
  });

  it("does not count a hook of the other Agent or one under another event", () => {
    const claudeScript = touch(join(temporaryRoot(), "apps", "mcp", "dist", "finalize-reminder.js"));
    const codexScript = touch(join(temporaryRoot(), "apps", "mcp", "dist", "codex-finalize-reminder.js"));
    expect(inspectHookInstallation(hooksWith({ Stop: commandForAgentHook(codexScript) }), "claude-code").state).toBe(
      "missing",
    );
    expect(
      inspectHookInstallation(
        hooksWith({ PreToolUse: commandForAgentHook(claudeScript), SessionEnd: commandForAgentHook(claudeScript) }),
        "claude-code",
      ).state,
    ).toBe("missing");
    expect(
      inspectHookInstallation(
        hooksWith({ Stop: commandForLauncherHook(POSIX_SHIM, CODEX_ACTION, "linux") }),
        "claude-code",
        { platform: "linux", shimPath: POSIX_SHIM },
      ).state,
    ).toBe("missing");
  });

  it("reads a missing file as nothing installed", () => {
    const installation = inspectHookInstallation(undefined, "claude-code");
    expect(installation).toMatchObject({ state: "missing", source: null });
    expect(inspectHookInstallation({}, "codex").state).toBe("missing");
  });

  it("counts an enabled plugin as installed by the plugin, and our own working entry before it", () => {
    const enabled = { enabledPlugins: { "work-intelligence@fixture": true } };
    const byPlugin = inspectHookInstallation(enabled, "claude-code");
    expect(byPlugin).toMatchObject({ state: "installed", source: "plugin" });
    expect(byPlugin.events.every((event) => event.state === "installed" && event.source === "plugin")).toBe(true);
    expect(inspectHookInstallation(enabled, "claude-code", { pluginEnabled: false }).state).toBe("missing");
    expect(inspectHookInstallation({}, "codex", { pluginEnabled: true })).toMatchObject({ source: "plugin" });

    const script = touch(join(temporaryRoot(), "apps", "mcp", "dist", "finalize-reminder.js"));
    const both = { ...enabled, ...(hooksWith({ Stop: commandForAgentHook(script) }) as object) };
    expect(inspectHookInstallation(both, "claude-code")).toMatchObject({ state: "installed", source: "checkout" });
  });

  it("reports disabled hooks for every event", () => {
    const script = touch(join(temporaryRoot(), "apps", "mcp", "dist", "finalize-reminder.js"));
    const config = { disableAllHooks: true, ...(hooksWith({ Stop: commandForAgentHook(script) }) as object) };
    const disabled = inspectHookInstallation(config, "claude-code");
    expect(disabled).toMatchObject({ state: "disabled", source: null });
    expect(disabled.events.every((event) => event.state === "disabled")).toBe(true);

    expect(inspectHookInstallation(config, "claude-code", { hooksDisabled: false }).state).toBe("installed");
    expect(inspectHookInstallation({}, "codex", { hooksDisabled: true }).state).toBe("disabled");
    expect(inspectHookInstallation(null, "codex", { hooksDisabled: true }).state).toBe("disabled");
  });

  it("reports an unreadable or malformed config as unknown for every event", () => {
    for (const config of [null, "text", [], { hooks: "no" }, { hooks: { Stop: {} } }, { hooks: { PostToolUse: 1 } }]) {
      const installation = inspectHookInstallation(config, "codex");
      expect(installation.state).toBe("unknown");
      expect(installation.events.every((event) => event.state === "unknown")).toBe(true);
    }
    expect(inspectHookInstallation({ hooks: { Stop: "x" } }, "claude-code").state).toBe("unknown");
  });

  it("skips entries that are not objects", () => {
    const script = touch(join(temporaryRoot(), "apps", "mcp", "dist", "finalize-reminder.js"));
    const config = {
      hooks: { Stop: ["text", null, { hooks: [{ type: "command", command: commandForAgentHook(script) }] }] },
    };
    expect(inspectHookInstallation(config, "claude-code").state).toBe("installed");
  });

  it("checks files through an injected probe for paths that exist only on another platform", () => {
    const script = String.raw`C:\repo\apps\mcp\dist\finalize-reminder.js`;
    const config = hooksWith({ Stop: commandForAgentHook(script, "win32") });
    const present = inspectHookInstallation(config, "claude-code", {
      platform: "win32",
      isFile: (path) => path === script,
    });
    expect(present).toMatchObject({ state: "installed", source: "checkout" });
    const absent = inspectHookInstallation(config, "claude-code", { platform: "win32", isFile: () => false });
    expect(absent.state).toBe("stale");
  });
});

describe("classifyMcpRegistration", () => {
  it("recognises the launcher shim as the App's registration", () => {
    const exists = { isFile: () => true };
    expect(classifyMcpRegistration({ type: "stdio", command: WINDOWS_SHIM, args: ["mcp"] }, exists)).toEqual({
      kind: "launcher",
      source: "app",
    });
    expect(classifyMcpRegistration({ command: POSIX_SHIM, args: ["mcp"] }, exists).kind).toBe("launcher");
    expect(classifyMcpRegistration({ command: POSIX_SHIM, args: ["other"] }, exists).kind).toBe("other");
  });

  it("does not call a launcher shim or a direct script that is gone registered", () => {
    expect(classifyMcpRegistration({ command: "/gone/bin/work-intelligence-launcher", args: ["mcp"] })).toEqual({
      kind: "other",
      source: null,
    });
    const direct = join(temporaryRoot(), "repo", "apps", "mcp", "dist", "index.js");
    expect(classifyMcpRegistration({ command: "node", args: [direct] }).kind).toBe("other");
    touch(direct);
    expect(classifyMcpRegistration({ command: "node", args: [direct] }).kind).toBe("direct");
  });

  it("does not call just any entry registered", () => {
    for (const value of [{ command: "foo" }, {}, { command: "node" }, { args: ["x"] }, "text", null, undefined]) {
      expect(classifyMcpRegistration(value)).toEqual({ kind: "other", source: null });
    }
    expect(classifyMcpRegistration({ command: "node", args: ["/tmp/some-server.js"] }).kind).toBe("other");
    expect(classifyMcpRegistration({ command: "python", args: ["/repo/apps/mcp/dist/launcher.js"] }).kind).toBe(
      "other",
    );
    expect(classifyMcpRegistration({ command: "pnpm", args: ["start:mcp"] }).kind).toBe("other");
    expect(classifyMcpRegistration({ command: "pnpm", args: ["build", "--dir", "/repo"] }).kind).toBe("other");
  });

  it("recognises a checkout launcher through node, and the legacy direct entry point", () => {
    const launcher = touch(join(temporaryRoot(), "repo", "apps", "mcp", "dist", "launcher.js"));
    expect(classifyMcpRegistration({ command: "/usr/bin/node", args: [launcher] })).toEqual({
      kind: "checkout",
      source: "checkout",
    });
    const gone = join(temporaryRoot(), "moved", "apps", "mcp", "dist", "launcher.js");
    expect(classifyMcpRegistration({ command: "node", args: [gone] }).kind).toBe("other");
    const direct = touch(join(dirname(launcher), "index.js"));
    expect(classifyMcpRegistration({ command: "node", args: [direct] })).toEqual({
      kind: "direct",
      source: null,
    });
  });

  it("recognises pnpm start:mcp on a checkout that still has its launcher or package", () => {
    const repository = join(temporaryRoot(), "repo");
    const missing = join(temporaryRoot(), "nowhere");
    expect(classifyMcpRegistration({ command: "pnpm", args: ["--dir", repository, "start:mcp"] }).kind).toBe("other");

    touch(join(repository, "apps", "mcp", "dist", "launcher.js"));
    expect(classifyMcpRegistration({ command: "pnpm", args: ["--dir", repository, "start:mcp"] })).toEqual({
      kind: "checkout",
      source: "checkout",
    });
    expect(classifyMcpRegistration({ command: "pnpm.cmd", args: ["-C", repository, "start:mcp"] }).kind).toBe(
      "checkout",
    );
    expect(classifyMcpRegistration({ command: "pnpm", args: ["start:mcp"], cwd: repository }).kind).toBe("checkout");
    expect(classifyMcpRegistration({ command: "pnpm", args: ["--dir", missing, "start:mcp"] }).kind).toBe("other");

    // A directory with a package.json but no built launcher is not a working checkout.
    const packageOnly = join(temporaryRoot(), "package-only");
    touch(join(packageOnly, "package.json"));
    expect(classifyMcpRegistration({ command: "pnpm", args: ["-C", packageOnly, "start:mcp"] }).kind).toBe("other");
  });

  describe("forms the older checks accepted", () => {
    const launcherOf = (root: string): string => join(root, "apps", "mcp", "dist", "launcher.js");

    it("takes a relative launcher script from cwd", () => {
      const root = temporaryRoot();
      touch(launcherOf(root));
      expect(classifyMcpRegistration({ command: "node", args: ["apps/mcp/dist/launcher.js"], cwd: root }).kind).toBe(
        "checkout",
      );
      expect(classifyMcpRegistration({ command: "node", args: ["apps/mcp/dist/launcher.js"] }).kind).toBe("other");
    });

    it("skips node flags before the script", () => {
      const root = temporaryRoot();
      touch(launcherOf(root));
      for (const flags of [
        ["--enable-source-maps"],
        ["--no-warnings", "--enable-source-maps"],
        ["-r", "dotenv/config"],
      ]) {
        expect(classifyMcpRegistration({ command: "node", args: [...flags, launcherOf(root)] }).kind).toBe("checkout");
      }
    });

    it("reads pnpm --dir=<dir> and pnpm start:mcp with cwd", () => {
      const root = temporaryRoot();
      touch(launcherOf(root));
      expect(classifyMcpRegistration({ command: "pnpm", args: [`--dir=${root}`, "start:mcp"] }).kind).toBe("checkout");
      expect(classifyMcpRegistration({ command: "pnpm", args: ["start:mcp"], cwd: root }).kind).toBe("checkout");
      expect(classifyMcpRegistration({ command: "pnpm", args: ["start:mcp"] }).kind).toBe("other");
    });

    it("looks through cmd /c", () => {
      const present = new Set([String.raw`C:\repo\apps\mcp\dist\launcher.js`]);
      const isFile = (path: string): boolean => present.has(path);
      expect(
        classifyMcpRegistration(
          { command: "cmd", args: ["/c", "pnpm.cmd", "--dir", String.raw`C:\repo`, "start:mcp"] },
          { platform: "win32", isFile },
        ).kind,
      ).toBe("checkout");
      expect(
        classifyMcpRegistration(
          { command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd", "start:mcp"], cwd: String.raw`C:\repo` },
          { platform: "win32", isFile },
        ).kind,
      ).toBe("checkout");
      expect(
        classifyMcpRegistration(
          { command: "cmd", args: ["/c", "pnpm.cmd", "start:mcp"] },
          { platform: "win32", isFile },
        ).kind,
      ).toBe("other");
    });
  });

  it("looks up a Windows checkout with the Windows path rules", () => {
    const present = new Set([String.raw`C:\repo\apps\mcp\dist\launcher.js`]);
    const isFile = (path: string): boolean => present.has(path);
    expect(
      classifyMcpRegistration(
        { command: "pnpm.cmd", args: ["--dir", String.raw`C:\repo`, "start:mcp"] },
        { platform: "win32", isFile },
      ).kind,
    ).toBe("checkout");
    expect(
      classifyMcpRegistration(
        { command: "node.exe", args: [String.raw`C:\repo\apps\mcp\dist\launcher.js`] },
        { platform: "win32", isFile },
      ).kind,
    ).toBe("checkout");
    expect(
      classifyMcpRegistration(
        { command: "pnpm.cmd", args: ["--dir", String.raw`D:\repo`, "start:mcp"] },
        { platform: "win32", isFile },
      ).kind,
    ).toBe("other");
  });
});

describe("inspectAgentHooks", () => {
  it("reads both Agents' hooks files and the Codex plugin and hooks switch from a synthetic home", () => {
    const fixture = createFixture();
    const home = fixture.options.homeDirectory;
    const shim = touch(join(fixture.temporaryRoot, "app", "bin", "work-intelligence-launcher"));
    const options = { ...fixture.options, shimPath: shim };

    expect(inspectAgentHooks(options)).toMatchObject({
      "claude-code": { state: "missing" },
      codex: { state: "missing" },
    });

    writeJson(fixture.paths.claudeSettings, hooksWith({ Stop: commandForLauncherHook(shim, CLAUDE_ACTION, "linux") }));
    writeJson(
      fixture.paths.codexHooks,
      hooksWith({
        Stop: commandForLauncherHook(shim, CODEX_ACTION, "linux"),
        PostToolUse: {
          matcher: CODEX_POST_TOOL_USE_MATCHER,
          command: commandForLauncherHook(shim, CODEX_ACTION, "linux"),
        },
      }),
    );
    expect(inspectAgentHooks(options)).toMatchObject({
      "claude-code": { state: "installed", source: "app" },
      codex: { state: "installed", source: "app" },
    });

    writeFileSync(fixture.paths.codexConfig, "[features]\nhooks = false\n");
    expect(inspectAgentHooks(options).codex.state).toBe("disabled");
    writeFileSync(fixture.paths.codexConfig, '[plugins."work-intelligence@fixture"]\nenabled = true\n');
    writeFileSync(fixture.paths.codexHooks, "{}");
    expect(inspectAgentHooks(options).codex).toMatchObject({ state: "installed", source: "plugin" });
    writeFileSync(fixture.paths.codexConfig, "= not toml");
    // A hooks switch that cannot be read leaves every event unconfirmed, as the doctor reports it.
    const unreadableSwitch = inspectAgentHooks(options).codex;
    expect(unreadableSwitch.state).toBe("unknown");
    expect(unreadableSwitch.events.every((event) => event.state === "unknown")).toBe(true);

    writeFileSync(fixture.paths.claudeSettings, "{ broken");
    writeFileSync(fixture.paths.codexHooks, "[]");
    const broken = inspectAgentHooks({ homeDirectory: home, repositoryRoot: home, platform: "linux" });
    expect(broken["claude-code"].state).toBe("unknown");
    expect(broken.codex.state).toBe("unknown");

    rmSync(fixture.paths.claudeSettings);
    mkdirSync(fixture.paths.claudeSettings);
    expect(inspectAgentHooks(options)["claude-code"].state).toBe("unknown");
  });
});
