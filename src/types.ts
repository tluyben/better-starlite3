// Re-export flexdb-node types for the unified API surface

export type {
  Statement,
  StatementResult,
  QueryResponse,
  TransactionHandle,
  TransactionCommitResponse,
  TransactionRollbackResponse,
  ConsistencyMode,
  TableMode,
  CrdtStrategy,
  QueryRequest,
  TableModeResponse,
  TableSearchConfig,
  SearchRequest,
  SearchResponse,
  NodesResponse,
  StatusResponse,
  HealthResponse,
  AnalyticsListResponse,
  AnalyticsGetResponse,
  AnalyticsRebuildResponse,
  AnalyticalTable,
  FlexDBClientOptions,
} from "flexdb-node";

export type DriverName = "better-sqlite3" | "best-sqlite3" | "flexdb" | "better-starlite";

export interface SQLiteDriverOptions {
  /** Local SQLite database file path. Use ":memory:" for in-memory database. */
  filename: string;
  /**
   * Enable WAL journal mode on open (default: true).
   * Not applicable to best-sqlite3 (pure-JS/WASM — no WAL support).
   */
  wal?: boolean;
}

export interface BetterSQLite3Options extends SQLiteDriverOptions {
  driver: "better-sqlite3";
}

export interface BestSQLite3Options extends SQLiteDriverOptions {
  driver: "best-sqlite3";
}

export interface FlexDBOptions {
  driver: "flexdb";
  /** One or more FlexDB node URLs. */
  nodes: string | string[];
  authToken?: string;
  healthCheckIntervalMs?: number;
  timeoutMs?: number;
}

export interface BetterStarliteOptions extends SQLiteDriverOptions {
  driver: "better-starlite";
}

export type OpenOptions = BetterSQLite3Options | BestSQLite3Options | FlexDBOptions | BetterStarliteOptions;

/** The unified client interface — same shape as FlexDBClient for the core API. */
export interface DatabaseClient {
  readonly driver: DriverName;

  /** Execute one or more SQL statements (reads or writes). */
  query(
    statements: import("flexdb-node").Statement | import("flexdb-node").Statement[],
    consistency?: import("flexdb-node").ConsistencyMode,
  ): Promise<import("flexdb-node").QueryResponse>;

  /** Execute one or more write-only SQL statements. */
  execute(
    statements: import("flexdb-node").Statement | import("flexdb-node").Statement[],
  ): Promise<import("flexdb-node").QueryResponse>;

  /** Open a transaction and return a handle. */
  beginTransaction(): Promise<import("flexdb-node").TransactionHandle>;

  /** Run fn inside a transaction; commits on success, rolls back on error. */
  transaction<T>(fn: (tx: import("flexdb-node").TransactionHandle) => Promise<T>): Promise<T>;

  /** Release resources (stop health checks, close db, etc.). */
  destroy(): void;
}
