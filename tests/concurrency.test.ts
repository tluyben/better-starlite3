/**
 * Fires many concurrent writes at the same DB instance and verifies that
 * the final row count is exactly right — no lost writes, no corruption.
 * Runs for both SQLite drivers.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/index.js";
import type { DatabaseClient } from "../src/index.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const WRITERS = 20;

async function runConcurrencyTest(db: DatabaseClient, label: string) {
  await db.execute([{ sql: "CREATE TABLE counter (val INTEGER NOT NULL)" }]);
  await db.execute([{ sql: "INSERT INTO counter VALUES (0)" }]);

  // Fire WRITERS concurrent increment-via-execute calls
  await Promise.all(
    Array.from({ length: WRITERS }, () =>
      db.execute([{ sql: "UPDATE counter SET val = val + 1" }]),
    ),
  );

  const res = await db.query({ sql: "SELECT val FROM counter" });
  const val = res.results[0].rows[0][0] as number;
  assert.equal(val, WRITERS, `${label}: expected ${WRITERS} increments, got ${val}`);
}

async function runTxConcurrencyTest(db: DatabaseClient, label: string) {
  await db.execute([{ sql: "CREATE TABLE tx_counter (val INTEGER NOT NULL)" }]);
  await db.execute([{ sql: "INSERT INTO tx_counter VALUES (0)" }]);

  // Fire WRITERS concurrent transactions
  await Promise.all(
    Array.from({ length: WRITERS }, () =>
      db.transaction(async (tx) => {
        await tx.execute([{ sql: "UPDATE tx_counter SET val = val + 1" }]);
      }),
    ),
  );

  const res = await db.query({ sql: "SELECT val FROM tx_counter" });
  const val = res.results[0].rows[0][0] as number;
  assert.equal(val, WRITERS, `${label} tx: expected ${WRITERS} increments, got ${val}`);
}

describe("better-sqlite3 concurrent writes", () => {
  let db: DatabaseClient;

  before(async () => {
    db = await open({ driver: "better-sqlite3", filename: ":memory:" });
  });
  after(() => db.destroy());

  it(`serialises ${WRITERS} concurrent execute() calls`, async () => {
    await runConcurrencyTest(db, "better-sqlite3");
  });

  it(`serialises ${WRITERS} concurrent transaction() calls`, async () => {
    await runTxConcurrencyTest(db, "better-sqlite3");
  });
});

describe("best-sqlite3 concurrent writes", () => {
  let db: DatabaseClient;
  const tmpFile = path.join(os.tmpdir(), `bst3-conc-${Date.now()}.db`);

  before(async () => {
    const orig = console.warn;
    console.warn = () => {};
    db = await open({ driver: "best-sqlite3", filename: tmpFile });
    console.warn = orig;
  });
  after(() => {
    db.destroy();
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it(`serialises ${WRITERS} concurrent execute() calls`, async () => {
    await runConcurrencyTest(db, "best-sqlite3");
  });

  it(`serialises ${WRITERS} concurrent transaction() calls`, async () => {
    await runTxConcurrencyTest(db, "best-sqlite3");
  });
});
