import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import register, { timing, type PluginApi } from "../src/plugin.ts";
import { FileStore } from "../src/store.ts";
import { activate, setStatus } from "../src/lessons.ts";
import { fingerprint } from "../src/core/fingerprint.ts";
import { tempDir, Transcript } from "./helpers.ts";

// An automatic update waits for a quiet gateway; here a few milliseconds, not ten minutes.
timing.quietMs = 5;

type Handler = (event: unknown, ctx: Record<string, unknown>) => unknown;

function fakeApi(
  stateDir: string,
  complete?: (params: Record<string, unknown>) => Promise<{ text: string }>,
  grant = true,
  injection?: boolean,
  pluginConfig: Record<string, unknown> = {},
  loadAdapter?: (id: string) => Promise<{ sendText?: (ctx: Record<string, unknown>) => Promise<unknown> } | undefined>,
) {
  const hooks = new Map<string, { handler: Handler; timeoutMs?: number }>();
  const commands = new Map<string, (ctx: { args?: string; agentId?: string; sessionKey?: string; [key: string]: unknown }) => unknown>();
  const logs: string[] = [];
  const api: PluginApi = {
    id: "refine-cycle",
    config: {
      plugins: { entries: { "refine-cycle": { hooks: { allowConversationAccess: grant, allowPromptInjection: injection } } } },
    },
    // Fixture sessions have fixed times and the clock is real: no pruning by age here.
    pluginConfig: { keepSessionDays: 0, ...pluginConfig },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
    runtime: {
      state: { resolveStateDir: () => stateDir },
      llm: complete ? { complete } : {},
      ...(loadAdapter ? { channel: { outbound: { loadAdapter } } } : {}),
    },
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

test("an unusable store means no injection, no learning, no thrown error, and the user told once through the agent", async () => {
  const stateDir = tempDir();
  const root = path.join(stateDir, "plugin-data", "refine-cycle");
  fs.mkdirSync(root, { recursive: true });
  // A store of another schema: not this version's to read.
  fs.writeFileSync(path.join(root, "meta.json"), JSON.stringify({ schema: 99, $v: 99 }));
  const { hooks, commands, logs } = fakeApi(stateDir);
  // No lessons; one notice, for the agent to pass on: the folder and the likely cause.
  const first = hooks.get("before_prompt_build")!.handler({}, { sessionId: "s1" }) as { prependContext: string };
  assert.match(first.prependContext, /^\[Refine Cycle notice\] .*Refine Cycle is switched off because it cannot use its folder .* \(the folder was written by another version of Refine Cycle\)/);
  assert.equal(hooks.get("before_prompt_build")!.handler({}, { sessionId: "s2" }), undefined, "once");
  assert.equal(hooks.get("agent_end")!.handler({}, { sessionId: "s1" }), undefined);
  const listed = String((await commands.get("refine")!({ args: "list" }) as { text: string }).text);
  assert.match(listed, /cannot use its store/);
  assert.ok(listed.includes(`folder: ${root}`));
  assert.match(listed, /likely cause: the folder was written by another version/);
  assert.ok(logs.some((line) => line.includes("store unusable") && line.includes("likely cause")));
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
  // No chat was known, so the lesson notice came with it, for the agent to pass on (once: s3 is still running).
  assert.match(injected.prependContext, /\[Refine Cycle notice\].*learned a new lesson/);
  const listed = (await commands.get("refine")!({ args: "list", agentId: "main" }) as { text: string }).text;
  const id = listed.split(" ")[0];
  assert.match((await commands.get("refine")!({ args: `disable ${id}`, agentId: "main" }) as { text: string }).text, /disabled/);
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

test("/refine with no arguments lists the lessons", async () => {
  const { commands } = fakeApi(tempDir());
  assert.equal((await commands.get("refine")!({ args: "", agentId: "main" }) as { text: string }).text, "No lessons yet.\nmodel calls today: 0/3");
  assert.equal((await commands.get("refine")!({ agentId: "main" }) as { text: string }).text, "No lessons yet.\nmodel calls today: 0/3");
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

test("/refine in chat sees and changes only the calling agent's lessons", async () => {
  const stateDir = tempDir();
  const { commands } = fakeApi(stateDir);
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  activate(store, {
    id: "l3", text: "When calling deploy, pass the region.", fingerprint: "0123456789ad", tool: "deploy",
    createdAt: new Date().toISOString(), sourceSessionId: "s0", evidence: { sessionIds: [], eventIds: [] }, reason: "",
    agentId: "ops",
  }, new Date());
  const refine = commands.get("refine")!;
  assert.equal((await refine({ args: "list", agentId: "main" }) as { text: string }).text, "No lessons yet.\nmodel calls today: 0/3");
  assert.equal((await refine({ args: "delete l3", agentId: "main" }) as { text: string }).text, "No lesson l3.");
  assert.match((await refine({ args: "list", agentId: "ops" }) as { text: string }).text, /l3 \[active\]/);
  // Without the host's agentId, the session key names the agent; with neither, nothing is guessed.
  assert.match((await refine({ args: "list", sessionKey: "agent:ops:telegram:direct:42" }) as { text: string }).text, /l3 \[active\]/);
  assert.match((await refine({ args: "delete l3" }) as { text: string }).text, /cannot tell which agent/);
  assert.match((await refine({ args: "list", sessionKey: "main" }) as { text: string }).text, /cannot tell which agent/);
  assert.equal(store.read<{ status: string }>("lessons/l3.json")!.status, "active");
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
    // Wait for the pass to record its outcome; a slow CI runner needs more than a fixed 200 ms.
    const file = path.join(stateDir, "plugin-data", "refine-cycle", "candidates", "s1.json");
    for (let waited = 0; !fs.existsSync(file) && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const candidate = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(candidate.outcome, "model_error");
    assert.match(candidate.reply, /cannot override the target agent/);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});


// -- K2 (2026-09-27): tests for mutations the suite let survive ----------------------

function seedLesson(stateDir: string, id: string, agentId: string): void {
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  store.open();
  activate(store, {
    id, text: `When calling cron_add for ${agentId}, give five fields.`, fingerprint: "0123456789ab", tool: "cron_add",
    createdAt: new Date().toISOString(), sourceSessionId: "s0", evidence: { sessionIds: [], eventIds: [] }, reason: "", agentId,
  }, new Date());
}

test("chat /refine takes the host's agentId over the one a session key names", async () => {
  const stateDir = tempDir();
  seedLesson(stateDir, "opslesson", "ops");
  seedLesson(stateDir, "mainlesson", "main");
  const { commands } = fakeApi(stateDir);
  const text = (await commands.get("refine")!({ args: "list", agentId: "ops", sessionKey: "agent:main:telegram:1" }) as { text: string }).text;
  assert.match(text, /opslesson/);
  assert.doesNotMatch(text, /mainlesson/);
});

test("chat /refine disable on a busy store answers at once instead of waiting", async () => {
  const stateDir = tempDir();
  seedLesson(stateDir, "busylesson", "main");
  const { commands } = fakeApi(stateDir);
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  const release = store.lock("lessons", 0);
  const started = Date.now();
  const text = (await commands.get("refine")!({ args: "disable busylesson", agentId: "main" }) as { text: string }).text;
  release();
  assert.ok(Date.now() - started < 1_000, `waited ${Date.now() - started} ms`);
  assert.match(text, /busy/);
});


// -- K6 (2026-09-27): the texts a person reads --------------------------------------

test("chat /refine report is written for a person, with the rule names kept", async () => {
  const stateDir = tempDir();
  seedLesson(stateDir, "reportlesson", "main");
  const { commands } = fakeApi(stateDir);
  const text = (await commands.get("refine")!({ args: "report", agentId: "main" }) as { text: string }).text;
  assert.match(text, /^Lessons: 1 active\./);
  assert.match(text, /Sessions read: 0, 0 with tool failures\. Model calls: 0\./);
  assert.throws(() => JSON.parse(text));
});

test("the command line lists every agent's lessons with their agent, reports JSON on request, and exits 1 on failure", async () => {
  const stateDir = tempDir();
  seedLesson(stateDir, "opslesson", "ops");
  const actions = new Map<string, (...args: unknown[]) => unknown>();
  const program = {
    command(spec: string) {
      const name = spec.split(" ")[0];
      const node = {
        command: (sub: string) => program.command(sub),
        description: () => node,
        option: () => node,
        action: (handler: (...args: unknown[]) => unknown) => {
          actions.set(name, handler);
          return node;
        },
      };
      return node;
    },
  };
  const api: PluginApi = {
    id: "refine-cycle",
    config: { plugins: { entries: { "refine-cycle": { hooks: { allowConversationAccess: true } } } } },
    runtime: { state: { resolveStateDir: () => stateDir } },
    logger: {},
    on: () => {},
    registerCli: (registrar) => registrar({ program: program as never }),
  };
  register(api);
  const printed: string[] = [];
  const log = console.log;
  const exitCode = process.exitCode;
  console.log = (line: string) => printed.push(line);
  try {
    await actions.get("list")!();
    assert.match(printed.at(-1)!, /^opslesson \[active\] \(agent ops\) When calling cron_add/);
    process.exitCode = undefined;
    await actions.get("disable")!("nope");
    assert.equal(printed.at(-1), "No lesson nope.");
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
    await actions.get("report")!({ json: true });
    assert.equal(JSON.parse(printed.at(-1)!).lessons.active, 1);
    await actions.get("audit")!({});
    assert.match(printed.at(-1)!, /opslesson \(ops\)/);
    await actions.get("status")!({});
    assert.match(printed.at(-1)!, /agent ops: lessons: 1 active/, "the command line shows every agent, by name");
    await actions.get("status")!({ json: true });
    assert.deepEqual(JSON.parse(printed.at(-1)!).agents.map((a: { agentId: string }) => a.agentId), ["ops"]);
    assert.equal(process.exitCode, undefined);
  } finally {
    console.log = log;
    process.exitCode = exitCode;
  }
});

function learningSetup(pluginConfig: Record<string, unknown> = {}, send?: (ctx: Record<string, unknown>) => Promise<unknown>) {
  const stateDir = tempDir();
  const error = "cron expression '* * *' has 3 fields, expected 5";
  const failing = () => new Transcript().user("schedule it").call("cron_add", { schedule: "* * *" }, { error });
  writeAgentDb(stateDir, { s1: failing(), s2: failing(), s3: failing() });
  const sent: Array<Record<string, unknown>> = [];
  const channels: string[] = [];
  const api = fakeApi(
    stateDir,
    async () => ({
      text: JSON.stringify({
        decision: "lesson",
        fingerprint: fingerprint("cron_add", error),
        lesson: "When calling cron_add, write the schedule as five cron fields, e.g. 0 3 * * *.",
        reason: "three-field schedules failed twice",
      }),
    }),
    true,
    undefined,
    pluginConfig,
    async (id) => {
      channels.push(id);
      return id === "telegram"
        ? {
            sendText: async (ctx) => {
              sent.push(ctx);
              return send ? send(ctx) : { ok: true };
            },
          }
        : undefined;
    },
  );
  return { ...api, stateDir, sent, channels };
}

const telegramTurn = (sessionId: string) => ({ sessionId, agentId: "main", channel: "telegram", accountId: "default", chatId: "4242" });

test("a new lesson is told in one line, once, in the chat the user is talking from", async () => {
  const { hooks, sent, channels } = learningSetup();
  const agentEnd = hooks.get("agent_end")!.handler;
  agentEnd({}, telegramTurn("s1"));
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual([...new Set(channels)], ["telegram"]);
  assert.equal(sent[0].to, "4242");
  assert.equal(sent[0].accountId, "default");
  assert.ok(sent[0].cfg, "the host config goes with the send");
  assert.match(String(sent[0].text), /^♾️ Refine Cycle — new lesson learned \(\d+\/4400\)$/);
  // Later turns, in the same or another chat, never repeat it.
  agentEnd({}, telegramTurn("s2"));
  agentEnd({}, { ...telegramTurn("s3"), chatId: "9999" });
  await settle();
  assert.equal(sent.length, 1);
});

test("a lesson learned with no chat on the turn and none known is kept for the agent, and the log says so", async () => {
  const { hooks, sent, logs } = learningSetup();
  const agentEnd = hooks.get("agent_end")!.handler;
  // A cron or command-line turn, no chat known yet: nothing sent; the agent passes it on in the next turn.
  agentEnd({}, { sessionId: "s1", agentId: "main" });
  await settle();
  assert.equal(sent.length, 0);
  assert.ok(logs.some((line) => line.includes("no chat a plugin can send to; the agent passes it on in its next reply")));
});

test("the last chat is remembered across turns and restarts", async () => {
  const stateDir = tempDir();
  const error = "cron expression '* * *' has 3 fields, expected 5";
  // Five failures in one session: over the bar without another session, so the chatty
  // turn (no backfill) has no queued failure to spend its call on.
  const failing = () => {
    const t = new Transcript().user("schedule it");
    for (let i = 0; i < 5; i++) t.call("cron_add", { schedule: "* * *" }, { error });
    return t;
  };
  writeAgentDb(stateDir, { chatty: new Transcript().user("hi"), s1: failing() });
  const sent: Array<Record<string, unknown>> = [];
  const loadAdapter = async (id: string) => (id === "telegram" ? { sendText: async (ctx: Record<string, unknown>) => void sent.push(ctx) } : undefined);
  const reply = async () => ({
    text: JSON.stringify({
      decision: "lesson",
      fingerprint: fingerprint("cron_add", error),
      lesson: "When calling cron_add, write the schedule as five cron fields, e.g. 0 3 * * *.",
      reason: "three-field schedules failed twice",
    }),
  });
  // A plain Telegram turn: nothing to learn, but the chat is remembered...
  fakeApi(stateDir, reply, true, undefined, { backfillSessions: 0 }, loadAdapter).hooks.get("agent_end")!.handler({}, telegramTurn("chatty"));
  await settle();
  assert.equal(sent.length, 0);
  // ...by a gateway started afresh, whose next turn comes from a cron job.
  fakeApi(stateDir, reply, true, undefined, { backfillSessions: 0 }, loadAdapter).hooks.get("agent_end")!.handler({}, { sessionId: "s1", agentId: "main" });
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "4242");
  assert.match(String(sent[0].text), /^♾️ Refine Cycle — new lesson learned \(\d+\/4400\)$/);
});

test("no message with the setting off, or on a channel that takes none", async () => {
  {
    const { hooks, sent } = learningSetup({ notifyOnLesson: false });
    hooks.get("agent_end")!.handler({}, telegramTurn("s1"));
    await settle();
    assert.equal(sent.length, 0);
  }
  {
    const { hooks, sent, logs } = learningSetup();
    hooks.get("agent_end")!.handler({}, { ...telegramTurn("s1"), channel: "webchat" });
    await settle();
    assert.equal(sent.length, 0);
    assert.ok(logs.some((line) => line.includes("the agent passes it on")));
  }
});

test("a message that cannot be delivered is logged, the lesson stays, and it is not retried", async () => {
  const { hooks, sent, logs, stateDir } = learningSetup({}, async () => {
    throw new Error("chat not found");
  });
  const agentEnd = hooks.get("agent_end")!.handler;
  agentEnd({}, telegramTurn("s1"));
  await settle();
  assert.equal(sent.length, 1);
  assert.ok(logs.some((line) => line.startsWith("WARN") && line.includes("chat not found")));
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  assert.equal(store.list("lessons").length, 1);
  agentEnd({}, telegramTurn("s2"));
  await settle();
  assert.equal(sent.length, 1);
});

test("chat /refine status shows the calling agent's state, and every blocker in words", async () => {
  const stateDir = tempDir();
  seedLesson(stateDir, "mainlesson", "main");
  seedLesson(stateDir, "opslesson", "ops");
  const complete = async () => ({ text: "{}" });
  {
    const { commands } = fakeApi(stateDir, complete);
    const text = (await commands.get("refine")!({ args: "status", agentId: "main", sessionId: "s9" } as never) as { text: string }).text;
    assert.match(text, /^♾️ Refine Cycle \d+\.\d+\.\d+ · working\n/);
    assert.match(text, /learning: on · injection: on/);
    assert.match(text, /model: .*the default agent's model/);
    assert.match(text, /model calls today: 0\/3 · this session has not had its call yet/);
    assert.match(text, /lessons: 1 active, 0 disabled, 0 deleted/);
    assert.match(text, /lessons block: \d+\/4400 characters/);
    assert.match(text, /queue: 0 failure\(s\) waiting/);
    assert.match(text, /journal: no unfinished changes/);
    assert.match(text, /blockers: none/);
    assert.equal(text.match(/lessons: \d+ active/g)!.length, 1, "chat sees only its own agent");
  }
  {
    // No grant, no model call, learning off: each one named.
    const { commands } = fakeApi(stateDir, undefined, false, false, { learnEnabled: false });
    const text = (await commands.get("refine")!({ args: "status", agentId: "main" }) as { text: string }).text;
    assert.match(text, /· not working/);
    assert.match(text, /learning: off · injection: off/);
    assert.match(text, /allowConversationAccess to true/);
    assert.match(text, /allowPromptInjection is false/);
    assert.match(text, /Learning is off in the settings/);
    assert.match(text, /no model call/);
  }
});

test("chat /refine audit judges only the calling agent's lessons; the command line judges all", async () => {
  const stateDir = tempDir();
  seedLesson(stateDir, "mainlesson", "main");
  seedLesson(stateDir, "opslesson", "ops");
  const { commands } = fakeApi(stateDir);
  const text = (await commands.get("refine")!({ args: "audit", agentId: "main" }) as { text: string }).text;
  assert.match(text, /^Refine Cycle lessons \(1\):/);
  assert.match(text, /mainlesson .* no recurrence window/);
  assert.doesNotMatch(text, /opslesson/);
});

// -- Passes started by hand: run, session, dry-run --

function passSetup(reply: (params: Record<string, unknown>) => Promise<{ text: string }>, send?: (ctx: Record<string, unknown>) => Promise<unknown>) {
  const stateDir = tempDir();
  const error = "cron expression '* * *' has 3 fields, expected 5";
  const failing = () => new Transcript().user("schedule it").call("cron_add", { schedule: "* * *" }, { error });
  writeAgentDb(stateDir, { s1: failing(), s2: failing() });
  const sent: Array<Record<string, unknown>> = [];
  const api = fakeApi(stateDir, reply, true, undefined, { backfillSessions: 10 }, async (id) =>
    id === "telegram" ? { sendText: send ?? (async (ctx) => void sent.push(ctx)) } : undefined,
  );
  const lessonText = "When calling cron_add, write the schedule as five cron fields, e.g. 0 3 * * *.";
  const fp = fingerprint("cron_add", error);
  return { stateDir, sent, ...api, lessonText, fp };
}

const lessonJson = (fp: string, lesson: string) => JSON.stringify({ decision: "lesson", fingerprint: fp, lesson, reason: "twice" });

test("/refine session <id> runs the pass on that session and answers with what it decided", async () => {
  let prompt = "";
  const error = "cron expression '* * *' has 3 fields, expected 5";
  const { commands } = passSetup(async (params) => {
    prompt = JSON.stringify(params);
    return { text: lessonJson(fingerprint("cron_add", error), "When calling cron_add, write the schedule as five cron fields, e.g. 0 3 * * *.") };
  });
  const refine = commands.get("refine")!;
  const text = (await refine({ args: "session s1 the <b>cron</b> schedules", agentId: "main" }) as { text: string }).text;
  assert.match(text, /pass over session s1:\nfailure: cron_add \(\w{12}\), 2× in 2 session\(s\)\nlesson learned: When calling cron_add/);
  assert.match(prompt, /asked to focus on: <untrusted_tool_result>the ‹b›cron‹\/b› schedules<\/untrusted_tool_result>/, "the reason is the user's words, as data");
  assert.match((await refine({ args: "list", agentId: "main" }) as { text: string }).text, /\[active\]/);
  // The same session again: its one call is spent.
  assert.match((await refine({ args: "session s1", agentId: "main" }) as { text: string }).text, /this session already had its model call \(a lesson learned\); a session gets one/);
});

test("/refine run needs the chat's session, session <id> an existing one, and each says so", async () => {
  const { commands } = passSetup(async () => ({ text: "{}" }));
  const refine = commands.get("refine")!;
  assert.match((await refine({ args: "run", agentId: "main" }) as { text: string }).text, /no session the host names; use `\/refine session <id>`/);
  assert.equal((await refine({ args: "session nope", agentId: "main" }) as { text: string }).text, "No session nope for agent main.");
  assert.equal((await refine({ args: "session", agentId: "main" }) as { text: string }).text, "Usage: session <id> [reason]");
  assert.match((await refine({ args: "run focus on cron", agentId: "main", sessionId: "s2" } as never) as { text: string }).text, /pass over session s2/);
});

test("/refine dry-run shows the lesson it would save, saves none, and spends the call like any pass", async () => {
  const setup = passSetup(async () => ({ text: lessonJson(fingerprint("cron_add", "cron expression '* * *' has 3 fields, expected 5"), "When calling cron_add, write the schedule as five cron fields, e.g. 0 3 * * *.") }));
  const refine = setup.commands.get("refine")!;
  const text = (await refine({ args: "dry-run session s1", agentId: "main" }) as { text: string }).text;
  assert.match(text, /^🔍 Dry run — nothing saved\.\nsession: s1\nfailure: cron_add .*\nlesson: When calling cron_add, write the schedule as five cron fields, e\.g\. 0 3 \* \* \*\.\nwould be saved: yes$/);
  assert.equal((await refine({ args: "list", agentId: "main" }) as { text: string }).text, "No lessons yet.\nmodel calls today: 1/3");
  const store = new FileStore(path.join(setup.stateDir, "plugin-data", "refine-cycle"));
  assert.equal(store.read<{ outcome: string }>("candidates/s1.json")!.outcome, "dry_run");
  assert.equal(store.list("budget").length, 1);
  // A dry run's lesson was not saved, so the failure is still open for a real pass.
  assert.match((await refine({ args: "session s2", agentId: "main" }) as { text: string }).text, /lesson learned/);
});

test("a chat pass the model is slow on answers at once and sends the result to the chat when done", async () => {
  const saved = timing.chatWaitMs;
  timing.chatWaitMs = 20;
  try {
    let answer: (value: { text: string }) => void = () => {};
    let called = false;
    const setup = passSetup(() => new Promise((resolve) => ((called = true), (answer = resolve))));
    // The chat the agent is talked to from, as the lesson message uses it.
    new FileStore(path.join(setup.stateDir, "plugin-data", "refine-cycle")).write("chats/main.json", { channel: "telegram", to: "4242" });
    const text = (await setup.commands.get("refine")!({ args: "session s1", agentId: "main" }) as { text: string }).text;
    assert.equal(text, "Pass over session s1 started; the result follows in your telegram chat when the model has answered.");
    for (let i = 0; i < 50 && !called; i++) await settle();
    answer({ text: lessonJson(setup.fp, setup.lessonText) });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    assert.ok(setup.sent.some((m) => /pass over session s1:[\s\S]*lesson learned/.test(String(m.text)) && m.to === "4242"), JSON.stringify(setup.sent));
  } finally {
    timing.chatWaitMs = saved;
  }
});

test("the command line runs session and dry-run on an exact session, finding its agent, and refuses run without one", async () => {
  const stateDir = tempDir();
  const error = "cron expression '* * *' has 3 fields, expected 5";
  writeAgentDb(stateDir, { s1: new Transcript().user("go").call("cron_add", { schedule: "* * *" }, { error }).call("cron_add", { schedule: "* * *" }, { error }).call("cron_add", { schedule: "* * *" }, { error }).call("cron_add", { schedule: "* * *" }, { error }).call("cron_add", { schedule: "* * *" }, { error }) });
  new FileStore(path.join(stateDir, "plugin-data", "refine-cycle")).write("sessions/seed.json", { format: 0, sessionId: "seed", agentId: "main", lastSeq: 0, errorCount: 0, selfCorrectingSuppressed: 0, patterns: [] });
  const actions = new Map<string, (...args: unknown[]) => unknown>();
  const program = {
    command(spec: string) {
      const name = spec.split(" ")[0];
      const node = { command: (sub: string) => program.command(sub), description: () => node, option: () => node, action: (handler: (...args: unknown[]) => unknown) => (actions.set(name, handler), node) };
      return node;
    },
  };
  register({
    id: "refine-cycle",
    config: { plugins: { entries: { "refine-cycle": { hooks: { allowConversationAccess: true } } } } },
    runtime: { state: { resolveStateDir: () => stateDir }, llm: { complete: async () => ({ text: JSON.stringify({ decision: "nothing", fingerprint: fingerprint("cron_add", error), lesson: "", reason: "" }) }) } },
    logger: {},
    on: () => {},
    registerCli: (registrar) => registrar({ program: program as never }),
  });
  const printed: string[] = [];
  const log = console.log;
  const exitCode = process.exitCode;
  console.log = (line: string) => printed.push(line);
  try {
    await actions.get("dry-run")!(["session", "s1", "look", "at", "cron"]);
    assert.match(printed.at(-1)!, /^🔍 Dry run — nothing saved\.\nsession: s1\nfailure: cron_add .*\nthe model found nothing to learn$/);
    await actions.get("session")!("s1", []);
    assert.match(printed.at(-1)!, /already had its model call/);
    process.exitCode = undefined;
    await actions.get("run")!([]);
    assert.match(printed.at(-1)!, /The command line has no current session/);
    assert.equal(process.exitCode, 1);
    await actions.get("session")!("nope", []);
    assert.equal(printed.at(-1), "No session nope.");
  } finally {
    console.log = log;
    process.exitCode = exitCode;
  }
});

// -- The refine_run tool --

function toolSetup(reply: (params: Record<string, unknown>) => Promise<{ text: string }>) {
  const stateDir = tempDir();
  const error = "cron expression '* * *' has 3 fields, expected 5";
  const failing = () => new Transcript().user("schedule it").call("cron_add", { schedule: "* * *" }, { error });
  writeAgentDb(stateDir, { s1: failing(), s2: failing() });
  const tools: Array<{ factory: (ctx: Record<string, unknown>) => unknown; options?: { name?: string; optional?: boolean } }> = [];
  const logs: string[] = [];
  const api: PluginApi = {
    id: "refine-cycle",
    config: { plugins: { entries: { "refine-cycle": { hooks: { allowConversationAccess: true } } } } },
    runtime: { state: { resolveStateDir: () => stateDir }, llm: { complete: reply } },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
    on: () => {},
    registerTool: (factory, options) => tools.push({ factory: factory as never, ...(options ? { options } : {}) }),
    registerCommand: () => {},
  };
  register(api);
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  type Tool = { name: string; execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };
  return { tools, logs, store, error, tool: (ctx: Record<string, unknown>) => tools[0].factory(ctx) as Tool };
}

test("refine_run is an optional tool that answers at once and runs the pass in the background", async () => {
  let answer: ((value: { text: string }) => void) | undefined;
  const setup = toolSetup(() => new Promise((resolve) => (answer = resolve)));
  assert.equal(setup.tools.length, 1);
  assert.deepEqual(setup.tools[0].options, { name: "refine_run", optional: true });
  const tool = setup.tool({ agentId: "main", sessionId: "s1" });
  assert.equal(tool.name, "refine_run");
  // The model has not answered, and the tool has already returned: the agent's turn goes on.
  const result = await tool.execute("call-1", { reason: "cron schedules" });
  assert.deepEqual(result.details, { started: true, session: "s1", dryRun: false });
  assert.match(result.content[0].text, /started in the background/);
  assert.equal(setup.store.list("lessons").length, 0);
  for (let i = 0; i < 50 && !answer; i++) await settle();
  assert.ok(answer, "the pass reached the model after the tool had returned");
  answer!({ text: JSON.stringify({ decision: "lesson", fingerprint: fingerprint("cron_add", setup.error), lesson: "When calling cron_add, write the schedule as five cron fields, e.g. 0 3 * * *.", reason: "r" }) });
  await settle();
  assert.equal(setup.store.list("lessons").length, 1);
  assert.ok(setup.logs.some((line) => line.includes("refine_run over s1: lesson")));
});

test("refine_run keeps the budget and the rules, and refuses bad arguments and unknown sessions", async () => {
  const calls: unknown[] = [];
  const setup = toolSetup(async (params) => {
    calls.push(params);
    return { text: JSON.stringify({ decision: "nothing", fingerprint: fingerprint("cron_add", setup.error), lesson: "", reason: "" }) };
  });
  const tool = setup.tool({ agentId: "main", sessionId: "s1" });
  await assert.rejects(tool.execute("c", { dry_run: "yes" }), /dry_run must be a boolean/);
  await assert.rejects(tool.execute("c", { reason: 3 }), /reason must be a string/);
  await assert.rejects(tool.execute("c", { session_id: "nope" }), /No session nope for agent main/);
  await assert.rejects(setup.tool({ agentId: "main" }).execute("c", {}), /pass session_id/);
  await tool.execute("c", { dry_run: true });
  await settle();
  await tool.execute("c", {});
  await settle();
  assert.equal(calls.length, 1, "one call for the session, dry run or not");
  assert.ok(setup.logs.some((line) => line.includes("refine_run over s1: already had its call (nothing)")));
});

// -- Update available and /refine update --

interface HostFake {
  source: "git" | "path" | "clawhub";
  installed: string;
  /** What `plugins update <id> --dry-run` prints, for a ClawHub install. */
  dryRun?: string;
  tags: string;
  /** What `plugins update <id>` does: the version it lands on, or a failure. */
  update: { to: string } | { code: number; stderr: string };
  runs: string[][];
  /** Exit code of `git ls-remote`: non-zero is a check without network. */
  gitCode?: number;
  /** When set, `plugins update <id>` waits for it: a slow update. */
  slow?: Promise<unknown>;
  /** OpenClaw runs as a service the host can restart (`gateway status --json`: service.loaded). */
  service?: boolean;
}

function updateSetup(host: HostFake, adapter?: Record<string, unknown>, pluginConfig: Record<string, unknown> = {}) {
  const stateDir = tempDir();
  writeAgentDb(stateDir, { s1: new Transcript().user("hi").say("hello"), s2: new Transcript().user("hi").say("hello") });
  const sent: Array<Record<string, unknown>> = [];
  const commands = new Map<string, (ctx: Record<string, unknown>) => unknown>();
  const hooks = new Map<string, Handler>();
  const logs: string[] = [];
  const runCommandWithTimeout = async (argv: string[]) => {
    host.runs.push(argv);
    if (argv[0] === "git") {
      return host.gitCode ? { stdout: "", stderr: "fatal: unable to access: Could not resolve host: github.com\n", code: host.gitCode } : { stdout: host.tags, stderr: "", code: 0 };
    }
    const args = argv.slice(2);
    if (args[0] === "gateway" && args[1] === "status") return { stdout: JSON.stringify({ service: { loaded: host.service === true } }), stderr: "", code: 0 };
    if (args[0] === "gateway" && args[1] === "restart") return host.service ? { stdout: "{}", stderr: "", code: 0 } : { stdout: "", stderr: "Gateway service not loaded.", code: 1 };
    if (args[1] === "inspect") {
      const install = host.source === "git" ? { source: "git", version: host.installed, gitUrl: "file:///repo", gitCommit: `c-${host.installed}` } : host.source === "clawhub" ? { source: "clawhub", version: host.installed } : undefined;
      return { stdout: `[plugins] noise\n${JSON.stringify({ plugin: { version: host.installed, source: "/x/dist/plugin.js" }, ...(install ? { install } : {}) })}`, stderr: "", code: 0 };
    }
    if (args[1] === "update" && args.includes("--dry-run")) return { stdout: host.dryRun ?? "", stderr: "", code: 0 };
    if (args[1] === "update") {
      await host.slow;
      if ("code" in host.update) return { stdout: "", stderr: host.update.stderr, code: host.update.code };
      const from = host.installed;
      if (from === host.update.to) return { stdout: `refine-cycle already at ${from}.\n`, stderr: "", code: 0 };
      host.installed = host.update.to;
      return { stdout: `Updated refine-cycle: ${from} -> ${host.update.to}.\n`, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "unexpected", code: 2 };
  };
  const api: PluginApi = {
    id: "refine-cycle",
    config: { plugins: { entries: { "refine-cycle": { hooks: { allowConversationAccess: true } } } } },
    // Fixture sessions have fixed times and the clock is real: no pruning by age here.
    // The notice with the button unless a test asks for the automatic update (autoUpdate, on by default).
    pluginConfig: { keepSessionDays: 0, autoUpdate: false, ...pluginConfig },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
    runtime: {
      state: { resolveStateDir: () => stateDir },
      system: { runCommandWithTimeout },
      channel: { outbound: { loadAdapter: async (id: string) => (id === "telegram" ? (adapter ?? { sendPayload: async (ctx: Record<string, unknown>) => void sent.push(ctx) }) : undefined) } },
    },
    on: (hook, handler) => hooks.set(hook, handler as Handler),
    registerCommand: (command) => commands.set(command.name, command.handler as never),
  };
  register(api);
  /** A turn from Telegram (true), from no chat (false), or with this context (a webchat turn, say). */
  const turn = async (sessionId: string, chat: boolean | Record<string, unknown> = true) => {
    const ctx = typeof chat === "object" ? { sessionId, agentId: "main", ...chat } : chat ? { sessionId, agentId: "main", channel: "telegram", chatId: "4242" } : { sessionId, agentId: "main" };
    hooks.get("agent_end")!({ success: true }, ctx);
    for (let i = 0; i < 10; i++) await settle();
    // An automatic update waits for a quiet gateway (timing.quietMs, short in these tests).
    await new Promise((resolve) => setTimeout(resolve, timing.quietMs * 4));
    for (let i = 0; i < 10; i++) await settle();
  };
  /** The prompt hook for a run, and what it put in front of the agent. */
  const prompt = (ctx: Record<string, unknown>) => (hooks.get("before_prompt_build")!({}, ctx) as { prependContext?: string } | undefined)?.prependContext ?? "";
  const end = (ctx: Record<string, unknown>, success = true) => hooks.get("agent_end")!({ success }, ctx);
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  return { sent, commands, logs, turn, prompt, end, store, host };
}

const gitHost = (over: Partial<HostFake> = {}): HostFake => ({
  source: "git", installed: "0.1.0", tags: "a\trefs/tags/v0.1.0\nb\trefs/tags/v0.2.0\n", update: { to: "0.2.0" }, runs: [], service: true, ...over,
});

test("a newer release is announced once, with an Update button that runs /refine update", async () => {
  const setup = updateSetup(gitHost());
  await setup.turn("s1");
  assert.equal(setup.sent.length, 1);
  assert.equal(setup.sent[0].text, "♾️ Refine Cycle — update available: 0.2.0");
  assert.equal(setup.sent[0].to, "4242");
  assert.deepEqual((setup.sent[0].payload as { presentation: unknown }).presentation, {
    blocks: [{ type: "buttons", buttons: [{ label: "Update", action: { type: "command", command: "/refine update" } }] }],
  });
  assert.ok(setup.host.runs.some((argv) => argv.join(" ") === "git ls-remote --tags --refs file:///repo"), "tags only: no code is fetched");
  // The next turn, the same day: no second check and no second message.
  const runs = setup.host.runs.length;
  await setup.turn("s2");
  assert.equal(setup.sent.length, 1);
  assert.equal(setup.host.runs.length, runs);
});

test("a ClawHub install reads the host's dry run, and an answer it cannot read is a failed check, not 'up to date'", async () => {
  const found = updateSetup(gitHost({ source: "clawhub", dryRun: "Would update refine-cycle: 0.1.0 -> 0.3.0.\n" }));
  await found.turn("s1");
  assert.equal(found.sent[0]?.text, "♾️ Refine Cycle — update available: 0.3.0");
  const current = updateSetup(gitHost({ source: "clawhub", dryRun: "refine-cycle already at 0.1.0.\n" }));
  await current.turn("s1");
  assert.equal(current.sent.length, 0);
  assert.equal(current.store.read<{ ok: boolean }>("update/state.json")!.ok, true);
  const changed = updateSetup(gitHost({ source: "clawhub", dryRun: "Checked 1 plugin.\n" }));
  await changed.turn("s1");
  assert.equal(changed.sent.length, 0);
  assert.equal(changed.store.read<{ ok: boolean }>("update/state.json")!.ok, false);
  assert.ok(changed.logs.some((line) => /could not read the host's answer/.test(line)));
});

test("a version already announced is not announced again after the day's next check", async () => {
  const setup = updateSetup(gitHost());
  await setup.turn("s1");
  const state = setup.store.read<{ checkedAt: string }>("update/state.json")!;
  setup.store.write("update/state.json", { ...state, checkedAt: "2026-01-01T00:00:00Z" });
  await setup.turn("s2");
  assert.equal(setup.sent.length, 1);
  assert.equal(setup.store.read<{ checkedAt: string }>("update/state.json")!.checkedAt > "2026-09-01", true, "it did check again");
});

test("a failed check is logged, not shown, and tried again after an hour", async () => {
  const setup = updateSetup(gitHost({ gitCode: 128 }));
  await setup.turn("s1");
  assert.equal(setup.sent.length, 0);
  assert.equal(setup.store.read<{ ok: boolean }>("update/state.json")!.ok, false);
  assert.ok(setup.logs.some((line) => line.startsWith("WARN") && line.includes("update check failed, next try in an hour") && /could not resolve host/i.test(line)));
  // The network is back, but within the hour nothing is tried.
  setup.host.gitCode = 0;
  const runs = setup.host.runs.length;
  await setup.turn("s2");
  assert.equal(setup.host.runs.length, runs);
  assert.equal(setup.sent.length, 0);
  // An hour later it is.
  const state = setup.store.read<Record<string, unknown>>("update/state.json")!;
  setup.store.write("update/state.json", { ...state, checkedAt: new Date(Date.now() - 61 * 60e3).toISOString() });
  await setup.turn("s1");
  assert.equal(setup.sent.length, 1);
});
test("with no chat on the turn, the update notice goes through the agent, and is not sent again later", async () => {
  const setup = updateSetup(gitHost());
  await setup.turn("s1", false);
  assert.equal(setup.sent.length, 0);
  assert.ok(setup.logs.some((line) => line.includes("update 0.2.0: no chat a plugin can send to")));
  assert.match(setup.prompt({ sessionId: "s2", agentId: "main", runId: "r2", trigger: "user" }), /0\.2\.0 is available/);
  await setup.turn("s2", true);
  assert.equal(setup.sent.length, 0, "once: it already went through the agent");
});

test("a channel without buttons gets the command to type instead", async () => {
  const texts: string[] = [];
  const payloads: unknown[] = [];
  const setup = updateSetup(gitHost(), {
    sendText: async (ctx: Record<string, unknown>) => void texts.push(String(ctx.text)),
    sendPayload: async (ctx: Record<string, unknown>) => void payloads.push(ctx),
    presentationCapabilities: { buttons: false },
  });
  await setup.turn("s1");
  assert.deepEqual(texts, ["♾️ Refine Cycle — update available: 0.2.0\n`/refine update` — installs it."]);
  assert.equal(payloads.length, 0, "no buttons where the channel says it has none");
});

test("/refine update updates through the host and says to which version; up to date; refused for others", async () => {
  const setup = updateSetup(gitHost());
  const refine = setup.commands.get("refine")!;
  assert.equal((await refine({ args: "update", agentId: "main", isAuthorizedSender: false }) as { text: string }).text, "Only an authorized sender may update Refine Cycle.");
  assert.equal((await refine({ args: "update", agentId: "main", isAuthorizedSender: true }) as { text: string }).text, "♾️ Refine Cycle updated to 0.2.0. OpenClaw restarts to finish it once no conversation is running.");
  assert.ok(setup.host.runs.some((argv) => argv.slice(2).join(" ") === "plugins update refine-cycle"), "the host's own update, same entry point");
  setup.host.update = { to: "0.2.0" };
  const again = (await refine({ args: "update", agentId: "main" }) as { text: string }).text;
  assert.equal(again, "♾️ Refine Cycle is up to date.");
});

test("a failed update says why in one line and the installed version stays", async () => {
  const setup = updateSetup(gitHost({ update: { code: 1, stderr: "Cloning…\nError: git clone failed: could not resolve host github.com\n" } }));
  const text = (await setup.commands.get("refine")!({ args: "update", agentId: "main" }) as { text: string }).text;
  assert.equal(text, "♾️ Refine Cycle update failed. Error: git clone failed: could not resolve host github.com");
  assert.equal(setup.host.installed, "0.1.0");
});

test("a plugin loaded from a path is not updated, and says so", async () => {
  const setup = updateSetup(gitHost({ source: "path" }));
  const text = (await setup.commands.get("refine")!({ args: "update", agentId: "main" }) as { text: string }).text;
  assert.match(text, /^♾️ Refine Cycle update failed\. It is loaded from a path \(\/x\/dist\/plugin\.js\), not installed/);
  assert.ok(!setup.host.runs.some((argv) => argv.includes("update")));
  await setup.turn("s1");
  assert.equal(setup.sent.length, 0, "nothing to announce for a path install");
});

test("/refine status starts a due update check, and the next status shows a newer release", async () => {
  const setup = updateSetup(gitHost());
  const refine = setup.commands.get("refine")!;
  assert.doesNotMatch((await refine({ args: "status", agentId: "main" }) as { text: string }).text, /is available/);
  for (let i = 0; i < 10; i++) await settle();
  const text = (await refine({ args: "status", agentId: "main" }) as { text: string }).text;
  assert.match(text, /warnings:\n  ⚠ Refine Cycle 0\.2\.0 is available \(installed 0\.1\.0\): `\/refine update`/);
  assert.equal(setup.sent.length, 0, "status itself sends nothing");
});

// -- /refine model --

function modelSetup(allowModelOverride: boolean | undefined, pluginConfig: Record<string, unknown> = {}) {
  const stateDir = tempDir();
  const error = "cron expression '* * *' has 3 fields, expected 5";
  const failing = () => new Transcript().user("schedule it").call("cron_add", { schedule: "* * *" }, { error });
  writeAgentDb(stateDir, { s1: failing(), s2: failing() });
  const calls: Array<Record<string, unknown>> = [];
  const commands = new Map<string, (ctx: Record<string, unknown>) => unknown>();
  register({
    id: "refine-cycle",
    config: { plugins: { entries: { "refine-cycle": { hooks: { allowConversationAccess: true }, ...(allowModelOverride === undefined ? {} : { llm: { allowModelOverride } }) } } } },
    pluginConfig,
    runtime: {
      state: { resolveStateDir: () => stateDir },
      llm: { complete: async (params) => (calls.push(params), { text: JSON.stringify({ decision: "nothing", fingerprint: fingerprint("cron_add", error), lesson: "", reason: "" }) }) },
    },
    logger: {},
    on: () => {},
    registerCommand: (command) => commands.set(command.name, command.handler as never),
  });
  const refine = async (args: string, extra: Record<string, unknown> = {}) => ((await commands.get("refine")!({ args, agentId: "main", ...extra })) as { text: string }).text;
  return { refine, calls };
}

test("/refine model sets the model lessons are written with, and it is sent when OpenClaw allows it", async () => {
  const { refine, calls } = modelSetup(true);
  assert.equal(await refine("model"), "model: (the default agent's)\nsource: default\nOpenClaw lets this plugin choose its model: yes (plugins.entries.refine-cycle.llm.allowModelOverride)");
  assert.equal(await refine("model openai/gpt-6-luna"), "Override set: model=openai/gpt-6-luna");
  assert.match(await refine("status"), /model: openai\/gpt-6-luna \(source: command; OpenClaw allows this plugin to choose it\)/);
  await refine("session s1");
  assert.equal(calls[0].model, "openai/gpt-6-luna");
  assert.match(await refine("model auto"), /^Override removed\. Effective model: \(the default agent's\) \(source: default\)$/);
});

test("a model OpenClaw does not let the plugin choose is dropped before the call, and status says so", async () => {
  const { refine, calls } = modelSetup(undefined, { model: "openai/gpt-6-luna" });
  assert.match(await refine("model"), /source: setting\n.*: no \(.*\)\n⚠ OpenClaw does not let this plugin choose its model/);
  assert.match(await refine("status"), /warnings:\n  ⚠ Model openai\/gpt-6-luna is set \(setting\) but OpenClaw does not let this plugin choose its model, so it is dropped before the call/);
  await refine("session s1");
  assert.equal("model" in calls[0], false, "no model is sent: the host would refuse the call");
});

test("/refine model refuses a malformed model and a sender off the allowlist", async () => {
  const { refine } = modelSetup(true);
  assert.match(await refine("model not a model"), /^Invalid model\./);
  assert.equal(await refine("model openai/x", { isAuthorizedSender: false }), "Only an authorized sender may change the model.");
  assert.equal(await refine("model auto"), "No override was set. Effective model: (the default agent's) (source: default)");
});

test("a model set with /refine model wins over the model setting, as Hermes' command override does", async () => {
  const { refine, calls } = modelSetup(true, { model: "openai/from-setting" });
  await refine("model openai/from-command");
  await refine("session s1");
  assert.equal(calls[0].model, "openai/from-command");
  assert.match(await refine("model auto"), /Effective model: openai\/from-setting \(source: setting\)/);
});

test("/refine rollback is delete by its Hermes name: a tombstone, and the audit offers it", async () => {
  const stateDir = tempDir();
  seedLesson(stateDir, "oldlesson", "main");
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  // Old enough, and never shown: the audit calls it unused and offers the rollback.
  const lesson = store.read<Record<string, unknown>>("lessons/oldlesson.json")!;
  store.write("lessons/oldlesson.json", { ...lesson, createdAt: "2026-01-01T00:00:00.000Z" });
  store.write("candidates/later.json", { sessionId: "later", agentId: "main", at: "2026-06-01T00:00:00.000Z", outcome: "no_failures", called: false, evaluated: [] });
  const { commands } = fakeApi(stateDir);
  const refine = async (args: string) => ((await commands.get("refine")!({ args, agentId: "main" })) as { text: string }).text;
  assert.match(await refine("audit"), /Candidates for removal:\n  oldlesson — \/refine rollback oldlesson/);
  assert.equal(await refine("rollback oldlesson"), "Lesson oldlesson deleted.");
  assert.equal(store.read<{ status: string }>("lessons/oldlesson.json")!.status, "deleted");
  assert.equal(await refine("rollback"), "Usage: rollback <lesson id>");
});

test("the package icon is where OpenClaw looks for it, and register() without an api does nothing", () => {
  const root = path.join(import.meta.dirname, "..");
  // OpenClaw 2026.9.6 takes the icon from the fixed path assets/icon.png; no manifest field names it.
  const png = fs.readFileSync(path.join(root, "assets", "icon.png"));
  assert.deepEqual([...png.subarray(1, 4)].map((b) => String.fromCharCode(b)).join(""), "PNG");
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20), "the icon is square");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("assets"), "assets/ is packaged");
  // `openclaw plugins validate` calls the default export with no argument.
  assert.doesNotThrow(() => (register as (api?: unknown) => void)());
});


test("list and report show today's model calls as the budget file counts them, the shortening call included", async () => {
  let calls = 0;
  const long = `When calling cron_add, write the schedule as five cron fields, e.g. 0 3 * * *, ${"and keep it to one line ".repeat(8)}.`;
  const setup = passSetup(async () => {
    calls++;
    return { text: calls === 1 ? lessonJson(fingerprint("cron_add", "cron expression '* * *' has 3 fields, expected 5"), long) : "When calling cron_add, write the schedule as five cron fields, e.g. 0 3 * * *." };
  });
  const refine = setup.commands.get("refine")!;
  assert.match((await refine({ args: "session s1", agentId: "main" }) as { text: string }).text, /lesson learned/);
  assert.equal(calls, 2, "a proposal and one shortening call");
  const store = new FileStore(path.join(setup.stateDir, "plugin-data", "refine-cycle"));
  const [day] = store.list("budget");
  const recorded = store.read<{ calls: Array<{ purpose?: string }> }>(`budget/${day}.json`)!.calls;
  assert.deepEqual(recorded.map((call) => call.purpose ?? "propose"), ["propose", "shorten"]);
  assert.match((await refine({ args: "list", agentId: "main" }) as { text: string }).text, /\nmodel calls today: 2\/3$/);
  assert.match((await refine({ args: "report", agentId: "main" }) as { text: string }).text, /\nmodel calls today: 2\/3\n/);
});

test("with rawLog on, the live plugin writes the same raw lines to raw/<date>.jsonl; off by default", async () => {
  const error = "cron expression '* * *' has 3 fields, expected 5";
  const failing = () => new Transcript().user("schedule it").call("cron_add", { schedule: "* * *" }, { error });
  const reply = async () => ({ text: lessonJson(fingerprint("cron_add", error), "When calling cron_add, write the schedule as five cron fields, e.g. 0 3 * * *.") });
  const off = tempDir();
  writeAgentDb(off, { s1: failing(), s2: failing() });
  fakeApi(off, reply).hooks.get("agent_end")!.handler({}, { sessionId: "s1", agentId: "main" });
  await settle();
  assert.equal(fs.existsSync(path.join(off, "plugin-data", "refine-cycle", "raw")), false);

  const stateDir = tempDir();
  writeAgentDb(stateDir, { s1: failing(), s2: failing() });
  const { hooks, commands } = fakeApi(stateDir, reply, true, undefined, { rawLog: true });
  hooks.get("agent_end")!.handler({}, { sessionId: "s1", agentId: "main" });
  await settle();
  const id = ((await commands.get("refine")!({ args: "list", agentId: "main" }) as { text: string }).text).split(" ")[0];
  await commands.get("refine")!({ args: `delete ${id}`, agentId: "main" });
  const dir = path.join(stateDir, "plugin-data", "refine-cycle", "raw");
  const [file] = fs.readdirSync(dir);
  assert.match(file, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  const lines = fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.kind), ["session", "lesson_status"]);
  const [session, status] = lines;
  assert.equal(session.sessionId, "s1");
  assert.equal(session.outcome, "lesson");
  assert.equal(session.modelCalls.length, 1);
  assert.equal(session.modelCalls[0].purpose, "propose");
  assert.equal(session.lesson.id, id);
  assert.equal(session.budget.callsToday, 1);
  assert.deepEqual(status, { kind: "lesson_status", format: 1, at: status.at, lessonId: id, agentId: "main", status: "deleted" });
});


// -- F1: messages go to a chat that can take them; F2: the Update button in status --

test("a webchat or heartbeat turn after a Telegram turn leaves the remembered chat as it is, and its lesson goes to Telegram", async () => {
  const stateDir = tempDir();
  const error = "cron expression '* * *' has 3 fields, expected 5";
  const failing = () => {
    const t = new Transcript().user("schedule it");
    for (let i = 0; i < 5; i++) t.call("cron_add", { schedule: "* * *" }, { error });
    return t;
  };
  writeAgentDb(stateDir, { chatty: new Transcript().user("hi"), idle: new Transcript().user("status?"), s1: failing() });
  const sent: Array<Record<string, unknown>> = [];
  // As on 2026.9.6: Telegram has an outbound adapter, webchat (the web UI, gateway chat.send, the heartbeat) has none.
  const loadAdapter = async (id: string) => (id === "telegram" ? { sendText: async (ctx: Record<string, unknown>) => void sent.push(ctx) } : undefined);
  const reply = async () => ({ text: lessonJson(fingerprint("cron_add", error), "When calling cron_add, write the schedule as five cron fields, e.g. 0 3 * * *.") });
  const { hooks } = fakeApi(stateDir, reply, true, undefined, { backfillSessions: 0 }, loadAdapter);
  const agentEnd = hooks.get("agent_end")!.handler;
  const chats = path.join(stateDir, "plugin-data", "refine-cycle", "chats", "main.json");
  agentEnd({}, telegramTurn("chatty"));
  await settle();
  const remembered = fs.readFileSync(chats, "utf8");
  assert.match(remembered, /"telegram"/);
  // The heartbeat's turn, every 30 minutes, as R5 logged it: channel webchat, the session key as its chat.
  agentEnd({}, { sessionId: "idle", agentId: "main", channel: "webchat", chatId: "agent:main:main" });
  await settle();
  assert.equal(fs.readFileSync(chats, "utf8"), remembered, "a turn a plugin cannot answer does not replace the chat");
  // A lesson learned in a webchat turn is told in the remembered Telegram chat.
  agentEnd({}, { sessionId: "s1", agentId: "main", channel: "webchat", chatId: "agent:main:r4v2-c4-tool" });
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "4242");
  assert.match(String(sent[0].text), /new lesson learned/);
  assert.equal(fs.readFileSync(chats, "utf8"), remembered);
});

const telegramCommand = { channel: "telegram", to: "telegram:4242", accountId: "default" };

test("/refine update from Telegram, slow, sends 'updated to' to that chat even when another chat is remembered", async () => {
  const saved = timing.chatWaitMs;
  timing.chatWaitMs = 20;
  try {
    let finish: () => void = () => {};
    const texts: Array<Record<string, unknown>> = [];
    const setup = updateSetup(gitHost({ slow: new Promise<void>((resolve) => (finish = resolve)) }), {
      sendText: async (ctx: Record<string, unknown>) => void texts.push(ctx),
    });
    setup.store.write("chats/main.json", { channel: "telegram", to: "1111", accountId: "other" });
    const refine = setup.commands.get("refine")!;
    const text = (await refine({ args: "update", agentId: "main", isAuthorizedSender: true, ...telegramCommand }) as { text: string }).text;
    assert.equal(text, "Updating Refine Cycle; the result follows in this chat.");
    finish();
    for (let i = 0; i < 20 && texts.length === 0; i++) await settle();
    assert.deepEqual(texts.map((m) => [m.to, m.accountId, m.text]), [["telegram:4242", "default", "♾️ Refine Cycle updated to 0.2.0. OpenClaw restarts to finish it once no conversation is running."]]);
  } finally {
    timing.chatWaitMs = saved;
  }
});

test("a slow /refine update from webchat, which a plugin cannot answer, goes to the remembered chat and says so", async () => {
  const saved = timing.chatWaitMs;
  timing.chatWaitMs = 20;
  try {
    let finish: () => void = () => {};
    const texts: Array<Record<string, unknown>> = [];
    const setup = updateSetup(gitHost({ slow: new Promise<void>((resolve) => (finish = resolve)) }), {
      sendText: async (ctx: Record<string, unknown>) => void texts.push(ctx),
    });
    setup.store.write("chats/main.json", { channel: "telegram", to: "1111" });
    const text = (await setup.commands.get("refine")!({ args: "update", agentId: "main", channel: "webchat", to: "agent:main:main" }) as { text: string }).text;
    assert.equal(text, "Updating Refine Cycle; the result follows in your telegram chat.");
    finish();
    for (let i = 0; i < 20 && texts.length === 0; i++) await settle();
    assert.deepEqual(texts.map((m) => m.to), ["1111"]);
  } finally {
    timing.chatWaitMs = saved;
  }
});

test("the late results of /refine session and /refine run go to the chat the command came from", async () => {
  const saved = timing.chatWaitMs;
  timing.chatWaitMs = 20;
  try {
    const answers: Array<(value: { text: string }) => void> = [];
    const setup = passSetup(() => new Promise((resolve) => answers.push(resolve)));
    new FileStore(path.join(setup.stateDir, "plugin-data", "refine-cycle")).write("chats/main.json", { channel: "telegram", to: "1111" });
    const refine = setup.commands.get("refine")!;
    const session = (await refine({ args: "session s1", agentId: "main", ...telegramCommand }) as { text: string }).text;
    assert.equal(session, "Pass over session s1 started; the result follows in this chat when the model has answered.");
    for (let i = 0; i < 50 && answers.length < 1; i++) await settle();
    // An unreadable reply: it pauses nothing, so s2 still gets its own call.
    answers[0]({ text: "not json" });
    const run = (await refine({ args: "run", agentId: "main", sessionId: "s2", ...telegramCommand, to: "telegram:5555" }) as { text: string }).text;
    assert.match(run, /started; the result follows in this chat/);
    for (let i = 0; i < 50 && answers.length < 2; i++) await settle();
    answers[1]({ text: lessonJson(setup.fp, setup.lessonText) });
    for (let i = 0; i < 20 && setup.sent.length < 2; i++) await settle();
    const late = setup.sent.filter((m) => /pass over session/.test(String(m.text)));
    assert.deepEqual(late.map((m) => [m.to, /session (s\d)/.exec(String(m.text))?.[1]]), [["telegram:4242", "s1"], ["telegram:5555", "s2"]]);
    assert.ok(!setup.sent.some((m) => m.to === "1111" && /pass over/.test(String(m.text))), "not the remembered chat");
  } finally {
    timing.chatWaitMs = saved;
  }
});

test("/refine status offers the Update button in a chat with buttons, and the command as copyable text elsewhere", async () => {
  const withButtons = updateSetup(gitHost(), { sendText: async () => undefined, sendPayload: async () => undefined });
  const refine = withButtons.commands.get("refine")!;
  // The first status starts the check; the next shows what it found.
  await refine({ args: "status", agentId: "main", ...telegramCommand });
  for (let i = 0; i < 10; i++) await settle();
  const offered = await refine({ args: "status", agentId: "main", ...telegramCommand }) as { text: string; presentation?: unknown };
  assert.match(offered.text, /is available \(installed 0\.1\.0\): `\/refine update`/);
  assert.deepEqual(offered.presentation, {
    blocks: [{ type: "buttons", buttons: [{ label: "Update", action: { type: "command", command: "/refine update" } }] }],
  });

  const noButtons = updateSetup(gitHost(), { sendText: async () => undefined, sendPayload: async () => undefined, presentationCapabilities: { buttons: false } });
  const plain = noButtons.commands.get("refine")!;
  await plain({ args: "status", agentId: "main", ...telegramCommand });
  for (let i = 0; i < 10; i++) await settle();
  const text = await plain({ args: "status", agentId: "main", ...telegramCommand }) as { text: string; presentation?: unknown };
  assert.match(text.text, /`\/refine update`/);
  assert.equal(text.presentation, undefined);
  // No update known: no button, even where the channel has them.
  const current = updateSetup(gitHost({ tags: "a\trefs/tags/v0.1.0\n" }), { sendText: async () => undefined, sendPayload: async () => undefined });
  await current.commands.get("refine")!({ args: "status", agentId: "main", ...telegramCommand });
  for (let i = 0; i < 10; i++) await settle();
  assert.equal((await current.commands.get("refine")!({ args: "status", agentId: "main", ...telegramCommand }) as { presentation?: unknown }).presentation, undefined);
});


// -- G1/L1/L2: notices through the agent where the plugin cannot send (webchat, the Tray) --

const webchatTurn = (sessionId: string, sessionKey = "agent:main:tray", runId = `run-${sessionId}`) =>
  ({ sessionId, agentId: "main", channel: "webchat", chatId: sessionKey, sessionKey, trigger: "user", runId });

const NOTICE = /\[Refine Cycle notice\] Tell the user in one short sentence, then go on with their request; this is a notice, not a task: /;

test("L1: a lesson learned while the next webchat session has begun is passed on in that session's next reply", async () => {
  const { hooks, sent, stateDir } = learningSetup();
  const prompt = (ctx: Record<string, unknown>) => hooks.get("before_prompt_build")!.handler({}, ctx) as { prependContext?: string } | undefined;
  const agentEnd = hooks.get("agent_end")!.handler;
  // The live order (2026-09-30): the lesson is learned in s1's pass, because s2's failure was already in the history.
  agentEnd({ success: true }, webchatTurn("s1", "agent:main:g1-pin-s1"));
  await settle();
  assert.equal(sent.length, 0, "no direct send: webchat takes none");
  const box = path.join(stateDir, "plugin-data", "refine-cycle", "notices", "main.json");
  assert.ok(fs.existsSync(box), "the notice waits for the agent");
  // The user's next message, in s2: its prompt carries the notice, after the lessons block.
  const s2 = webchatTurn("s2", "agent:main:g1-pin-s2");
  const text = prompt(s2)!.prependContext!;
  assert.match(text, /^<refine_cycle_lessons[\s\S]*<\/refine_cycle_lessons>\n\n\[Refine Cycle notice\]/);
  assert.match(text, new RegExp(`${NOTICE.source}Refine Cycle learned a new lesson; lessons use \\d+ of 4400 characters\\.$`));
  agentEnd({ success: true }, s2);
  await settle();
  assert.ok(!fs.existsSync(box), "passed on: gone");
  assert.doesNotMatch(prompt(webchatTurn("s3", "agent:main:g1-pin-s2", "run-s3b"))?.prependContext ?? "", NOTICE, "once");
});

test("L2: a notice handed to a run that ended without a reply is given to the next run", async () => {
  const { hooks } = learningSetup();
  const prompt = (ctx: Record<string, unknown>) => (hooks.get("before_prompt_build")!.handler({}, ctx) as { prependContext?: string } | undefined)?.prependContext ?? "";
  const agentEnd = hooks.get("agent_end")!.handler;
  agentEnd({ success: true }, webchatTurn("s1"));
  await settle();
  const crashed = webchatTurn("s2", "agent:main:tray", "run-crashed");
  assert.match(prompt(crashed), NOTICE);
  // The host's error ("Codex session policy handoff failed …"): no reply reached the user.
  agentEnd({ success: false, error: "Codex session policy handoff failed" }, crashed);
  await settle();
  const retry = webchatTurn("s2", "agent:main:tray", "run-retry");
  assert.match(prompt(retry), NOTICE, "the retry gets it");
  agentEnd({ success: true }, retry);
  await settle();
  assert.doesNotMatch(prompt(webchatTurn("s3")), NOTICE);
});

test("heartbeat and cron runs are never handed a notice; the user's next turn is", async () => {
  const { hooks } = learningSetup();
  const prompt = (ctx: Record<string, unknown>) => (hooks.get("before_prompt_build")!.handler({}, ctx) as { prependContext?: string } | undefined)?.prependContext ?? "";
  const agentEnd = hooks.get("agent_end")!.handler;
  agentEnd({ success: true }, webchatTurn("s1"));
  await settle();
  for (const trigger of ["heartbeat", "cron"]) {
    const background = { ...webchatTurn("s2", "agent:main:main", `run-${trigger}`), trigger };
    assert.doesNotMatch(prompt(background), NOTICE, trigger);
    agentEnd({ success: true }, background);
    await settle();
  }
  assert.match(prompt(webchatTurn("s3")), NOTICE);
});

test("with a Telegram chat known, a lesson learned in webchat is sent there, never also through the agent", async () => {
  const stateDir = tempDir();
  const error = "cron expression '* * *' has 3 fields, expected 5";
  const failing = () => {
    const t = new Transcript().user("schedule it");
    for (let i = 0; i < 5; i++) t.call("cron_add", { schedule: "* * *" }, { error });
    return t;
  };
  writeAgentDb(stateDir, { chatty: new Transcript().user("hi"), s1: failing() });
  const sent: Array<Record<string, unknown>> = [];
  const loadAdapter = async (id: string) => (id === "telegram" ? { sendText: async (ctx: Record<string, unknown>) => void sent.push(ctx) } : undefined);
  const reply = async () => ({ text: lessonJson(fingerprint("cron_add", error), "When calling cron_add, write the schedule as five cron fields, e.g. 0 3 * * *.") });
  const { hooks } = fakeApi(stateDir, reply, true, undefined, { backfillSessions: 0 }, loadAdapter);
  hooks.get("agent_end")!.handler({}, telegramTurn("chatty"));
  await settle();
  hooks.get("agent_end")!.handler({}, webchatTurn("s1"));
  await settle();
  assert.equal(sent.length, 1);
  assert.match(String(sent[0].text), /new lesson learned/);
  assert.doesNotMatch((hooks.get("before_prompt_build")!.handler({}, webchatTurn("s2")) as { prependContext?: string } | undefined)?.prependContext ?? "", NOTICE);
});

test("the update notice goes to Telegram with its button, or to the agent in webchat, once, and is then announced", async () => {
  const web = updateSetup(gitHost(), { sendText: async () => undefined });
  await web.turn("s1", webchatTurn("s1"));
  assert.equal(web.sent.length, 0);
  assert.deepEqual(web.store.read<{ announced: string[] }>("update/state.json")!.announced, ["0.2.0"]);
  const first = web.prompt(webchatTurn("s2"));
  assert.match(first, /Refine Cycle 0\.2\.0 is available; sending \/refine update installs it\.$/);
  web.end(webchatTurn("s2"));
  const state = web.store.read<Record<string, unknown>>("update/state.json")!;
  web.store.write("update/state.json", { ...state, checkedAt: "2026-01-01T00:00:00Z" });
  await web.turn("s3", webchatTurn("s3"));
  assert.doesNotMatch(web.prompt(webchatTurn("s4")), NOTICE, "not given twice");

  const tg = updateSetup(gitHost());
  await tg.turn("s1");
  assert.equal(tg.sent.length, 1);
  assert.ok(tg.sent[0].payload, "the button payload");
  assert.doesNotMatch(tg.prompt(webchatTurn("s2")), NOTICE);
});

// -- G2: updates install themselves --

const autoOn = { autoUpdate: true };

test("with autoUpdate on, a newer release is installed once by the host's own update, and said once", async () => {
  const setup = updateSetup(gitHost(), { sendText: async (ctx: Record<string, unknown>) => void setup.sent.push(ctx) }, autoOn);
  await setup.turn("s1");
  const updates = () => setup.host.runs.filter((argv) => argv.slice(2).join(" ") === "plugins update refine-cycle").length;
  assert.equal(updates(), 1);
  assert.equal(setup.host.installed, "0.2.0");
  assert.deepEqual(setup.sent.map((m) => m.text), ["♾️ Refine Cycle — updated to 0.2.0."]);
  const state = setup.store.read<Record<string, unknown>>("update/state.json")!;
  assert.deepEqual(state.attempted, ["0.2.0"]);
  setup.store.write("update/state.json", { ...state, checkedAt: "2026-01-01T00:00:00Z" });
  await setup.turn("s2");
  assert.equal(updates(), 1);
  assert.equal(setup.sent.length, 1);
});

test("a failed automatic update is said once and that version is not tried again; the next one is", async () => {
  const host = gitHost({ update: { code: 1, stderr: "Error: git clone failed: could not resolve host github.com\n" } });
  const setup = updateSetup(host, { sendText: async (ctx: Record<string, unknown>) => void setup.sent.push(ctx) }, autoOn);
  const updates = () => host.runs.filter((argv) => argv.slice(2).join(" ") === "plugins update refine-cycle").length;
  await setup.turn("s1");
  assert.equal(updates(), 1);
  assert.deepEqual(setup.sent.map((m) => m.text), ["♾️ Refine Cycle — update to 0.2.0 failed: Error: git clone failed: could not resolve host github.com"]);
  assert.equal(host.installed, "0.1.0");
  const recheck = () => {
    const state = setup.store.read<Record<string, unknown>>("update/state.json")!;
    setup.store.write("update/state.json", { ...state, checkedAt: "2026-01-01T00:00:00Z" });
  };
  recheck();
  await setup.turn("s2");
  assert.equal(updates(), 1, "0.2.0 is not tried again");
  assert.equal(setup.sent.length, 1);
  // A newer release is.
  host.tags += "c\trefs/tags/v0.3.0\n";
  host.update = { to: "0.3.0" };
  recheck();
  await setup.turn("s1");
  assert.equal(updates(), 2);
  assert.equal(setup.sent[1].text, "♾️ Refine Cycle — updated to 0.3.0.");
});

test("with autoUpdate off, the notice with the button, and nothing is installed", async () => {
  const setup = updateSetup(gitHost(), undefined, { autoUpdate: false });
  await setup.turn("s1");
  assert.equal(setup.sent[0].text, "♾️ Refine Cycle — update available: 0.2.0");
  assert.ok(!setup.host.runs.some((argv) => argv.slice(2).join(" ") === "plugins update refine-cycle"));
});

test("a plugin loaded from a path is never updated by itself", async () => {
  const setup = updateSetup(gitHost({ source: "path" }), { sendText: async (ctx: Record<string, unknown>) => void setup.sent.push(ctx) }, autoOn);
  await setup.turn("s1");
  assert.ok(!setup.host.runs.some((argv) => argv[2] === "plugins" && argv[3] === "update"), JSON.stringify(setup.host.runs));
  assert.equal(setup.sent.length, 0);
});

test("a ClawHub install is updated when the host's dry run says 'Would update', and left alone on 'is up to date' or a pin", async () => {
  // The host's own words, 2026.9.6 update-attempt: buildDryRunPluginUpdateOutcome and formatNewerExactPinnedClawHubDefaultLineMessage.
  const found = updateSetup(gitHost({ source: "clawhub", dryRun: "Would update refine-cycle: 0.1.0 -> 0.3.0.\n", update: { to: "0.3.0" } }), { sendText: async (ctx: Record<string, unknown>) => void found.sent.push(ctx) }, autoOn);
  await found.turn("s1");
  assert.equal(found.host.runs.filter((argv) => argv.slice(2).join(" ") === "plugins update refine-cycle").length, 1);
  assert.deepEqual(found.sent.map((m) => m.text), ["♾️ Refine Cycle — updated to 0.3.0."]);

  const current = updateSetup(gitHost({ source: "clawhub", dryRun: "refine-cycle is up to date (0.1.0).\n" }), { sendText: async (ctx: Record<string, unknown>) => void current.sent.push(ctx) }, autoOn);
  await current.turn("s1");
  assert.equal(current.store.read<{ ok: boolean; latest: string }>("update/state.json")!.ok, true);
  assert.ok(!current.host.runs.some((argv) => argv.slice(2).join(" ") === "plugins update refine-cycle"));
  assert.equal(current.sent.length, 0);

  const pinned = updateSetup(gitHost({
    source: "clawhub",
    dryRun: "refine-cycle is pinned to clawhub:refine-cycle-openclaw@0.1.0 (installed 0.1.0); ClawHub latest resolves to 0.3.0. Pass `openclaw plugins install clawhub:refine-cycle-openclaw --force` to replace this version pin.\n",
  }), { sendText: async (ctx: Record<string, unknown>) => void pinned.sent.push(ctx) }, autoOn);
  await pinned.turn("s1");
  assert.equal(pinned.store.read<{ ok: boolean }>("update/state.json")!.ok, true, "a pin is read, not a failed check");
  assert.ok(!pinned.host.runs.some((argv) => argv.slice(2).join(" ") === "plugins update refine-cycle"));
  assert.ok(pinned.logs.some((line) => line.includes("is pinned to clawhub:refine-cycle-openclaw@0.1.0")));
});

test("a git install with no release tags says so in the log, not 'loaded from a path'", async () => {
  const setup = updateSetup(gitHost({ tags: "" }), undefined, autoOn);
  await setup.turn("s1");
  assert.ok(setup.logs.some((line) => line.includes("latest (no release tags yet)")), setup.logs.join("\n"));
});

// -- G3: over the soft limit the plugin tidies itself, and says so --

function seedJudged(stateDir: string, id: string, verdict: "did not help" | "working", daysOld: number): void {
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  store.open();
  const createdAt = new Date(Date.now() - daysOld * 86_400_000).toISOString();
  activate(store, {
    id, text: `When calling tool_${id}, pass the ${id} argument it needs, spelled out in full every time it is used.`, fingerprint: `fp${id}`, tool: `tool_${id}`,
    createdAt, sourceSessionId: "s", evidence: { sessionIds: ["s"], eventIds: [] }, reason: "", agentId: "main",
  }, new Date(createdAt));
  const folded = verdict === "did not help" ? { shown: 3, cameBack: 2, recurrences: 2, unplaced: 0 } : { shown: 5, cameBack: 0, recurrences: 0, unplaced: 0 };
  store.write(`ledger/${id}.json`, { lessonId: id, sessions: {}, folded, updatedAt: createdAt });
}

test("after a turn over the soft limit, lessons that did not help are switched off and the user is told once", async () => {
  const stateDir = tempDir();
  writeAgentDb(stateDir, { s1: new Transcript().user("hi").say("hello"), s2: new Transcript().user("hi").say("hello") });
  seedJudged(stateDir, "helps", "did not help", 30);
  seedJudged(stateDir, "works", "working", 30);
  const sent: Array<Record<string, unknown>> = [];
  const loadAdapter = async (id: string) => (id === "telegram" ? { sendText: async (ctx: Record<string, unknown>) => void sent.push(ctx) } : undefined);
  const { hooks } = fakeApi(stateDir, async () => ({ text: "{}" }), true, undefined, { maxInjectedChars: 300, checkForUpdates: false }, loadAdapter);
  hooks.get("agent_end")!.handler({}, telegramTurn("s1"));
  await settle();
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  assert.deepEqual(allLessonsOf(store), [["helps", "disabled", "tidy: did not help"], ["works", "active", undefined]]);
  assert.equal(sent.length, 1);
  assert.match(String(sent[0].text), /^♾️ Refine Cycle — switched off 1 lesson that did not help, lessons now \d+\/300$/);
  hooks.get("agent_end")!.handler({}, telegramTurn("s2"));
  await settle();
  assert.equal(sent.length, 1, "once per tidy");
});

test("with autoTidy off, over the soft limit nothing is switched off; the user is told once", async () => {
  const stateDir = tempDir();
  writeAgentDb(stateDir, { s1: new Transcript().user("hi").say("hello") });
  seedJudged(stateDir, "helps", "did not help", 30);
  seedJudged(stateDir, "works", "working", 30);
  const sent: Array<Record<string, unknown>> = [];
  const loadAdapter = async (id: string) => (id === "telegram" ? { sendText: async (ctx: Record<string, unknown>) => void sent.push(ctx) } : undefined);
  const { hooks } = fakeApi(stateDir, async () => ({ text: "{}" }), true, undefined, { maxInjectedChars: 300, checkForUpdates: false, autoTidy: false }, loadAdapter);
  hooks.get("agent_end")!.handler({}, telegramTurn("s1"));
  await settle();
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  assert.deepEqual(allLessonsOf(store).map((row) => row[1]), ["active", "active"]);
  assert.equal(sent.length, 1);
  assert.match(String(sent[0].text), /^♾️ Refine Cycle — lessons use \d+\/300 characters, over the soft limit, and none can be switched off yet: .*\/refine audit/);
  hooks.get("agent_end")!.handler({}, telegramTurn("s2"));
  await settle();
  assert.equal(sent.length, 1, "once, until the block fits again");
});

function allLessonsOf(store: FileStore): Array<[string, string, string | undefined]> {
  return store.list("lessons").sort().map((name) => {
    const lesson = store.read<{ id: string; status: string; disabledBy?: string }>(`lessons/${name}.json`)!;
    return [lesson.id, lesson.status, lesson.disabledBy];
  });
}


// -- L3: the automatic update compares with the running version, and waits for a quiet gateway --

test("L3: a cached 'installed' older than the running version is not an update", async () => {
  // The live case: 0.1.4 running, the stored state still saying installed 0.1.2, latest 0.1.3.
  // Here the running version is package.json's; the state is a check's leftover from before an install.
  const running = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  const setup = updateSetup(gitHost({ installed: running, tags: `a\trefs/tags/v${running}\n` }), { sendText: async (ctx: Record<string, unknown>) => void setup.sent.push(ctx) }, { autoUpdate: true });
  setup.store.write("update/state.json", { checkedAt: new Date().toISOString(), ok: true, source: "git", installed: "0.0.1", latest: running, announced: [] });
  await setup.turn("s1");
  assert.ok(!setup.host.runs.some((argv) => argv.slice(2).join(" ") === "plugins update refine-cycle"), JSON.stringify(setup.host.runs));
  assert.equal(setup.sent.length, 0);
  assert.doesNotMatch(((await setup.commands.get("refine")!({ args: "status", agentId: "main" })) as { text: string }).text, /is available/);
});

test("L3: the automatic update waits for a quiet gateway, and every run postpones it", async () => {
  const saved = timing.quietMs;
  timing.quietMs = 150;
  try {
    const setup = updateSetup(gitHost(), { sendText: async (ctx: Record<string, unknown>) => void setup.sent.push(ctx) }, { autoUpdate: true });
    const updates = () => setup.host.runs.filter((argv) => argv.slice(2).join(" ") === "plugins update refine-cycle").length;
    const pause = async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 10; i++) await settle();
    };
    setup.end({ sessionId: "s1", agentId: "main", channel: "telegram", chatId: "4242", runId: "r1" });
    await pause(20);
    assert.ok(setup.host.runs.some((argv) => argv[0] === "git"), "the check ran after the turn");
    assert.equal(updates(), 0, "not inside the turn's own agent_end chain");
    // A new run starts before the quiet period is over, and is still going when it would fire.
    setup.prompt({ sessionId: "s2", agentId: "main", runId: "r2", trigger: "user" });
    await pause(250);
    assert.equal(updates(), 0, "never while a run is in progress");
    setup.end({ sessionId: "s2", agentId: "main", runId: "r2" });
    await pause(60);
    assert.equal(updates(), 0, "the quiet period starts again when the run ends");
    await pause(250);
    assert.equal(updates(), 1);
    assert.deepEqual(setup.sent.map((m) => m.text), ["♾️ Refine Cycle — updated to 0.2.0."]);
  } finally {
    timing.quietMs = saved;
  }
});

// -- L4: a tidy can be undone --

test("L4: /refine enable turns a disabled lesson back on; a deleted one stays deleted", async () => {
  const stateDir = tempDir();
  writeAgentDb(stateDir, { s1: new Transcript().user("hi") });
  seedJudged(stateDir, "helps", "did not help", 30);
  seedJudged(stateDir, "gone", "did not help", 30);
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  store.open();
  setStatus(store, "helps", "disabled", new Date(), 0, "tidy: did not help");
  setStatus(store, "gone", "deleted", new Date());
  const { commands } = fakeApi(stateDir, async () => ({ text: "{}" }));
  const refine = async (args: string) => ((await commands.get("refine")!({ args, agentId: "main" })) as { text: string }).text;
  assert.equal(await refine("enable helps"), "Lesson helps enabled. The tidy will not switch it off again.");
  assert.deepEqual(allLessonsOf(store).find((row) => row[0] === "helps"), ["helps", "active", undefined]);
  assert.equal(await refine("enable helps"), "Lesson helps is active; only a disabled lesson can be enabled.");
  assert.equal(await refine("enable gone"), "Lesson gone was deleted; a deleted lesson stays deleted.");
  assert.equal(await refine("enable nope"), "No lesson nope.");
  assert.match(await refine("list"), /helps \[active\]/);
});

test("L4: the tidy never switches off again a lesson the user enabled", async () => {
  const stateDir = tempDir();
  writeAgentDb(stateDir, { s1: new Transcript().user("hi").say("hello"), s2: new Transcript().user("hi").say("hello") });
  seedJudged(stateDir, "helps", "did not help", 30);
  seedJudged(stateDir, "works", "working", 30);
  const sent: Array<Record<string, unknown>> = [];
  const loadAdapter = async (id: string) => (id === "telegram" ? { sendText: async (ctx: Record<string, unknown>) => void sent.push(ctx) } : undefined);
  const { hooks, commands } = fakeApi(stateDir, async () => ({ text: "{}" }), true, undefined, { maxInjectedChars: 300, checkForUpdates: false }, loadAdapter);
  hooks.get("agent_end")!.handler({}, telegramTurn("s1"));
  await settle();
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  assert.equal(allLessonsOf(store)[0][1], "disabled", "the tidy switched it off");
  await commands.get("refine")!({ args: "enable helps", agentId: "main" });
  hooks.get("agent_end")!.handler({}, telegramTurn("s2"));
  await settle();
  assert.deepEqual(allLessonsOf(store), [["helps", "active", undefined], ["works", "active", undefined]], "still over the limit, but the user's choice stands");
  // One tidy line from the first tidy; then, still over with nothing it may switch off, one over-limit line.
  assert.deepEqual(sent.map((m) => String(m.text).replace(/\d+\/300/, "N/300")), [
    "♾️ Refine Cycle — switched off 1 lesson that did not help, lessons now N/300",
    "♾️ Refine Cycle — lessons use N/300 characters, over the soft limit, and none can be switched off yet: every turn now costs more tokens; /refine audit shows which lessons to turn off",
  ]);
});


// -- Review round 1 --

test("a run that crashed before agent_end stops holding the automatic update after lostRunMs", async () => {
  const saved = { ...timing };
  timing.quietMs = 30;
  timing.lostRunMs = 120;
  try {
    const setup = updateSetup(gitHost(), { sendText: async (ctx: Record<string, unknown>) => void setup.sent.push(ctx) }, { autoUpdate: true });
    const updates = () => setup.host.runs.filter((argv) => argv.slice(2).join(" ") === "plugins update refine-cycle").length;
    const pause = async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 10; i++) await settle();
    };
    // A run starts and never ends: the process lost it (the Codex handoff crash).
    setup.prompt({ sessionId: "lost", agentId: "main", runId: "r-lost", trigger: "user" });
    setup.end({ sessionId: "s1", agentId: "main", channel: "telegram", chatId: "4242", runId: "r1" });
    await pause(80);
    assert.equal(updates(), 0, "held while the lost run still counts");
    await pause(200);
    assert.equal(updates(), 1, "a run not seen for lostRunMs no longer holds it");
  } finally {
    Object.assign(timing, saved);
  }
});

test("a notice stored while a run has the others, even in the same millisecond, is not dropped with them", () => {
  const { hooks, stateDir } = learningSetup();
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  const at = "2026-09-30T21:00:00.000Z";
  store.write("notices/main.json", { notices: [{ what: "lesson a", sentence: "First.", at }] });
  const run = webchatTurn("s1", "agent:main:tray", "r-1");
  const text = (hooks.get("before_prompt_build")!.handler({}, run) as { prependContext?: string }).prependContext!;
  assert.match(text, /First\.$/);
  const box = store.read<{ notices: unknown[]; handedTo: { at: string } }>("notices/main.json")!;
  // A second notice, stored with exactly the hand-over's time.
  store.write("notices/main.json", { ...box, notices: [...box.notices, { what: "tidy", sentence: "Second.", at: box.handedTo.at }] });
  hooks.get("agent_end")!.handler({ success: true }, run);
  const left = store.read<{ notices: Array<{ sentence: string }> }>("notices/main.json")!;
  assert.deepEqual(left.notices.map((notice) => notice.sentence), ["Second."]);
});


// -- Quiet update, live on d09c719: the update never fired; a hot reload breaks the Codex harness --

test("the two hooks of one run need not carry the same ids: an agent_end without the runId still ends the run", async () => {
  const saved = { ...timing };
  timing.quietMs = 40;
  try {
    const setup = updateSetup(gitHost({ service: true }), { sendText: async (ctx: Record<string, unknown>) => void setup.sent.push(ctx) }, { autoUpdate: true });
    const updates = () => setup.host.runs.filter((argv) => argv.slice(2).join(" ") === "plugins update refine-cycle").length;
    const pause = async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 10; i++) await settle();
    };
    setup.end({ sessionId: "s0", agentId: "main", channel: "telegram", chatId: "4242" });
    await pause(10);
    // The prompt of a run carries the host's runId; its agent_end only the session.
    setup.prompt({ sessionId: "s1", sessionKey: "agent:main:main", runId: "r-1", agentId: "main", trigger: "user" });
    setup.end({ sessionId: "s1", agentId: "main" });
    await pause(200);
    assert.equal(updates(), 1, "the run ended: nothing holds the update");
  } finally {
    Object.assign(timing, saved);
  }
});

test("after an automatic update OpenClaw is restarted in the same quiet window, when it is a service", async () => {
  const setup = updateSetup(gitHost({ service: true }), { sendText: async (ctx: Record<string, unknown>) => void setup.sent.push(ctx) }, { autoUpdate: true });
  await setup.turn("s1");
  const steps = setup.host.runs.map((argv) => argv.slice(2).join(" ")).filter((step) => /^(plugins update refine-cycle|gateway )/.test(step));
  assert.deepEqual(steps, ["gateway status --json", "plugins update refine-cycle", "gateway restart --safe --json"]);
  assert.deepEqual(setup.sent.map((m) => m.text), ["♾️ Refine Cycle — updated to 0.2.0."], "said before the restart stops this process");
});

test("without a service to restart, the update is offered, not installed: a reload alone would break the Codex harness", async () => {
  const setup = updateSetup(gitHost({ service: false }), { sendText: async (ctx: Record<string, unknown>) => void setup.sent.push(ctx) }, { autoUpdate: true });
  await setup.turn("s1");
  assert.ok(!setup.host.runs.some((argv) => argv.slice(2).join(" ") === "plugins update refine-cycle"), "not installed");
  assert.ok(!setup.host.runs.some((argv) => argv.slice(2).join(" ").startsWith("gateway restart")));
  assert.deepEqual(setup.sent.map((m) => m.text), ["♾️ Refine Cycle — update available: 0.2.0\n`/refine update` — installs it."]);
});

test("/refine update restarts OpenClaw once no run is in progress, or asks for a restart without a service", async () => {
  const saved = { ...timing };
  timing.restartPollMs = 20;
  try {
    const service = updateSetup(gitHost({ service: true }));
    const refine = service.commands.get("refine")!;
    service.prompt({ sessionId: "busy", agentId: "main", runId: "r-busy", trigger: "user" });
    const text = ((await refine({ args: "update", agentId: "main", isAuthorizedSender: true })) as { text: string }).text;
    assert.equal(text, "♾️ Refine Cycle updated to 0.2.0. OpenClaw restarts to finish it once no conversation is running.");
    const restarts = () => service.host.runs.filter((argv) => argv.slice(2).join(" ") === "gateway restart --safe --json").length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(restarts(), 0, "not while a run is in progress");
    service.end({ sessionId: "busy", agentId: "main", runId: "r-busy" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (let i = 0; i < 10; i++) await settle();
    assert.equal(restarts(), 1);

    const plain = updateSetup(gitHost({ service: false }));
    const answer = ((await plain.commands.get("refine")!({ args: "update", agentId: "main", isAuthorizedSender: true })) as { text: string }).text;
    assert.equal(answer, "♾️ Refine Cycle — updated to 0.2.0; restart OpenClaw to finish.");
  } finally {
    Object.assign(timing, saved);
  }
});


test("openclaw refine-cycle enable exits 1 when it did not enable: a deleted lesson, an active one, no such lesson", async () => {
  const stateDir = tempDir();
  seedJudged(stateDir, "gone", "did not help", 30);
  seedJudged(stateDir, "off", "did not help", 30);
  const store = new FileStore(path.join(stateDir, "plugin-data", "refine-cycle"));
  store.open();
  setStatus(store, "gone", "deleted", new Date());
  setStatus(store, "off", "disabled", new Date());
  const actions = new Map<string, (...args: unknown[]) => unknown>();
  const program = {
    command(spec: string) {
      const name = spec.split(" ")[0];
      const node = { command: (sub: string) => program.command(sub), description: () => node, option: () => node, action: (handler: (...args: unknown[]) => unknown) => (actions.set(name, handler), node) };
      return node;
    },
  };
  register({
    id: "refine-cycle",
    config: { plugins: { entries: { "refine-cycle": { hooks: { allowConversationAccess: true } } } } },
    runtime: { state: { resolveStateDir: () => stateDir } },
    logger: {},
    on: () => {},
    registerCli: (registrar) => registrar({ program: program as never }),
  });
  const log = console.log;
  const exitCode = process.exitCode;
  const run = async (id: string) => {
    const printed: string[] = [];
    console.log = (line: unknown) => void printed.push(String(line));
    process.exitCode = 0;
    try {
      await actions.get("enable")!(id);
      return { text: printed.join("\n"), code: process.exitCode };
    } finally {
      console.log = log;
      process.exitCode = exitCode;
    }
  };
  assert.deepEqual(await run("gone"), { text: "Lesson gone was deleted; a deleted lesson stays deleted.", code: 1 });
  assert.deepEqual(await run("nope"), { text: "No lesson nope.", code: 1 });
  assert.deepEqual(await run("off"), { text: "Lesson off enabled. The tidy will not switch it off again.", code: 0 });
  assert.deepEqual(await run("off"), { text: "Lesson off is active; only a disabled lesson can be enabled.", code: 1 });
});


// -- product-ux-audit 2026-10-01: nothing the user must hear is left in the log alone --

test("a late /refine update result for webchat, with no chat a plugin can reach, comes through the agent", async () => {
  const saved = { ...timing };
  timing.chatWaitMs = 20;
  try {
    let finish: () => void = () => {};
    const setup = updateSetup(gitHost({ service: false, slow: new Promise<void>((resolve) => (finish = resolve)) }), { sendText: async () => undefined });
    const text = (await setup.commands.get("refine")!({ args: "update", agentId: "main", channel: "webchat", to: "agent:main:tray" }) as { text: string }).text;
    assert.equal(text, "Updating Refine Cycle; the result follows in my next reply to you.");
    finish();
    for (let i = 0; i < 20; i++) await settle();
    assert.match(setup.prompt({ sessionId: "s2", agentId: "main", runId: "r2", trigger: "user" }), /Refine Cycle — updated to 0\.2\.0; restart OpenClaw to finish\.$/);
  } finally {
    Object.assign(timing, saved);
  }
});

test("a late /refine session result for webchat comes through the agent, not only the log", async () => {
  const saved = timing.chatWaitMs;
  timing.chatWaitMs = 20;
  try {
    const answers: Array<(value: { text: string }) => void> = [];
    const setup = passSetup(() => new Promise((resolve) => answers.push(resolve)));
    const refine = setup.commands.get("refine")!;
    const started = (await refine({ args: "session s1", agentId: "main", channel: "webchat", to: "agent:main:tray" }) as { text: string }).text;
    assert.equal(started, "Pass over session s1 started; the result follows in my next reply to you when the model has answered.");
    for (let i = 0; i < 50 && answers.length < 1; i++) await settle();
    answers[0]({ text: lessonJson(setup.fp, setup.lessonText) });
    for (let i = 0; i < 20; i++) await settle();
    const prompt = setup.hooks.get("before_prompt_build")!.handler({}, { sessionId: "s9", agentId: "main", runId: "r9", trigger: "user" }) as { prependContext: string };
    assert.match(prompt.prependContext, /\[Refine Cycle notice\].*pass over session s1: .*lesson learned/);
  } finally {
    timing.chatWaitMs = saved;
  }
});

test("a direct send that fails goes through the agent instead of being lost", async () => {
  const { hooks, sent } = learningSetup({}, async () => {
    throw new Error("Telegram: chat not found");
  });
  hooks.get("agent_end")!.handler({}, telegramTurn("s1"));
  await settle();
  assert.equal(sent.length, 1, "the send was tried");
  const prompt = hooks.get("before_prompt_build")!.handler({}, { sessionId: "s2", agentId: "main", runId: "r2", trigger: "user" }) as { prependContext: string };
  assert.match(prompt.prependContext, /\[Refine Cycle notice\].*learned a new lesson/);
});
