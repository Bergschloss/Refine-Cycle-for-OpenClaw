import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict, type AuditInput } from "../src/core/audit.ts";

const base: AuditInput = { status: "active", ageDays: 20, windowOpen: true, shown: 4, cameBack: 0, recurrences: 0, unplaced: 0 };
const v = (over: Partial<AuditInput>) => verdict({ ...base, ...over }).verdict;

test("every verdict of the Hermes vocabulary that applies here, with its rule", () => {
  assert.equal(v({}), "working");
  assert.equal(v({ cameBack: 1, recurrences: 3 }), "did not help");
  assert.equal(v({ shown: 0 }), "unused");
  assert.equal(v({ shown: 0, ageDays: 13 }), "too early");
  assert.equal(v({ ageDays: 2 }), "too early", "shown, but not yet the 3-day horizon");
  assert.equal(v({ shown: 0, windowOpen: false }), "no recurrence window");
  assert.equal(v({ unplaced: 2 }), "unreliable");
  assert.equal(v({ status: "disabled", cameBack: 5 }), "disabled");
  assert.equal(v({ status: "deleted" }), "rolled back");
});

test("the thresholds are Hermes': 3 quiet days for working, 14 days for unused", () => {
  assert.equal(v({ ageDays: 3 }), "working");
  assert.equal(v({ ageDays: 2 }), "too early");
  assert.equal(v({ shown: 0, ageDays: 14 }), "unused");
  assert.equal(v({ shown: 0, ageDays: 13 }), "too early");
});

test("working needs 3 sessions that showed the lesson with no recurrence (owner decision D5), however old it is", () => {
  assert.equal(v({ shown: 1, ageDays: 60 }), "too early");
  assert.equal(v({ shown: 2, ageDays: 60 }), "too early");
  assert.match(verdict({ ...base, shown: 2 }).why, /shown in 2 of the 3 sessions a verdict needs/);
  assert.equal(v({ shown: 3, ageDays: 3 }), "working");
  // A recurrence in any of them is a verdict of its own, at any count.
  assert.equal(v({ shown: 2, cameBack: 1 }), "did not help");
  assert.equal(v({ shown: 3, cameBack: 1 }), "did not help");
});

test("a failure that came back outweighs time and unplaced failures; a withdrawn lesson is judged by its status", () => {
  assert.equal(v({ cameBack: 1, unplaced: 4, ageDays: 0 }), "did not help");
  assert.equal(v({ status: "deleted", cameBack: 1 }), "rolled back");
  assert.match(verdict({ ...base, cameBack: 2, shown: 5 }).why, /2 of 5 session/);
});
