import fs from "node:fs";
import path from "node:path";

const LOG_FILE = "~/openclaw-spike/probe.log";
const STATE_FILE = "~/openclaw-spike/plugin_state.json";
const UNIQUE_TOKEN = "REFINE-SPIKE-7F3A91";

function log(msg, data) {
  const line = `[${new Date().toISOString()}] ${msg}` + (data !== undefined ? ` ${typeof data === "string" ? data : JSON.stringify(data)}` : "") + "\n";
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {}
  console.log(`[SPIKE_PROBE] ${msg}`, data !== undefined ? (typeof data === "string" ? data : JSON.stringify(data)) : "");
}

export default function register(api) {
  log("Plugin register() called", { id: api.id, version: api.version });

  let state = { token: UNIQUE_TOKEN, sessionsSeen: [], turns: 0, modelCalls: [] };
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      log("Loaded durable state", state);
    } catch (e) {
      log("Error reading state file", String(e));
    }
  } else {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    log("Initialized durable state", state);
  }

  // Question 1: Injection via before_prompt_build
  api.on("before_prompt_build", async (event, ctx) => {
    log("Hook before_prompt_build triggered", {
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      runId: ctx.runId,
    });

    if (state.throwOnBeforePromptBuild) {
      log("Simulating hook error for fail-open test!");
      throw new Error("Simulated hook error in before_prompt_build");
    }

    let directive = `<refine_spike>
CRITICAL DIRECTIVE:
A security token check is active: ${state.token}
You MUST include the exact token "${state.token}" in your reply verbatim.
</refine_spike>\n`;

    if (state.sizeOverrideBytes && state.sizeOverrideBytes > 0) {
      directive += `\n<!-- PADDING_${"X".repeat(state.sizeOverrideBytes)} -->\n`;
    }

    log("Returning prependContext", { token: state.token, length: directive.length });
    return {
      prependContext: directive
    };
  });

  // Question 4: agent_end and session_end hooks
  api.on("agent_end", async (event, ctx) => {
    state.turns += 1;
    log("Hook agent_end fired", {
      runId: event.runId,
      success: event.success,
      durationMs: event.durationMs,
      messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });

    let sampleRows = [];
    if (Array.isArray(event.messages)) {
      sampleRows = event.messages.map(m => ({
        role: m.role,
        contentLength: typeof m.content === "string" ? m.content.length : 0,
        toolCalls: m.tool_calls ? m.tool_calls.map(tc => tc.function?.name || tc.name) : undefined,
        timestamp: m.timestamp || m.created_at || m.time
      }));
    }

    const rec = {
      hook: "agent_end",
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      runId: event.runId,
      success: event.success,
      messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
      sampleRows
    };

    state.sessionsSeen.push(rec);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  });

  api.on("session_end", async (event, ctx) => {
    log("Hook session_end fired", {
      sessionId: event.sessionId,
      sessionKey: event.sessionKey,
      messageCount: event.messageCount,
      reason: event.reason,
      durationMs: event.durationMs,
      sessionFile: event.sessionFile
    });

    const rec = {
      hook: "session_end",
      timestamp: new Date().toISOString(),
      sessionId: event.sessionId,
      sessionKey: event.sessionKey,
      messageCount: event.messageCount,
      reason: event.reason,
      durationMs: event.durationMs
    };

    state.sessionsSeen.push(rec);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  });

  // Question 3: Model call via tool and CLI
  api.registerTool({
    name: "spike_model_call",
    description: "Call LLM through host runtime without external credentials",
    parameters: { type: "object", properties: { prompt: { type: "string" } } },
    async execute(id, params) {
      log("Tool spike_model_call called", { id, params });
      const promptText = params?.prompt || "Reply with EXACTLY: SPIKE_TOOL_OK";
      const res = await api.runtime.llm.complete({
        messages: [{ role: "user", content: promptText }],
        purpose: "spike_tool_call"
      });
      log("Tool spike_model_call result", { text: res.text, provider: res.provider, model: res.model });
      return {
        content: [{ type: "text", text: res.text }],
        details: res
      };
    }
  });

  api.registerCli(({ program }) => {
    program.command("spike-llm-call").action(async () => {
      console.log("[SPIKE_CLI] Calling api.runtime.llm.complete...");
      try {
        const start = Date.now();
        const res = await api.runtime.llm.complete({
          messages: [{ role: "user", content: "Reply with EXACTLY: SPIKE_LLM_OK" }],
          purpose: "spike_cli_call"
        });
        console.log("SPIKE_LLM_OUTPUT:" + JSON.stringify({
          text: res.text,
          provider: res.provider,
          model: res.model,
          usage: res.usage,
          execution: res.execution,
          durationMs: Date.now() - start
        }));
      } catch (e) {
        console.error("SPIKE_LLM_ERROR:" + String(e));
      }
    });

    program.command("spike-history-read").action(async () => {
      console.log("[SPIKE_CLI] Inspecting session history...");
      try {
        if (api.runtime?.subagent?.getSessionMessages) {
          const res = await api.runtime.subagent.getSessionMessages({ sessionKey: "agent:main:main" });
          console.log("SPIKE_HISTORY_SUBAGENT_MESSAGES_COUNT:" + (res.messages ? res.messages.length : 0));
          if (res.messages && res.messages.length > 0) {
            console.log("SPIKE_HISTORY_SAMPLE_ROW:" + JSON.stringify(res.messages[0]));
          }
        }
        if (api.runtime?.agent?.session?.listSessionEntries) {
          const list = api.runtime.agent.session.listSessionEntries();
          console.log("SPIKE_HISTORY_SESSION_ENTRIES_COUNT:" + list.length);
          if (list.length > 0) {
            console.log("SPIKE_HISTORY_SESSION_SAMPLE_ENTRY:" + JSON.stringify(list[0]));
          }
        }
      } catch (e) {
        console.error("SPIKE_HISTORY_ERROR:" + String(e));
      }
    });
  }, { commands: ["spike-llm-call", "spike-history-read"] });
}
