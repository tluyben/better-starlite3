/**
 * Detects SQL patterns that are not supported by FlexDB and warns when using
 * SQLite drivers so code stays portable across all three drivers.
 */

const PRAGMA_RE = /^\s*PRAGMA\s/i;
// SQLite CLI dot-commands like .tables, .mode, .schema
const DOT_CMD_RE = /^\s*\.[a-z]/i;

export function warnIfUnsupported(sql: string, driver: string): void {
  if (PRAGMA_RE.test(sql)) {
    console.warn(
      `[better-starlite3] PRAGMA detected on driver "${driver}": ${sql.trim().slice(0, 80)}\n` +
      `  FlexDB does not support PRAGMA. better-sqlite3/best-sqlite3 open in WAL mode\n` +
      `  automatically, so most PRAGMAs are unnecessary. Remove for portability.`,
    );
    return;
  }
  if (DOT_CMD_RE.test(sql)) {
    console.warn(
      `[better-starlite3] SQLite CLI dot-command detected on driver "${driver}": ${sql.trim().slice(0, 80)}\n` +
      `  Dot-commands (.tables, .mode, etc.) are SQLite CLI-only and not valid SQL.\n` +
      `  FlexDB and programmatic drivers do not support them. Remove for portability.`,
    );
  }
}
