import { describe, expect, it } from "vitest";
import { canonicalJson, createReceipt, verifyReceipt } from "../../src/receipt/receipt.js";

describe("canonicalJson", () => {
  it("sorts keys at every level so key order never changes the hash", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("drops undefined values like JSON.stringify does", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("receipts (F12)", () => {
  const make = () => createReceipt({ source: "postgres://ro:***@a/db", target: "postgres://ro:***@b/db" }, { drift: { identical: true, items: [] } }, new Date("2026-01-01T00:00:00Z"));

  it("produces a deterministic hash for the same content", () => {
    expect(make().integrity.hash).toBe(make().integrity.hash);
    expect(make().integrity.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies an untouched receipt, including after a JSON round-trip", () => {
    expect(verifyReceipt(JSON.parse(JSON.stringify(make()))).valid).toBe(true);
  });

  it("detects any edit to the content", () => {
    const r = make();
    (r.results.drift as { identical: boolean }).identical = false;
    expect(verifyReceipt(r).valid).toBe(false);
  });
});
