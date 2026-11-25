import { vi } from "vitest";

// Vitest setup file: every writable SQLite connection a test process opens runs with `PRAGMA synchronous = OFF`.
//
// Why: SQLite's default (FULL) flushes the file to the disk on every commit, on the switch to WAL and at each
// checkpoint. A test database lives in a temp directory for a few hundred milliseconds and is read back by the same
// live operating system, so a flush has nothing to protect; the tests only pay its latency. On the Windows CI runner
// that latency is usually a few milliseconds but now and then several seconds per flush for a minute or two. The
// SQLite timing report of such a run shows it directly: `COMMIT` 6 to 9 s, `PRAGMA journal_mode = WAL` 6.7 s and
// `VACUUM INTO` 12 s on small private files, with no other connection holding a lock. A test that opens a fresh store
// (about nine flushes) and writes a few rows then runs past the 20 s limit, a different test each time.
//
// What stays the same: the product code is not changed and still opens its databases at the default level; locking,
// WAL, transactions, busy handling and every byte SQLite writes are identical, only the flush calls are left out.
// A crash of the process (the kill tests) loses nothing either way, because the operating system keeps the written
// pages; only a power loss could tell the difference. Read-only connections are left alone, so the tests that prove a
// read-only open touches nothing see exactly what production does. Child processes (the backup worker, tsx entries) do
// not load this file and keep the default.
vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  const Original = actual.DatabaseSync;
  type Options = ConstructorParameters<typeof Original>[1];

  /** Never throws: a file that is locked or is not a database must fail later, in the product code, as it does today. */
  function turnFlushOff(database: InstanceType<typeof Original>, options: Options): void {
    if (options?.readOnly === true || !database.isOpen) return;
    try {
      // The original method, so a test's spy on `DatabaseSync.prototype.exec` neither sees nor replaces this call.
      Original.prototype.exec.call(database, "PRAGMA synchronous = OFF");
    } catch {
      // Left at the default.
    }
  }

  class NoFlushDatabaseSync extends Original {
    readonly #options: Options;

    public constructor(...args: ConstructorParameters<typeof Original>) {
      super(...args);
      this.#options = args[1];
      turnFlushOff(this, this.#options);
    }

    public override open(): void {
      super.open();
      turnFlushOff(this, this.#options);
    }
  }
  // Carries the name of the class it wraps: `DatabaseSync`, or `TimedDatabaseSync` when the timing hook is installed.
  Object.defineProperty(NoFlushDatabaseSync, "name", { value: Original.name });
  const DatabaseSync = NoFlushDatabaseSync;

  return { ...actual, DatabaseSync, default: { ...actual, DatabaseSync } };
});
