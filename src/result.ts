import type { QueryResponse, StatementResult } from "flexdb-node";

/** Build a QueryResponse shell for local SQLite drivers. */
export function makeQueryResponse(
  results: StatementResult[],
  driver: string,
): QueryResponse {
  return {
    results,
    node_id: driver,
    role: "standalone",
    executed_on: driver,
    raft_index: 0,
    crdt_conflicts: [],
  };
}

/** Convert a plain row-object from better-sqlite3 / best-sqlite3 to a column+rows pair. */
export function objectRowsToResult(
  rows: Record<string, unknown>[],
  rowsAffected: number,
  lastInsertId: number | null,
  timeNs: number,
): StatementResult {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return {
    columns,
    rows: rows.map((r) => columns.map((c) => (r[c] as string | number | boolean | null) ?? null)),
    rows_affected: rowsAffected,
    last_insert_id: lastInsertId,
    time_ns: timeNs,
  };
}

/**
 * Convert POSITIONAL rows (a column-name list + value arrays) to a
 * StatementResult.
 *
 * Prefer this over objectRowsToResult for reads. A row object keyed by column
 * name silently drops duplicate columns — `SELECT a.id, b.id … FROM a JOIN b`
 * keeps only one `id` — which misaligns every later field. Drizzle and other
 * ORMs map result rows by POSITION, so the duplicate columns must be preserved.
 */
export function arrayRowsToResult(
  columns: string[],
  rows: unknown[][],
  timeNs: number,
): StatementResult {
  return {
    columns,
    rows: rows.map((r) => r.map((v) => (v as string | number | boolean | null) ?? null)),
    rows_affected: 0,
    last_insert_id: null,
    time_ns: timeNs,
  };
}

export function emptyResult(
  rowsAffected: number,
  lastInsertId: number | null,
  timeNs: number,
): StatementResult {
  return { columns: [], rows: [], rows_affected: rowsAffected, last_insert_id: lastInsertId, time_ns: timeNs };
}

export function hrNow(): bigint {
  return process.hrtime.bigint();
}

export function elapsed(start: bigint): number {
  return Number(process.hrtime.bigint() - start);
}
