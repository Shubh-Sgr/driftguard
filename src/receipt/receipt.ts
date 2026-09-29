import { createHash } from "node:crypto";
import { VERSION } from "../version.js";

/**
 * F12: a migration receipt — what was found, planned and verified, in one JSON file,
 * with a SHA-256 over its canonical form. It's tamper-EVIDENT, not a signature: if the
 * hash is stored somewhere else (a ticket, a PR comment), any later edit to the file is
 * detectable. It does not prove who produced it (that would need e.g. Ed25519 signing).
 */
export interface Receipt {
  receiptVersion: 1;
  tool: { name: "driftguard"; version: string };
  createdAt: string;
  /** Connection URLs with passwords removed. */
  databases: { source: string; target: string };
  /** Any JSON-serializable results: drift, locks, plan, verification, shadow. */
  results: Record<string, unknown>;
}

export interface SignedReceipt extends Receipt {
  integrity: { algorithm: "sha256"; hash: string };
}

/**
 * JSON with object keys sorted at every level and no whitespace. Two receipts with the
 * same content produce the same bytes (and so the same hash), whatever the key order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined) // JSON.stringify drops undefined too
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function createReceipt(databases: Receipt["databases"], results: Record<string, unknown>, now = new Date()): SignedReceipt {
  const receipt: Receipt = {
    receiptVersion: 1,
    tool: { name: "driftguard", version: VERSION },
    createdAt: now.toISOString(),
    databases,
    // Round-trip through JSON so the hash covers exactly what gets written to disk.
    results: JSON.parse(JSON.stringify(results)),
  };
  return { ...receipt, integrity: { algorithm: "sha256", hash: sha256(canonicalJson(receipt)) } };
}

/** Recomputes the hash over everything except the integrity block. */
export function verifyReceipt(signed: SignedReceipt): { valid: boolean; expected: string; actual: string } {
  const { integrity, ...receipt } = signed;
  const actual = sha256(canonicalJson(receipt));
  return { valid: actual === integrity?.hash, expected: integrity?.hash, actual };
}
