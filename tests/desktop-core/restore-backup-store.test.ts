import { describe, expect, it } from "vitest";
import {
  RESTORE_BACKUP_MAX_PER_SENDER,
  RESTORE_BACKUP_TTL_MS,
  RestoreBackupStore,
} from "../../packages/desktop-core/src/index.js";

const WINDOW = 7;
const OTHER_WINDOW = 8;

function setup() {
  let now = 1_000_000;
  let counter = 0;
  const store = new RestoreBackupStore<string>({ clock: () => now, newId: () => `id-${(counter += 1)}` });
  return {
    store,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("restore backup token store", () => {
  it("hands back the entry held for the token", () => {
    const { store } = setup();
    const [id] = store.putListed(WINDOW, ["/synthetic/backups/a.sqlite"]);
    expect(store.claim(WINDOW, id as string)?.entry).toBe("/synthetic/backups/a.sqlite");
  });

  it("is single use", () => {
    const { store } = setup();
    const id = store.putPicked(WINDOW, "picked");
    expect(store.claim(WINDOW, id)).toBeDefined();
    expect(store.claim(WINDOW, id)).toBeUndefined();
  });

  it("is bound to the window that asked", () => {
    const { store } = setup();
    const id = store.putPicked(WINDOW, "picked");
    expect(store.claim(OTHER_WINDOW, id)).toBeUndefined();
    expect(store.claim(WINDOW, id)).toBeDefined();
  });

  it("expires, and an unknown id looks the same", () => {
    const { store, advance } = setup();
    const id = store.putPicked(WINDOW, "picked");
    advance(RESTORE_BACKUP_TTL_MS);
    expect(store.claim(WINDOW, id)).toBeUndefined();
    expect(store.claim(WINDOW, "never-issued")).toBeUndefined();
  });

  it("may be released again when the restore never started, until it expires", () => {
    const { store, advance } = setup();
    const id = store.putPicked(WINDOW, "picked");
    store.claim(WINDOW, id)?.release();
    const again = store.claim(WINDOW, id);
    expect(again).toBeDefined();
    advance(RESTORE_BACKUP_TTL_MS);
    again?.release();
    expect(store.claim(WINDOW, id)).toBeUndefined();
  });

  it("a new listing replaces the old listing but keeps the chosen file", () => {
    const { store } = setup();
    const [oldListed] = store.putListed(WINDOW, ["one"]);
    const picked = store.putPicked(WINDOW, "chosen");
    const [newListed] = store.putListed(WINDOW, ["two"]);
    expect(store.claim(WINDOW, oldListed as string)).toBeUndefined();
    expect(store.claim(WINDOW, picked)?.entry).toBe("chosen");
    expect(store.claim(WINDOW, newListed as string)?.entry).toBe("two");
  });

  it("does not bring a released token back over a newer listing", () => {
    const { store } = setup();
    const [id] = store.putListed(WINDOW, ["one"]);
    const claim = store.claim(WINDOW, id as string);
    store.putListed(WINDOW, ["two"]);
    claim?.release();
    expect(store.claim(WINDOW, id as string)).toBeUndefined();
  });

  it("caps what one window holds", () => {
    const { store } = setup();
    const ids = store.putListed(
      WINDOW,
      Array.from({ length: RESTORE_BACKUP_MAX_PER_SENDER + 10 }, (_, index) => `entry-${index}`),
    );
    expect(ids).toHaveLength(RESTORE_BACKUP_MAX_PER_SENDER);
  });
});
