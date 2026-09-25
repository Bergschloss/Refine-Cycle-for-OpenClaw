import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { activate, activeLessons, allLessons, LessonExistsError, recover, setStatus } from "../src/lessons.ts";
import { FileStore, StoreError } from "../src/store.ts";
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

test("activation never overwrites an existing lesson; a leftover draft may be finished", () => {
  const root = tempDir();
  const store = new FileStore(root);
  store.open();
  activate(store, lesson(), NOW);
  setStatus(store, "abc123", "deleted", NOW);
  assert.throws(() => activate(store, lesson(), NOW), LessonExistsError);
  assert.equal(allLessons(store)[0].status, "deleted");

  const drafts = new FileStore(tempDir());
  drafts.open();
  drafts.write("lessons/abc123.json", { ...lesson(), status: "draft", changedAt: NOW.toISOString() });
  assert.equal(activate(drafts, lesson(), NOW).status, "active");
});

test("a deleted lesson stays deleted, and repeating a command changes nothing", () => {
  const store = new FileStore(tempDir());
  store.open();
  activate(store, lesson(), NOW);
  setStatus(store, "abc123", "deleted", NOW);
  const journalBefore = store.list("journal").length;
  assert.equal(setStatus(store, "abc123", "disabled", NOW)!.status, "deleted");
  assert.equal(setStatus(store, "abc123", "deleted", NOW)!.status, "deleted");
  assert.equal(store.list("journal").length, journalBefore, "no journal record for a no-op");
});

test("a lesson file missing a field the sort needs is skipped, not fatal", () => {
  const root = tempDir();
  const store = new FileStore(root);
  store.open();
  activate(store, lesson(), NOW);
  store.write("lessons/zz.json", { id: "zz", text: "When a, b.", fingerprint: "0123456789ab", status: "active" });
  assert.deepEqual(activeLessons(store).map((l) => l.id), ["abc123"]);
  assert.ok(formatBlock(activeLessons(store), 1000));
});

test("the store lock is exclusive across instances, and a stale one is taken over", () => {
  const root = tempDir();
  const one = new FileStore(root);
  const two = new FileStore(root);
  const release = one.lock("budget");
  assert.throws(() => two.lock("budget", 60), StoreError);
  release();
  two.lock("budget", 60)();
  fs.writeFileSync(path.join(root, "budget.lock"), "12345");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(root, "budget.lock"), old, old);
  two.lock("budget", 60)();
});

test("recovery waits for the next run when another process holds the lesson lock", () => {
  const root = tempDir();
  new FileStore(root).open();
  assert.throws(() => activate(crashingStore(root, 3), lesson(), NOW), Crash);
  const store = new FileStore(root);
  const release = store.lock("lessons");
  assert.deepEqual(recover(store, NOW), { finished: 0, abandoned: 0, unreadable: 0, skipped: true });
  release();
  assert.equal(recover(store, NOW).finished, 1);
  assert.equal(activeLessons(store).length, 1);
});

test("recovery does not undo a change the user made after the crash", () => {
  const root = tempDir();
  const store = new FileStore(root);
  store.open();
  activate(store, lesson(), NOW);
  // A disable crashed after its intent; then the user deleted the lesson.
  assert.throws(() => setStatus(crashingStore(root, 2), "abc123", "disabled", NOW), Crash);
  setStatus(store, "abc123", "deleted", new Date(NOW.getTime() + 60_000));
  recover(store, new Date(NOW.getTime() + 120_000));
  assert.equal(allLessons(store)[0].status, "deleted");
});

test("a stale lock that cannot be removed is 'busy' at once, never a spin", () => {
  const root = tempDir();
  const store = new FileStore(root);
  // A stale lock that cannot be removed (no permission on the folder, a file held open).
  const lock = path.join(root, "budget.lock");
  fs.writeFileSync(lock, "dead-owner");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (target: fs.PathLike) => {
    if (String(target) === lock) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    unlink(target);
  };
  const started = Date.now();
  try {
    assert.throws(() => store.lock("budget", 0), StoreError);
    assert.throws(() => store.lock("budget", 100), StoreError);
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.equal(fs.existsSync(`${lock}.takeover`), false);
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});

test("a stale lock is taken over, and a fresh lock that replaced it is never removed", () => {
  const dir = tempDir();
  const store = new FileStore(dir);
  const file = path.join(dir, "budget.lock");
  fs.writeFileSync(file, "dead-owner");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  const release = store.lock("budget", 0);
  assert.notEqual(fs.readFileSync(file, "utf8"), "dead-owner");
  assert.throws(() => store.lock("budget", 0), /store is locked/);
  release();
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".stale")), []);

  // Another waiter took the stale lock over and holds a fresh one before we get the guard.
  fs.writeFileSync(file, "dead-owner");
  fs.utimesSync(file, old, old);
  const open = fs.openSync;
  fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode) => {
    if (String(target).endsWith(".takeover")) {
      fs.openSync = open;
      fs.unlinkSync(file);
      fs.writeFileSync(file, "fresh-owner");
    }
    return open(target, flags);
  }) as typeof fs.openSync;
  try {
    assert.throws(() => store.lock("budget", 0), /store is locked/);
  } finally {
    fs.openSync = open;
  }
  assert.equal(fs.readFileSync(file, "utf8"), "fresh-owner");

  // A waiter mid-takeover holds the guard: nobody else removes the lock; a guard left
  // by a waiter that died is cleared.
  fs.unlinkSync(file);
  fs.writeFileSync(file, "dead-owner");
  fs.utimesSync(file, old, old);
  fs.writeFileSync(`${file}.takeover`, "");
  assert.throws(() => store.lock("budget", 0), /store is locked/);
  assert.equal(fs.readFileSync(file, "utf8"), "dead-owner");
  fs.utimesSync(`${file}.takeover`, old, old);
  store.lock("budget", 0)();
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith("budget.lock")), []);
});

test("closed journal records are pruned after a week, open ones never", () => {
  const root = tempDir();
  const store = new FileStore(root);
  const at = "2026-09-01T00:00:00.000Z";
  store.write("journal/old-applied.json", { id: "old-applied", op: "disable", lessonId: "x", state: "applied", at });
  store.write("journal/new-applied.json", { id: "new-applied", op: "disable", lessonId: "x", state: "applied", at: "2026-09-25T00:00:00.000Z" });
  store.write("journal/old-intent.json", { id: "old-intent", op: "disable", lessonId: "missing", state: "intent", at });
  recover(store, new Date("2026-09-26T00:00:00.000Z"));
  assert.deepEqual(store.list("journal").sort(), ["new-applied", "old-intent"]);
  assert.equal(store.read<{ state: string }>("journal/old-intent.json")!.state, "applied");
});

test("a closed journal record that cannot be removed never fails recovery or a disable", () => {
  const root = tempDir();
  const store = new FileStore(root);
  activate(store, lesson("l1"), new Date("2026-09-01T00:00:00.000Z"));
  const journal = path.join(root, "journal");
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (target: fs.PathLike) => {
    if (String(target).startsWith(journal)) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    unlink(target);
  };
  try {
    const now = new Date("2026-09-26T00:00:00.000Z");
    assert.doesNotThrow(() => recover(store, now));
    setStatus(store, "l1", "disabled", now);
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.equal(store.read<{ status: string }>("lessons/l1.json")!.status, "disabled");
});
