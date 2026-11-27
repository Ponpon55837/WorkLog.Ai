import type { UsageProjectsResponse, UsageScanResponse } from "../../../packages/core/src/index.js";

function localDay(now: Date, offset: number): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

export const USAGE_PROJECTS: UsageProjectsResponse = {
  items: [
    { id: "usage-p1", name: "Fictional Orchard", current: true, sources: { claudeFolders: 2, codexFiles: 3 } },
    { id: "usage-p2", name: "Fictional Barn", current: false, sources: { claudeFolders: 1, codexFiles: 0 } },
    { id: "usage-p3", name: "Fictional Mill", current: false, sources: { claudeFolders: 0, codexFiles: 1 } },
  ],
  groups: [{ projects: ["usage-p2", "usage-p3"], claudeFolders: 1, codexFiles: 1 }],
};

export function usageScanFixture(now = new Date()): UsageScanResponse {
  const day = (offset: number, input: number, output: number, cacheRead: number, cacheCreation: number) => ({
    date: localDay(now, offset),
    tokens: { input, output, cacheRead, cacheCreation },
  });
  return {
    totals: {
      sessions: 7,
      turns: 214,
      assistantMessages: 640,
      toolCalls: 1_380,
      workIntelligenceCalls: 96,
      workIntelligenceShare: 96 / 1_380,
    },
    tokens: {
      input: 1_240_000,
      output: 860_000,
      cacheRead: 38_400_000,
      cacheCreation: 2_900_000,
      primary: 2_100_000,
      cacheReadShare: 38_400_000 / (1_240_000 + 38_400_000 + 2_900_000),
    },
    models: [
      {
        agent: "claude-code",
        model: "fictional-model-large",
        tokens: { input: 900_000, output: 600_000, cacheRead: 30_000_000, cacheCreation: 2_000_000 },
        primary: 1_500_000,
        responses: 410,
      },
      {
        agent: "codex",
        model: "fictional-model-small",
        tokens: { input: 300_000, output: 240_000, cacheRead: 8_000_000, cacheCreation: 800_000 },
        primary: 540_000,
        responses: 190,
      },
      {
        agent: "codex",
        model: "",
        tokens: { input: 40_000, output: 20_000, cacheRead: 400_000, cacheCreation: 100_000 },
        primary: 60_000,
        responses: 12,
      },
    ],
    daily: [
      day(6, 120_000, 80_000, 4_000_000, 300_000),
      day(5, 310_000, 210_000, 9_000_000, 700_000),
      day(3, 200_000, 150_000, 6_000_000, 500_000),
      day(2, 410_000, 290_000, 12_000_000, 900_000),
      day(0, 200_000, 130_000, 7_400_000, 500_000),
    ],
    blocks: [
      {
        agent: "claude-code",
        startAt: new Date(now.getTime() - 100 * 60_000).toISOString(),
        endAt: new Date(now.getTime() + 200 * 60_000).toISOString(),
        firstActivityAt: new Date(now.getTime() - 95 * 60_000).toISOString(),
        lastActivityAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
        tokens: { input: 90_000, output: 60_000, cacheRead: 2_000_000, cacheCreation: 150_000 },
        primary: 150_000,
        elapsedMs: 100 * 60_000,
        remainingMs: 200 * 60_000,
        primaryPerMinute: 1_500,
      },
    ],
    operations: [
      { key: "work_read/work_get_session", calls: 41, resultChars: 82_000, avgChars: 2_000 },
      { key: "work_write/work_finalize", calls: 18, resultChars: 9_000, avgChars: 500 },
      { key: "work_read/(unknown)", calls: 3, resultChars: 300, avgChars: 100 },
    ],
    sessions: [
      {
        label: "session-1",
        turns: 80,
        toolCalls: 400,
        tokens: { input: 600_000, output: 420_000, cacheRead: 20_000_000, cacheCreation: 1_200_000 },
        primary: 1_020_000,
      },
      {
        label: "session-2",
        turns: 40,
        toolCalls: 210,
        tokens: { input: 200_000, output: 150_000, cacheRead: 6_000_000, cacheCreation: 500_000 },
        primary: 350_000,
      },
    ],
    otherTools: [
      { name: "Bash", calls: 620 },
      { name: "Read", calls: 340 },
      { name: "Edit", calls: 120 },
    ],
    forAgentText: "Synthetic usage report",
    cache: { reused: 1, appended: 0, parsed: 4 },
    allocation: {
      groups: [
        {
          projects: ["usage-p2", "usage-p3"],
          allocated: [
            {
              projectId: "usage-p2",
              included: true,
              conversations: 3,
              tokens: { input: 300, output: 100, cacheRead: 0, cacheCreation: 0 },
              primary: 400,
              byBasis: { projectRoot: 2, filePaths: 1, cwd: 0 },
            },
            {
              projectId: "usage-p3",
              included: false,
              conversations: 1,
              tokens: { input: 50, output: 10, cacheRead: 0, cacheCreation: 0 },
              primary: 60,
              byBasis: { projectRoot: 0, filePaths: 0, cwd: 1 },
            },
          ],
          unallocated: {
            included: false,
            conversations: 2,
            tokens: { input: 900, output: 100, cacheRead: 0, cacheCreation: 0 },
            primary: 1_000,
          },
        },
      ],
    },
    durationMs: 240,
    range: { since: new Date(now.getTime() - 7 * 86_400_000).toISOString(), until: null },
    problems: [],
  };
}
