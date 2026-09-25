import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readCorpus, replay } from "../src/replay.ts";
import { DEFAULTS } from "../src/settings.ts";
import { fingerprint } from "../src/core/fingerprint.ts";
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
