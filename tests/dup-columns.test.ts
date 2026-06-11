import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/index.js";
import type { DatabaseClient } from "../src/index.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpFile = path.join(os.tmpdir(), `bst3-dup-${Date.now()}.db`);

/**
 * Regression: a SELECT that returns two columns with the same name (the classic
 * `a.id` + `b.id` join) must keep EVERY selected column, positionally. ORMs like
 * Drizzle map result rows by position, so collapsing duplicate column names
 * shifts every later field and scrambles the row.
 */
describe("joins with duplicate column names", () => {
  let db: DatabaseClient;

  before(async () => {
    const warn = console.warn;
    console.warn = () => {}; // suppress WAL warning
    db = await open({ driver: "better-sqlite3", filename: tmpFile });
    console.warn = warn;
    await db.execute([{ sql: "CREATE TABLE a (id TEXT PRIMARY KEY, name TEXT)" }]);
    await db.execute([{ sql: "CREATE TABLE b (id TEXT PRIMARY KEY, a_id TEXT, label TEXT)" }]);
    await db.execute([{ sql: "INSERT INTO a (id, name) VALUES ('A1','Alice')" }]);
    await db.execute([{ sql: "INSERT INTO b (id, a_id, label) VALUES ('B1','A1','beta')" }]);
  });

  after(() => {
    db.destroy();
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it("preserves all four selected columns positionally", async () => {
    const res = await db.query([
      { sql: "SELECT a.id, b.id, a.name, b.label FROM a JOIN b ON b.a_id = a.id", params: [] },
    ]);
    const r = res.results[0];
    assert.equal(r.columns.length, 4, `expected 4 columns, got ${r.columns.length}: ${JSON.stringify(r.columns)}`);
    assert.equal(r.rows[0].length, 4, `expected 4 values, got ${r.rows[0].length}: ${JSON.stringify(r.rows[0])}`);
    assert.deepEqual(r.rows[0], ["A1", "B1", "Alice", "beta"]);
  });
});
