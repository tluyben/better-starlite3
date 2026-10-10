/**
 * Slow-query detector — every client returned by `open()` / `wrapBetterSQLite3()`
 * times each statement and reports the slow ones.
 *
 * Why: the SQLite drivers here run IN-PROCESS. The API is async, but a query
 * executes on the main thread, so one 300 ms full-table scan blocks every other
 * request for 300 ms. (2026-10-10, kissuptime: an unindexed `WHERE round_id = ?`
 * over 2.7M rows, run per check round, pegged the process until its health
 * probe failed.) This surfaces such queries long before they take a site down.
 *
 * Measured: the driver's own per-statement time (`StatementResult.time_ns`), so
 * waiting for the write mutex or a busy event loop does not count. If a driver
 * leaves it at 0, a single-statement call falls back to wall time.
 *
 * Reported: the SQL SHAPE only — literals stripped, IN-lists collapsed,
 * parameters NEVER included (they carry user data). The message is
 * low-cardinality (`db slow query op=select table=monitor_checks`).
 *
 * Where to: SauroMON, when SAUROMON_ENDPOINT + SAUROMON_INGEST_KEY (or
 * SAUROMON_EVENTS_KEY) are set, as `kind=event, eventType=db.slow_query`; and/or
 * an `onSlowQuery` callback. Nothing configured ⇒ timing still runs (≈free) but
 * nothing is sent.
 *
 * Flood-safe: per query shape at most one report per `reportSeconds` (the report
 * carries the count/max/total since the previous one) and a global per-minute
 * cap. Reporting can never throw into, or slow down, the query path.
 *
 * Env (options passed to open() win):
 *   DB_SLOW_QUERY_MS                 threshold, default 200 (0 = off)
 *   DB_SLOW_QUERY_ERROR_MS           level=error at/above, default 1000
 *   DB_SLOW_QUERY_REPORT_SECONDS     per-shape report interval, default 60
 *   DB_SLOW_QUERY_MAX_EVENTS_PER_MIN global cap, default 30
 *   SAUROMON_ENDPOINT, SAUROMON_INGEST_KEY | SAUROMON_EVENTS_KEY,
 *   SAUROMON_SERVICE, SAUROMON_ENVIRONMENT, SAUROMON_RELEASE
 */

import type { DatabaseClient, Statement, QueryResponse, TransactionHandle } from "./types.js";

export interface SlowQueryEvent {
  kind: "event";
  eventType: "db.slow_query";
  level: "warn" | "error";
  message: string;
  durationMs: number;
  fields: {
    sql: string;
    op: string;
    table: string;
    ms: number;
    rows: number;
    thresholdMs: number;
    /** Slow executions of this shape since its previous report (this one included). */
    occurrences: number;
    maxMs: number;
    totalMs: number;
    windowSeconds: number;
    inTransaction: boolean;
    driver: string;
  };
}

export interface SlowQueryOptions {
  thresholdMs?: number;
  errorMs?: number;
  reportSeconds?: number;
  maxEventsPerMin?: number;
  /** Called for every report (after rate limiting). Must not throw (it is guarded anyway). */
  onSlowQuery?: (event: SlowQueryEvent) => void;
  /** Built-in SauroMON sender; default on when the SAUROMON_* env is set. */
  sauromon?: boolean;
}

interface Config { thresholdMs: number; errorMs: number; reportIntervalMs: number; maxEventsPerMin: number }

const envNum = (env: Record<string, string | undefined>, k: string, d: number) => {
  const v = env[k]?.trim();
  const n = Number(v);
  return v && Number.isFinite(n) && n >= 0 ? n : d;
};

export function resolveSlowQueryConfig(opts: SlowQueryOptions = {}, env: Record<string, string | undefined> = process.env): Config {
  return {
    thresholdMs: opts.thresholdMs ?? envNum(env, "DB_SLOW_QUERY_MS", 200),
    errorMs: opts.errorMs ?? envNum(env, "DB_SLOW_QUERY_ERROR_MS", 1000),
    reportIntervalMs: (opts.reportSeconds ?? envNum(env, "DB_SLOW_QUERY_REPORT_SECONDS", 60)) * 1000,
    maxEventsPerMin: opts.maxEventsPerMin ?? envNum(env, "DB_SLOW_QUERY_MAX_EVENTS_PER_MIN", 30),
  };
}

// ── SQL shape ──────────────────────────────────────────────────────────────

const MAX_SQL = 1000;

/** The SQL with every literal removed, so it identifies the query, not the data. */
export function fingerprintSql(sql: string): string {
  return sql
    .replace(/\?\d+/g, "?") // numbered params ?1 ?2 (before numbers, or ?1 becomes ??)
    .replace(/'(?:[^']|'')*'/g, "?") // string literals
    .replace(/\bx'[0-9a-f]*'/gi, "?") // blob literals
    .replace(/(?<![\w"`$?])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, "?") // numbers (not inside identifiers)
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?…)") // IN (?, ?, ?) of any length
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SQL);
}

/** `select` / `insert` / … and the first table it touches, for the message. */
export function describeSql(sql: string): { op: string; table: string } {
  const s = sql.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*/, "");
  let op = (s.match(/^\w+/)?.[0] ?? "sql").toLowerCase();
  if (op === "with") op = s.match(/\)\s*(select|insert|update|delete)\b/i)?.[1]?.toLowerCase() ?? "with";
  const ident = String.raw`["\`\[]?([\w.$]+)["\`\]]?`;
  const re =
    op === "insert" || op === "replace"
      ? new RegExp(String.raw`\binto\s+${ident}`, "i")
      : op === "update"
        ? new RegExp(String.raw`^update\s+(?:or\s+\w+\s+)?${ident}`, "i")
        : new RegExp(String.raw`\bfrom\s+${ident}`, "i");
  return { op, table: s.match(re)?.[1] ?? "-" };
}

// ── Aggregation + rate limiting (clock injected for tests) ─────────────────

interface ShapeState { lastReportAt: number; occurrences: number; maxMs: number; totalMs: number }

export class SlowQueryTracker {
  private shapes = new Map<string, ShapeState>();
  private minuteStart = 0;
  private sentThisMinute = 0;

  constructor(
    private readonly config: Config,
    private readonly report: (event: SlowQueryEvent) => void,
    private readonly driver = "sqlite",
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.config.thresholdMs > 0;
  }

  observe(sql: string, ms: number, rows: number, inTransaction: boolean): void {
    if (!this.enabled || !(ms >= this.config.thresholdMs)) return;
    const shape = fingerprintSql(sql);
    const t = this.now();
    let st = this.shapes.get(shape);
    if (!st) {
      if (this.shapes.size >= 1000) this.shapes.clear(); // bounded: a shape explosion must not leak memory
      st = { lastReportAt: -Infinity, occurrences: 0, maxMs: 0, totalMs: 0 };
      this.shapes.set(shape, st);
    }
    st.occurrences++;
    st.totalMs += ms;
    if (ms > st.maxMs) st.maxMs = ms;
    if (t - st.lastReportAt < this.config.reportIntervalMs) return;

    if (t - this.minuteStart >= 60_000) { this.minuteStart = t; this.sentThisMinute = 0; }
    if (this.sentThisMinute >= this.config.maxEventsPerMin) return;
    this.sentThisMinute++;

    const { op, table } = describeSql(sql);
    const event: SlowQueryEvent = {
      kind: "event",
      eventType: "db.slow_query",
      level: st.maxMs >= this.config.errorMs ? "error" : "warn",
      message: `db slow query op=${op} table=${table}`,
      durationMs: Math.round(ms),
      fields: {
        sql: shape,
        op,
        table,
        ms: Math.round(ms),
        rows,
        thresholdMs: this.config.thresholdMs,
        occurrences: st.occurrences,
        maxMs: Math.round(st.maxMs),
        totalMs: Math.round(st.totalMs),
        windowSeconds: Number.isFinite(st.lastReportAt) ? Math.round((t - st.lastReportAt) / 1000) : 0,
        inTransaction,
        driver: this.driver,
      },
    };
    st.lastReportAt = t;
    st.occurrences = 0;
    st.maxMs = 0;
    st.totalMs = 0;
    try { this.report(event); } catch { /* reporting must never break a query */ }
  }
}

// ── Built-in SauroMON sender (batched, bounded, fire-and-forget) ───────────

const env = (k: string) => (process.env[k] ?? "").trim();
const sauromonKey = () => env("SAUROMON_EVENTS_KEY") || env("SAUROMON_INGEST_KEY");
const sauromonEndpoint = () => env("SAUROMON_ENDPOINT").replace(/\/+$/, "");
export const sauromonConfigured = () => !!(sauromonKey() && sauromonEndpoint());

const queue: Record<string, unknown>[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sending = false;
const MAX_QUEUE = 500;

export function sendToSauromon(event: SlowQueryEvent): void {
  if (!sauromonConfigured()) return;
  const service = env("SAUROMON_SERVICE") || env("OTEL_SERVICE_NAME") || "app";
  queue.push({
    ts: new Date().toISOString(),
    ...event,
    service,
    source: service,
    environment: env("SAUROMON_ENVIRONMENT") || undefined,
    release: env("SAUROMON_RELEASE") || undefined,
  });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  if (!timer) {
    timer = setTimeout(() => { timer = null; void flushSauromon(); }, 2000);
    (timer as { unref?: () => void }).unref?.();
  }
}

/** Send what is queued (also used by tests / shutdown hooks). Never throws. */
export async function flushSauromon(): Promise<void> {
  if (sending || !queue.length || !sauromonConfigured()) return;
  sending = true;
  const batch = queue.splice(0, 100);
  try {
    const res = await fetch(`${sauromonEndpoint()}/api/v1/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sauromonKey()}` },
      body: JSON.stringify({ events: batch }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 500 || res.status === 429) queue.unshift(...batch); // retry later; 4xx = bad batch, drop
    await res.body?.cancel().catch(() => {});
  } catch {
    queue.unshift(...batch);
  } finally {
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    sending = false;
    if (queue.length && !timer) {
      timer = setTimeout(() => { timer = null; void flushSauromon(); }, 30_000);
      (timer as { unref?: () => void }).unref?.();
    }
  }
}

// ── Client wrapper ─────────────────────────────────────────────────────────

const asArray = (s: Statement | Statement[]): Statement[] => (Array.isArray(s) ? s : [s]);

function observeResponse(tracker: SlowQueryTracker, stmts: Statement[], res: QueryResponse, wallNs: number, inTx: boolean) {
  const results = res?.results ?? [];
  stmts.forEach((stmt, i) => {
    const r = results[i];
    const ns = r?.time_ns && r.time_ns > 0 ? r.time_ns : stmts.length === 1 ? wallNs : 0;
    if (!ns) return;
    tracker.observe(stmt.sql, ns / 1e6, r?.rows?.length || r?.rows_affected || 0, inTx);
  });
}

type Exec = (stmts: Statement | Statement[], ...rest: unknown[]) => Promise<QueryResponse>;

function timed(tracker: SlowQueryTracker, inTx: boolean, fn: Exec): Exec {
  return async (stmts, ...rest) => {
    const start = process.hrtime.bigint();
    const res = await fn(stmts, ...rest);
    try {
      observeResponse(tracker, asArray(stmts), res, Number(process.hrtime.bigint() - start), inTx);
    } catch { /* timing must never break a query */ }
    return res;
  };
}

/**
 * The SQLite drivers only QUEUE a transaction's statements and run them all,
 * synchronously, inside commit() — so commit() is what blocks and what gets
 * timed (reported as one shape: the statement shapes joined). flexdb executes
 * each statement when it is sent, so query/execute are timed as well.
 */
function wrapTx(tx: TransactionHandle, tracker: SlowQueryTracker): TransactionHandle {
  const sent: Statement[] = [];
  // Patch commit ON the handle: client.transaction() calls commit on its own
  // reference to the handle, never on the proxy we hand to the callback.
  const commit = tx.commit.bind(tx);
  try {
    (tx as { commit: TransactionHandle["commit"] }).commit = async () => {
      const start = process.hrtime.bigint();
      const res = await commit();
      try {
        if (sent.length) {
          const sql = `/* transaction of ${sent.length} */ ${sent.map((s) => fingerprintSql(s.sql)).join("; ")}`;
          tracker.observe(sql, Number(process.hrtime.bigint() - start) / 1e6, sent.length, true);
        }
      } catch { /* timing must never break a commit */ }
      return res;
    };
  } catch { /* frozen handle: statements are still timed below */ }
  return new Proxy(tx, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      const fn = (v as (...a: unknown[]) => unknown).bind(target);
      if (prop === "query" || prop === "execute") {
        const run = timed(tracker, true, fn as Exec);
        return (stmts: Statement | Statement[], ...rest: unknown[]) => { sent.push(...asArray(stmts)); return run(stmts, ...rest); };
      }
      return fn;
    },
  });
}

const INSTRUMENTED = Symbol.for("better-starlite3.slowQuery");

/** `client` with every query/execute (transactions included) timed. Idempotent. */
export function instrumentClient(client: DatabaseClient, tracker: SlowQueryTracker): DatabaseClient {
  if (!tracker.enabled || (client as unknown as Record<symbol, unknown>)[INSTRUMENTED]) return client;
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === INSTRUMENTED) return true;
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      const fn = (v as (...a: unknown[]) => unknown).bind(target);
      if (prop === "query" || prop === "execute") return timed(tracker, false, fn as Exec);
      if (prop === "beginTransaction") return async () => wrapTx((await fn()) as TransactionHandle, tracker);
      if (prop === "transaction") {
        return (cb: (tx: TransactionHandle) => Promise<unknown>) => fn((tx: TransactionHandle) => cb(wrapTx(tx, tracker)));
      }
      return fn;
    },
  });
}

/** What open()/wrapBetterSQLite3() apply: env + options → tracker → instrumented client. */
export function withSlowQueryDetection(client: DatabaseClient, opts: SlowQueryOptions | false | undefined): DatabaseClient {
  if (opts === false) return client;
  const o = opts ?? {};
  const useSauromon = o.sauromon ?? true;
  const tracker = new SlowQueryTracker(resolveSlowQueryConfig(o), (event) => {
    if (o.onSlowQuery) { try { o.onSlowQuery(event); } catch { /* guarded */ } }
    if (useSauromon) sendToSauromon(event);
  }, client.driver);
  return instrumentClient(client, tracker);
}
