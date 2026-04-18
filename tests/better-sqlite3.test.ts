import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/index.js";
import { warnIfUnsupported } from "../src/warnings.js";
import type { DatabaseClient, Statement } from "../src/index.js";

describe("better-sqlite3 driver", () => {
  let db: DatabaseClient;

  before(async () => {
    db = await open({ driver: "better-sqlite3", filename: ":memory:" });
    await db.execute([{ sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)" }]);
  });

  after(() => db.destroy());

  it("inserts a row and returns last_insert_id", async () => {
    const res = await db.execute([{
      sql: "INSERT INTO users (name, age) VALUES (?1, ?2)",
      params: ["Alice", 30],
    }]);
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].last_insert_id, 1);
    assert.equal(res.results[0].rows_affected, 1);
  });

  it("also accepts a single statement (non-array form)", async () => {
    const res = await db.query({ sql: "SELECT * FROM users WHERE name = ?1", params: ["Alice"] });
    assert.equal(res.results[0].rows.length, 1);
    assert.deepEqual(res.results[0].columns, ["id", "name", "age"]);
    assert.equal(res.results[0].rows[0][1], "Alice");
  });

  it("returns standalone metadata", async () => {
    const res = await db.query({ sql: "SELECT 1 AS n" });
    assert.equal(res.role, "standalone");
    assert.equal(res.node_id, "better-sqlite3");
    assert.equal(res.raft_index, 0);
  });

  it("runs multiple statements in a batch", async () => {
    const stmts: Statement[] = [
      { sql: "INSERT INTO users (name, age) VALUES (?1, ?2)", params: ["Bob", 25] },
      { sql: "INSERT INTO users (name, age) VALUES (?1, ?2)", params: ["Carol", 35] },
    ];
    const res = await db.execute(stmts);
    assert.equal(res.results.length, 2);
  });

  it("transaction commits on success", async () => {
    await db.transaction(async (tx) => {
      await tx.execute([{ sql: "INSERT INTO users (name, age) VALUES (?1, ?2)", params: ["Dave", 40] }]);
      await tx.execute([{ sql: "INSERT INTO users (name, age) VALUES (?1, ?2)", params: ["Eve", 28] }]);
    });
    const res = await db.query({ sql: "SELECT COUNT(*) AS cnt FROM users" });
    assert.equal(res.results[0].rows[0][0], 5);
  });

  it("transaction rolls back on error", async () => {
    const before = await db.query({ sql: "SELECT COUNT(*) AS cnt FROM users" });
    const countBefore = before.results[0].rows[0][0] as number;

    await assert.rejects(async () => {
      await db.transaction(async (tx) => {
        await tx.execute([{ sql: "INSERT INTO users (name, age) VALUES (?1, ?2)", params: ["Frank", 22] }]);
        throw new Error("intentional rollback");
      });
    }, /intentional rollback/);

    const after = await db.query({ sql: "SELECT COUNT(*) AS cnt FROM users" });
    assert.equal(after.results[0].rows[0][0], countBefore);
  });

  it("warns on PRAGMA statements", async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      warnIfUnsupported("PRAGMA journal_mode", "test");
    } finally {
      console.warn = orig;
    }
    assert.ok(warnings.some((w) => w.includes("PRAGMA")));
  });

  it("warns on dot-commands", async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      warnIfUnsupported(".tables", "test");
    } finally {
      console.warn = orig;
    }
    assert.ok(warnings.some((w) => w.includes("dot-command")));
  });

  it("time_ns is a positive number", async () => {
    const res = await db.query({ sql: "SELECT 42 AS n" });
    assert.ok(res.results[0].time_ns > 0);
  });
});
