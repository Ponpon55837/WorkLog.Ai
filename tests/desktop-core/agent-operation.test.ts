import { describe, expect, it } from "vitest";
// The main-process module reads the built package, so the coordinator comes from the same build (one class, one type).
import {
  InMemoryOperationJournalStore,
  OperationCoordinator,
  OperationJournal,
} from "../../packages/desktop-core/dist/index.js";
import { runAgentOperation } from "../../apps/desktop/src/main/agent-operation.js";

/** An Agent apply is an `apply-agent` operation of the coordinator (H-01): journaled while it runs, closed after. */
function harness() {
  const journal = new OperationJournal(new InMemoryOperationJournalStore());
  return { journal, coordinator: new OperationCoordinator(journal) };
}

describe("runAgentOperation", () => {
  it("journals the apply as in progress while it runs and closes the record afterwards", async () => {
    const { journal, coordinator } = harness();
    let during: string | undefined;
    const result = await runAgentOperation(coordinator, "MANAGED", async () => {
      during = (await journal.findInProgress())?.kind;
      return "applied";
    });
    expect(result).toEqual({ status: "done", value: "applied" });
    expect(during).toBe("apply-agent");
    expect(await journal.findInProgress()).toBeNull();
  });

  it("reports a failure of the work itself and still closes the record", async () => {
    const { journal, coordinator } = harness();
    const result = await runAgentOperation(coordinator, "MANAGED", () => {
      throw new Error("synthetic failure");
    });
    expect(result).toEqual({ status: "failed" });
    expect(await journal.findInProgress()).toBeNull();
  });

  it("reports busy, without running the work, while another operation holds the lock", async () => {
    const { coordinator } = harness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runAgentOperation(coordinator, "MANAGED", () => gate);
    let ran = false;
    const second = await runAgentOperation(coordinator, "MANAGED", () => {
      ran = true;
    });
    expect(second).toEqual({ status: "busy" });
    expect(ran).toBe(false);
    release();
    expect(await first).toEqual({ status: "done", value: undefined });
  });
});
