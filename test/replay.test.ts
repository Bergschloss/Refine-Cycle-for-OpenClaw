import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readCorpus, replay } from "../src/replay.ts";
import { DEFAULTS } from "../src/settings.ts";
import { fingerprint } from "../src/core/fingerprint.ts";
import { summarizeSession } from "../src/core/failures.ts";
import type { Llm } from "../src/pipeline.ts";
import { tempDir, Transcript } from "./helpers.ts";

const ERROR = "cron expression '* * *' has 3 fields, expected 5";

test("replay runs the corpus in order, each session seeing only the ones before it", async () => {
  const dir = tempDir();
  const corpus = path.join(dir, "corpus.jsonl");
  const failing = () => new Transcript().user("go").call("cron_add", {}, { error: ERROR }).rows;
  const lines = [
    { sessionId: "a", rows: failing() },
    { sessionId: "b", rows: new Transcript().user("hi").say("hello").rows },
    { sessionId: "c", rows: failing() },
  ].map((s) => JSON.stringify(s));
  fs.writeFileSync(corpus, lines.join("\n") + "\n");
  const prompts: string[] = [];
  const llm: Llm = {
    complete: async (_system, user) => {
      prompts.push(user);
      return JSON.stringify({ decision: "lesson", fingerprint: fingerprint("cron_add", ERROR), lesson: "When calling cron_add, give five cron fields such as 0 3 * * *.", reason: "r" });
    },
  };
  const result = await replay({
    corpusFile: corpus,
    storeDir: path.join(dir, "store"),
    llm,
    sources: [],
    settings: { ...DEFAULTS, maxModelCallsPerDay: 1000 },
    log: () => {},
  });
  // "a" alone is below the bar (one session, one failure); by "c" it spans two.
  assert.equal(prompts.length, 1);
  assert.equal(result.sessions, 3);
  assert.equal(result.report.outcomes.all_refused, 1);
  assert.equal(result.report.outcomes.lesson, 1);
  assert.equal(result.lessons.length, 1);
  assert.equal(result.lessons[0].sourceSessionId, "c");
  assert.ok(fs.existsSync(path.join(dir, "store", "replay-result.json")));
});

test("the corpus is replayed in the order the sessions happened", () => {
  const file = path.join(tempDir(), "corpus.jsonl");
  const line = (sessionId: string, startedAt?: string | number) => JSON.stringify({ sessionId, startedAt, rows: [] });
  fs.writeFileSync(file, [line("late", 300), line("undated"), line("early", 100), line("iso", "1970-01-01T00:00:00.200Z")].join("\n"));
  assert.deepEqual(readCorpus(file).map((s) => s.sessionId), ["early", "iso", "late", "undated"]);
});

test("replay refuses a store directory that already holds a run", async () => {
  const dir = tempDir();
  const corpus = path.join(dir, "corpus.jsonl");
  fs.writeFileSync(corpus, "");
  fs.mkdirSync(path.join(dir, "store"));
  fs.writeFileSync(path.join(dir, "store", "meta.json"), "{}");
  await assert.rejects(
    replay({ corpusFile: corpus, storeDir: path.join(dir, "store"), llm: null, sources: [], settings: DEFAULTS, log: () => {} }),
    /empty store directory/,
  );
});


// K0.8: a corpus whose assistant messages carry the tool calls as the host writes them
// (`toolCall` parts with `arguments`, directly or through OpenClaw's `tool_call` wrapper).
test("replay reads toolCall arguments from the corpus exactly as the live path does: summary, evidence, self-correction", async () => {
  const dir = tempDir();
  const corpus = path.join(import.meta.dirname, "fixtures", "corpus-with-args.jsonl");
  const prompts: string[] = [];
  const shape = "invalid date '25/09/2026': expected YYYY-MM-DD";
  const llm: Llm = {
    complete: async (_system, user) => {
      prompts.push(user);
      return JSON.stringify({ decision: "lesson", fingerprint: fingerprint("send_report", shape), lesson: "When calling send_report, write the date as YYYY-MM-DD, e.g. 2026-09-25.", reason: "r" });
    },
  };
  const storeDir = path.join(dir, "store");
  const result = await replay({ corpusFile: corpus, storeDir, llm, sources: [], settings: { ...DEFAULTS, maxModelCallsPerDay: 1000 }, log: () => {} });
  for (const session of readCorpus(corpus)) {
    const stored = JSON.parse(fs.readFileSync(path.join(storeDir, "sessions", `${session.sessionId}.json`), "utf8"));
    // The same summary the gateway would write for these rows.
    const { $v: _v, ...live } = { ...summarizeSession(session.sessionId, "replay", session.rows), $v: 1 };
    const { $v: _w, ...replayed } = stored;
    assert.deepEqual(replayed, live);
    const [pattern] = stored.patterns;
    assert.equal(pattern.tool, "send_report");
    assert.equal(JSON.parse(pattern.sampleArgs).date, "25/09/2026", "the failing call's arguments");
    assert.equal(JSON.parse(pattern.correctionArgs).date, "2026-09-25", "the call that fixed it");
    assert.deepEqual(pattern.occurrences.map((o: { resolution: string }) => o.resolution), ["corrected"]);
  }
  // Corrected in each session, but in two sessions: sent to the model with the fix as evidence.
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /25\/09\/2026/);
  assert.match(prompts[0], /2026-09-25/);
  assert.equal(result.lessons.length, 1);
  assert.deepEqual(result.lessons[0].sessionIds, ["args-a", "args-b"]);
});


// K0.7: the raw record alone gives back every number of the report, without the plugin's code.
test("replay --raw writes a run line and one line per session, from which the report is recomputed exactly", async () => {
  const dir = tempDir();
  const corpus = path.join(dir, "corpus.jsonl");
  const cron = "cron expression '* * *' has 3 fields, expected 5";
  const date = "invalid date '25/09/2026': expected YYYY-MM-DD";
  const other = "unknown region 'mars'";
  const both = () => new Transcript().user("go").call("cron_add", {}, { error: cron }).call("send_report", {}, { error: date }).rows;
  const lines = [
    { sessionId: "a", startedAt: 1, rows: both() },
    { sessionId: "b", startedAt: 2, rows: new Transcript().user("hi").say("hello").rows },
    { sessionId: "c", startedAt: 3, rows: both() },
    // Only a failure below the bar of its own: its call goes to the queue (send_report, crowded out in "c").
    { sessionId: "d", startedAt: 4, rows: new Transcript().user("go").call("deploy", {}, { error: other }).rows },
  ].map((s) => JSON.stringify(s));
  fs.writeFileSync(corpus, lines.join("\n") + "\n");
  const long = (tool: string) => `When calling ${tool}, ${"check the argument format against the tool's schema first ".repeat(5)}.`;
  const llm: Llm = {
    complete: async (system, user) => {
      if (!user.includes("Fingerprint:")) return "When calling send_report, write the date as YYYY-MM-DD.";
      const fp = /Fingerprint: ([0-9a-f]+)/.exec(user)![1];
      const tool = fp === fingerprint("cron_add", cron) ? "cron_add" : "send_report";
      // send_report's lesson is too long: one shortening call.
      const lesson = tool === "cron_add" ? "When calling cron_add, give five cron fields such as 0 3 * * *." : long(tool);
      return JSON.stringify({ decision: "lesson", fingerprint: fp, lesson, reason: "r" });
    },
  };
  const rawFile = path.join(dir, "raw", "replay.jsonl");
  const result = await replay({
    corpusFile: corpus, storeDir: path.join(dir, "store"), llm, sources: [], settings: { ...DEFAULTS, maxModelCallsPerDay: 1000 },
    log: () => {}, rawFile, version: "9.9.9",
  });
  const raw = fs.readFileSync(rawFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(raw[0].kind, "run");
  assert.equal(raw[0].sessions, 4);
  assert.equal(raw[0].version, "9.9.9");
  const sessions = raw.filter((line) => line.kind === "session");
  assert.deepEqual(sessions.map((line) => line.sessionId), ["a", "b", "c", "d"]);
  assert.deepEqual(sessions.map((line) => line.corpusStartedAt), [1, 2, 3, 4]);

  // What Apodex does: the last line per session, and nothing else.
  const last = new Map<string, Record<string, any>>();
  for (const line of sessions) last.set(`${line.agentId}/${line.sessionId}`, line);
  const outcomes: Record<string, number> = {};
  const refusals: Record<string, number> = {};
  let modelCalls = 0;
  let queuedCalls = 0;
  let callsMade = 0;
  const active = new Set<string>();
  for (const line of last.values()) {
    outcomes[line.outcome] = (outcomes[line.outcome] ?? 0) + 1;
    for (const entry of line.evaluated) if (entry.rule) refusals[entry.rule] = (refusals[entry.rule] ?? 0) + 1;
    if (line.refusedAfterModel) refusals[`after_model:${line.refusedAfterModel}`] = (refusals[`after_model:${line.refusedAfterModel}`] ?? 0) + 1;
    if (line.called) modelCalls++;
    if (line.called && line.queue.used) queuedCalls++;
    callsMade += line.modelCalls.length;
    for (const lesson of line.activated) active.add(lesson.id);
  }
  const r = result.report;
  assert.equal(last.size, r.sessions);
  assert.equal([...last.values()].filter((line) => line.failures.length > 0).length, r.sessionsWithFailures);
  assert.deepEqual(outcomes, r.outcomes);
  assert.deepEqual(refusals, r.refusals);
  assert.equal(modelCalls, r.modelCalls);
  assert.equal(queuedCalls, r.queuedCalls);
  assert.equal(queuedCalls, 1, "d spent its call on the queue");
  assert.equal(active.size, r.lessons.active);
  assert.equal(active.size, 2);
  // Every model call is there, the shortening one included, with its size and its answer.
  assert.equal(callsMade, 3, "c: a proposal; d: a proposal and its shortening");
  const shortening = sessions.flatMap((line) => line.modelCalls).filter((call) => call.purpose === "shorten");
  assert.equal(shortening.length, 1);
  assert.ok(shortening[0].promptChars > 0 && shortening[0].replyChars > 0);
  const d = last.get("replay/d")!;
  assert.equal(d.queue.fingerprint, fingerprint("send_report", date));
  assert.equal(d.lesson.text, "When calling send_report, write the date as YYYY-MM-DD.");
  assert.equal(d.lesson.length, d.lesson.text.length);
  assert.deepEqual(d.shortening, { from: long("send_report").length, to: d.lesson.length });
  // A raw file that already holds a run is refused, like a used store.
  await assert.rejects(
    replay({ corpusFile: corpus, storeDir: path.join(dir, "store2"), llm, sources: [], settings: DEFAULTS, log: () => {}, rawFile }),
    /new or empty raw file/,
  );
});
