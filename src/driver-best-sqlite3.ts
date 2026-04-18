import type { QueryResponse, Statement, TransactionHandle } from "flexdb-node";
import type { DatabaseClient } from "./types.js";
import { warnIfUnsupported } from "./warnings.js";
import { makeQueryResponse, objectRowsToResult, emptyResult, hrNow, elapsed } from "./result.js";
import { convertParamsForSqlJs } from "./params.js";
import { AsyncMutex } from "./mutex.js";
import BestSqlite from "best-sqlite3";

type BestDB = InstanceType<typeof BestSqlite>;

function execStatement(db: BestDB, stmt: Statement): import("flexdb-node").StatementResult {
  warnIfUnsupported(stmt.sql, "best-sqlite3");
  const { sql, params } = convertParamsForSqlJs(stmt.sql, stmt.params);
  const start = hrNow();
  const trimmed = stmt.sql.trim().toLowerCase();

  if (trimmed.startsWith("select") || trimmed.startsWith("with")) {
    const rows = db.exec(sql, params) as Record<string, unknown>[];
    return objectRowsToResult(rows, 0, null, elapsed(start));
  }
  const res = db.run(sql, params) as { rowsModified: number; lastInsertRowId?: number };
  return emptyResult(res.rowsModified ?? 0, res.lastInsertRowId ?? null, elapsed(start));
}

function buildTransactionHandle(db: BestDB, writeMu: AsyncMutex): TransactionHandle {
  const pending: Statement[] = [];
  let done = false;
  const id = `best-tx-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const handle: TransactionHandle = {
    id,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),

    async query(stmts, _consistency?) {
      if (done) throw new Error("Transaction already closed");
      (Array.isArray(stmts) ? stmts : [stmts]).forEach((s) => pending.push(s));
      return makeQueryResponse([], "best-sqlite3");
    },

    async execute(stmts) {
      if (done) throw new Error("Transaction already closed");
      (Array.isArray(stmts) ? stmts : [stmts]).forEach((s) => pending.push(s));
      return makeQueryResponse([], "best-sqlite3");
    },

    commit() {
      if (done) throw new Error("Transaction already closed");
      done = true;
      return writeMu.run(() => {
        pending.forEach((s) => execStatement(db, s));
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

export async function openBestSQLite3(
  filename: string,
  wal = true,
): Promise<DatabaseClient> {
  if (wal) {
    console.warn(
      "[better-starlite3] best-sqlite3 (pure-JS/WASM driver) does not support WAL mode. " +
      "WAL configuration is ignored for this driver.",
    );
  }

  const db = await BestSqlite.connect(filename) as BestDB;
  const writeMu = new AsyncMutex();

  const client: DatabaseClient = {
    driver: "best-sqlite3",

    async query(statements, _consistency?) {
      // Reads are not serialised
      const stmts = Array.isArray(statements) ? statements : [statements];
      return makeQueryResponse(stmts.map((s) => execStatement(db, s)), "best-sqlite3");
    },

    execute(statements) {
      const stmts = Array.isArray(statements) ? statements : [statements];
      return writeMu.run(() =>
        makeQueryResponse(stmts.map((s) => execStatement(db, s)), "best-sqlite3"),
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
      // best-sqlite3 auto-saves on process exit via chokidar/fs watcher
    },
  };
  return client;
}
