import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { callsToday } from "../src/pipeline.ts";
import { FileStore } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

test("callsToday safely handles unreadable budget record returning 0 instead of throwing", () => {
  const root = tempDir();
  const store = new FileStore(root);
  fs.mkdirSync(path.join(root, "budget"), { recursive: true });
  fs.writeFileSync(path.join(root, "budget", "2026-09-24.json"), "{ unreadable");

  const now = new Date("2026-09-24T10:00:00Z");
  assert.equal(callsToday(store, now), 0);
});
