import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertParamsForSqlJs, convertParamsForBetterSqlite3 } from "../src/params.js";

describe("convertParamsForSqlJs", () => {
  it("converts ?1 ?2 to $p1 $p2", () => {
    const { sql, params } = convertParamsForSqlJs(
      "SELECT * FROM t WHERE a = ?1 AND b = ?2",
      ["hello", 42],
    );
    assert.equal(sql, "SELECT * FROM t WHERE a = $p1 AND b = $p2");
    assert.equal(params.$p1, "hello");
    assert.equal(params.$p2, 42);
  });

  it("handles empty params", () => {
    const { sql, params } = convertParamsForSqlJs("SELECT 1", []);
    assert.equal(sql, "SELECT 1");
    assert.deepEqual(params, {});
  });

  it("handles undefined params", () => {
    const { sql, params } = convertParamsForSqlJs("SELECT 1", undefined);
    assert.equal(sql, "SELECT 1");
    assert.deepEqual(params, {});
  });

  it("handles null values", () => {
    const { sql, params } = convertParamsForSqlJs("INSERT INTO t VALUES (?1)", [null]);
    assert.equal(params.$p1, null);
  });

  it("handles bare ? placeholders", () => {
    const { sql, params } = convertParamsForSqlJs("SELECT * FROM t WHERE x = ?", ["val"]);
    assert.equal(sql, "SELECT * FROM t WHERE x = $q1");
    assert.equal(params.$q1, "val");
  });
});

describe("convertParamsForBetterSqlite3", () => {
  it("converts ?1 ?2 to ? ? preserving order", () => {
    const { sql, params } = convertParamsForBetterSqlite3(
      "SELECT * FROM t WHERE a = ?1 AND b = ?2",
      ["hello", 42],
    );
    assert.equal(sql, "SELECT * FROM t WHERE a = ? AND b = ?");
    assert.deepEqual(params, ["hello", 42]);
  });

  it("handles empty params", () => {
    const { sql, params } = convertParamsForBetterSqlite3("SELECT 1", []);
    assert.equal(sql, "SELECT 1");
    assert.deepEqual(params, []);
  });

  it("handles undefined params", () => {
    const { sql, params } = convertParamsForBetterSqlite3("SELECT 1", undefined);
    assert.equal(sql, "SELECT 1");
    assert.deepEqual(params, []);
  });

  it("handles null values", () => {
    const { sql, params } = convertParamsForBetterSqlite3("INSERT INTO t VALUES (?1)", [null]);
    assert.equal(sql, "INSERT INTO t VALUES (?)");
    assert.equal(params[0], null);
  });

  it("reorders out-of-order params (?2 before ?1)", () => {
    const { sql, params } = convertParamsForBetterSqlite3(
      "SELECT * FROM t WHERE b = ?2 AND a = ?1",
      ["first", "second"],
    );
    assert.equal(sql, "SELECT * FROM t WHERE b = ? AND a = ?");
    assert.deepEqual(params, ["second", "first"]);
  });
});
