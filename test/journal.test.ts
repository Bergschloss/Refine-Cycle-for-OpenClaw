import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { activate, activeLessons, allLessons, recover, setStatus } from "../src/lessons.ts";
import { FileStore } from "../src/store.ts";
import { formatBlock } from "../src/core/injection.ts";
import { tempDir } from "./helpers.ts";

const NOW = new Date("2026-09-24T10:00:00Z");

function lesson(id = "abc123") {
  return {
    id,
    text: "When calling cron_add, give five fields.",
    fingerprint: "0123456789ab",
    tool: "cron_add",
    createdAt: NOW.toISOString(),
    sourceSessionId: "s1",
    evidence: { sessionIds: ["s1"], eventIds: ["ev-1"] },
    reason: "r",
  };
}

class Crash extends Error {}

/** A store that dies before its n-th write, like a killed process. */
function crashingStore(root: string, n: number): FileStore {
  let writes = 0;
  return new FileStore(root, {
    beforeWrite: () => {
      if (++writes === n) throw new Crash(`crash before write ${n}`);
    },
  });
}

test("activation writes intent, draft, active, mark — and a crash at any point recovers to one active lesson", () => {
  // activate() makes four writes; crash before each of them in turn.
  for (let n = 1; n <= 4; n++) {
    const root = tempDir();
    new FileStore(root).open();
    assert.throws(() => activate(crashingStore(root, n), lesson(), NOW), Crash);
    const store = new FileStore(root);
    store.open();
    const before = activeLessons(store);
    // Before recovery only a fully activated lesson may be injected.
    assert.ok(before.every((l) => l.status === "active"));
    recover(store, NOW);
    const after = activeLessons(store);
    if (n === 1) {
      assert.equal(after.length, 0, "nothing was written, nothing to recover");
    } else {
      assert.equal(after.length, 1, `crash before write ${n}`);
    }
    // The plugin keeps working: the next lesson activates normally.
    activate(store, lesson("def456"), NOW);
    assert.ok(activeLessons(store).some((l) => l.id === "def456"));
    // And every journal record is closed.
    for (const name of store.list("journal")) {
      assert.notEqual(store.read<{ state: string }>(`journal/${name}.json`)!.state, "intent");
    }
  }
});

test("a torn lesson or journal file is skipped, never fatal", () => {
  const root = tempDir();
  const store = new FileStore(root);
  store.open();
  activate(store, lesson(), NOW);
  fs.writeFileSync(path.join(root, "lessons", "torn.json"), '{"id": "torn", "text": "When');
  fs.writeFileSync(path.join(root, "journal", "torn.json"), "{");
  assert.equal(activeLessons(store).length, 1);
  assert.deepEqual(recover(store, NOW), { finished: 0, abandoned: 0, unreadable: 1 });
  assert.ok(formatBlock(activeLessons(store), 1000));
});

test("disable and delete go through the journal and survive a crash", () => {
  for (const status of ["disabled", "deleted"] as const) {
    const root = tempDir();
    const store = new FileStore(root);
    store.open();
    activate(store, lesson(), NOW);
    // setStatus makes three writes: intent, lesson, mark. Crash before the lesson write.
    assert.throws(() => setStatus(crashingStore(root, 2), "abc123", status, NOW), Crash);
    assert.equal(activeLessons(store).length, 1);
    recover(store, NOW);
    assert.equal(activeLessons(store).length, 0);
    assert.equal(allLessons(store)[0].status, status);
  }
});

test("an unreadable meta record makes the store refuse to open", () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, "meta.json"), "not json");
  assert.throws(() => new FileStore(root).open(), /unreadable/);
});
