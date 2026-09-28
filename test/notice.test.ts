import { test } from "node:test";
import assert from "node:assert/strict";
import { lessonNotice } from "../src/core/notice.ts";

test("the lesson line says how much of the soft limit the lessons take, and in words near and past it", () => {
  assert.equal(lessonNotice(412, 4400), "♾️ Refine Cycle — new lesson learned (lessons 412/4400)");
  assert.equal(lessonNotice(3959, 4400), "♾️ Refine Cycle — new lesson learned (lessons 3959/4400)");
  assert.equal(lessonNotice(3960, 4400), "♾️ Refine Cycle — new lesson learned (lessons 3960/4400, getting tight)");
  assert.equal(lessonNotice(4400, 4400), "♾️ Refine Cycle — new lesson learned (lessons 4400/4400, getting tight)");
  assert.equal(lessonNotice(4401, 4400), "♾️ Refine Cycle — new lesson learned (lessons 4401/4400, over the soft limit)");
});
