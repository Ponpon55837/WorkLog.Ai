import { describe, expect, it } from "vitest";
import type { WorkSessionRecord } from "../../../packages/core/src/index.js";
import { findSessionMatch } from "../../../apps/web/src/utils/session-match.js";

const session = {
  title: "Prepare the release",
  summary: "Bumped versions and rewrote the changelog.",
  workSummary: {
    outcomes: ["Published"],
    scope: ["Packaging scripts"],
    decisions: ["Keep the Backup folder name"],
    verification: [],
    nextSteps: [],
  },
  changedFiles: ["scripts/pack.mjs"],
} as unknown as WorkSessionRecord;

const visible = [session.title, "Published"];

describe("findSessionMatch", () => {
  it("returns nothing when the visible text already shows every word", () => {
    expect(findSessionMatch(session, "release published", visible)).toBeUndefined();
    expect(findSessionMatch(session, "   ", visible)).toBeUndefined();
  });

  it("finds the first field outside the visible text, in summary, sections, then files", () => {
    expect(findSessionMatch(session, "changelog", visible)).toMatchObject({ kind: "excerpt", field: "summary" });
    expect(findSessionMatch(session, "packaging", visible)).toMatchObject({ kind: "excerpt", field: "scope" });
    expect(findSessionMatch(session, "backup", visible)).toMatchObject({ kind: "excerpt", field: "decisions" });
    expect(findSessionMatch(session, "pack.mjs", visible)).toMatchObject({ kind: "excerpt", field: "changedFiles" });
  });

  it("looks only for the words the visible text lacks and honours quoted phrases", () => {
    expect(findSessionMatch(session, "release changelog", visible)).toMatchObject({ field: "summary" });
    expect(findSessionMatch(session, '"folder name"', visible)).toMatchObject({ field: "decisions" });
  });

  it("falls back to the events note when no field the list carries has the word", () => {
    expect(findSessionMatch(session, "stacktrace", visible)).toEqual({ kind: "events" });
  });
});
