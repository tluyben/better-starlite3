import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/index.js";

// 2026-10-10: commit() awaits between a transaction's statements; a plain write from
// another request that landed in that gap joined the open SQLite transaction on the
// shared connection and was rolled back with it when the transaction failed.
describe("better-starlite driver: writes never join another request's transaction", () => {
  it("a concurrent plain write survives a transaction that rolls back", async () => {
    const db = await open({ driver: "better-starlite", filename: ":memory:", slowQuery: false });
    await db.execute([{ sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL UNIQUE)" }]);
    for (let round = 0; round < 20; round++) {
      const failing = db.transaction(async (tx) => {
        for (let i = 0; i < 20; i++) await tx.execute([{ sql: "INSERT INTO t (v) VALUES (?1)", params: [`tx-${round}-${i}`] }]);
        await tx.execute([{ sql: "INSERT INTO t (v) VALUES (?1)", params: [`tx-${round}-0`] }]); // UNIQUE violation at commit
      }).then(() => "committed", () => "rolled back");
      // The commit only yields on microtasks, so start writers at staggered microtask
      // depths: some of them land while the failing transaction is open.
      const plain = Array.from({ length: 60 }, async (_, k) => {
        for (let d = 0; d < k; d++) await null;
        await db.query({ sql: "INSERT INTO t (v) VALUES (?1)", params: [`plain-${round}-${k}`] });
      });
      assert.equal(await failing, "rolled back");
      await Promise.all(plain);
    }
    const rows = (await db.query({ sql: "SELECT v FROM t ORDER BY id" })).results[0].rows.map((r) => r[0] as string);
    assert.equal(rows.filter((v) => v.startsWith("tx-")).length, 0, "nothing from the rolled-back transactions");
    assert.equal(rows.length, 20 * 60, "every plain write survived");
    db.destroy();
  });
});
