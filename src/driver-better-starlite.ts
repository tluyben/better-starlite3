import type { QueryResponse, Statement, TransactionHandle } from "flexdb-node";
import type { DatabaseClient } from "./types.js";
import { warnIfUnsupported } from "./warnings.js";
import { makeQueryResponse, objectRowsToResult, emptyResult, hrNow, elapsed } from "./result.js";
import { convertParamsForBetterSqlite3 } from "./params.js";

async function loadDriver(): Promise<{
  createDatabase: (filename: string, options: Record<string, unknown>) => Promise<BetterStarliteDB>;
}> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import("better-starlite/dist/async-unified") as unknown as BetterStarliteModule;
    return { createDatabase: mod.createDatabase };
  } catch {
    throw new Error(
      "[better-starlite3] better-starlite is not installed in 3rdparty. " +
      "Run: git clone https://github.com/tluyben/better-starlite 3rdparty/better-starlite && " +
      "cd 3rdparty/better-starlite && npm install && npm run build && cd ../.. && npm install",
    );
  }
}

// Minimal structural types for the better-starlite async API
interface BetterStarliteStatement {
  run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  all(...params: unknown[]): Promise<Record<string, unknown>[]>;
  reader: boolean;
}

interface BetterStarliteDB {
  prepare(sql: string): Promise<BetterStarliteStatement>;
  transaction<T>(fn: (...args: unknown[]) => Promise<T>): Promise<(...args: unknown[]) => Promise<T>>;
  close(): Promise<unknown>;
}

interface BetterStarliteModule {
  createDatabase(filename: string, options: Record<string, unknown>): Promise<BetterStarliteDB>;
}

async function execStatement(
  db: BetterStarliteDB,
  stmt: Statement,
): Promise<import("flexdb-node").StatementResult> {
  warnIfUnsupported(stmt.sql, "better-starlite");
  const { sql, params } = convertParamsForBetterSqlite3(stmt.sql, stmt.params);
  const start = hrNow();
  const prepared = await db.prepare(sql);
  if (prepared.reader) {
    const rows = await prepared.all(...params) as Record<string, unknown>[];
    return objectRowsToResult(rows, 0, null, elapsed(start));
  }
  const info = await prepared.run(...params);
  return emptyResult(
    info.changes,
    typeof info.lastInsertRowid === "bigint" ? Number(info.lastInsertRowid) : info.lastInsertRowid,
    elapsed(start),
  );
}

function buildTransactionHandle(db: BetterStarliteDB): TransactionHandle {
  const pending: Statement[] = [];
  let done = false;
  const id = `bsl-tx-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return {
    id,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),

    async query(stmts, _consistency?) {
      if (done) throw new Error("Transaction already closed");
      (Array.isArray(stmts) ? stmts : [stmts]).forEach((s) => pending.push(s));
      return makeQueryResponse([], "better-starlite");
    },

    async execute(stmts) {
      if (done) throw new Error("Transaction already closed");
      (Array.isArray(stmts) ? stmts : [stmts]).forEach((s) => pending.push(s));
      return makeQueryResponse([], "better-starlite");
    },

    async commit() {
      if (done) throw new Error("Transaction already closed");
      done = true;
      const stmtsToRun = [...pending];
      const wrappedFn = await db.transaction(async () => {
        for (const s of stmtsToRun) {
          await execStatement(db, s);
        }
      });
      await wrappedFn();
      return { status: "committed" as const, transaction_id: id, raft_index: 0 };
    },

    async rollback() {
      if (done) throw new Error("Transaction already closed");
      done = true;
      pending.length = 0;
      return { status: "rolled_back" as const, transaction_id: id };
    },

    enqueue(): never {
      throw new Error("[better-starlite3] honker is only available with the flexdb driver");
    },
  };
}

export async function openBetterStarlite(
  filename: string,
  wal = true,
): Promise<DatabaseClient> {
  const { createDatabase } = await loadDriver();
  const db = await createDatabase(filename, { disableWAL: !wal });

  const client: DatabaseClient = {
    driver: "better-starlite",

    async query(statements, _consistency?) {
      const stmts = Array.isArray(statements) ? statements : [statements];
      return makeQueryResponse(
        await Promise.all(stmts.map((s) => execStatement(db, s))),
        "better-starlite",
      );
    },

    async execute(statements) {
      const stmts = Array.isArray(statements) ? statements : [statements];
      const results: import("flexdb-node").StatementResult[] = [];
      for (const s of stmts) results.push(await execStatement(db, s));
      return makeQueryResponse(results, "better-starlite");
    },

    async beginTransaction() {
      return buildTransactionHandle(db);
    },

    transaction<T>(fn: (tx: TransactionHandle) => Promise<T>): Promise<T> {
      const tx = buildTransactionHandle(db);
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
