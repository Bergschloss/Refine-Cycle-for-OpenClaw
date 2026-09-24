import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { processSession, report, type Deps, type Llm } from "../src/pipeline.ts";
import { DEFAULTS, type Settings } from "../src/settings.ts";
import { FileStore } from "../src/store.ts";
import { activeLessons } from "../src/lessons.ts";
import { fingerprint } from "../src/core/fingerprint.ts";
import type { Source } from "../src/core/covered.ts";
import { FakeHistory, tempDir, Transcript } from "./helpers.ts";

const ERROR = "cron expression '* * *' has 3 fields, expected 5";
const FP = fingerprint("cron_add", ERROR);

function failing(times = 1): Transcript {
  const t = new Transcript().user("schedule the backup");
  for (let i = 0; i < times; i++) t.call("cron_add", { schedule: "* * *" }, { error: ERROR });
  return t.say("I could not schedule it.");
}

class ScriptedLlm implements Llm {
  calls: Array<{ system: string; user: string }> = [];
  replies: string[];
  constructor(...replies: string[]) {
    this.replies = replies;
  }
  async complete(system: string, user: string): Promise<string> {
    this.calls.push({ system, user });
    return this.replies.shift() ?? "";
  }
}

function lessonReply(lesson = "When scheduling with cron_add, give a five-field cron expression such as 0 3 * * *.", fp = FP): string {
  return "```json\n" + JSON.stringify({ decision: "lesson", fingerprint: fp, lesson, reason: "three-field expressions keep failing" }) + "\n```";
}

function deps(history: FakeHistory, llm: Llm | null, overrides: Partial<Settings> = {}, sources: Source[] = []): Deps & { logs: string[] } {
  const logs: string[] = [];
  const store = new FileStore(tempDir());
  store.open();
  return {
    store,
    history,
    llm,
    sources: () => sources,
    settings: { ...DEFAULTS, ...overrides },
    now: () => new Date("2026-09-24T10:00:00Z"),
    log: (message) => logs.push(message),
    logs,
  };
}

test("a failure repeated across two sessions becomes one active, traceable lesson", async () => {
  const history = new FakeHistory().add("s1", failing()).add("s2", failing());
  const llm = new ScriptedLlm(lessonReply());
  const d = deps(history, llm);
  // Backfill reads s2 too, so the failure already spans two sessions when s1 ends.
  const decision = await processSession(d, "s1", "main");
  assert.equal(decision.outcome, "lesson");
  const later = await processSession(d, "s2", "main");
  assert.equal(later.evaluated[0].refusal?.rule, "covered_by_lesson");
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].user, new RegExp(FP));
  const [lesson] = activeLessons(d.store);
  assert.equal(lesson.fingerprint, FP);
  assert.deepEqual(lesson.evidence.sessionIds.sort(), ["s1", "s2"]);
  assert.ok(lesson.evidence.eventIds.length > 0);
});

test("below the recurrence bar there is no model call", async () => {
  const llm = new ScriptedLlm(lessonReply());
  const d = deps(new FakeHistory().add("s1", failing(2)), llm);
  const decision = await processSession(d, "s1", "main");
  assert.equal(decision.outcome, "all_refused");
  assert.equal(decision.evaluated[0].refusal?.rule, "below_bar");
  assert.equal(llm.calls.length, 0);
});

test("five occurrences in one session clear the bar", async () => {
  const llm = new ScriptedLlm(lessonReply());
  const decision = await processSession(deps(new FakeHistory().add("s1", failing(5)), llm), "s1", "main");
  assert.equal(decision.outcome, "lesson");
});

test("a failure the agent corrected every time in this session is refused", async () => {
  const fixed = new Transcript().call("cron_add", { schedule: "* * *" }, { error: ERROR }).call("cron_add", { schedule: "0 3 * * *" }, { ok: "added" });
  const llm = new ScriptedLlm(lessonReply());
  const d = deps(new FakeHistory().add("s1", failing()).add("s2", fixed), llm);
  const decision = await processSession(d, "s2", "main");
  assert.equal(decision.evaluated[0].refusal?.rule, "self_corrected");
  assert.equal(llm.calls.length, 0);
});

test("transient failures and wrong-tool failures are not lesson-shaped", async () => {
  for (const [error, rule] of [
    ["request timed out after 30s", "not_lesson_shaped:transient"],
    ["HTTP 503 Service Unavailable for https://api.example.com", "not_lesson_shaped:transient"],
    ["Unknown tool id: say_hello. Use tool_search to find a tool", "not_lesson_shaped:wrong_tool"],
  ]) {
    const t = () => new Transcript().call("net", {}, { error });
    const llm = new ScriptedLlm(lessonReply());
    const d = deps(new FakeHistory().add("s1", t()).add("s2", t()), llm);
    await processSession(d, "s1", "main");
    const decision = await processSession(d, "s2", "main");
    assert.equal(decision.evaluated[0].refusal?.rule, rule, error);
    assert.equal(llm.calls.length, 0);
  }
});

test("a rule the agent's skills already state is refused before the model, with its location", async () => {
  const skill: Source = {
    name: "/ws/skills/cron/SKILL.md",
    text: "# Cron\n\nWhen calling cron_add, the cron expression must have 5 fields (minute hour day month weekday); 3 fields are rejected.\n",
  };
  const llm = new ScriptedLlm(lessonReply());
  const d = deps(new FakeHistory().add("s1", failing()).add("s2", failing()), llm, {}, [skill]);
  const decision = await processSession(d, "s2", "main");
  assert.equal(decision.evaluated[0].refusal?.rule, "already_covered");
  assert.equal(decision.evaluated[0].refusal?.covering?.source, skill.name);
  assert.equal(decision.evaluated[0].refusal?.covering?.line, 3);
  assert.equal(llm.calls.length, 0);
});

test("a lesson that restates a skill is refused after the model", async () => {
  const skill: Source = {
    name: "/ws/AGENTS.md",
    text: "Scheduling: give cron_add a five-field cron expression such as 0 3 * * * when scheduling.",
  };
  // The skill does not mention the error's words, so the pre-model check lets it through...
  const llm = new ScriptedLlm(lessonReply());
  const d = deps(new FakeHistory().add("s1", failing()).add("s2", failing()), llm, {}, [skill]);
  const decision = await processSession(d, "s2", "main");
  // ...and the proposed lesson says what it already says.
  assert.equal(decision.outcome, "refused_after_model");
  assert.equal(decision.refusal?.rule, "restatement");
  assert.equal(activeLessons(d.store).length, 0);
});

test("the model may answer nothing, and that is recorded, not retried", async () => {
  const llm = new ScriptedLlm(JSON.stringify({ decision: "nothing", fingerprint: FP, lesson: "", reason: "no clear fix" }));
  const d = deps(new FakeHistory().add("s1", failing(5)), llm);
  assert.equal((await processSession(d, "s1", "main")).outcome, "nothing");
  assert.equal((await processSession(d, "s1", "main")).outcome, "nothing");
  assert.equal(llm.calls.length, 1);
});

test("a lesson naming a fingerprint that was not observed is refused", async () => {
  const llm = new ScriptedLlm(lessonReply(undefined, "deadbeef0000"));
  const decision = await processSession(deps(new FakeHistory().add("s1", failing(5)), llm), "s1", "main");
  assert.equal(decision.refusal?.rule, "ungrounded");
});

test("too long, unparseable and duplicate lessons are refused", async () => {
  const long = await processSession(deps(new FakeHistory().add("s1", failing(5)), new ScriptedLlm(lessonReply("When x, " + "y".repeat(300)))), "s1", "main");
  assert.equal(long.refusal?.rule, "too_long");
  const garbage = await processSession(deps(new FakeHistory().add("s1", failing(5)), new ScriptedLlm("I think you should retry.")), "s1", "main");
  assert.equal(garbage.outcome, "invalid_reply");

  const d = deps(new FakeHistory().add("s1", failing(5)).add("s2", failing(5)), new ScriptedLlm(lessonReply(), lessonReply()));
  assert.equal((await processSession(d, "s1", "main")).outcome, "lesson");
  const second = await processSession(d, "s2", "main");
  assert.equal(second.evaluated[0].refusal?.rule, "covered_by_lesson");
});

test("the day budget is spent before the call and stops the fourth", async () => {
  const history = new FakeHistory();
  const replies: string[] = [];
  for (let i = 0; i < 4; i++) {
    const error = `widget ${"abcd"[i]} rejected: bad colour`;
    const t = new Transcript();
    for (let k = 0; k < 5; k++) t.call(`tool${i}`, {}, { error });
    history.add(`s${i}`, t);
    replies.push(JSON.stringify({ decision: "nothing", fingerprint: fingerprint(`tool${i}`, error), lesson: "", reason: "" }));
  }
  const llm = new ScriptedLlm(...replies);
  const d = deps(history, llm);
  const outcomes = [];
  for (let i = 0; i < 4; i++) outcomes.push((await processSession(d, `s${i}`, "main")).outcome);
  assert.deepEqual(outcomes, ["nothing", "nothing", "nothing", "all_refused"]);
  assert.equal(llm.calls.length, 3);
  const budget = JSON.parse(fs.readFileSync(path.join(d.store.root, "budget", "2026-09-24.json"), "utf8"));
  assert.equal(budget.calls.length, 3);
});

test("a model error spends the session's one call; learning off means no call", async () => {
  const failingLlm: Llm = { complete: async () => { throw new Error("provider down"); } };
  const d = deps(new FakeHistory().add("s1", failing(5)), failingLlm);
  assert.equal((await processSession(d, "s1", "main")).outcome, "model_error");
  assert.equal((await processSession(d, "s1", "main")).outcome, "model_error");

  const llm = new ScriptedLlm(lessonReply());
  const off = await processSession(deps(new FakeHistory().add("s1", failing(5)), llm, { learnEnabled: false }), "s1", "main");
  assert.equal(off.outcome, "learning_disabled");
  assert.equal(llm.calls.length, 0);
});

test("sessions from before the plugin ran are counted through backfill", async () => {
  const history = new FakeHistory().add("old", failing()).add("new", failing());
  const d = deps(history, new ScriptedLlm(lessonReply()));
  const decision = await processSession(d, "new", "main");
  assert.equal(decision.outcome, "lesson");
});

test("the report counts outcomes and refusals by rule", async () => {
  const history = new FakeHistory().add("s1", failing()).add("s2", failing()).add("s3", new Transcript().say("hi"));
  const d = deps(history, new ScriptedLlm(lessonReply()));
  for (const id of ["s1", "s2", "s3"]) await processSession(d, id, "main");
  const r = report(d.store);
  assert.equal(r.sessions, 3);
  assert.equal(r.sessionsWithFailures, 2);
  assert.equal(r.outcomes.lesson, 1);
  assert.equal(r.outcomes.no_failures, 1);
  assert.equal(r.modelCalls, 1);
  assert.equal(r.lessons.active, 1);
});
