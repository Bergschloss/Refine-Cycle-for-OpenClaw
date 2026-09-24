/**
 * Does a live OpenClaw still match what the tests assume?
 *
 * The unit tests fake the host with test/fixtures/openclaw-<version>.json. A fake
 * that drifted from the real host is how the Hermes plugin once shipped a broken
 * rollback, so this compares the fixture against a real agent database:
 *
 *   node --experimental-strip-types scripts/drift-check.ts <path to openclaw-agent.sqlite>
 *
 * Read-only. Prints what differs and exits 1 if anything does.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: drift-check.ts <openclaw-agent.sqlite> [fixture.json]");
  process.exit(2);
}
const fixturePath = process.argv[3] ?? new URL("../test/fixtures/openclaw-2026.9.5.json", import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const db = new DatabaseSync(file, { readOnly: true });
const problems: string[] = [];

const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'transcript_events'").get() as { sql?: string } | undefined)?.sql;
if (!ddl) problems.push("table transcript_events is missing");
else if (ddl !== fixture.transcriptEventsDdl) problems.push(`transcript_events schema changed:\n${ddl}`);

function keysOf(value: unknown): string[] {
  return value && typeof value === "object" ? Object.keys(value).sort() : [];
}

function sample(role: string, extra = ""): Record<string, unknown> | null {
  const row = db
    .prepare(`SELECT event_json FROM transcript_events WHERE json_extract(event_json, '$.message.role') = ? ${extra} ORDER BY created_at DESC LIMIT 1`)
    .get(role) as { event_json?: string } | undefined;
  return row?.event_json ? JSON.parse(row.event_json) : null;
}

const error = sample("toolResult", "AND json_extract(event_json, '$.message.isError') = 1");
if (!error) {
  problems.push("no failed tool result in this database to compare (run a session with a failing tool first)");
} else {
  const want = fixture.toolResultErrorEvent.message;
  const got = error.message as Record<string, unknown>;
  for (const key of ["role", "toolCallId", "toolName", "content", "isError"]) {
    if (!(key in got)) problems.push(`toolResult has no "${key}" (fixture keys: ${keysOf(want).join(", ")}; live: ${keysOf(got).join(", ")})`);
  }
  if (!Array.isArray(got.content)) problems.push("toolResult content is not an array of parts");
  if (got.isError !== true) problems.push("toolResult isError is not the boolean true");
}

const call = db
  .prepare("SELECT event_json FROM transcript_events WHERE event_json LIKE '%\"toolCall\"%' ORDER BY created_at DESC LIMIT 1")
  .get() as { event_json?: string } | undefined;
if (!call?.event_json) {
  problems.push("no assistant tool call in this database to compare");
} else {
  const parts = (JSON.parse(call.event_json).message?.content ?? []) as Array<Record<string, unknown>>;
  const part = parts.find((p) => p.type === "toolCall");
  for (const key of ["id", "name", "arguments"]) {
    if (!part || !(key in part)) problems.push(`assistant toolCall part has no "${key}"`);
  }
}

db.close();
if (problems.length) {
  console.log(`DRIFT (${problems.length}):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("no drift: schema and row shapes match the fixture");
