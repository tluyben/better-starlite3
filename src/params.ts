/**
 * FlexDB uses positional params like ?1, ?2, ?3.
 * better-sqlite3 accepts ?1, ?2 natively — no conversion needed.
 * best-sqlite3 (sql.js) uses $key named params — needs conversion.
 */

export function convertParamsForSqlJs(
  sql: string,
  params: (string | number | boolean | null)[] | undefined,
): { sql: string; params: Record<string, string | number | boolean | null> } {
  if (!params || params.length === 0) return { sql, params: {} };

  const named: Record<string, string | number | boolean | null> = {};
  // Replace ?1..?N with $p1..$pN
  const newSql = sql.replace(/\?(\d+)/g, (_, n) => {
    const idx = parseInt(n, 10);
    const key = `$p${idx}`;
    named[key] = params[idx - 1] ?? null;
    return key;
  });
  // Also handle bare ? (positional without index) — convert left-to-right
  let pos = 0;
  const finalSql = newSql.replace(/\?(?!\d)/g, () => {
    pos++;
    const key = `$q${pos}`;
    named[key] = params[pos - 1] ?? null;
    return key;
  });

  return { sql: finalSql, params: named };
}

/**
 * Convert FlexDB-style ?1/?2 numbered params to anonymous ? for better-sqlite3.
 * better-sqlite3 v12+ only accepts positional anonymous ? or named $key params;
 * numbered ?NNN params are rejected when passed as positional arguments.
 * Returns the rewritten SQL and the params array (order preserved).
 */
export function convertParamsForBetterSqlite3(
  sql: string,
  params: (string | number | boolean | null)[] | undefined,
): { sql: string; params: (string | number | boolean | null)[] } {
  if (!params || params.length === 0) return { sql, params: [] };

  // Replace ?N (numbered) with ?, preserving parameter order
  // Also handle bare ? which is already anonymous
  const reordered: (string | number | boolean | null)[] = [];
  const newSql = sql.replace(/\?(\d+)/g, (_, n) => {
    reordered.push(params[parseInt(n, 10) - 1] ?? null);
    return "?";
  });

  // If no numbered params were found, use original params with bare ?
  if (reordered.length === 0) {
    return { sql: newSql, params: params ?? [] };
  }
  return { sql: newSql, params: reordered };
}
