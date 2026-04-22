import type { QueryResponse, Statement, TransactionHandle } from "flexdb-node";
import type { DatabaseClient } from "./types.js";
import { warnIfUnsupported } from "./warnings.js";
import { makeQueryResponse, objectRowsToResult, emptyResult, hrNow, elapsed } from "./result.js";
import { convertParamsForBetterSqlite3 } from "./params.js";
import { AsyncMutex } from "./mutex.js";

async function loadDriver() {
  try {
    const mod = await import("better-sqlite3");
    return mod.default as typeof import("better-sqlite3");
  } catch {
    throw new Error(
      "[better-starlite3] better-sqlite3 is not installed. Run: npm install better-sqlite3",
    );
  }
}

function execStatement(
  db: import("better-sqlite3").Database,
  stmt: Statement,
): import("flexdb-node").StatementResult {
  warnIfUnsupported(stmt.sql, "better-sqlite3");
  const { sql, params } = convertParamsForBetterSqlite3(stmt.sql, stmt.params);
  const start = hrNow();
  const prepared = db.prepare(sql);
  if (prepared.reader) {
    const rows = prepared.all(...params) as Record<string, unknown>[];
    return objectRowsToResult(rows, 0, null, elapsed(start));
  }
  const info = prepared.run(...params);
  return emptyResult(
    info.changes,
    typeof info.lastInsertRowid === "bigint" ? Number(info.lastInsertRowid) : info.lastInsertRowid,
    elapsed(start),
  );
}

function buildTransactionHandle(
  db: import("better-sqlite3").Database,
  writeMu: AsyncMutex,
): TransactionHandle {
  const pending: Statement[] = [];
  let done = false;
  const id = `bs3-tx-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const handle: TransactionHandle = {
    id,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),

    async query(stmts, _consistency?) {
      if (done) throw new Error("Transaction already closed");
      (Array.isArray(stmts) ? stmts : [stmts]).forEach((s) => pending.push(s));
      return makeQueryResponse([], "better-sqlite3");
    },

    async execute(stmts) {
      if (done) throw new Error("Transaction already closed");
      (Array.isArray(stmts) ? stmts : [stmts]).forEach((s) => pending.push(s));
      return makeQueryResponse([], "better-sqlite3");
    },

    commit() {
      if (done) throw new Error("Transaction already closed");
      done = true;
      return writeMu.run(() => {
        db.transaction(() => pending.forEach((s) => execStatement(db, s)))();
        return { status: "committed" as const, transaction_id: id, raft_index: 0 };
      });
    },

    async rollback() {
      if (done) throw new Error("Transaction already closed");
      done = true;
      pending.length = 0;
      return { status: "rolled_back" as const, transaction_id: id };
    },
  };
  return handle;
}

export async function openBetterSQLite3(
  filename: string,
  wal = true,
): Promise<DatabaseClient> {
  const Database = await loadDriver();
  const db = new Database(filename);
  if (wal) db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const writeMu = new AsyncMutex();

  const client: DatabaseClient = {
    driver: "better-sqlite3",

    async query(statements, _consistency?) {
      // Reads are not serialised — WAL allows concurrent readers
      const stmts = Array.isArray(statements) ? statements : [statements];
      return makeQueryResponse(stmts.map((s) => execStatement(db, s)), "better-sqlite3");
    },

    execute(statements) {
      const stmts = Array.isArray(statements) ? statements : [statements];
      return writeMu.run(() =>
        makeQueryResponse(stmts.map((s) => execStatement(db, s)), "better-sqlite3"),
      );
    },

    async beginTransaction() {
      return buildTransactionHandle(db, writeMu);
    },

    transaction<T>(fn: (tx: TransactionHandle) => Promise<T>): Promise<T> {
      const tx = buildTransactionHandle(db, writeMu);
      return fn(tx)
        .then((result) => tx.commit().then(() => result))
        .catch(async (err) => {
          try { await tx.rollback(); } catch { /* ignore */ }
          throw err;
        });
    },

    destroy() {
      db.close();
    },
  };
  return client;
}
