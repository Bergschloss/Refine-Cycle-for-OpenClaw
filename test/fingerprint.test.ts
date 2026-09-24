import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fingerprint, normalizeError } from "../src/core/fingerprint.ts";

interface GoldenRow {
  tool: string;
  input: string;
  normalized: string;
  fingerprint: string;
}

// Recorded from the Python original (Hermes plugin v1.3.17, patterns.py): every
// input its test suite passes to the fingerprint code, plus Unicode edge cases.
// A fingerprint is a failure's identity, so the port must agree on every row.
const golden: GoldenRow[] = JSON.parse(
  readFileSync(new URL("./golden/fingerprint.json", import.meta.url), "utf8"),
);

test("the golden corpus is not empty", () => {
  assert.ok(golden.length > 300, `only ${golden.length} rows`);
});

test("normalizeError matches the Python original on every golden row", () => {
  const mismatches = golden
    .filter((row) => normalizeError(row.input) !== row.normalized)
    .map((row) => ({ input: row.input.slice(0, 200), want: row.normalized, got: normalizeError(row.input) }));
  assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} of ${golden.length} differ`);
});

test("fingerprint matches the Python original on every golden row", () => {
  const mismatches = golden.filter((row) => fingerprint(row.tool, row.input) !== row.fingerprint);
  assert.equal(mismatches.length, 0, `${mismatches.length} of ${golden.length} differ`);
});
