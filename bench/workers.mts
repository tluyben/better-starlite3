// Run: node --import tsx/esm bench/workers.mts workers|inproc   (Node 22; prints one JSON line)
import { open } from "../src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mode = process.argv[2];
if (mode === "inproc") process.env.DB_WORKERS = "0";
const dir = mkdtempSync(join(tmpdir(), "bench-"));
const events: any[] = [];
const db = await open({ driver: "better-starlite", filename: join(dir, "b.db"), slowQuery: { thresholdMs: 100, reportSeconds: 0, sauromon: false, onSlowQuery: (e) => events.push(e) } });
await db.execute([{ sql: "CREATE TABLE big (id INTEGER PRIMARY KEY, round_id TEXT, payload TEXT)" },
  { sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1000000) INSERT INTO big (round_id, payload) SELECT 'r' || i, hex(randomblob(48)) FROM n" }]);
const t = () => performance.now();
let s = t();
for (let i = 0; i < 5000; i++) await db.query({ sql: "SELECT * FROM big WHERE id = ?1", params: [1 + (i * 7919) % 1000000] });
const seqRead = (t() - s) / 5000 * 1000;
s = t();
await Promise.all(Array.from({ length: 20000 }, (_, i) => db.query({ sql: "SELECT * FROM big WHERE id = ?1", params: [1 + (i * 104729) % 1000000] })));
const parRead = 20000 / ((t() - s) / 1000);
s = t();
for (let i = 0; i < 2000; i++) await db.execute([{ sql: "UPDATE big SET payload = ?1 WHERE id = ?2", params: ["x" + i, i + 1] }]);
const seqWrite = (t() - s) / 2000 * 1000;
// stall during a 1M-row scan while point reads keep coming
let last = t(), stall = 0, served = 0, stop = false;
const iv = setInterval(() => { const n = t(); stall = Math.max(stall, n - last); last = n; }, 5);
const bg = (async () => { while (!stop) { await db.query({ sql: "SELECT id FROM big WHERE id = ?1", params: [42] }); served++; } })();
s = t();
await db.query({ sql: "SELECT count(*) FROM big WHERE payload LIKE '%zzzz%' AND round_id <> ?1", params: ["x"] });
const scan = t() - s; stop = true; await bg; stall = Math.max(stall, t() - last); clearInterval(iv);
console.log(JSON.stringify({ mode, seqReadUs: +seqRead.toFixed(1), parReadPerSec: Math.round(parRead), seqWriteUs: +seqWrite.toFixed(1), scanMs: Math.round(scan), loopStallMs: Math.round(stall), pointReadsDuringScan: served, slowEvents: events.map((e) => `${e.fields.table}:${e.fields.ms}ms`) }));
db.destroy(); rmSync(dir, { recursive: true, force: true });
