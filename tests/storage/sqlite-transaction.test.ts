import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runImmediateTransaction } from "../../packages/storage/src/sqlite-transaction.js";

describe("immediate transaction nesting", () => {
  it("shares one atomic write lock without relying on the Node 22.16 transaction getter", () => {
    const db = new DatabaseSync(":memory:");
    const legacyConnection = new Proxy(db, {
      get(target, property) {
        if (property === "isTransaction") throw new Error("Unavailable on Node 22.5");
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      db.exec("CREATE TABLE synthetic (value TEXT)");
      expect(() =>
        runImmediateTransaction(legacyConnection, () => {
          db.prepare("INSERT INTO synthetic VALUES (?)").run("outer");
          runImmediateTransaction(legacyConnection, () => db.prepare("INSERT INTO synthetic VALUES (?)").run("inner"));
          throw new Error("synthetic rollback");
        }),
      ).toThrow("synthetic rollback");
      expect(db.prepare("SELECT COUNT(*) AS count FROM synthetic").get()?.count).toBe(0);
      runImmediateTransaction(legacyConnection, () =>
        runImmediateTransaction(legacyConnection, () =>
          db.prepare("INSERT INTO synthetic VALUES (?)").run("committed"),
        ),
      );
      expect(db.prepare("SELECT COUNT(*) AS count FROM synthetic").get()?.count).toBe(1);
    } finally {
      db.close();
    }
  });
});
