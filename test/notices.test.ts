import { test } from "node:test";
import assert from "node:assert/strict";
import { FileStore } from "../src/store.ts";
import { dropNotice, handNotices, keepNotice, MAX_NOTICES, settleNotices, type NoticeBox } from "../src/notices.ts";
import { tempDir } from "./helpers.ts";

const T0 = new Date("2026-10-01T00:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const never = () => false;

function store(): FileStore {
  const s = new FileStore(tempDir());
  s.open();
  return s;
}
const box = (s: FileStore) => s.read<NoticeBox>("notices/main.json");

test("a kept notice is handed to the next run, and gone once that run replied", () => {
  const s = store();
  keepNotice(s, "main", "lesson a", "First.", at(0));
  assert.deepEqual(handNotices(s, "main", ["s1", "r1"], never, at(1)), ["First."]);
  assert.equal(settleNotices(s, "main", ["s1"], true), "passed", "the same run by any of its ids");
  assert.equal(box(s), undefined);
  assert.equal(handNotices(s, "main", ["s2"], never, at(2)), null);
});

test("a run that ended without a reply leaves its notices for the next one", () => {
  const s = store();
  keepNotice(s, "main", "lesson a", "First.", at(0));
  handNotices(s, "main", ["r1"], never, at(1));
  assert.equal(settleNotices(s, "main", ["r1"], false), "kept");
  assert.deepEqual(handNotices(s, "main", ["r2"], never, at(2)), ["First."]);
});

test("a notice that arrived while the run had the others stays for the next run", () => {
  const s = store();
  keepNotice(s, "main", "lesson a", "First.", at(0));
  handNotices(s, "main", ["r1"], never, at(1));
  keepNotice(s, "main", "tidy", "Second.", at(1)); // same instant as the hand-over
  assert.equal(settleNotices(s, "main", ["r1"], true), "passed");
  assert.deepEqual(box(s)!.notices.map((n) => n.sentence), ["Second."]);
});

test("a run still holding the notices keeps another run from being handed them too", () => {
  const s = store();
  keepNotice(s, "main", "lesson a", "First.", at(0));
  handNotices(s, "main", ["r1"], never, at(1));
  assert.equal(handNotices(s, "main", ["r2"], (holder) => holder.includes("r1"), at(2)), null, "r1 is still going");
  assert.deepEqual(handNotices(s, "main", ["r2"], never, at(3)), ["First."], "r1 is gone: r2 takes them");
  assert.equal(settleNotices(s, "main", ["r1"], true), null, "the hand-over moved to r2");
});

test("a record from before runIds is settled by its runKey alone", () => {
  const s = store();
  s.write("notices/main.json", { notices: [{ what: "a", sentence: "Old.", at: at(0).toISOString() }], handedTo: { runKey: "r-old", at: at(1).toISOString(), ids: [`a@${at(0).toISOString()}`] } });
  assert.equal(settleNotices(s, "main", ["s9", "r-old"], true), "passed");
  assert.equal(box(s), undefined);
});

test("one notice per subject, the newest; at most MAX_NOTICES wait; a run with no ids gets none", () => {
  const s = store();
  keepNotice(s, "main", "update 0.2.0", "Old wording.", at(0));
  keepNotice(s, "main", "update 0.2.0", "New wording.", at(1));
  assert.deepEqual(box(s)!.notices.map((n) => n.sentence), ["New wording."]);
  for (let i = 0; i < MAX_NOTICES + 3; i++) keepNotice(s, "main", `n${i}`, `N${i}.`, at(2 + i));
  assert.equal(box(s)!.notices.length, MAX_NOTICES);
  assert.equal(box(s)!.notices[0].sentence, "N3.");
  assert.equal(handNotices(s, "main", [], never, at(30)), null);
  assert.equal(settleNotices(s, "main", [], true), null);
});


test("dropNotice drops only that notice, and only when an earlier process kept it", () => {
  const s = store();
  keepNotice(s, "main", "restart 0.2.0", "Restart.", at(0));
  keepNotice(s, "main", "update 0.2.0", "Updated.", at(1));
  assert.equal(dropNotice(s, "main", "restart 0.2.0", at(0)), false, "kept at the start of this process, not before it");
  assert.equal(dropNotice(s, "main", "restart 0.1.0", at(10)), false, "another version");
  assert.equal(dropNotice(s, "main", "restart 0.2.0", at(10)), true);
  assert.deepEqual(box(s)?.notices.map((n) => n.what), ["update 0.2.0"]);
  assert.equal(dropNotice(s, "main", "update 0.2.0", at(10)), true);
  assert.equal(box(s), undefined, "an empty box is removed");
  assert.equal(dropNotice(s, "other", "restart 0.2.0", at(10)), false, "no box");
});
