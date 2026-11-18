import { describe, expect, it } from "vitest";
import { backendTone, databaseTone, ownerTone } from "../../apps/desktop/src/renderer/repair/badge.js";
import { isBlockingDatabase, panelInputs } from "../../apps/desktop/src/renderer/repair/view-model.js";
import { diagnosticsMessages } from "../../packages/desktop-core/src/shell/diagnostics-i18n.js";
import { shellMessages, type RepairState } from "../../packages/desktop-core/src/index.js";

type Blocking = Pick<RepairState, "owner" | "database" | "candidates">;

const healthy: Blocking = { owner: "MANAGED", database: { display: "~/x.sqlite", status: "ok" }, candidates: [] };

describe("when the database blocks the service", () => {
  it("is not blocking while the service is managed, whatever the database says", () => {
    expect(isBlockingDatabase(healthy)).toBe(false);
    expect(isBlockingDatabase({ ...healthy, database: { display: null, status: "missing" } })).toBe(false);
  });

  it("is blocking when the service needs repair and the database cannot be used", () => {
    expect(
      isBlockingDatabase({ ...healthy, owner: "NEEDS_REPAIR", database: { display: null, status: "offline" } }),
    ).toBe(true);
  });

  it("is blocking when the service needs repair and other databases were found", () => {
    const candidate = {
      id: "c",
      display: "~/y.sqlite",
      status: "ok",
      canConfirm: true,
      needsMigration: false,
    } as const;
    expect(isBlockingDatabase({ ...healthy, owner: "NEEDS_REPAIR", candidates: [candidate] })).toBe(true);
  });

  it("is not blocking when the service needs repair for another reason and the database is fine", () => {
    expect(isBlockingDatabase({ ...healthy, owner: "NEEDS_REPAIR" })).toBe(false);
  });
});

describe("what a panel is drawn from", () => {
  const state = {
    locale: "en",
    owner: "MANAGED",
    retryOperationId: "a",
    port: { port: 1, activePort: 1, focus: false, handoffHeld: false },
    update: { currentVersion: "1", checking: false, result: null },
    shell: { tabs: ["status"], blockingTab: null, badges: {} },
    recentErrors: [],
  } as unknown as RepairState;

  it("ignores the retry id (new in every snapshot), the badges and the sections of other tabs", () => {
    const next = { ...state, retryOperationId: "b", shell: { ...state.shell, blockingTab: "status" } } as RepairState;
    expect(panelInputs("status", next)).toEqual(panelInputs("status", state));
    expect(panelInputs("data", next)).toEqual(panelInputs("data", state));
    const moved = { ...state, port: { ...state.port!, port: 2 } } as RepairState;
    expect(panelInputs("status", moved)).toEqual(panelInputs("status", state));
  });

  it("settings follow the port and the update, and nothing else", () => {
    const moved = { ...state, port: { ...state.port!, port: 2 } } as RepairState;
    expect(panelInputs("settings", moved)).not.toEqual(panelInputs("settings", state));
    const errored = { ...state, recentErrors: [{ code: "X", at: "t" }] } as RepairState;
    expect(panelInputs("settings", errored)).toEqual(panelInputs("settings", state));
    expect(panelInputs("status", errored)).not.toEqual(panelInputs("status", state));
  });
});

describe("status pill tones", () => {
  it("never relies on colour alone but each state has its tone", () => {
    expect(ownerTone("MANAGED")).toBe("success");
    expect(ownerTone("NEEDS_REPAIR")).toBe("danger");
    expect(ownerTone("STARTING")).toBe("accent");
    expect(ownerTone("EXTERNAL")).toBe("neutral");
    expect(backendTone("running")).toBe("success");
    expect(backendTone("crashed")).toBe("danger");
    expect(backendTone("stopped")).toBe("neutral");
    expect(databaseTone("ok")).toBe("success");
    expect(databaseTone("unsupported-schema")).toBe("attention");
    expect(databaseTone("offline")).toBe("danger");
    expect(databaseTone("unknown")).toBe("neutral");
  });
});

describe("the words the tabs need", () => {
  it("has the Data link and the Diagnostics explanation in both languages", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      expect(shellMessages(locale).statusOpenData.length).toBeGreaterThan(0);
      expect(diagnosticsMessages(locale).tabIntro.length).toBeGreaterThan(0);
    }
    expect(shellMessages("zh-TW").statusOpenData).not.toBe(shellMessages("en").statusOpenData);
    expect(diagnosticsMessages("zh-TW").tabIntro).not.toBe(diagnosticsMessages("en").tabIntro);
  });
});
