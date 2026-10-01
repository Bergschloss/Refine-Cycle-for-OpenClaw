import { test } from "node:test";
import assert from "node:assert/strict";
import { Runs } from "../src/runs.ts";

function clock() {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("a run that started is in progress until an end that shares any of its ids", () => {
  const c = clock();
  const runs = new Runs(c.now);
  runs.started(["s1", "agent:main:main", "r1"]);
  assert.equal(runs.inProgress(60_000).running.length, 1);
  // The end carries only the session: still the same run.
  runs.ended(["s1"]);
  assert.equal(runs.inProgress(60_000).running.length, 0);
  runs.started(["s2", "r2"]);
  runs.ended(["r2"]);
  assert.equal(runs.inProgress(60_000).running.length, 0, "or only the run id");
});

test("a run with no ids is not counted, and an end that shares nothing ends nothing", () => {
  const c = clock();
  const runs = new Runs(c.now);
  runs.started([]);
  runs.started(["s1", "r1"]);
  runs.ended(["s9"]);
  assert.deepEqual(runs.inProgress(60_000).running.map((r) => r.ids), [["s1", "r1"]]);
});

test("a run that never ends stops counting after the bound, and is returned once as lost", () => {
  const c = clock();
  const runs = new Runs(c.now);
  runs.started(["lost"]);
  c.advance(30_000);
  runs.started(["fresh"]);
  c.advance(40_000);
  const first = runs.inProgress(60_000);
  assert.deepEqual(first.lost.map((r) => r.ids[0]), ["lost"]);
  assert.deepEqual(first.running.map((r) => r.ids[0]), ["fresh"]);
  assert.deepEqual(runs.inProgress(60_000).lost, [], "said once");
});

test("a run seen again starts its clock again, and at most max runs are kept, the oldest dropped", () => {
  const c = clock();
  const runs = new Runs(c.now, 3);
  runs.started(["a"]);
  c.advance(50_000);
  runs.started(["a"]);
  c.advance(20_000);
  assert.equal(runs.inProgress(60_000).running.length, 1, "not lost: seen 20 s ago");
  for (const id of ["b", "c", "d"]) runs.started([id]);
  assert.deepEqual(runs.inProgress(60_000).running.map((r) => r.ids[0]), ["b", "c", "d"]);
});
