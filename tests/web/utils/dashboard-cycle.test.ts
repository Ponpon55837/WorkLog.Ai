import { describe, expect, it } from "vitest";
import type { KnowledgePageRecord, TimelineKnowledgeEvent } from "@work-intelligence/core";
import { countKnowledgeEvents, countRevisedPages } from "../../../apps/web/src/utils/dashboard-cycle.js";

function event(kind: TimelineKnowledgeEvent["kind"]): TimelineKnowledgeEvent {
  return { knowledgeId: "k", projectId: "p", title: "t", kind, at: "2026-11-10T00:00:00.000Z" };
}

function page(version: number, sourcedThrough?: string): KnowledgePageRecord {
  return { version, sourcedThrough } as KnowledgePageRecord;
}

describe("dashboard cycle counts", () => {
  it("counts created, confirmed and contradicted events and ignores superseded ones", () => {
    expect(
      countKnowledgeEvents([
        event("created"),
        event("created"),
        event("confirmed"),
        event("contradicted"),
        event("superseded"),
      ]),
    ).toEqual({ created: 2, confirmed: 1, contradicted: 1 });
    expect(countKnowledgeEvents([])).toEqual({ created: 0, confirmed: 0, contradicted: 0 });
  });

  it("counts pages written in the range once, skipping unwritten pages", () => {
    const noon = (day: string) => new Date(`${day}T12:00:00`).toISOString();
    expect(
      countRevisedPages(
        [
          page(3, noon("2026-11-09")),
          page(1, noon("2026-11-15")),
          page(2, noon("2026-11-08")),
          page(0, noon("2026-11-10")),
          page(1, undefined),
        ],
        "2026-11-09",
        "2026-11-15",
      ),
    ).toBe(2);
  });
});
