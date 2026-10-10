# better-starlite3

A unified async SQLite client that wraps **better-sqlite3**, **best-sqlite3**, **better-starlite**, and **flexdb-node** behind a single API. Switch between drivers with one option change — the rest of your code is identical.

## Installation

```bash
npm install better-starlite3
```

Install whichever driver(s) you need:

```bash
npm install better-sqlite3    # native SQLite (fastest, WAL auto-enabled)
npm install best-sqlite3      # pure-JS/WASM SQLite (no native build required)
npm install better-starlite   # async better-sqlite3 wrapper with rqlite support
npm install flexdb-node       # distributed FlexDB cluster
```

## Quick start

```ts
import { open } from "better-starlite3";

// Open with any driver — same API for all four
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
// Local development — native SQLite (synchronous internally)
const db = await open({ driver: "better-sqlite3", filename: "dev.db" });

// Local development — async better-sqlite3 wrapper with rqlite/FlexDB support
const db = await open({ driver: "better-starlite", filename: "dev.db" });

// CI / serverless — pure-JS SQLite, no native build
const db = await open({ driver: "best-sqlite3", filename: "data.db" });

// Production — distributed FlexDB cluster
const db = await open({
  driver: "flexdb",
  nodes: ["http://node1:4001", "http://node2:4001"],
  authToken: process.env.FLEXDB_TOKEN,
});
```

The `query`, `execute`, `beginTransaction`, `transaction`, and `destroy` methods work identically across all four.

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

**better-starlite options:**
```ts
{
  driver: "better-starlite";
  filename: string;   // file path or ":memory:"
  wal?: boolean;      // default: true — opens in WAL mode automatically
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

All four drivers return the same structure:

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
- **better-starlite** — rewritten to `?`, `?` anonymous params (same as better-sqlite3)
- **best-sqlite3** — rewritten to `$p1`, `$p2` named params
- **flexdb** — passed through unchanged

## Worker threads (default for `better-starlite`)

better-sqlite3 is synchronous: behind an async API it still runs on the Node main
thread, so one slow statement (an unindexed scan of a big table) freezes every
request, timer and health check in the process. The `better-starlite` driver
therefore runs a local database file on worker threads:

- **1 writer thread** — every write, transaction commit, PRAGMA and DDL, in order.
  One thread means one total order: no lost or interleaved writes.
- **N reader threads** (default **3**, all started at `open()`) — `SELECT` /
  `EXPLAIN` / `WITH` statements, on separate WAL connections. A read that starts
  after a write's promise resolved sees that write. A reader that finds a
  statement writes (`WITH … INSERT`) hands it to the writer.
- `:memory:` and `wal: false` databases get no readers (the writer does
  everything, still off the main thread).
- Same API, results and error codes (`err.code === "SQLITE_CONSTRAINT_UNIQUE"`),
  Buffers for blobs, positional rows. The process still exits on its own: workers
  only hold it open while a query is in flight.

| Env | Default | |
|---|---|---|
| `DB_WORKERS` | on | `0` / `off` = run in-process as before |
| `DB_READ_WORKERS` | `3` | reader threads (0–32); raise it for read-heavy apps |
| `DB_WORKER_SPIN_US` | `200` | µs a worker keeps polling for the next query before sleeping |
| `BETTER_SQLITE3_PATH` | resolved from `process.cwd()` | better-sqlite3 module the workers load |

Not on workers: better-starlite's own replication (`SHAREFILES_URL` + `REPLICA`),
remote URLs (`http(s)://`, `flexdb://`) and Bun — those keep the in-process path.
Container-level WAL replication (a tailer shipping the `-wal` file) is unaffected.

Cost and gain, measured (1M-row table, Node 22, 10-core VM):

| | in-process | workers |
|---|---|---|
| sequential point read | ~70 µs | ~140–210 µs (thread wake-up) |
| parallel point reads | ~17.5k/s | ~18–27k/s |
| main thread frozen during a 160 ms scan | 162 ms | 6 ms |
| other queries served during that scan | 2 | 340–770 |

Slow statements are still reported (see slow-query detection): `time_ns` is the
worker's execution time, without queue wait.

## Write serialisation (mutex)

`better-sqlite3` and `best-sqlite3` automatically serialise all write operations
(`execute()` and transaction `commit()`) through a per-connection async mutex.
`better-starlite` serialises writes on its single writer thread (or, with
`DB_WORKERS=0`, a per-connection mutex).
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
on `better-sqlite3` and `better-starlite`, and `best-sqlite3` reads are synchronous.

FlexDB handles write serialisation server-side via RAFT consensus, so no
client-side mutex is needed for that driver.

## WAL mode

`better-sqlite3`, `better-starlite`, and `best-sqlite3` automatically open in WAL journal mode
(`wal: true` default), which means **you do not need** `PRAGMA journal_mode`,
`PRAGMA synchronous`, or similar pragmas.

## Warnings

`console.warn` is called when any statement contains:

- **PRAGMA** — FlexDB does not support pragma commands. Since WAL is set
  automatically, most pragmas are unnecessary anyway.
- **Dot-commands** (`.tables`, `.mode`, etc.) — these are SQLite CLI-only and
  are not valid SQL. They will fail on FlexDB and programmatic drivers.

These warnings fire on all four drivers so you notice portability issues early.

```
[better-starlite3] PRAGMA detected on driver "better-sqlite3": PRAGMA journal_mode
  FlexDB does not support PRAGMA. better-sqlite3/best-sqlite3 open in WAL mode
  automatically, so most PRAGMAs are unnecessary. Remove for portability.
```

## Limitations

| Feature | better-sqlite3 | best-sqlite3 | better-starlite | flexdb |
|---|---|---|---|---|
| WAL mode | ✅ auto | ❌ n/a (WASM) | ✅ auto | ✅ server-managed |
| Atomic transactions | ✅ native | ⚠️ sequential commit | ✅ native | ✅ RAFT |
| In-memory database | ✅ `:memory:` | ✅ (no filename) | ✅ `:memory:` | ❌ |
| Full-text search | ❌ | ❌ | ❌ | ✅ via FlexDB API |
| Cluster / replication | ❌ | ❌ | ❌ | ✅ |
| rqlite support | ❌ | ❌ | ✅ via URL | ❌ |

**best-sqlite3 transactions**: The `best-sqlite3` driver has no native transaction API. Statements are buffered and executed sequentially on commit. This means a mid-transaction crash could leave partial writes. Use `better-sqlite3`, `better-starlite`, or FlexDB when atomicity matters.

## 3rdparty directory

When developing this package locally, clone both 3rdparty dependencies:

```bash
git clone https://github.com/tluyben/flexdb-node.git 3rdparty/flexdb-node
cd 3rdparty/flexdb-node && npm install && npm run build && cd ../..

git clone https://github.com/tluyben/better-starlite.git 3rdparty/better-starlite
cd 3rdparty/better-starlite && npm install && npm run build && cd ../..

npm install
```

The `3rdparty/` directory is git-ignored and used as the local dev dependencies for these packages.

## License

MIT
