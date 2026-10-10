/**
 * Off-main-thread SQLite: ONE writer worker + N reader workers, each with its own
 * better-sqlite3 connection to the same file.
 *
 * Why: better-sqlite3 is synchronous. Even behind an async API, a 300 ms scan on
 * the main thread freezes every request, health probe and timer in the process
 * (kissuptime 2026-10-10: project-down alerts from one unindexed lookup). Here the
 * main thread only posts messages; a slow statement blocks one worker.
 *
 *   - Writer: every write, every transaction commit, PRAGMAs, DDL. One thread =
 *     one total order, so no main-thread write lock is needed.
 *   - Readers: SELECT / EXPLAIN / WITH. WAL lets them read while the writer
 *     writes; a read that starts after a write's promise resolved sees that write.
 *     A reader that finds a statement is not read-only (e.g. `WITH … INSERT`)
 *     hands the whole call back, and it is re-run on the writer.
 *   - `:memory:` and non-WAL databases get no readers (a second connection would
 *     not see the same data / would block): everything runs on the writer, still
 *     off the main thread.
 *
 * Workers are created from source (`eval`), not from a file, so nothing has to
 * survive bundling/tracing (Next standalone) — they only need to `require`
 * better-sqlite3, resolved here from the app's cwd.
 *
 * Env:
 *   DB_WORKERS=0|off        — disable (better-starlite runs in-process as before)
 *   DB_READ_WORKERS=<n>     — reader threads, all started at open (default 3, max 32;
 *                             0 = the writer does everything, still off the main thread)
 *   DB_WORKER_SPIN_US=<n>   — µs a worker keeps polling after a reply (default 200)
 */
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Statement, StatementResult } from "flexdb-node";
import { convertParamsForBetterSqlite3 } from "./params.js";

export interface WorkerPoolOptions {
  filename: string;
  wal: boolean;
  readers: number;
  /** better-sqlite3 module path; resolved from process.cwd() when omitted. */
  sqlitePath?: string;
  busyTimeoutMs?: number;
  /** `PRAGMA synchronous` value; SQLite's default when omitted. */
  synchronous?: string;
  autoOptimise?: boolean;
  autoOptimiseIntervalMs?: number;
  /** Microseconds a worker keeps polling for the next message after a reply (default 200, env DB_WORKER_SPIN_US). */
  spinUs?: number;
}

type Role = "writer" | "reader";
type WireStatement = { sql: string; params: unknown[] };
type Reply =
  | { id: number; ok: true; results: StatementResult[] }
  | { id: number; ok: false; error: { message: string; code?: string; name?: string } }
  | { id: number; redirect: true };

const REDIRECT = Symbol("redirect-to-writer");

/** Statements a reader may take. Anything else goes straight to the writer. */
const READ_ONLY = /^\s*(?:select|explain|with)\b/i;
export const isReadOnly = (stmts: Statement[]) => stmts.length > 0 && stmts.every((s) => READ_ONLY.test(s.sql));

const WORKER_SOURCE = String.raw`
const { parentPort, workerData, receiveMessageOnPort } = require("node:worker_threads");
const { role, filename, wal, sqlitePath, busyTimeoutMs, synchronous, autoOptimise, autoOptimiseIntervalMs, spinUs } = workerData;
const Database = require(sqlitePath);
const db = new Database(filename);
if (wal && filename !== ":memory:" && role === "writer") db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = " + busyTimeoutMs);
if (synchronous) db.pragma("synchronous = " + synchronous);
if (role === "reader") db.pragma("query_only = ON");

let optimiseTimer;
if (role === "writer" && autoOptimise) {
  try { db.pragma("optimize = 0x10002"); } catch {}
  optimiseTimer = setInterval(() => {
    if (!db.inTransaction) { try { db.pragma("optimize"); } catch {} }
  }, autoOptimiseIntervalMs);
}

// Prepared-statement cache (LRU by insertion order).
const cache = new Map();
function prepare(sql) {
  let st = cache.get(sql);
  if (st) { cache.delete(sql); cache.set(sql, st); return st; }
  st = db.prepare(sql);
  cache.set(sql, st);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return st;
}

function fix(params) {
  // structured clone turns Buffers into Uint8Arrays; better-sqlite3 binds Buffers.
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) params[i] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }
  return params;
}

function run(st, params) {
  const start = process.hrtime.bigint();
  if (st.reader) {
    const columns = st.columns().map((c) => c.name);
    // Positional rows: duplicate-named join columns must survive (Drizzle maps by position).
    const rows = st.raw(true).all(...params);
    return { columns, rows, rows_affected: 0, last_insert_id: null, time_ns: Number(process.hrtime.bigint() - start) };
  }
  const info = st.run(...params);
  const id = info.lastInsertRowid;
  return {
    columns: [], rows: [], rows_affected: info.changes,
    last_insert_id: typeof id === "bigint" ? Number(id) : id,
    time_ns: Number(process.hrtime.bigint() - start),
  };
}

function handle(msg) {
  if (msg.op === "close") {
    clearInterval(optimiseTimer);
    try { if (role === "writer" && autoOptimise) db.pragma("optimize"); } catch {}
    try { db.close(); } catch {}
    parentPort.close();
    return;
  }
  const { id, stmts, tx } = msg;
  try {
    if (role === "reader" && stmts.some((s) => !prepare(s.sql).reader)) {
      parentPort.postMessage({ id, redirect: true });
      return;
    }
    // Prepare each statement just before it runs: an earlier one may create the table a later one uses.
    const runAll = () => stmts.map((s) => run(prepare(s.sql), fix(s.params)));
    const results = tx ? db.transaction(runAll)() : runAll();
    parentPort.postMessage({ id, ok: true, results });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: { message: String(e && e.message || e), code: e && e.code, name: e && e.name } });
  }
}

// After a reply, poll briefly before going back to sleep: a request's next query
// usually arrives within microseconds, and catching it here saves a thread wake-up
// (the dominant per-query cost). Bounded, so an idle worker uses no CPU.
const spinNs = BigInt(Math.max(0, spinUs | 0)) * 1000n;
let closing = false;
parentPort.on("message", (msg) => {
  if (msg.op === "close") closing = true;
  handle(msg);
  if (closing || spinNs === 0n) return;
  let until = process.hrtime.bigint() + spinNs;
  while (!closing && process.hrtime.bigint() < until) {
    const next = receiveMessageOnPort(parentPort);
    if (!next) continue;
    if (next.message.op === "close") closing = true;
    handle(next.message);
    until = process.hrtime.bigint() + spinNs;
  }
});
parentPort.postMessage({ ready: true });
`;

interface Pending {
  resolve: (r: StatementResult[] | typeof REDIRECT) => void;
  reject: (e: Error) => void;
  /** Captured at the call site; its stack is only formatted if the call fails. */
  origin: Error;
}

class SqliteWorker {
  private worker!: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready!: Promise<void>;
  private closed = false;

  constructor(private readonly role: Role, private readonly data: Record<string, unknown>) {
    this.spawn();
  }

  /** Calls in flight, counted from the moment exec() is called (not when the worker is ready). */
  private inflight = 0;
  get load() { return this.inflight; }

  private spawn() {
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { ...this.data, role: this.role },
      // The source is CommonJS; a parent started with --input-type=module (or a
      // module default type) would otherwise run it as ESM, where require is undefined.
      execArgv: process.execArgv.filter((a) => !/^--(input-type|experimental-default-type)\b/.test(a)),
    });
    this.worker = w;
    let started = false;
    this.ready = new Promise<void>((resolve, reject) => {
      const onMsg = (m: { ready?: boolean }) => {
        if (m && m.ready) {
          started = true;
          w.off("message", onMsg); w.off("error", onErr);
          // Referenced while opening (so an awaiting process does not exit), then only while work is in flight.
          if (this.pending.size === 0) w.unref();
          resolve();
        }
      };
      const onErr = (e: Error) => { w.off("message", onMsg); reject(e); };
      w.on("message", onMsg);
      w.once("error", onErr);
    });
    this.ready.catch(() => { /* surfaced to callers via whenReady()/exec() */ });
    w.on("message", (m: Reply | { ready: true }) => this.onReply(m));
    w.on("error", (e: Error) => this.failAll(e));
    w.on("exit", (code) => {
      if (!started) return; // the ready promise already rejected via "error"
      this.failAll(new Error(`[better-starlite3] ${this.role} worker exited (code ${code})`));
      // Respawn so the next call works — not after an intentional close, and never a
      // worker that failed to open the database (returned above; it would loop forever).
      if (!this.closed && this.worker === w) this.spawn();
    });
  }

  whenReady() { return this.ready; }

  private onReply(m: Reply | { ready: true }) {
    if (!("id" in m)) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (this.pending.size === 0) this.worker.unref();
    if ("redirect" in m) return p.resolve(REDIRECT);
    if (m.ok) {
      for (const r of m.results) for (const row of r.rows as unknown[][]) {
        for (let i = 0; i < row.length; i++) {
          const v = row[i];
          if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[i] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
        }
      }
      p.resolve(m.results);
    } else {
      const err = new Error(m.error.message) as Error & { code?: string };
      err.name = m.error.name ?? "SqliteError";
      if (m.error.code) err.code = m.error.code;
      const callerStack = p.origin.stack?.split("\n").slice(2).join("\n");
      if (callerStack) err.stack = `${err.name}: ${err.message}\n${callerStack}`;
      p.reject(err);
    }
  }

  private failAll(e: Error) {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(e);
  }

  /** Resolves REDIRECT when a reader finds a statement that writes. */
  async exec(stmts: WireStatement[], tx: boolean): Promise<StatementResult[] | typeof REDIRECT> {
    if (this.closed) throw new Error("[better-starlite3] database is closed");
    const origin = new Error(); // before any await, so the caller's frames are still on the stack
    this.inflight++;
    try {
      await this.ready;
      return await new Promise<StatementResult[] | typeof REDIRECT>((resolve, reject) => {
        const id = this.nextId++;
        this.pending.set(id, { resolve, reject, origin });
        if (this.pending.size === 1) this.worker.ref(); // keep the process alive only while work is in flight
        this.worker.postMessage({ id, stmts, tx });
      });
    } finally {
      this.inflight--;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("[better-starlite3] database is closed"));
    this.worker.postMessage({ op: "close" });
  }
}

function toWire(stmts: Statement[]): WireStatement[] {
  return stmts.map((s) => {
    const { sql, params } = convertParamsForBetterSqlite3(s.sql, s.params);
    return { sql, params };
  });
}

export class SqliteWorkerPool {
  private readonly writer: SqliteWorker;
  private readonly readers: SqliteWorker[] = [];
  private readonly readerCount: number;
  private readonly data: Record<string, unknown>;
  private lastReader?: SqliteWorker;

  private constructor(opts: WorkerPoolOptions) {
    const memory = opts.filename === ":memory:" || opts.filename === "";
    const readers = memory || !opts.wal ? 0 : Math.max(0, opts.readers);
    const data = {
      filename: opts.filename,
      wal: opts.wal,
      sqlitePath: opts.sqlitePath ?? resolveSqlitePath(),
      busyTimeoutMs: opts.busyTimeoutMs ?? 5000,
      synchronous: opts.synchronous ?? null,
      autoOptimise: opts.autoOptimise ?? !/^(0|false|off|no)$/i.test(process.env.AUTO_OPTIMISE ?? ""),
      autoOptimiseIntervalMs: opts.autoOptimiseIntervalMs ?? (Number(process.env.AUTO_OPTIMISE_INTERVAL_MS) || 24 * 60 * 60 * 1000),
      spinUs: opts.spinUs ?? (process.env.DB_WORKER_SPIN_US !== undefined ? Number(process.env.DB_WORKER_SPIN_US) || 0 : 200),
    };
    this.writer = new SqliteWorker("writer", data);
    this.readerCount = readers;
    this.data = data;
  }

  /** Opens the writer first (it creates the file and switches to WAL), then the readers. */
  static async open(opts: WorkerPoolOptions): Promise<SqliteWorkerPool> {
    const pool = new SqliteWorkerPool(opts);
    await pool.writer.whenReady();
    for (let i = 0; i < pool.readerCount; i++) pool.readers.push(new SqliteWorker("reader", pool.data));
    await Promise.all(pool.readers.map((r) => r.whenReady()));
    return pool;
  }

  get readerWorkers() { return this.readers.length; }

  /** Reads go to the least-loaded reader; everything else (and readers' hand-backs) to the writer. */
  async run(stmts: Statement[]): Promise<StatementResult[]> {
    const wire = toWire(stmts);
    if (this.readers.length > 0 && isReadOnly(stmts)) {
      const r = await this.pickReader().exec(wire, false);
      if (r !== REDIRECT) return r;
    }
    return this.onWriter(wire, false);
  }

  private async onWriter(wire: WireStatement[], tx: boolean): Promise<StatementResult[]> {
    const r = await this.writer.exec(wire, tx);
    if (r === REDIRECT) throw new Error("[better-starlite3] writer refused a statement");
    return r;
  }

  /** Runs statements on the writer, in order, outside a transaction. */
  write(stmts: Statement[]): Promise<StatementResult[]> {
    return this.onWriter(toWire(stmts), false);
  }

  /** Runs statements atomically in one transaction on the writer. */
  transaction(stmts: Statement[]): Promise<StatementResult[]> {
    return this.onWriter(toWire(stmts), true);
  }

  /**
   * Least-loaded reader; ties go to the one used last — it is still polling for
   * its next message (see spinUs), so it answers without a thread wake-up.
   */
  private pickReader(): SqliteWorker {
    let best = this.lastReader ?? this.readers[0];
    for (const r of this.readers) if (r.load < best.load) best = r;
    this.lastReader = best;
    return best;
  }

  close() {
    for (const r of this.readers) r.close();
    this.writer.close();
  }
}

/** better-sqlite3 as the APP sees it (bundlers rewrite our own module paths). */
function resolveSqlitePath(): string {
  if (process.env.BETTER_SQLITE3_PATH) return process.env.BETTER_SQLITE3_PATH;
  try {
    return createRequire(join(process.cwd(), "noop.js")).resolve("better-sqlite3");
  } catch {
    return "better-sqlite3";
  }
}

/** DB_WORKERS=0|off disables the pool. */
export function workersEnabled(env = process.env): boolean {
  return !/^(0|false|off|no)$/i.test(env.DB_WORKERS ?? "");
}

export function readerCount(env = process.env): number {
  const n = Number(env.DB_READ_WORKERS);
  return env.DB_READ_WORKERS !== undefined && Number.isInteger(n) && n >= 0 ? Math.min(n, 32) : 3;
}
