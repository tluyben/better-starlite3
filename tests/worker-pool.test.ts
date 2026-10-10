import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { open } from "../src/index.js";
import type { DatabaseClient } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "bs3-workers-"));
delete process.env.DB_WORKERS; // these tests are about the worker pool; the fallback test sets it itself
delete process.env.DB_READ_WORKERS;
after(() => rmSync(dir, { recursive: true, force: true }));

const ROWS = 300_000;
const SLOW = "SELECT count(*) FROM big WHERE payload LIKE '%zzzz%' AND round_id <> ?1";

async function openFile(name: string, extra: Record<string, unknown> = {}): Promise<DatabaseClient> {
  return open({ driver: "better-starlite", filename: join(dir, name), slowQuery: false, ...extra } as never);
}

async function seed(db: DatabaseClient) {
  await db.execute([
    { sql: "CREATE TABLE big (id INTEGER PRIMARY KEY, round_id TEXT, payload TEXT)" },
    { sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${ROWS}) INSERT INTO big (round_id, payload) SELECT 'r' || i, hex(randomblob(48)) FROM n` },
  ]);
}

/** Longest gap between 5 ms timer ticks while `work` runs = how long the event loop was frozen. */
async function maxLoopStall(work: () => Promise<unknown>): Promise<{ stall: number; took: number }> {
  let last = performance.now();
  let stall = 0;
  const t = setInterval(() => {
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
  }, 5);
  const start = performance.now();
  await work();
  const end = performance.now();
  stall = Math.max(stall, end - last);
  const took = end - start;
  clearInterval(t);
  return { stall, took };
}

describe("worker pool (default better-starlite driver)", () => {
  let db: DatabaseClient;
  before(async () => {
    db = await openFile("main.db");
    await seed(db);
  });
  after(() => db.destroy());

  it("a slow scan does not freeze the main thread", async () => {
    const { stall, took } = await maxLoopStall(() => db.query({ sql: SLOW, params: ["x"] }));
    assert.ok(took > 40, `scan should be slow enough to matter (took ${took.toFixed(0)} ms)`);
    assert.ok(stall < Math.max(30, took / 4), `event loop stalled ${stall.toFixed(0)} ms during a ${took.toFixed(0)} ms query`);
  });

  it("slow reads run in parallel on the readers", async () => {
    // 3 readers by default: three scans at once should take far less than three in a row.
    const ratios: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const one = await maxLoopStall(() => db.query({ sql: SLOW, params: ["a"] }));
      const three = await maxLoopStall(() => Promise.all(["b", "c", "d"].map((p) => db.query({ sql: SLOW, params: [p] }))));
      ratios.push(three.took / one.took);
      if (ratios.at(-1)! < 2.2) return;
    }
    assert.fail(`3 parallel scans took ${ratios.map((r) => r.toFixed(2)).join("/")}× one scan (serial = 3×)`);
  });

  it("a read issued after a write resolves always sees it", async () => {
    await db.execute({ sql: "CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER)" });
    for (let i = 0; i < 300; i++) {
      await db.query({ sql: "INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v", params: ["a", i] });
      const r = await db.query({ sql: "SELECT v FROM kv WHERE k = ?1", params: ["a"] });
      assert.deepEqual(r.results[0].rows, [[i]]);
    }
  });

  it("writes via query(), rowsAffected and lastInsertId", async () => {
    await db.execute({ sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)" });
    const ins = await db.query({ sql: "INSERT INTO t (name) VALUES (?1)", params: ["x"] });
    assert.equal(ins.results[0].rows_affected, 1);
    assert.equal(ins.results[0].last_insert_id, 1);
    const upd = await db.query({ sql: "UPDATE t SET name = name || ?1", params: ["!"] });
    assert.equal(upd.results[0].rows_affected, 1);
  });

  it("a WITH … INSERT sent to a reader is handed to the writer", async () => {
    await db.execute({ sql: "CREATE TABLE w (n INTEGER)" });
    await db.query({ sql: "WITH x(n) AS (SELECT 7) INSERT INTO w SELECT n FROM x" });
    const r = await db.query({ sql: "SELECT n FROM w" });
    assert.deepEqual(r.results[0].rows, [[7]]);
  });

  it("errors keep SQLite's code and point at the caller", async () => {
    await db.execute({ sql: "CREATE TABLE u (email TEXT UNIQUE)" });
    await db.query({ sql: "INSERT INTO u VALUES (?1)", params: ["a@b"] });
    await assert.rejects(
      () => db.query({ sql: "INSERT INTO u VALUES (?1)", params: ["a@b"] }),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, "SQLITE_CONSTRAINT_UNIQUE");
        assert.match(e.message, /UNIQUE constraint failed/);
        assert.match(e.stack ?? "", /worker-pool\.test\.ts/);
        return true;
      },
    );
    await assert.rejects(() => db.query({ sql: "SELECT * FROM nope" }), /no such table: nope/);
  });

  it("blobs round-trip as Buffers; duplicate join columns survive", async () => {
    await db.execute({ sql: "CREATE TABLE b (id INTEGER PRIMARY KEY, data BLOB)" });
    const buf = Buffer.from([0, 1, 2, 255]);
    await db.query({ sql: "INSERT INTO b (id, data) VALUES (1, ?1)", params: [buf as never] });
    const r = await db.query({ sql: "SELECT b.data, b.id, b2.id FROM b JOIN b AS b2 ON b2.id = b.id" });
    assert.ok(Buffer.isBuffer(r.results[0].rows[0][0]));
    assert.deepEqual(r.results[0].rows[0][0], buf);
    assert.deepEqual(r.results[0].columns, ["data", "id", "id"]);
    assert.deepEqual(r.results[0].rows[0].slice(1), [1, 1]);
  });

  it("transactions are atomic and roll back as a whole", async () => {
    await db.execute({ sql: "CREATE TABLE acct (id INTEGER PRIMARY KEY, bal INTEGER CHECK (bal >= 0))" });
    await db.execute({ sql: "INSERT INTO acct VALUES (1, 100), (2, 0)" });
    await assert.rejects(() => db.transaction(async (tx) => {
      await tx.execute([{ sql: "UPDATE acct SET bal = bal + 500 WHERE id = 2" }]);
      await tx.execute([{ sql: "UPDATE acct SET bal = bal - 500 WHERE id = 1" }]); // CHECK fails at commit
    }), /CHECK constraint failed/);
    const r = await db.query({ sql: "SELECT bal FROM acct ORDER BY id" });
    assert.deepEqual(r.results[0].rows, [[100], [0]]);
  });

  it("plain writes racing failing transactions are never lost", async () => {
    await db.execute({ sql: "CREATE TABLE race (n INTEGER)" });
    await db.execute({ sql: "CREATE TABLE guard (n INTEGER CHECK (n < 0))" });
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 400; i++) work.push(db.execute({ sql: "INSERT INTO race VALUES (?1)", params: [i] }));
    for (let i = 0; i < 40; i++) {
      work.push(db.transaction(async (tx) => {
        await tx.execute([{ sql: "INSERT INTO race VALUES (-1)" }]);
        await tx.execute([{ sql: "INSERT INTO guard VALUES (1)" }]);
      }).catch(() => {}));
    }
    await Promise.all(work);
    const r = await db.query({ sql: "SELECT count(*), min(n) FROM race" });
    assert.deepEqual(r.results[0].rows, [[400, 0]]);
  });

  it("parallel mixed load keeps every write", async () => {
    await db.execute({ sql: "CREATE TABLE mix (n INTEGER)" });
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i++) {
      work.push(i % 3 === 0
        ? db.query({ sql: "SELECT count(*) FROM mix" })
        : db.query({ sql: "INSERT INTO mix VALUES (?1)", params: [i] }));
    }
    await Promise.all(work);
    const r = await db.query({ sql: "SELECT count(*) FROM mix" });
    assert.deepEqual(r.results[0].rows, [[666]]);
  });

  it("calls after destroy() fail cleanly", async () => {
    const d = await openFile("closed.db");
    d.destroy();
    await assert.rejects(() => d.query({ sql: "SELECT 1" }), /closed/);
  });
});

describe(":memory: runs on the writer alone (no readers)", () => {
  it("works and keeps data across calls", async () => {
    const db = await open({ driver: "better-starlite", filename: ":memory:", slowQuery: false });
    await db.execute({ sql: "CREATE TABLE m (n INTEGER)" });
    await db.execute({ sql: "INSERT INTO m VALUES (1)" });
    const r = await db.query({ sql: "SELECT n FROM m" });
    assert.deepEqual(r.results[0].rows, [[1]]);
    db.destroy();
  });
});

describe("DB_WORKERS=0 falls back to in-process better-starlite", () => {
  it("blocks the main thread like before (proves the test above measures something)", async () => {
    process.env.DB_WORKERS = "0";
    try {
      const db = await openFile("inproc.db");
      await seed(db);
      const { stall, took } = await maxLoopStall(() => db.query({ sql: SLOW, params: ["x"] }));
      assert.ok(stall > took * 0.7, `in-process scan should stall the loop (stall ${stall.toFixed(0)} / took ${took.toFixed(0)})`);
      db.destroy();
    } finally {
      delete process.env.DB_WORKERS;
    }
  });
});

describe("process lifetime", () => {
  it("a script that never calls destroy() still exits", () => {
    const script = join(dir, "exit.mts");
    writeFileSync(script, `
      import { open } from ${JSON.stringify(new URL("../src/index.js", import.meta.url).pathname)};
      const db = await open({ driver: "better-starlite", filename: ${JSON.stringify(join(dir, "exit.db"))}, slowQuery: false });
      await db.execute({ sql: "CREATE TABLE IF NOT EXISTS e (n INTEGER)" });
      const r = await db.query({ sql: "SELECT count(*) FROM e" });
      console.log("rows", r.results[0].rows[0][0]);
    `);
    const res = spawnSync(process.execPath, ["--import", "tsx/esm", script], { cwd: process.cwd(), timeout: 15_000, encoding: "utf8" });
    assert.equal(res.signal, null, `script hung: ${res.stderr}`);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /rows 0/);
  });
});

describe("DB_READ_WORKERS / DB_WORKERS parsing", () => {
  it("defaults to 3 readers, honours 0..32, ignores garbage", async () => {
    const { readerCount, workersEnabled } = await import("../src/worker-pool.js");
    assert.equal(readerCount({}), 3);
    assert.equal(readerCount({ DB_READ_WORKERS: "8" }), 8);
    assert.equal(readerCount({ DB_READ_WORKERS: "0" }), 0);
    assert.equal(readerCount({ DB_READ_WORKERS: "500" }), 32);
    assert.equal(readerCount({ DB_READ_WORKERS: "lots" }), 3);
    assert.equal(workersEnabled({}), true);
    assert.equal(workersEnabled({ DB_WORKERS: "off" }), false);
    assert.equal(workersEnabled({ DB_WORKERS: "0" }), false);
  });
});

describe("filename and parent flags", () => {
  it("a file: prefix (DATABASE_URL=\"file:./x.db\") opens ./x.db, workers and in-process", async () => {
    for (const workers of ["on", "0"]) {
      process.env.DB_WORKERS = workers;
      try {
        const name = `prefixed-${workers}.db`;
        const db = await open({ driver: "better-starlite", filename: `file:${join(dir, name)}`, slowQuery: false });
        await db.execute({ sql: "CREATE TABLE p (n INTEGER)" });
        db.destroy();
        const again = await openFile(name);
        const r = await again.query({ sql: "SELECT count(*) FROM p" });
        assert.deepEqual(r.results[0].rows, [[0]]);
        again.destroy();
      } finally {
        delete process.env.DB_WORKERS;
      }
    }
  });

  it("works when the parent runs with --input-type=module", () => {
    const code = `
      const { open } = await import(${JSON.stringify(new URL("../src/index.js", import.meta.url).pathname)});
      const db = await open({ driver: "better-starlite", filename: ${JSON.stringify(join(dir, "esm.db"))}, slowQuery: false });
      const r = await db.query({ sql: "SELECT 41 + 1" });
      console.log("answer", r.results[0].rows[0][0]);
    `;
    const res = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", code], { timeout: 15_000, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /answer 42/);
  });
});
