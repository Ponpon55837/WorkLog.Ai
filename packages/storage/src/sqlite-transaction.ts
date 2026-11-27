import { DatabaseSync } from "node:sqlite";

const immediateTransactions = new WeakSet<DatabaseSync>();
const afterCommitOperations = new WeakMap<DatabaseSync, Array<() => void>>();
const writeGates = new WeakMap<DatabaseSync, () => void>();

export function setImmediateTransactionGate(db: DatabaseSync, gate: () => void): void {
  writeGates.set(db, gate);
}

export function runAfterImmediateTransaction(db: DatabaseSync, operation: () => void): void {
  const operations = afterCommitOperations.get(db);
  if (!immediateTransactions.has(db) || !operations) {
    operation();
    return;
  }
  operations.push(operation);
}

export function runImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  // A guarded MCP write already owns the immediate transaction; inner services share that atomic boundary.
  if (immediateTransactions.has(db)) return operation();
  db.exec("BEGIN IMMEDIATE");
  immediateTransactions.add(db);
  const afterCommit = [] as Array<() => void>;
  afterCommitOperations.set(db, afterCommit);
  let result: T;
  try {
    writeGates.get(db)?.();
    result = operation();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Keep the original error.
    }
    throw error;
  } finally {
    immediateTransactions.delete(db);
    afterCommitOperations.delete(db);
  }
  afterCommit.forEach((callback) => callback());
  return result;
}

export function runReadTransaction<T>(db: DatabaseSync, operation: () => T): T {
  if (immediateTransactions.has(db)) return operation();
  db.exec("BEGIN");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Keep the original error.
    }
    throw error;
  }
}
