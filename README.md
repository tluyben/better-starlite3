# better-starlite3

A unified async SQLite client that wraps **better-sqlite3**, **best-sqlite3**, and **flexdb-node** behind a single API. Switch between drivers with one option change — the rest of your code is identical.

## Installation

```bash
npm install better-starlite3
```

Install whichever driver(s) you need:

```bash
npm install better-sqlite3   # native SQLite (fastest, WAL auto-enabled)
npm install best-sqlite3     # pure-JS/WASM SQLite (no native build required)
npm install flexdb-node      # distributed FlexDB cluster
```

## Quick start

```ts
import { open } from "better-starlite3";

// Open with any driver — same API for all three
const db = await open({ driver: "better-sqlite3", filename: "myapp.db" });

// Write
await db.execute([{
  sql: "INSERT INTO users (name, age) VALUES (?1, ?2)",
  params: ["Alice", 30],
}]);

// Read
const res = await db.query({ sql: "SELECT * FROM users WHERE age > ?1", params: [18] });
console.log(res.results[0].rows);

// Transaction
await db.transaction(async (tx) => {
  await tx.execute([{ sql: "UPDATE accounts SET balance = balance - ?1 WHERE id = ?2", params: [100, 1] }]);
  await tx.execute([{ sql: "UPDATE accounts SET balance = balance + ?1 WHERE id = ?2", params: [100, 2] }]);
});

db.destroy();
```

## Switching drivers

```ts
// Local development — native SQLite
const db = await open({ driver: "better-sqlite3", filename: "dev.db" });

// CI / serverless — pure-JS SQLite, no native build
const db = await open({ driver: "best-sqlite3", filename: "data.db" });

// Production — distributed FlexDB cluster
const db = await open({
  driver: "flexdb",
  nodes: ["http://node1:4001", "http://node2:4001"],
  authToken: process.env.FLEXDB_TOKEN,
});
```

The `query`, `execute`, `beginTransaction`, `transaction`, and `destroy` methods work identically across all three.

## API

### `open(options): Promise<DatabaseClient>`

Opens a database connection.

**better-sqlite3 options:**
```ts
{
  driver: "better-sqlite3";
  filename: string;   // file path or ":memory:"
  wal?: boolean;      // default: true — opens in WAL mode automatically
}
```

**best-sqlite3 options:**
```ts
{
  driver: "best-sqlite3";
  filename: string;   // file path (WAL not supported by this driver)
  wal?: boolean;      // accepted but ignored with a warning
}
```

**flexdb options:**
```ts
{
  driver: "flexdb";
  nodes: string | string[];
  authToken?: string;
  healthCheckIntervalMs?: number;  // default: 10000
  timeoutMs?: number;              // default: 30000
}
```

### `db.query(statements, consistency?): Promise<QueryResponse>`

Execute one or more SQL statements (reads or writes). The optional `consistency` hint (`"raft"` | `"eventual"`) is forwarded to FlexDB; it is ignored on SQLite drivers.

```ts
// Single statement
const res = await db.query({ sql: "SELECT * FROM users" });

// Multiple statements
const res = await db.query([
  { sql: "SELECT * FROM a" },
  { sql: "SELECT * FROM b" },
]);
```

### `db.execute(statements): Promise<QueryResponse>`

Write-only path. Identical to `query` on SQLite drivers; on FlexDB it rejects SELECT statements server-side.

### `db.beginTransaction(): Promise<TransactionHandle>`

Returns a transaction handle with `query()`, `execute()`, `commit()`, and `rollback()` methods. The handle accumulates statements on SQLite drivers and executes them atomically on commit.

### `db.transaction(fn): Promise<T>`

Auto-commit/rollback wrapper (recommended):

```ts
const result = await db.transaction(async (tx) => {
  await tx.execute([{ sql: "INSERT INTO t VALUES (?1)", params: [42] }]);
  return "done";
});
```

Commits on success; rolls back and re-throws on any error.

### `db.destroy(): void`

Close the database / stop FlexDB background health checks. Always call when done to allow process exit.

## QueryResponse shape

All three drivers return the same structure:

```ts
{
  results: Array<{
    columns: string[];
    rows: (string | number | boolean | null)[][];
    rows_affected: number;
    last_insert_id: number | null;
    time_ns: number;
  }>;
  node_id: string;         // driver name for SQLite, node ID for FlexDB
  role: "standalone" | "leader" | "follower";
  executed_on: string;
  raft_index: number;      // 0 for SQLite
  crdt_conflicts: unknown[];
}
```

## Parameter style

All drivers accept FlexDB-style numbered parameters (`?1`, `?2`, etc.):

```ts
{ sql: "WHERE id = ?1 AND name = ?2", params: [42, "Alice"] }
```

This is translated internally for each driver:
- **better-sqlite3** — rewritten to `?`, `?` anonymous params
- **best-sqlite3** — rewritten to `$p1`, `$p2` named params
- **flexdb** — passed through unchanged

## Write serialisation (mutex)

`better-sqlite3` and `best-sqlite3` automatically serialise all write operations
(`execute()` and transaction `commit()`) through a per-connection async mutex.
This means it is safe to fire concurrent writes without coordinating callers:

```ts
// All 20 increments are serialised — no lost updates
await Promise.all(
  Array.from({ length: 20 }, () =>
    db.execute([{ sql: "UPDATE counter SET val = val + 1" }])
  )
);
```

Reads (`query()`) are **not** serialised — WAL mode allows concurrent readers
on `better-sqlite3`, and `best-sqlite3` reads are synchronous.

FlexDB handles write serialisation server-side via RAFT consensus, so no
client-side mutex is needed for that driver.

## WAL mode

`better-sqlite3` and `best-sqlite3` automatically open in WAL journal mode
(`wal: true` default), which means **you do not need** `PRAGMA journal_mode`,
`PRAGMA synchronous`, or similar pragmas.

## Warnings

`console.warn` is called when any statement contains:

- **PRAGMA** — FlexDB does not support pragma commands. Since WAL is set
  automatically, most pragmas are unnecessary anyway.
- **Dot-commands** (`.tables`, `.mode`, etc.) — these are SQLite CLI-only and
  are not valid SQL. They will fail on FlexDB and programmatic drivers.

These warnings fire on all three drivers so you notice portability issues early.

```
[better-starlite3] PRAGMA detected on driver "better-sqlite3": PRAGMA journal_mode
  FlexDB does not support PRAGMA. better-sqlite3/best-sqlite3 open in WAL mode
  automatically, so most PRAGMAs are unnecessary. Remove for portability.
```

## Limitations

| Feature | better-sqlite3 | best-sqlite3 | flexdb |
|---|---|---|---|
| WAL mode | ✅ auto | ❌ n/a (WASM) | ✅ server-managed |
| Atomic transactions | ✅ native | ⚠️ sequential commit | ✅ RAFT |
| In-memory database | ✅ `:memory:` | ✅ (no filename) | ❌ |
| Full-text search | ❌ | ❌ | ✅ via FlexDB API |
| Cluster / replication | ❌ | ❌ | ✅ |

**best-sqlite3 transactions**: The `best-sqlite3` driver has no native transaction API. Statements are buffered and executed sequentially on commit. This means a mid-transaction crash could leave partial writes. Use `better-sqlite3` or FlexDB when atomicity matters.

## 3rdparty directory

When developing this package locally, run:

```bash
git clone https://github.com/tluyben/flexdb-node.git 3rdparty/flexdb-node
cd 3rdparty/flexdb-node && npm install && npm run build
```

The `3rdparty/` directory is git-ignored and used as the local `flexdb-node` dev dependency.

## License

MIT
