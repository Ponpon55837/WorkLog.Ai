import { describe, expect, it } from "vitest";
import { inFirefoxBackgroundTask, isExternalBrowser } from "../../apps/desktop/tests/packaged-smoke/browser-process.js";

const FIREFOX = "C:\\Program Files\\Mozilla Firefox\\firefox.exe";
const DASHBOARD_PORT = 43_210;

function firefox(args: string) {
  return { executable: FIREFOX, commandLine: `"${FIREFOX}" ${args}` };
}

describe("which processes the packaged smoke counts as an external browser", () => {
  it("ignores the Firefox Default Browser Agent that the Windows Task Scheduler runs", () => {
    expect(isExternalBrowser(firefox("--backgroundtask defaultagent do-task 0123456789ABCDEF"), DASHBOARD_PORT)).toBe(
      false,
    );
  });

  it("counts Firefox opened for a URL", () => {
    expect(isExternalBrowser(firefox(`-osint -url http://127.0.0.1:${DASHBOARD_PORT}/`), DASHBOARD_PORT)).toBe(true);
    expect(isExternalBrowser(firefox("https://example.test/"), DASHBOARD_PORT)).toBe(true);
  });

  it("counts a Firefox background task whose command line names the Dashboard", () => {
    expect(
      isExternalBrowser(firefox(`--backgroundtask open http://127.0.0.1:${DASHBOARD_PORT}/`), DASHBOARD_PORT),
    ).toBe(true);
    expect(
      isExternalBrowser(firefox(`--backgroundtask open http://localhost:${DASHBOARD_PORT}/`), DASHBOARD_PORT),
    ).toBe(true);
  });

  it("matches the background-task flag only as a whole argument and only for Firefox", () => {
    expect(isExternalBrowser(firefox("--backgroundtasks defaultagent"), DASHBOARD_PORT)).toBe(true);
    expect(
      isExternalBrowser(
        { executable: undefined, commandLine: "/usr/bin/google-chrome --backgroundtask defaultagent" },
        DASHBOARD_PORT,
      ),
    ).toBe(true);
    expect(isExternalBrowser({ executable: undefined, commandLine: "/usr/bin/firefox --backgroundtask x" })).toBe(
      false,
    );
  });

  it("is not a browser when the executable is none of the browsers", () => {
    expect(isExternalBrowser({ executable: "C:\\Windows\\System32\\conhost.exe", commandLine: "conhost.exe" })).toBe(
      false,
    );
  });
});

describe("children of a Firefox background task", () => {
  const T = Date.parse("2026-11-17T13:26:30Z");
  function ffProc(pid: number, ppid: number, args: string, startedAt?: number) {
    return { pid, ppid, ...firefox(args), startedAt };
  }
  const agent = ffProc(1452, 900, "--backgroundtask defaultagent do-task 0123456789ABCDEF", T);
  const content = ffProc(1232, 1452, "-contentproc -parentBuildID 20261101 -childID 1 tab", T + 6_000);

  it("excludes a -contentproc child whose nearest browser ancestor is a background task", () => {
    expect(isExternalBrowser(content, DASHBOARD_PORT)).toBe(true);
    expect(inFirefoxBackgroundTask(content, [agent, content], DASHBOARD_PORT)).toBe(true);
  });

  it("walks past non-browser processes between the child and the background task", () => {
    const helper = {
      pid: 1300,
      ppid: 1452,
      executable: "C:\\Windows\\System32\\conhost.exe",
      commandLine: "conhost.exe 0x4",
      startedAt: T + 1_000,
    };
    const grandchild = ffProc(1400, 1300, "-contentproc -childID 2 tab", T + 2_000);
    expect(inFirefoxBackgroundTask(grandchild, [agent, helper, grandchild], DASHBOARD_PORT)).toBe(true);
  });

  it("counts a child of a background task that names the Dashboard", () => {
    const opener = ffProc(1452, 900, `--backgroundtask open http://127.0.0.1:${DASHBOARD_PORT}/`, T);
    expect(inFirefoxBackgroundTask(content, [opener, content], DASHBOARD_PORT)).toBe(false);
  });

  it("counts a child of a normal Firefox main process, even one already running", () => {
    const main = ffProc(1452, 900, "-osint -url https://example.test/", T - 3_600_000);
    expect(inFirefoxBackgroundTask(content, [main, content], DASHBOARD_PORT)).toBe(false);
  });

  it("does not attribute a child to a parent created after it (a reused pid)", () => {
    const reused = ffProc(1452, 900, "--backgroundtask defaultagent do-task 0123456789ABCDEF", T + 60_000);
    expect(inFirefoxBackgroundTask(content, [reused, content], DASHBOARD_PORT)).toBe(false);
  });

  it("does not attribute a child to a reused pid further up, past an ancestor whose start time is unknown", () => {
    const helper = {
      pid: 1300,
      ppid: 1452,
      executable: "C:\\Windows\\System32\\conhost.exe",
      commandLine: "conhost.exe 0x4",
    };
    const child = ffProc(1232, 1300, "-contentproc -childID 1 tab", T + 6_000);
    const reused = ffProc(1452, 900, "--backgroundtask defaultagent do-task 0123456789ABCDEF", T + 60_000);
    expect(inFirefoxBackgroundTask(child, [reused, helper, child], DASHBOARD_PORT)).toBe(false);
  });

  it("stops at a missing parent or a parent-pid cycle", () => {
    expect(inFirefoxBackgroundTask(content, [content], DASHBOARD_PORT)).toBe(false);
    const a = { pid: 10, ppid: 11, executable: "a.exe", commandLine: "a.exe" };
    const b = { pid: 11, ppid: 10, executable: "b.exe", commandLine: "b.exe" };
    const child = ffProc(12, 10, "-contentproc");
    expect(inFirefoxBackgroundTask(child, [a, b, child])).toBe(false);
  });
});
