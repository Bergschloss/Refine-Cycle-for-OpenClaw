import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBlock } from "../src/core/injection.ts";

test("the block is marked, bounded, and built from whole lessons only", () => {
  const lessons = [
    { id: "a", text: "When calling cron_add, give five fields." },
    { id: "b", text: "x".repeat(900) },
    { id: "c", text: "When a path has spaces, quote it." },
  ];
  const block = formatBlock(lessons, 1000)!;
  assert.ok(block.text.startsWith("<refine_cycle_lessons>\n"));
  assert.ok(block.text.endsWith("\n</refine_cycle_lessons>"));
  assert.match(block.text, /Refine Cycle plugin/);
  assert.deepEqual(block.lessonIds, ["a", "c"]);
  assert.ok(block.text.length <= 1000);
  assert.equal(block.hash.length, 16);
});

test("no lessons, or none that fit, means no block", () => {
  assert.equal(formatBlock([], 1000), null);
  assert.equal(formatBlock([{ id: "a", text: "y".repeat(2000) }], 1000), null);
});

test("the same lessons give the same block", () => {
  const lessons = [{ id: "a", text: "When x, do y." }];
  assert.equal(formatBlock(lessons, 1000)!.hash, formatBlock(lessons, 1000)!.hash);
});
