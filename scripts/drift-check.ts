/**
 * Does a live OpenClaw still match what the tests assume?
 *
 * The unit tests fake the host with test/fixtures/openclaw-<version>.json. A fake
 * that drifted from the real host is how the Hermes plugin once shipped a broken
 * rollback, so this compares the fixture against a real agent database:
 *
 *   node --experimental-strip-types scripts/drift-check.ts <path to openclaw-agent.sqlite>
 *
 * The schema must match one of the recorded versions (test/fixtures/openclaw-*.json).
 *
 * Read-only. Prints what differs and exits 1 if anything does.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: drift-check.ts <openclaw-agent.sqlite>");
  process.exit(2);
}
const fixtureDir = new URL("../test/fixtures/", import.meta.url);
const fixtures = fs
  .readdirSync(fixtureDir)
  .filter((name) => /^openclaw-.*\.json$/.test(name))
  .sort()
  .map((name) => ({ name, ...JSON.parse(fs.readFileSync(new URL(name, fixtureDir), "utf8")) }));
/** The newest recorded version, for the row-shape comparison. */
const fixture = fixtures[fixtures.length - 1];
const db = new DatabaseSync(file, { readOnly: true });
const problems: string[] = [];

const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'transcript_events'").get() as { sql?: string } | undefined)?.sql;
if (!ddl) problems.push("table transcript_events is missing");
else {
  const known = fixtures.find((f) => f.transcriptEventsDdl === ddl);
  if (known) console.log(`schema matches ${known.name}`);
  else problems.push(`transcript_events schema matches no recorded version:\n${ddl}`);
}

function keysOf(value: unknown): string[] {
  return value && typeof value === "object" ? Object.keys(value).sort() : [];
}

function sample(role: string, extra = ""): Record<string, unknown> | null {
  const row = db
    .prepare(`SELECT event_json FROM transcript_events WHERE json_extract(event_json, '$.message.role') = ? ${extra} ORDER BY created_at DESC LIMIT 1`)
    .get(role) as { event_json?: string } | undefined;
  return row?.event_json ? JSON.parse(row.event_json) : null;
}

// Compressed rows (2026.9.6+) have no event_json; the plain ones are enough to compare shapes.
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
  if (typeof got.timestamp !== "number" && typeof (error as Record<string, unknown>).timestamp !== "string") {
    problems.push("toolResult has neither message.timestamp (ms) nor event.timestamp (ISO): the effect ledger cannot place failures in time");
  }
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
