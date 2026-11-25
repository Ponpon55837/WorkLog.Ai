import { describe, expect, it } from "vitest";
import type {
  UsageAllocation,
  UsageBlockItem,
  UsageModelItem,
  UsageProjectItem,
  UsageTokenSummary,
} from "@work-intelligence/core";
import { formatMultiple, formatTokens } from "../../../apps/web/src/utils/format.js";
import {
  fillDailyRange,
  usageBlockRows,
  usageComposition,
  usageDayLabel,
  toggleUsageGroup,
  usageModelRows,
  usageProjectLayout,
  usageSharedRows,
  withRatio,
  withShare,
} from "../../../apps/web/src/utils/usage.js";
import { t } from "../../../apps/web/src/i18n/index.js";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

describe("formatTokens", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1K"],
    [1_234, "1.2K"],
    [34_500_000, "34.5M"],
    [1_020_000_000, "1.02B"],
    [12_300_000_000, "12.3B"],
  ])("formats %d as %s", (value, text) => {
    expect(formatTokens(value)).toBe(text);
  });

  it("moves a value that rounds up to 1000 into the next unit", () => {
    expect(formatTokens(999_960)).toBe("1M");
    expect(formatTokens(999_960_000)).toBe("1B");
  });

  it("formats multiples with one decimal under 100", () => {
    expect(formatMultiple(18.44)).toBe("18.4");
    expect(formatMultiple(250.4)).toBe("250");
  });
});

describe("fillDailyRange", () => {
  const range = { since: new Date(2026, 10, 18, 9).toISOString(), until: new Date(2026, 10, 22, 18).toISOString() };

  it("fills the days the server omits with zeros across the whole range", () => {
    const points = fillDailyRange(
      [
        { date: "2026-11-19", tokens: { ...ZERO, input: 5, output: 2 } },
        { date: "2026-11-22", tokens: { ...ZERO, input: 1 } },
      ],
      range,
    );
    expect(points.map((point) => point.date)).toEqual([
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-21",
      "2026-11-22",
    ]);
    expect(points.map((point) => point.input)).toEqual([0, 5, 0, 0, 1]);
    expect(points.map((point) => point.output)).toEqual([0, 2, 0, 0, 0]);
  });

  it("ends an open range today and extends it to usage outside the range", () => {
    const now = new Date(2026, 10, 20, 12);
    const points = fillDailyRange(
      [{ date: "2026-11-16", tokens: { ...ZERO, input: 3 } }],
      {
        since: range.since,
        until: null,
      },
      now,
    );
    expect(points[0]?.date).toBe("2026-11-16");
    expect(points.at(-1)?.date).toBe("2026-11-20");
    expect(points).toHaveLength(5);
  });

  it("steps over a month and year boundary by calendar day and returns nothing without data or range", () => {
    const points = fillDailyRange([], {
      since: new Date(2026, 11, 30, 1).toISOString(),
      until: new Date(2027, 0, 2, 1).toISOString(),
    });
    expect(points.map((point) => point.date)).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(usageDayLabel("2027-01-02")).toBe("01/02");
  });

  it("keeps the most recent 366 days of a very long range", () => {
    const points = fillDailyRange([], {
      since: new Date(2020, 0, 1).toISOString(),
      until: new Date(2026, 0, 1).toISOString(),
    });
    expect(points).toHaveLength(366);
    expect(points.at(-1)?.date).toBe("2026-01-01");
  });
});

describe("usageComposition", () => {
  const tokens: UsageTokenSummary = {
    input: 300,
    output: 100,
    cacheRead: 2_000,
    cacheCreation: 500,
    primary: 400,
    cacheReadShare: 2_000 / 2_800,
  };

  it("scales each row to its own 100% and never adds cache to the headline", () => {
    const composition = usageComposition(tokens);
    expect(composition.counted.total).toBe(tokens.primary);
    expect(composition.counted.parts.map((part) => part.share)).toEqual([0.75, 0.25]);
    expect(composition.cache.total).toBe(2_500);
    expect(composition.cache.parts.map((part) => part.share)).toEqual([0.8, 0.2]);
    expect(composition.cacheReadMultiple).toBe(5);
  });

  it("has no multiple without a headline and zero shares for empty rows", () => {
    const composition = usageComposition({ ...ZERO, primary: 0, cacheReadShare: null });
    expect(composition.cacheReadMultiple).toBeNull();
    expect(composition.counted.parts.map((part) => part.share)).toEqual([0, 0]);
  });
});

describe("usage rows", () => {
  it("labels agents and unlabelled models and gives each its share of all models", () => {
    const models: UsageModelItem[] = [
      { agent: "claude-code", model: "model-a", tokens: ZERO, primary: 200, responses: 3 },
      { agent: "codex", model: "", tokens: ZERO, primary: 50, responses: 1 },
    ];
    const rows = usageModelRows(models);
    expect(rows.map((row) => row.agentLabel)).toEqual(["Claude Code", "Codex"]);
    expect(rows[1]?.modelLabel).toBe(t("usage.modelUnlabelled"));
    expect(rows.map((row) => row.share)).toEqual([0.8, 0.2]);
  });

  it("scales a ratio to the highest value and a share to the sum", () => {
    const items = [{ n: 50 }, { n: 200 }, { n: 150 }];
    expect(withRatio(items, (item) => item.n).map((item) => item.ratio)).toEqual([0.25, 1, 0.75]);
    expect(withShare(items, (item) => item.n).map((item) => item.share)).toEqual([0.125, 0.5, 0.375]);
    expect(withRatio(items, (item) => item.n)[1]).toMatchObject({ n: 200, ratio: 1 });
  });

  it("gives zero ratios and shares for empty and all-zero input", () => {
    expect(withRatio([], (item: { n: number }) => item.n)).toEqual([]);
    expect(withShare([], (item: { n: number }) => item.n)).toEqual([]);
    const zeros = [{ n: 0 }, { n: 0 }];
    expect(withRatio(zeros, (item) => item.n).map((item) => item.ratio)).toEqual([0, 0]);
    expect(withShare(zeros, (item) => item.n).map((item) => item.share)).toEqual([0, 0]);
    expect(usageModelRows([]).length).toBe(0);
  });

  it("derives the 5-hour block progress from elapsed and remaining time", () => {
    const block: UsageBlockItem = {
      agent: "codex",
      startAt: "2026-11-23T08:00:00.000Z",
      endAt: "2026-11-23T13:00:00.000Z",
      firstActivityAt: "2026-11-23T08:10:00.000Z",
      lastActivityAt: "2026-11-23T09:50:00.000Z",
      tokens: ZERO,
      primary: 900,
      elapsedMs: 3_600_000,
      remainingMs: 14_400_000,
      primaryPerMinute: 15,
    };
    expect(usageBlockRows([block])[0]).toMatchObject({
      agentLabel: "Codex",
      progress: 0.2,
      primary: 900,
      startAt: block.startAt,
      endAt: block.endAt,
    });
  });
});

describe("shared-folder groups", () => {
  const project = (id: string, name: string): UsageProjectItem => ({
    id,
    name,
    current: false,
    sources: { claudeFolders: 0, codexFiles: 0 },
  });
  const projects = [
    project("a", "assistant"),
    project("o", "other"),
    project("d", "devtools"),
    project("w", "devdocs"),
  ];

  it("lists a group's projects once, larger groups first, and keeps the rest loose", () => {
    const layout = usageProjectLayout(projects, [
      { projects: ["d", "w"], claudeFolders: 1, codexFiles: 0 },
      { projects: ["a", "d", "w"], claudeFolders: 1, codexFiles: 0 },
    ]);

    expect(layout.sections.map((section) => section.names)).toEqual(["assistant, devtools, devdocs"]);
    expect(layout.sections[0]?.members.map((member) => member.id)).toEqual(["a", "d", "w"]);
    expect(layout.sections[0]?.projectIds).toEqual(["a", "d", "w"]);
    expect(layout.loose.map((member) => member.id)).toEqual(["o"]);
  });

  it("selects and clears a whole group without touching other selections", () => {
    expect(toggleUsageGroup(["o", "d"], ["a", "d", "w"], true)).toEqual(["o", "a", "d", "w"]);
    expect(toggleUsageGroup(["o", "a", "d", "w"], ["a", "d", "w"], false)).toEqual(["o"]);
  });

  it("keeps the whole-group selection order when ids repeat or overlap the selection", () => {
    expect(toggleUsageGroup([], ["a", "d"], true)).toEqual(["a", "d"]);
    expect(toggleUsageGroup(["a"], ["a"], true)).toEqual(["a"]);
    expect(toggleUsageGroup(["a", "o"], ["a", "d"], false)).toEqual(["o"]);
  });

  it("names projects missing from the list as unknown in shared rows", () => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const byBasis = { projectRoot: 0, filePaths: 0, cwd: 0 };
    const [row] = usageSharedRows(
      {
        groups: [
          {
            projects: ["a", "gone"],
            allocated: [{ projectId: "gone", included: true, conversations: 1, tokens, primary: 0, byBasis }],
            unallocated: { included: true, conversations: 0, tokens, primary: 0 },
          },
        ],
      },
      projects,
    );
    expect(row?.names).toBe("assistant");
    expect(row?.projects[0]?.name).toBe(t("usage.unknownProject"));
  });

  it("names the unallocated bucket from project names only", () => {
    const tokens = { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 };
    const allocation: UsageAllocation = {
      groups: [
        {
          projects: ["a", "d"],
          allocated: [
            {
              projectId: "a",
              included: true,
              conversations: 2,
              tokens,
              primary: 3,
              byBasis: { projectRoot: 1, filePaths: 0, cwd: 1 },
            },
            {
              projectId: "d",
              included: false,
              conversations: 0,
              tokens,
              primary: 0,
              byBasis: { projectRoot: 0, filePaths: 0, cwd: 0 },
            },
          ],
          unallocated: { included: false, conversations: 4, tokens, primary: 12 },
        },
      ],
    };

    const [row] = usageSharedRows(allocation, projects);

    expect(t("usage.sharedUnallocated", { projects: row?.names ?? "" })).toContain("assistant, devtools");
    expect(row).toMatchObject({ included: false, conversations: 4, primary: 12 });
    expect(row?.projects.map((entry) => entry.name)).toEqual(["assistant", "devtools"]);
  });
});
