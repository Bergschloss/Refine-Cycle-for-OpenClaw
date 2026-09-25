import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import register, { type PluginApi } from "../src/plugin.ts";
import { FileStore } from "../src/store.ts";
import { activate } from "../src/lessons.ts";
import { fingerprint } from "../src/core/fingerprint.ts";
import { tempDir, Transcript } from "./helpers.ts";

type Handler = (event: unknown, ctx: Record<string, unknown>) => unknown;

function fakeApi(
  stateDir: string,
  complete?: (params: Record<string, unknown>) => Promise<{ text: string }>,
  grant = true,
  injection?: boolean,
  pluginConfig: Record<string, unknown> = {},
) {
  const hooks = new Map<string, { handler: Handler; timeoutMs?: number }>();
  const commands = new Map<string, (ctx: { args?: string; agentId?: string }) => unknown>();
  const logs: string[] = [];
  const api: PluginApi = {
    id: "refine-cycle",
    config: {
      plugins: { entries: { "refine-cycle": { hooks: { allowConversationAccess: grant, allowPromptInjection: injection } } } },
    },
    pluginConfig,
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

test("with prompt injection denied, nothing is injected or counted as shown, and the log says so", async () => {
  const stateDir = tempDir();
  writeAgentDb(stateDir, { s1: new Transcript().user("hi") });
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  store.open();
  activate(store, {
    id: "l1", text: "When calling cron_add, give five fields.", fingerprint: "0123456789ab", tool: "cron_add",
    createdAt: new Date().toISOString(), sourceSessionId: "s0", evidence: { sessionIds: [], eventIds: [] }, reason: "",
  }, new Date());
  const { hooks, logs } = fakeApi(stateDir, undefined, true, false);
  assert.equal(hooks.get("before_prompt_build")!.handler({}, { sessionId: "s1" }), undefined);
  hooks.get("agent_end")!.handler({}, { sessionId: "s1" });
  await settle();
  assert.equal(fs.existsSync(path.join(store.root, "effects", "s1.json")), false);
  assert.ok(logs.some((line) => line.startsWith("WARN") && line.includes("allowPromptInjection")));
});

test("/refine with no arguments lists the lessons", () => {
  const { commands } = fakeApi(tempDir());
  assert.equal((commands.get("refine")!({ args: "" }) as { text: string }).text, "No lessons yet.");
  assert.equal((commands.get("refine")!({}) as { text: string }).text, "No lessons yet.");
});

test("lessons of one agent are not injected into another agent's prompt", () => {
  const stateDir = tempDir();
  const { hooks } = fakeApi(stateDir);
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  activate(store, {
    id: "l2", text: "When calling deploy, pass the region.", fingerprint: "0123456789ac", tool: "deploy",
    createdAt: new Date().toISOString(), sourceSessionId: "s0", evidence: { sessionIds: [], eventIds: [] }, reason: "",
    agentId: "ops",
  }, new Date());
  const prompt = hooks.get("before_prompt_build")!.handler;
  assert.match((prompt({}, { sessionId: "a", agentId: "ops" }) as { prependContext: string }).prependContext, /pass the region/);
  assert.equal(prompt({}, { sessionId: "b", agentId: "main" }), undefined);
});

test("/refine in chat sees and changes only the calling agent's lessons", () => {
  const stateDir = tempDir();
  const { commands } = fakeApi(stateDir);
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  activate(store, {
    id: "l3", text: "When calling deploy, pass the region.", fingerprint: "0123456789ad", tool: "deploy",
    createdAt: new Date().toISOString(), sourceSessionId: "s0", evidence: { sessionIds: [], eventIds: [] }, reason: "",
    agentId: "ops",
  }, new Date());
  const refine = commands.get("refine")!;
  assert.equal((refine({ args: "list", agentId: "main" }) as { text: string }).text, "No lessons yet.");
  assert.equal((refine({ args: "delete l3", agentId: "main" }) as { text: string }).text, "No lesson l3.");
  assert.match((refine({ args: "list", agentId: "ops" }) as { text: string }).text, /l3 \[active\]/);
});

test("a model call the host never answers times out on the plugin's own clock", async () => {
  const stateDir = tempDir();
  const error = "cron expression '* * *' has 3 fields, expected 5";
  const failing = () => new Transcript().user("go").call("cron_add", { schedule: "* * *" }, { error });
  writeAgentDb(stateDir, { s1: failing(), s2: failing() });
  const { hooks } = fakeApi(stateDir, () => new Promise(() => {}), true, undefined, { proposalTimeoutMs: 50 });
  hooks.get("agent_end")!.handler({}, { sessionId: "s1", agentId: "main" });
  const candidate = path.join(stateDir, "plugin-data", "refine-cycle", "candidates", "s1.json");
  for (let i = 0; i < 100 && !(fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, "utf8")).outcome !== "pending"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const decision = JSON.parse(fs.readFileSync(candidate, "utf8"));
  assert.equal(decision.outcome, "model_error");
  assert.match(decision.reply, /timed out/);
});

test("learning survives the host closing the hook's async work scope (OpenClaw 2026.9.6)", async () => {
  // OpenClaw keeps the turn's work scope in this process-global slot and closes it
  // when agent_end returns; a model call made from a closed scope is refused.
  const slot = Symbol.for("openclaw.asyncWorkScope");
  const globals = globalThis as Record<PropertyKey, unknown>;
  const previous = globals[slot];
  const scopes = new AsyncLocalStorage<{ phase: string }>();
  globals[slot] = scopes;
  try {
    const stateDir = tempDir();
    const error = "cron expression '* * *' has 3 fields, expected 5";
    const failing = () => new Transcript().user("go").call("cron_add", { schedule: "* * *" }, { error });
    writeAgentDb(stateDir, { s1: failing(), s2: failing() });
    const { hooks } = fakeApi(stateDir, async () => {
      if (scopes.getStore()?.phase === "closed") throw new Error("Async work scope is closed");
      return {
        text: JSON.stringify({ decision: "lesson", fingerprint: fingerprint("cron_add", error), lesson: "When calling cron_add, give five cron fields such as 0 3 * * *.", reason: "r" }),
      };
    });
    const turn = { phase: "open" };
    scopes.run(turn, () => hooks.get("agent_end")!.handler({}, { sessionId: "s1", agentId: "main" }));
    turn.phase = "closed";
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const candidate = JSON.parse(fs.readFileSync(path.join(stateDir, "plugin-data", "refine-cycle", "candidates", "s1.json"), "utf8"));
    assert.equal(candidate.outcome, "lesson", candidate.reply);
  } finally {
    if (previous === undefined) delete globals[slot];
    else globals[slot] = previous;
  }
});

test("the cli-metadata registration pass touches neither the runtime nor the disk", () => {
  const stateDir = tempDir();
  // Where the plugin would fall back to if it went looking for a state directory.
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const runtime = new Proxy({}, { get() { throw new Error("runtime is intentionally unavailable"); } });
  const hooks: string[] = [];
  register({
    id: "refine-cycle",
    registrationMode: "cli-metadata",
    runtime: runtime as PluginApi["runtime"],
    on: (hook) => hooks.push(hook),
  });
  if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = previous;
  assert.deepEqual(hooks, []);
  assert.equal(fs.existsSync(path.join(stateDir, "plugin-data")), false);
});

test("a host whose model call throws synchronously leaves no timer and no unhandled rejection", async () => {
  const stateDir = tempDir();
  const error = "cron expression '* * *' has 3 fields, expected 5";
  const failing = () => new Transcript().user("go").call("cron_add", { schedule: "* * *" }, { error });
  writeAgentDb(stateDir, { s1: failing(), s2: failing() });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { hooks } = fakeApi(
      stateDir,
      () => {
        throw new Error("cannot override the target agent");
      },
      true,
      undefined,
      { proposalTimeoutMs: 50 },
    );
    hooks.get("agent_end")!.handler({}, { sessionId: "s1", agentId: "main" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const candidate = JSON.parse(fs.readFileSync(path.join(stateDir, "plugin-data", "refine-cycle", "candidates", "s1.json"), "utf8"));
    assert.equal(candidate.outcome, "model_error");
    assert.match(candidate.reply, /cannot override the target agent/);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
