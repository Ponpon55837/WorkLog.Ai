import { describe, expect, it } from "vitest";
import {
  createdBefore,
  descendantsOf,
  describeProcessLine,
  isChildOf,
  parseElapsedSeconds,
  startedSince,
  survivingTree,
  type BrowserSnapshot,
} from "../../apps/desktop/tests/packaged-smoke/browser-process.js";

const FIREFOX = "C:\\Program Files\\Mozilla Firefox\\firefox.exe";

function proc(pid: number, ppid: number, commandLine = `cmd-${pid}`, startedAt?: number) {
  return { pid, ppid, commandLine, startedAt };
}

describe("the process tree of an ended browser", () => {
  it("includes the roots, their descendants and nothing unrelated", () => {
    const snapshot = [proc(1, 0), proc(10, 1), proc(11, 10), proc(20, 2), proc(21, 20)];
    expect(descendantsOf(snapshot, [10]).map((p) => p.pid)).toEqual([10, 11]);
    expect(descendantsOf(snapshot, [10, 20]).map((p) => p.pid)).toEqual([10, 11, 20, 21]);
  });

  it("waits for a child that appears after the kill, and for the orphan kept by its pid", () => {
    const tracked = new Map(descendantsOf([proc(10, 1), proc(11, 10)], [10]).map((p) => [p.pid, p]));
    const live = [proc(11, 4), proc(12, 11), proc(30, 4)];
    expect(survivingTree(tracked, live).map((p) => p.pid)).toEqual([11, 12]);
    expect(tracked.has(12)).toBe(true);
    expect(survivingTree(tracked, [proc(30, 4)])).toEqual([]);
  });

  it("does not take a reused pid for a member of the tree", () => {
    const tracked = new Map([[11, proc(11, 10, "firefox -contentproc", 1_000)]]);
    expect(survivingTree(tracked, [proc(11, 4, "notepad.exe", 900_000)])).toEqual([]);
    expect(survivingTree(tracked, [proc(11, 4, "other", undefined)])).toEqual([]);
  });
});

describe("a reused pid in the process tree", () => {
  // The browser root the test started (pid 6272, created at 500 s); the system processes were created long before it and
  // name the pid 6272 because their real parent of that pid ended and Windows handed the pid on.
  const browser = proc(6272, 900, "firefox.exe", 500_000);

  it("does not take an older process that names the root's pid as a child of the root", () => {
    const snapshot = [
      browser,
      proc(6300, 6272, "firefox.exe -contentproc", 501_000),
      proc(6252, 6272, "winlogon.exe", 10_000),
      proc(6400, 6252, "dwm.exe", 11_000),
      proc(6401, 6252, "fontdrvhost.exe", 11_500),
    ];
    expect(descendantsOf(snapshot, [6272]).map((p) => p.pid)).toEqual([6272, 6300]);
  });

  it("does not take in the children of a root that is gone, by its pid alone", () => {
    const snapshot = [proc(6252, 6272, "winlogon.exe", 10_000), proc(6400, 6252, "dwm.exe", 11_000)];
    expect(descendantsOf(snapshot, [6272])).toEqual([]);
  });

  it("keeps a child whose ps time rounds to just before its parent", () => {
    expect(isChildOf(proc(11, 10, "child", 99_500), proc(10, 1, "parent", 100_000))).toBe(true);
    expect(isChildOf(proc(11, 10, "child", 90_000), proc(10, 1, "parent", 100_000))).toBe(false);
    expect(isChildOf(proc(11, 10, "child"), proc(10, 1, "parent", 100_000))).toBe(true);
    expect(isChildOf(proc(11, 12, "child", 100_000), proc(10, 1, "parent", 100_000))).toBe(false);
  });

  it("does not wait for processes whose parent pid was handed on after the tree was taken", () => {
    const tracked = new Map(
      descendantsOf([browser, proc(6300, 6272, "content", 501_000)], [6272]).map((p) => [p.pid, p]),
    );
    // The browser ended and its pid went to an unrelated new process; an older system process names that pid as parent.
    const live = [
      proc(6272, 4, "svchost.exe", 600_000),
      proc(6252, 6272, "winlogon.exe", 10_000),
      proc(6400, 6252, "dwm.exe", 11_000),
    ];
    expect(survivingTree(tracked, live)).toEqual([]);
    expect(tracked.has(6252)).toBe(false);
  });

  it("does not wait for an older process naming a live member as its parent", () => {
    const tracked = new Map([[6300, proc(6300, 6272, "content", 501_000)]]);
    const live = [proc(6300, 1, "content", 501_000), proc(6252, 6300, "winlogon.exe", 10_000)];
    expect(survivingTree(tracked, live).map((p) => p.pid)).toEqual([6300]);
  });
});

describe("which processes a test is blamed for", () => {
  const snapshot: BrowserSnapshot = {
    takenAt: 100_000,
    processes: [{ pid: 5, commandLine: "firefox" }],
  };

  it("does not blame a process created before the baseline", () => {
    expect(createdBefore({ startedAt: 50_000 }, snapshot.takenAt)).toBe(true);
    expect(createdBefore({ startedAt: 99_000 }, snapshot.takenAt)).toBe(false); // within the clock tolerance
    expect(createdBefore({ startedAt: undefined }, snapshot.takenAt)).toBe(false);
    const found = startedSince([proc(7, 1, "firefox", 50_000), proc(8, 1, "firefox", 150_000)], snapshot);
    expect(found.map((p) => p.pid)).toEqual([8]);
  });

  it("falls back to pid plus command line where the creation time is unknown", () => {
    const found = startedSince([proc(5, 1, "firefox"), proc(5, 1, "firefox --new"), proc(6, 1, "firefox")], snapshot);
    expect(found.map((p) => p.pid)).toEqual([5, 6]);
    expect(found[0]?.commandLine).toBe("firefox --new");
  });
});

describe("process descriptions", () => {
  const content = {
    ...proc(8728, 4321, `"${FIREFOX}" -contentproc -ipcHandle 2000`, Date.UTC(2026, 0, 2, 3, 4, 5)),
    executable: FIREFOX,
  };

  it("names the parent pid, its executable while it is alive, and the creation time", () => {
    const line = describeProcessLine(content, { alive: true, executable: "C:\\Windows\\explorer.exe" }, 160);
    expect(line).toContain("pid 8728");
    expect(line).toContain("parent pid 4321 C:\\Windows\\explorer.exe");
    expect(line).toContain("2026-01-02T03:04:05.000Z");
    expect(line).toContain("-contentproc");
  });

  it("prints the start of the parent's command line", () => {
    const line = describeProcessLine(
      content,
      {
        alive: true,
        executable: FIREFOX,
        commandLine: `"${FIREFOX}" --backgroundtask defaultagent do-task ${"X".repeat(200)}`,
      },
      120,
    );
    expect(line).toContain(`parent pid 4321 ${FIREFOX} (command: "${FIREFOX}" --backgroundtask`);
    expect(line).toContain("--backgroundtask");
    expect(line).not.toContain("X".repeat(100));
  });

  it("says the parent is gone when it no longer runs", () => {
    expect(describeProcessLine(content, { alive: false, executable: undefined }, 160)).toContain(
      "parent pid 4321 (gone)",
    );
  });

  it("parses ps elapsed times", () => {
    expect(parseElapsedSeconds("00:07")).toBe(7);
    expect(parseElapsedSeconds("12:34")).toBe(754);
    expect(parseElapsedSeconds("1:02:03")).toBe(3723);
    expect(parseElapsedSeconds("2-01:00:00")).toBe(2 * 86_400 + 3_600);
    expect(parseElapsedSeconds("soon")).toBeUndefined();
  });
});
