import { describe, expect, it } from "vitest";
import { DIAGNOSTICS_PREVIEW_TTL_MS, DiagnosticsPreviewStore } from "../../packages/desktop-core/src/index.js";

const REPAIR_WINDOW = 7;
const OTHER_WINDOW = 8;

function setup() {
  let now = 1_000_000;
  let counter = 0;
  const store = new DiagnosticsPreviewStore({ clock: () => now, newId: () => `preview-${(counter += 1)}` });
  return {
    store,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("diagnostics preview store", () => {
  it("hands back exactly the previewed bytes", () => {
    const { store } = setup();
    const text = '{\n  "note": "日本語 😀 \\u0000 and a trailing newline"\n}\n';
    const id = store.put(REPAIR_WINDOW, text);
    const claim = store.claim(REPAIR_WINDOW, id);
    expect(claim).toBeDefined();
    expect(Buffer.compare(claim?.bytes ?? Buffer.alloc(0), Buffer.from(text, "utf8"))).toBe(0);
  });

  it("is single use", () => {
    const { store } = setup();
    const id = store.put(REPAIR_WINDOW, "text");
    expect(store.claim(REPAIR_WINDOW, id)).toBeDefined();
    expect(store.claim(REPAIR_WINDOW, id)).toBeUndefined();
  });

  it("expires after ten minutes, by the injected clock", () => {
    const { store, advance } = setup();
    expect(DIAGNOSTICS_PREVIEW_TTL_MS).toBe(10 * 60 * 1000);
    const early = store.put(REPAIR_WINDOW, "early");
    advance(DIAGNOSTICS_PREVIEW_TTL_MS - 1);
    expect(store.claim(REPAIR_WINDOW, early)).toBeDefined();
    const late = store.put(REPAIR_WINDOW, "late");
    advance(DIAGNOSTICS_PREVIEW_TTL_MS);
    expect(store.claim(REPAIR_WINDOW, late)).toBeUndefined();
  });

  it("answers an unknown id like an expired one", () => {
    const { store } = setup();
    store.put(REPAIR_WINDOW, "text");
    expect(store.claim(REPAIR_WINDOW, "preview-999")).toBeUndefined();
    expect(store.claim(REPAIR_WINDOW, "")).toBeUndefined();
  });

  it("binds a preview to the sender it was made for", () => {
    const { store } = setup();
    const id = store.put(REPAIR_WINDOW, "text");
    expect(store.claim(OTHER_WINDOW, id)).toBeUndefined();
    // The refused attempt did not use it up.
    expect(store.claim(REPAIR_WINDOW, id)).toBeDefined();
  });

  it("keeps one live preview per sender: a new one replaces the old", () => {
    const { store } = setup();
    const first = store.put(REPAIR_WINDOW, "first");
    const other = store.put(OTHER_WINDOW, "other");
    const second = store.put(REPAIR_WINDOW, "second");
    expect(store.claim(REPAIR_WINDOW, first)).toBeUndefined();
    expect(store.claim(REPAIR_WINDOW, second)?.bytes.toString()).toBe("second");
    expect(store.claim(OTHER_WINDOW, other)?.bytes.toString()).toBe("other");
  });

  it("lets a cancelled save be tried again, but not twice at once", () => {
    const { store } = setup();
    const id = store.put(REPAIR_WINDOW, "text");
    const claim = store.claim(REPAIR_WINDOW, id);
    // While the dialog is open the preview is taken.
    expect(store.claim(REPAIR_WINDOW, id)).toBeUndefined();
    claim?.release();
    expect(store.claim(REPAIR_WINDOW, id)).toBeDefined();
  });

  it("does not bring a released preview back over a newer one or past its time", () => {
    const { store, advance } = setup();
    const old = store.put(REPAIR_WINDOW, "old");
    const claim = store.claim(REPAIR_WINDOW, old);
    const newer = store.put(REPAIR_WINDOW, "newer");
    claim?.release();
    expect(store.claim(REPAIR_WINDOW, old)).toBeUndefined();
    expect(store.claim(REPAIR_WINDOW, newer)?.bytes.toString()).toBe("newer");

    const expiring = store.put(REPAIR_WINDOW, "expiring");
    const taken = store.claim(REPAIR_WINDOW, expiring);
    advance(DIAGNOSTICS_PREVIEW_TTL_MS);
    taken?.release();
    expect(store.claim(REPAIR_WINDOW, expiring)).toBeUndefined();
  });
});
