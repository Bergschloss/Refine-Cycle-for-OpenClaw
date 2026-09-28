import { test } from "node:test";
import assert from "node:assert/strict";
import { lessonNotice, storeErrorText } from "../src/core/notice.ts";

test("the store error names the folder, the likely cause and the fix", () => {
  const root = "/srv/state/plugin-data/refine-cycle";
  const cases: Array<[string, RegExp, RegExp]> = [
    ["StoreError: cannot create /srv: Error: EACCES: permission denied, mkdir '/srv'", /permissions/, /write access/],
    ["Error: EPERM: operation not permitted, open 'meta.json'", /permissions/, /write access/],
    ["Error: ENOSPC: no space left on device, write", /disk .*is full/, /free space/],
    ["Error: EDQUOT: disk quota exceeded, write", /quota\) is full/, /free space/],
    ["Error: EROFS: read-only file system, open", /read-only file system/, /writable/],
    ["StoreError: store schema 99 is not 1", /another version/, /move the folder aside/],
    ["StoreError: something new", /cannot be created or read/, /read and write it/],
  ];
  for (const [error, cause, fix] of cases) {
    const text = storeErrorText(root, error);
    const lines = text.split("\n");
    assert.equal(lines[0], `Refine Cycle cannot use its store: ${error}`);
    assert.equal(lines[1], `folder: ${root}`);
    assert.match(lines[2], cause, error);
    assert.match(lines[3], fix, error);
    assert.match(lines[3], /restart the gateway/);
  }
});

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
