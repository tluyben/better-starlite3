/**
 * Tunables for the local SQLite drivers (better-sqlite3 / best-sqlite3).
 *
 * `synchronous` trades durability for speed. Under WAL, `NORMAL` is safe for
 * the vast majority of applications (a crash can lose the last commit only on
 * OS/hardware power-loss, never corrupt the DB) and is markedly faster, so it
 * is the DEFAULT. High-durability workloads — banking, ledgers, anything that
 * must survive power loss with zero committed-transaction loss — should use
 * `FULL`.
 *
 * Configure via the `BETTER_STARLITE_SYNCHRONOUS` env var: `OFF` | `NORMAL` |
 * `FULL` | `EXTRA`. When left unset we default to `NORMAL` and warn once, so the
 * durability posture is a conscious choice rather than a silent one.
 */

export type SynchronousMode = "OFF" | "NORMAL" | "FULL" | "EXTRA";

const VALID: SynchronousMode[] = ["OFF", "NORMAL", "FULL", "EXTRA"];

let warned = false;

/** Resolve the effective `synchronous` mode (env-configured, default NORMAL). */
export function resolveSynchronous(): SynchronousMode {
  const raw = process.env.BETTER_STARLITE_SYNCHRONOUS?.trim().toUpperCase();
  if (raw && (VALID as string[]).includes(raw)) {
    return raw as SynchronousMode;
  }
  if (raw && !warned) {
    warned = true;
    console.warn(
      `[better-starlite3] Ignoring invalid BETTER_STARLITE_SYNCHRONOUS="${process.env.BETTER_STARLITE_SYNCHRONOUS}". ` +
      `Valid values: ${VALID.join(", ")}. Falling back to NORMAL.`,
    );
  } else if (!raw && !warned) {
    warned = true;
    console.warn(
      "[better-starlite3] synchronous defaulting to NORMAL — fast, and crash-safe under WAL for typical apps " +
      "(only power-loss can drop the last commit; the DB is never corrupted). " +
      "High-durability workloads (banking/ledgers) should set BETTER_STARLITE_SYNCHRONOUS=FULL. " +
      "Set BETTER_STARLITE_SYNCHRONOUS explicitly to silence this warning.",
    );
  }
  return "NORMAL";
}
