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
