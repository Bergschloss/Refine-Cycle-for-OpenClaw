import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import register, { type PluginApi } from "../src/plugin.ts";
import { FileStore } from "../src/store.ts";
import { activate } from "../src/lessons.ts";
import { fingerprint } from "../src/core/fingerprint.ts";
import { tempDir, Transcript } from "./helpers.ts";

type Handler = (event: unknown, ctx: Record<string, unknown>) => unknown;

function fakeApi(stateDir: string, complete?: (params: Record<string, unknown>) => Promise<{ text: string }>, grant = true) {
  const hooks = new Map<string, { handler: Handler; timeoutMs?: number }>();
  const commands = new Map<string, (ctx: { args?: string }) => unknown>();
  const logs: string[] = [];
  const api: PluginApi = {
    id: "refine-cycle",
    config: { plugins: { entries: { "refine-cycle": { hooks: { allowConversationAccess: grant } } } } },
    pluginConfig: {},
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
    runtime: { state: { resolveStateDir: () => stateDir }, llm: complete ? { complete } : {} },
    on: (hook, handler, options) => hooks.set(hook, { handler: handler as Handler, timeoutMs: options?.timeoutMs }),
    registerCommand: (command) => commands.set(command.name, command.handler),
  };
  register(api);
  return { hooks, commands, logs };
}

/** An agent database with the host's real transcript_events schema (OpenClaw 2026.9.5). */
function writeAgentDb(stateDir: string, sessions: Record<string, Transcript>): void {
  const dir = path.join(stateDir, "agents", "main", "agent");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/openclaw-2026.9.5.json", import.meta.url), "utf8"));
  // The foreign key points at a table this test does not create.
  db.exec(fixture.transcriptEventsDdl.replace(/,\s*FOREIGN KEY[^\n]*/, ""));
  const insert = db.prepare("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)");
  let clock = 1_790_000_000_000;
  for (const [sessionId, transcript] of Object.entries(sessions)) {
    for (const row of transcript.rows) insert.run(sessionId, row.seq, JSON.stringify(row.event), clock++);
  }
  db.close();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("the prompt hook injects active lessons with a short timeout, and nothing without them", () => {
  const stateDir = tempDir();
  const { hooks } = fakeApi(stateDir);
  const prompt = hooks.get("before_prompt_build")!;
  assert.ok(prompt.timeoutMs! <= 5000);
  assert.equal(prompt.handler({}, { sessionId: "s1" }), undefined);

  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  activate(store, {
    id: "l1", text: "When calling cron_add, give five fields.", fingerprint: "0123456789ab", tool: "cron_add",
    createdAt: new Date().toISOString(), sourceSessionId: "s0", evidence: { sessionIds: [], eventIds: [] }, reason: "",
  }, new Date());
  const result = prompt.handler({}, { sessionId: "s1" }) as { prependContext: string };
  assert.match(result.prependContext, /When calling cron_add, give five fields\./);
});

test("without the conversation-access grant the log says why nothing happens", () => {
  const withGrant = fakeApi(tempDir());
  assert.ok(!withGrant.logs.some((line) => line.includes("allowConversationAccess")));
  const without = fakeApi(tempDir(), undefined, false);
  assert.ok(without.logs.some((line) => line.startsWith("WARN") && line.includes("allowConversationAccess")));
});

test("an unusable store means no injection, no learning, and no thrown error", () => {
  const stateDir = tempDir();
  const root = path.join(stateDir, "plugin-data", "refine-cycle");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "meta.json"), "garbage");
  const { hooks, commands, logs } = fakeApi(stateDir);
  assert.equal(hooks.get("before_prompt_build")!.handler({}, { sessionId: "s1" }), undefined);
  assert.equal(hooks.get("agent_end")!.handler({}, { sessionId: "s1" }), undefined);
  assert.match(String((commands.get("refine")!({ args: "list" }) as { text: string }).text), /cannot use its store/);
  assert.ok(logs.some((line) => line.includes("store unusable")));
});

test("end to end on a real SQLite file: failures in two sessions become a lesson the next prompt carries", async () => {
  const stateDir = tempDir();
  const error = "cron expression '* * *' has 3 fields, expected 5";
  const failing = () => new Transcript().user("schedule it").call("cron_add", { schedule: "* * *" }, { error });
  writeAgentDb(stateDir, { s1: failing(), s2: failing() });
  const calls: Array<Record<string, unknown>> = [];
  const { hooks, commands } = fakeApi(stateDir, async (params) => {
    calls.push(params);
    return {
      text: JSON.stringify({
        decision: "lesson",
        fingerprint: fingerprint("cron_add", error),
        lesson: "When calling cron_add, write the schedule as five cron fields, e.g. 0 3 * * *.",
        reason: "three-field schedules failed twice",
      }),
    };
  });

  const agentEnd = hooks.get("agent_end")!.handler;
  assert.equal(agentEnd({ success: true, messages: [] }, { sessionId: "s1", agentId: "main" }), undefined);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, undefined, "naming the agent is an override OpenClaw refuses");
  assert.ok(calls[0].signal instanceof AbortSignal);

  const injected = hooks.get("before_prompt_build")!.handler({}, { sessionId: "s3" }) as { prependContext: string };
  assert.match(injected.prependContext, /five cron fields/);
  const listed = (commands.get("refine")!({ args: "list" }) as { text: string }).text;
  const id = listed.split(" ")[0];
  assert.match((commands.get("refine")!({ args: `disable ${id}` }) as { text: string }).text, /disabled/);
  assert.equal(hooks.get("before_prompt_build")!.handler({}, { sessionId: "s4" }), undefined);
});

test("the hook returns before the learning work runs", async () => {
  const stateDir = tempDir();
  writeAgentDb(stateDir, { s1: new Transcript().user("hi") });
  let started = false;
  const { hooks } = fakeApi(stateDir, async () => {
    started = true;
    return { text: "" };
  });
  const result = hooks.get("agent_end")!.handler({}, { sessionId: "s1" });
  assert.equal(result, undefined);
  assert.equal(started, false);
  await settle();
});
