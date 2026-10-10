import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { open, wrapBetterSQLite3, flushSauromon } from "../src/index.js";
import type { DatabaseClient, SlowQueryEvent } from "../src/index.js";
import { fingerprintSql, describeSql, resolveSlowQueryConfig, SlowQueryTracker } from "../src/slow-query.js";

const cfg = (o: Partial<ReturnType<typeof resolveSlowQueryConfig>> = {}) => ({
  thresholdMs: 200, errorMs: 1000, reportIntervalMs: 60_000, maxEventsPerMin: 30, ...o,
});

function tracker(o: Partial<ReturnType<typeof resolveSlowQueryConfig>> = {}) {
  const events: SlowQueryEvent[] = [];
  let t = 1_000_000;
  const tr = new SlowQueryTracker(cfg(o), (e) => events.push(e), "test", () => t);
  return { tr, events, advance: (ms: number) => { t += ms; } };
}

describe("fingerprintSql / describeSql", () => {
  it("strips literals, numbered params and IN lists; keeps identifiers", () => {
    assert.equal(
      fingerprintSql(`select "t1"."c2" from t1 where email = 'a@b.com' and n > 42 and x = ?1 and id in (?, ?, ?) limit 10`),
      `select "t1"."c2" from t1 where email = ? and n > ? and x = ? and id in (?…) limit ?`,
    );
    assert.equal(fingerprintSql(`select  *\n from t where s = 'it''s'`), "select * from t where s = ?");
  });
  for (const [sql, op, table] of [
    ['select "a" from "monitor_checks" inner join x on 1', "select", "monitor_checks"],
    ["insert into `users` (id) values (?)", "insert", "users"],
    ['update "sessions" set a = ?', "update", "sessions"],
    ["delete from workload_samples where ts < ?", "delete", "workload_samples"],
    ["with r as (select 1) select * from r", "select", "r"],
    ["pragma table_info(x)", "pragma", "-"],
  ] as const) {
    it(`describes ${sql}`, () => assert.deepEqual(describeSql(sql), { op, table }));
  }
});

describe("resolveSlowQueryConfig", () => {
  it("defaults, env overrides, options win, garbage falls back", () => {
    assert.deepEqual(resolveSlowQueryConfig({}, {}), cfg());
    assert.deepEqual(resolveSlowQueryConfig({}, { DB_SLOW_QUERY_MS: "0", DB_SLOW_QUERY_REPORT_SECONDS: "5", DB_SLOW_QUERY_ERROR_MS: "x" }),
      cfg({ thresholdMs: 0, reportIntervalMs: 5000 }));
    assert.equal(resolveSlowQueryConfig({ thresholdMs: 50 }, { DB_SLOW_QUERY_MS: "9" }).thresholdMs, 50);
  });
});

describe("SlowQueryTracker", () => {
  const SQL = "select * from monitor_checks where round_id = ?";

  it("ignores fast queries, reports slow ones with a low-cardinality message", () => {
    const { tr, events } = tracker();
    tr.observe(SQL, 199, 1, false);
    tr.observe(SQL, 320.4, 5, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].message, "db slow query op=select table=monitor_checks");
    assert.equal(events[0].level, "warn");
    assert.deepEqual(
      { sql: events[0].fields.sql, ms: events[0].fields.ms, rows: events[0].fields.rows, occurrences: events[0].fields.occurrences },
      { sql: SQL, ms: 320, rows: 5, occurrences: 1 },
    );
  });

  it("rate-limits per shape and carries count/max of the suppressed ones", () => {
    const { tr, events, advance } = tracker();
    tr.observe(SQL, 300, 0, false);
    for (let i = 0; i < 42; i++) { advance(500); tr.observe(SQL, 310 + i, 0, false); }
    assert.equal(events.length, 1);
    advance(60_000);
    tr.observe(SQL, 305, 0, false);
    assert.equal(events.length, 2);
    assert.equal(events[1].fields.occurrences, 43);
    assert.equal(events[1].fields.maxMs, 351);
  });

  it("literals do not create new shapes; other shapes report independently", () => {
    const { tr, events } = tracker();
    tr.observe(`select * from a where x = 'p'`, 300, 0, false);
    tr.observe(`select * from a where x = 'q'`, 300, 0, false);
    tr.observe("select * from b", 300, 0, false);
    assert.deepEqual(events.map((e) => e.fields.table), ["a", "b"]);
  });

  it("error level, global cap, throwing reporter, disabled", () => {
    const a = tracker();
    a.tr.observe(SQL, 1500, 0, false);
    assert.equal(a.events[0].level, "error");

    const b = tracker({ maxEventsPerMin: 3 });
    for (let i = 0; i < 10; i++) b.tr.observe(`select * from t${"x".repeat(i)}`, 300, 0, false);
    assert.equal(b.events.length, 3);
    b.advance(60_000);
    b.tr.observe("select * from fresh", 300, 0, false);
    assert.equal(b.events.length, 4);

    const c = new SlowQueryTracker(cfg(), () => { throw new Error("boom"); });
    assert.doesNotThrow(() => c.observe(SQL, 500, 0, false));

    const d = tracker({ thresholdMs: 0 });
    d.tr.observe(SQL, 5000, 0, false);
    assert.equal(d.tr.enabled, false);
    assert.equal(d.events.length, 0);
  });
});

/** A real full-table scan on a real database — the 2026-10-10 kissuptime shape. */
async function seedScanTable(db: DatabaseClient) {
  await db.execute([{ sql: "CREATE TABLE checks (id INTEGER PRIMARY KEY, round_id TEXT, payload TEXT)" }]);
  await db.execute([{
    sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 200000) INSERT INTO checks (round_id, payload) SELECT 'r' || i, hex(randomblob(32)) FROM n",
  }]);
}

describe("open(): real driver, real slow query", () => {
  let db: DatabaseClient;
  const events: SlowQueryEvent[] = [];

  before(async () => {
    db = await open({
      driver: "better-sqlite3",
      filename: ":memory:",
      slowQuery: { thresholdMs: 1, reportSeconds: 0, sauromon: false, onSlowQuery: (e) => events.push(e) },
    });
    await seedScanTable(db);
    events.length = 0;
  });
  after(() => db.destroy());

  it("reports an unindexed lookup with its shape, never its parameters", async () => {
    const res = await db.query({ sql: "SELECT * FROM checks WHERE round_id = ?1", params: ["r-secret-value"] });
    assert.equal(res.results[0].rows.length, 0);
    const e = events.find((x) => x.fields.table === "checks");
    assert.ok(e, "slow query reported");
    assert.equal(e.fields.sql, "SELECT * FROM checks WHERE round_id = ?");
    assert.ok(!JSON.stringify(e).includes("secret"), "parameters never leak");
    assert.ok(e.fields.ms >= 1);
    assert.equal(e.fields.driver, "better-sqlite3");
  });

  it("an index makes it disappear (the actual fix)", async () => {
    await db.execute([{ sql: "CREATE INDEX checks_round_idx ON checks (round_id)" }]);
    events.length = 0;
    for (let i = 0; i < 20; i++) await db.query({ sql: "SELECT * FROM checks WHERE round_id = ?1", params: [`r${i}`] });
    assert.equal(events.filter((x) => x.fields.table === "checks" && x.fields.ms >= 5).length, 0);
  });

  it("times statements inside transactions", async () => {
    events.length = 0;
    await db.transaction(async (tx) => {
      await tx.query([{ sql: "SELECT count(*) FROM checks WHERE payload LIKE '%zz%'" }]);
    });
    assert.ok(events.some((x) => x.fields.inTransaction && x.fields.table === "checks"));
  });

  it("results pass through unchanged and other members still work", async () => {
    const r = await db.query({ sql: "SELECT 1 AS one" });
    assert.deepEqual(r.results[0].rows, [[1]]);
    assert.equal(db.driver, "better-sqlite3");
    assert.ok(db._raw);
  });
});

describe("wrapBetterSQLite3() is instrumented too; slowQuery:false opts out", () => {
  it("both", async () => {
    const Database = (await import("better-sqlite3")).default;
    const events: SlowQueryEvent[] = [];
    const on = wrapBetterSQLite3(new Database(":memory:"), {
      slowQuery: { thresholdMs: 1, reportSeconds: 0, sauromon: false, onSlowQuery: (e) => events.push(e) },
    });
    await seedScanTable(on);
    await on.query({ sql: "SELECT * FROM checks WHERE round_id = 'x'" });
    assert.ok(events.some((e) => e.fields.table === "checks"));
    on.destroy();

    const raw = new Database(":memory:");
    const off = wrapBetterSQLite3(raw, { slowQuery: false });
    assert.equal((off as unknown as Record<symbol, unknown>)[Symbol.for("better-starlite3.slowQuery")], undefined);
    off.destroy();
  });
});

describe("built-in SauroMON sender", () => {
  let server: Server;
  const received: Array<{ auth?: string; body: { events: Array<Record<string, unknown>> } }> = [];
  const saved = { ...process.env };

  before(async () => {
    server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { received.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.end("{}"); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    process.env.SAUROMON_ENDPOINT = `http://127.0.0.1:${port}/`;
    process.env.SAUROMON_INGEST_KEY = "slk_test_key";
    process.env.SAUROMON_SERVICE = "unit";
  });
  after(() => { server.close(); process.env = saved; });

  it("POSTs db.slow_query events to /api/v1/telemetry with the ingest key", async () => {
    const db = await open({ driver: "better-sqlite3", filename: ":memory:", slowQuery: { thresholdMs: 1, reportSeconds: 0 } });
    await seedScanTable(db);
    await db.query({ sql: "SELECT * FROM checks WHERE round_id = ?1", params: ["nope"] });
    await flushSauromon();
    db.destroy();
    const events = received.flatMap((r) => r.body.events);
    assert.equal(received[0].auth, "Bearer slk_test_key");
    const e = events.find((x) => (x.fields as { table?: string })?.table === "checks");
    assert.ok(e);
    assert.equal(e.kind, "event");
    assert.equal(e.eventType, "db.slow_query");
    assert.equal(e.service, "unit");
    assert.ok(!JSON.stringify(events).includes("nope"), "parameters never sent");
  });
});
