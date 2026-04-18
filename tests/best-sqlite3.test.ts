import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/index.js";
import type { DatabaseClient, Statement } from "../src/index.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpFile = path.join(os.tmpdir(), `bst3-test-${Date.now()}.db`);

describe("best-sqlite3 driver", () => {
  let db: DatabaseClient;

  before(async () => {
    const orig = console.warn;
    console.warn = () => {}; // suppress expected WAL warning
    db = await open({ driver: "best-sqlite3", filename: tmpFile });
    console.warn = orig;
    await db.execute([{ sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, val INTEGER)" }]);
  });

  after(() => {
    db.destroy();
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it("inserts and returns rowsModified", async () => {
    const res = await db.execute([{
      sql: "INSERT INTO items (label, val) VALUES (?1, ?2)",
      params: ["alpha", 1],
    }]);
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].rows_affected, 1);
  });

  it("queries inserted rows", async () => {
    const res = await db.query([{ sql: "SELECT * FROM items WHERE label = ?1", params: ["alpha"] }]);
    assert.equal(res.results[0].rows.length, 1);
    assert.ok(res.results[0].columns.includes("label"));
  });

  it("returns standalone metadata", async () => {
    const res = await db.query({ sql: "SELECT 1 AS n" });
    assert.equal(res.role, "standalone");
    assert.equal(res.node_id, "best-sqlite3");
  });

  it("batches multiple statements", async () => {
    const stmts: Statement[] = [
      { sql: "INSERT INTO items (label, val) VALUES (?1, ?2)", params: ["beta", 2] },
      { sql: "INSERT INTO items (label, val) VALUES (?1, ?2)", params: ["gamma", 3] },
    ];
    const res = await db.execute(stmts);
    assert.equal(res.results.length, 2);
  });

  it("transaction commits", async () => {
    await db.transaction(async (tx) => {
      await tx.execute([{ sql: "INSERT INTO items (label, val) VALUES (?1, ?2)", params: ["delta", 4] }]);
    });
    const res = await db.query({ sql: "SELECT COUNT(*) AS cnt FROM items" });
    assert.ok((res.results[0].rows[0][0] as number) >= 4);
  });

  it("transaction rolls back", async () => {
    const before = await db.query({ sql: "SELECT COUNT(*) AS cnt FROM items" });
    const countBefore = before.results[0].rows[0][0] as number;

    await assert.rejects(async () => {
      await db.transaction(async (tx) => {
        await tx.execute([{ sql: "INSERT INTO items (label, val) VALUES (?1, ?2)", params: ["epsilon", 5] }]);
        throw new Error("rollback test");
      });
    });

    const after = await db.query({ sql: "SELECT COUNT(*) AS cnt FROM items" });
    assert.equal(after.results[0].rows[0][0], countBefore);
  });
});
