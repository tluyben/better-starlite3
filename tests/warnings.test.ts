import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { warnIfUnsupported } from "../src/warnings.js";

function captureWarn(fn: () => void): string[] {
  const msgs: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => msgs.push(String(args[0]));
  try { fn(); } finally { console.warn = orig; }
  return msgs;
}

describe("warnIfUnsupported", () => {
  it("warns on PRAGMA (uppercase)", () => {
    const w = captureWarn(() => warnIfUnsupported("PRAGMA journal_mode", "drv"));
    assert.ok(w.length > 0 && w[0].includes("PRAGMA"));
  });

  it("warns on PRAGMA (lowercase)", () => {
    const w = captureWarn(() => warnIfUnsupported("pragma cache_size = 2000", "drv"));
    assert.ok(w.length > 0 && w[0].includes("PRAGMA"));
  });

  it("warns on PRAGMA with leading whitespace", () => {
    const w = captureWarn(() => warnIfUnsupported("  PRAGMA synchronous = NORMAL", "drv"));
    assert.ok(w.length > 0);
  });

  it("warns on dot-commands", () => {
    const w = captureWarn(() => warnIfUnsupported(".tables", "drv"));
    assert.ok(w.length > 0 && w[0].includes("dot-command"));
  });

  it("warns on .schema dot-command", () => {
    const w = captureWarn(() => warnIfUnsupported(".schema users", "drv"));
    assert.ok(w.length > 0 && w[0].includes("dot-command"));
  });

  it("does not warn for normal SELECT", () => {
    const w = captureWarn(() => warnIfUnsupported("SELECT * FROM users", "drv"));
    assert.equal(w.length, 0);
  });

  it("does not warn for INSERT", () => {
    const w = captureWarn(() => warnIfUnsupported("INSERT INTO t VALUES (1)", "drv"));
    assert.equal(w.length, 0);
  });

  it("does not warn for UPDATE", () => {
    const w = captureWarn(() => warnIfUnsupported("UPDATE t SET x = 1 WHERE id = 1", "drv"));
    assert.equal(w.length, 0);
  });

  it("includes driver name in warning", () => {
    const w = captureWarn(() => warnIfUnsupported("PRAGMA page_size", "better-sqlite3"));
    assert.ok(w[0].includes("better-sqlite3"));
  });
});
