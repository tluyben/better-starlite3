declare module "best-sqlite3" {
  interface BestSqliteInstance {
    run(sql: string, params?: Record<string, unknown>): Record<string, unknown>[] | { rowsModified: number; lastInsertRowId?: number };
    exec(sql: string, params?: Record<string, unknown>): Record<string, unknown>[];
    registerFunction(name: string, fn: (...args: unknown[]) => unknown): void;
    regFunc(name: string, fn: (...args: unknown[]) => unknown): void;
    get tables(): string[];
    get views(): string[];
  }

  class BestSqlite {
    constructor(filePath: string);
    static connect(filePath: string): Promise<BestSqliteInstance>;
    run(sql: string, params?: Record<string, unknown>): Record<string, unknown>[] | { rowsModified: number; lastInsertRowId?: number };
    exec(sql: string, params?: Record<string, unknown>): Record<string, unknown>[];
  }

  export = BestSqlite;
}
