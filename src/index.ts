export type {
  Statement,
  StatementResult,
  QueryResponse,
  TransactionHandle,
  TransactionCommitResponse,
  TransactionRollbackResponse,
  ConsistencyMode,
  DatabaseClient,
  DriverName,
  OpenOptions,
  BetterSQLite3Options,
  BestSQLite3Options,
  FlexDBOptions,
} from "./types.js";

import type { DatabaseClient, OpenOptions } from "./types.js";
import { openBetterSQLite3 } from "./driver-better-sqlite3.js";
import { openBestSQLite3 } from "./driver-best-sqlite3.js";
import { openFlexDB } from "./driver-flexdb.js";

/**
 * Open a database connection using one of the three supported drivers.
 *
 * All three drivers expose the same async API modelled on flexdb-node:
 *   - `query(statements, consistency?)` — reads or writes
 *   - `execute(statements)` — write-only path
 *   - `beginTransaction()` — returns a TransactionHandle
 *   - `transaction(fn)` — auto commit/rollback wrapper
 *   - `destroy()` — close / stop background tasks
 *
 * SQLite drivers (better-sqlite3, best-sqlite3) open in WAL mode by default
 * so journal_mode and synchronous PRAGMAs are not needed. Any PRAGMA or
 * dot-command in a statement will log a console warning because FlexDB does
 * not support them.
 *
 * @example
 * ```ts
 * // Local SQLite with better-sqlite3
 * const db = await open({ driver: "better-sqlite3", filename: "myapp.db" });
 *
 * // Local SQLite with best-sqlite3 (pure-JS/WASM)
 * const db = await open({ driver: "best-sqlite3", filename: "myapp.db" });
 *
 * // Remote FlexDB cluster
 * const db = await open({
 *   driver: "flexdb",
 *   nodes: ["http://localhost:4001"],
 *   authToken: "secret",
 * });
 *
 * // Unified API
 * const res = await db.query({ sql: "SELECT * FROM users WHERE id = ?1", params: [42] });
 * console.log(res.results[0].rows);
 * db.destroy();
 * ```
 */
export async function open(options: OpenOptions): Promise<DatabaseClient> {
  switch (options.driver) {
    case "better-sqlite3":
      return openBetterSQLite3(options.filename, options.wal ?? true);
    case "best-sqlite3":
      return openBestSQLite3(options.filename, options.wal ?? true);
    case "flexdb":
      return openFlexDB({
        nodes: options.nodes,
        authToken: options.authToken,
        healthCheckIntervalMs: options.healthCheckIntervalMs,
        timeoutMs: options.timeoutMs,
      });
    default: {
      const d = (options as { driver: string }).driver;
      throw new Error(
        `[better-starlite3] Unknown driver "${d}". Valid: better-sqlite3, best-sqlite3, flexdb`,
      );
    }
  }
}
