import { test } from "node:test";
import assert from "node:assert/strict";
import { lessonNotice } from "../src/core/notice.ts";

test("the lesson line carries the block space in use, and says so when it is tight or over the soft limit", () => {
  assert.equal(lessonNotice(412, 4400), "♾️ Refine Cycle — new lesson learned (412/4400)");
  assert.equal(lessonNotice(3959, 4400), "♾️ Refine Cycle — new lesson learned (3959/4400)");
  assert.equal(lessonNotice(3960, 4400), "♾️ Refine Cycle — new lesson learned (3960/4400, getting tight)");
  assert.equal(lessonNotice(4400, 4400), "♾️ Refine Cycle — new lesson learned (4400/4400, getting tight)");
  assert.equal(
    lessonNotice(4401, 4400),
    "♾️ Refine Cycle — new lesson learned (4401/4400, over the soft limit: every turn now costs more tokens; /refine audit shows which lessons to turn off)",
  );
});
