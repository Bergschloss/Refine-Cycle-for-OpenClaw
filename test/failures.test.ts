import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { aggregate, isSelfCorrectingError, missingParameters, summarizeSession } from "../src/core/failures.ts";
import { fingerprint } from "../src/core/fingerprint.ts";
import { Transcript } from "./helpers.ts";

test("a failure is identified by the real tool behind the tool_call wrapper", () => {
  const t = new Transcript().user("go").call("fs_read", { path: "/tmp/a.txt" }, { error: "ENOENT: no such file /tmp/a.txt" });
  const summary = summarizeSession("s1", "main", t.rows);
  assert.equal(summary.patterns.length, 1);
  assert.equal(summary.patterns[0].tool, "fs_read");
  assert.equal(summary.patterns[0].fingerprint, fingerprint("fs_read", "ENOENT: no such file /tmp/a.txt"));
  assert.equal(summary.patterns[0].occurrences[0].toolCallId, "call_0");
  assert.equal(summary.patterns[0].occurrences[0].eventId, "ev-2");
});

test("the same error with a different path is one pattern", () => {
  const t = new Transcript()
    .call("fs_read", { path: "/tmp/a.txt" }, { error: "ENOENT: no such file /tmp/a.txt" })
    .call("fs_read", { path: "/var/b.txt" }, { error: "ENOENT: no such file /var/b.txt" });
  const summary = summarizeSession("s1", "main", t.rows);
  assert.equal(summary.patterns.length, 1);
  assert.equal(summary.patterns[0].count, 2);
});

test("the whole session counts, not only the newest rows", () => {
  const t = new Transcript().call("db", {}, { error: "relation users does not exist" });
  for (let i = 0; i < 400; i++) t.user(`turn ${i}`).say("ok");
  t.call("db", {}, { error: "relation users does not exist" });
  assert.equal(summarizeSession("s1", "main", t.rows).patterns[0].count, 2);
});

test("what the agent did next is classified up to the next user message", () => {
  const t = new Transcript()
    .user("a").call("x", { q: 1 }, { error: "bad value 1" }).call("x", { q: 2 }, { ok: "fine" })
    .user("b").call("y", {}, { error: "boom" }).call("y", {}, { error: "boom" })
    .user("c").call("z", {}, { error: "nope" }).call("other", {}, { ok: "done" })
    .user("d").call("w", {}, { error: "stuck" }).user("never mind");
  const summary = summarizeSession("s1", "main", t.rows);
  const resolution = (tool: string) => summary.patterns.find((p) => p.tool === tool)!.occurrences[0].resolution;
  assert.equal(resolution("x"), "corrected");
  assert.equal(resolution("y"), "repeated");
  assert.equal(resolution("z"), "switched");
  assert.equal(resolution("w"), "unknown");
});

test("an error that states its own remedy is seen but never a candidate", () => {
  const t = new Transcript().call("tool_search", {}, { error: "query is required" });
  const summary = summarizeSession("s1", "main", t.rows);
  assert.equal(summary.patterns.length, 0);
  assert.equal(summary.selfCorrectingSuppressed, 1);
  assert.equal(summary.errorCount, 1);
});

test("a missing credential is not self-correcting (ported rule)", () => {
  assert.equal(isSelfCorrectingError("query is required"), true);
  assert.equal(isSelfCorrectingError("GITHUB_TOKEN is required"), false);
  assert.equal(isSelfCorrectingError("Authentication is required"), false);
  assert.equal(isSelfCorrectingError("x".repeat(60) + " query is required"), false);
});

test("dropping an argument the agent already used is recognised", () => {
  assert.deepEqual(missingParameters("Missing required parameter: 'schedule'"), ["schedule"]);
  const t = new Transcript()
    .call("cron_add", { schedule: "0 * * * *", command: "x" }, { ok: "added" })
    .call("cron_add", { command: "y" }, { error: "Missing required parameter: schedule" });
  assert.equal(summarizeSession("s1", "main", t.rows).patterns[0].droppedArgument, true);
  const fresh = new Transcript().call("cron_add", { command: "y" }, { error: "Missing required parameter: schedule" });
  assert.equal(summarizeSession("s1", "main", fresh.rows).patterns[0].droppedArgument, false);
});

test("aggregation counts sessions and occurrences, and a re-read session is not double-counted", () => {
  const one = summarizeSession("s1", "main", new Transcript().call("db", {}, { error: "locked" }).rows);
  const two = summarizeSession("s2", "main", new Transcript().call("db", {}, { error: "locked" }).call("db", {}, { error: "locked" }).rows);
  const merged = aggregate([one, two]).get(one.patterns[0].fingerprint)!;
  assert.equal(merged.count, 3);
  assert.deepEqual(merged.sessionIds, ["s1", "s2"]);
});

test("a Codex-runtime tool result (the ChatGPT-subscription route) is read too", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/openclaw-2026.9.5.json", import.meta.url), "utf8"));
  const rows = [
    { seq: 0, event: fixture.codexToolCallEvent },
    { seq: 1, event: fixture.codexToolResultErrorEvent },
  ];
  const summary = summarizeSession("s1", "main", rows);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.patterns[0].tool, "schedule_backup");
  assert.equal(summary.patterns[0].sample, "cron expression '0 3 *' has 3 fields, expected 5");
  assert.equal(summary.patterns[0].sampleArgs, '{"cron":"0 3 *"}');
  assert.deepEqual(summary.patterns[0].times, [1790214680414], "the host's own ms timestamp");
});

test("rows that are not messages, or malformed, are skipped", () => {
  const rows = [
    { seq: 0, event: { type: "session" } },
    { seq: 1, event: null },
    { seq: 2, event: { type: "message", message: { role: "toolResult", isError: true, content: "plain string error" } } },
  ];
  const summary = summarizeSession("s1", "main", rows);
  assert.equal(summary.patterns.length, 1);
  assert.equal(summary.lastSeq, 2);
});

test("a long error is bounded like the Hermes plugin: head 1000 and tail 3000 characters", () => {
  const error = (middle: string) => "E".repeat(1000) + middle.repeat(5000) + "T".repeat(3000);
  const t = new Transcript().call("x", {}, { error: error("a") }).call("x", {}, { error: error("b") });
  const summary = summarizeSession("s1", "main", t.rows);
  assert.equal(summary.patterns.length, 1, "differences outside head and tail do not split the pattern");
  assert.equal(summary.patterns[0].count, 2);
  assert.deepEqual(summary.patterns[0].seqs, [1, 3]);
});

test("an event with only an ISO timestamp is still placed in time", () => {
  const rows = [
    { seq: 0, event: { type: "message", id: "e", timestamp: "2026-09-22T00:45:48.690Z", message: { role: "toolResult", toolName: "x", isError: true, content: "boom" } } },
  ];
  assert.deepEqual(summarizeSession("s1", "main", rows).patterns[0].times, [Date.parse("2026-09-22T00:45:48.690Z")]);
});

test("a later success of a different shell command does not count as a correction", () => {
  const t = new Transcript()
    .call("Bash", { command: "python3 build.py" }, { error: "exit code 49" })
    .call("Bash", { command: "ls -la" }, { ok: "files" })
    .user("again")
    .call("Bash", { command: "python3 build.py" }, { error: "exit code 49" })
    .call("Bash", { command: "/usr/bin/python3 build.py --fixed" }, { ok: "built" });
  const [pattern] = summarizeSession("s1", "main", t.rows).patterns;
  assert.deepEqual(pattern.occurrences.map((o) => o.resolution), ["unknown", "corrected"]);
});
