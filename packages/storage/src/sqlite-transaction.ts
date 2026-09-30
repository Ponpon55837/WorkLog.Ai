import { DatabaseSync } from "node:sqlite";

const immediateTransactions = new WeakSet<DatabaseSync>();

export function runImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  // A guarded MCP write already owns the immediate transaction; inner services share that atomic boundary.
  if (immediateTransactions.has(db)) return operation();
  db.exec("BEGIN IMMEDIATE");
  immediateTransactions.add(db);
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original error if the connection is already closed.
    }
    throw error;
  } finally {
    immediateTransactions.delete(db);
  }
}
