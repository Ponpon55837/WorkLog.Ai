import { describe, expect, it } from "vitest";
import {
  createdBefore,
  descendantsOf,
  describeProcessLine,
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
    // The main process is gone; its content process (11) is orphaned, and a new child (12) of it appeared.
    const live = [proc(11, 4), proc(12, 11), proc(30, 4)];
    expect(survivingTree(tracked, live).map((p) => p.pid)).toEqual([11, 12]);
    expect(tracked.has(12)).toBe(true);
    // Later only the unrelated process is left: the tree is gone.
    expect(survivingTree(tracked, [proc(30, 4)])).toEqual([]);
  });

  it("does not take a reused pid for a member of the tree", () => {
    const tracked = new Map([[11, proc(11, 10, "firefox -contentproc", 1_000)]]);
    expect(survivingTree(tracked, [proc(11, 4, "notepad.exe", 900_000)])).toEqual([]);
    expect(survivingTree(tracked, [proc(11, 4, "other", undefined)])).toEqual([]);
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
