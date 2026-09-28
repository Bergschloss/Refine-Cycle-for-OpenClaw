import { test } from "node:test";
import assert from "node:assert/strict";
import { lessonNotice } from "../src/core/notice.ts";

test("the lesson line carries the block space in use, and says so when it is tight or full", () => {
  assert.equal(lessonNotice(412, 1000), "♾️ Refine Cycle — new lesson learned (lessons 412/1000)");
  assert.equal(lessonNotice(899, 1000), "♾️ Refine Cycle — new lesson learned (lessons 899/1000)");
  assert.equal(lessonNotice(900, 1000), "♾️ Refine Cycle — new lesson learned (lessons 900/1000, getting tight)");
  assert.equal(lessonNotice(980, 1000, true), "♾️ Refine Cycle — new lesson learned (lessons 980/1000, full)");
});
