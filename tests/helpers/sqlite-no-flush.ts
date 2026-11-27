import { vi } from "vitest";

// Opens writable test connections with PRAGMA synchronous = OFF: the default flush per commit only costs latency (seconds on a Windows CI runner) for a database that lives a few hundred ms.
// Read-only connections and child processes keep the default, so tests proving a read-only open touches nothing see what production does.
vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  const Original = actual.DatabaseSync;
  type Options = ConstructorParameters<typeof Original>[1];

  function turnFlushOff(database: InstanceType<typeof Original>, options: Options): void {
    if (options?.readOnly === true || !database.isOpen) return;
    try {
      // The original method, so a test's spy on `DatabaseSync.prototype.exec` neither sees nor replaces this call.
      Original.prototype.exec.call(database, "PRAGMA synchronous = OFF");
    } catch {
      // A locked or non-database file must fail later in the product code, as it does today.
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
  Object.defineProperty(NoFlushDatabaseSync, "name", { value: Original.name });
  const DatabaseSync = NoFlushDatabaseSync;

  return { ...actual, DatabaseSync, default: { ...actual, DatabaseSync } };
});
