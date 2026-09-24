import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { sqliteHistory } from "../src/host/history.ts";
import { tempDir } from "./helpers.ts";

function fixture(version: string) {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/openclaw-${version}.json`, import.meta.url), "utf8"));
}

test("2026.9.6 schema: a zstd-compressed event is read like a plain one", () => {
  const f = fixture("2026.9.6");
  assert.match(f.transcriptEventsDdl, /event_zstd BLOB/);
  const file = path.join(tempDir(), "openclaw-agent.sqlite");
  const db = new DatabaseSync(file);
  // The recorded columns, without the host's foreign key and CHECK constraints.
  db.exec(`CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT,
    created_at INTEGER NOT NULL, event_zstd BLOB, event_utf8_bytes INTEGER, navigation_json TEXT,
    PRIMARY KEY (session_id, seq))`);
  const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?, ?, ?)");
  const call = JSON.stringify(f.codexToolCallEvent);
  const result = JSON.stringify(f.codexToolResultErrorEvent);
  insert.run("s1", 0, call, 1, null, null, null);
  insert.run("s1", 1, null, 2, zlib.zstdCompressSync(Buffer.from(result)), Buffer.byteLength(result), "{}");
  db.close();

  const rows = sqliteHistory(file).readSession("s1");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].event, f.codexToolResultErrorEvent);
  assert.deepEqual(sqliteHistory(file).recentSessions(5), [{ sessionId: "s1", lastSeq: 1 }]);
});

test("2026.9.5 schema: no event_zstd column, plain rows still read", () => {
  const f = fixture("2026.9.5");
  const file = path.join(tempDir(), "openclaw-agent.sqlite");
  const db = new DatabaseSync(file);
  db.exec(f.transcriptEventsDdl.replace(/,\s*FOREIGN KEY[^\n]*/, ""));
  db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run("s1", 0, JSON.stringify(f.toolResultErrorEvent), 1);
  db.close();
  assert.deepEqual(sqliteHistory(file).readSession("s1")[0].event, f.toolResultErrorEvent);
});
