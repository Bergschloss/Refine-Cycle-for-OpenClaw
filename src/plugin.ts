/**
 * The OpenClaw entry point: the only file that knows the host.
 *
 * - `before_prompt_build` puts the active lessons in front of the model. It reads
 *   lesson files and nothing else, and returns nothing on any error.
 * - `agent_end` queues the ended turn's session for the learning loop and
 *   returns at once; the loop runs in the background, one session at a time.
 * - `/refine` in chat and `openclaw refine-cycle` on the command line list,
 *   disable and delete lessons, and report what the loop decided.
 *
 * Nothing here patches the host, writes the user's files or sends a message the
 * user did not ask for.
 */

import os from "node:os";
import path from "node:path";
import { formatBlock, type Block } from "./core/injection.ts";
import { sqliteHistory, agentDatabasePath } from "./host/history.ts";
import { readSources } from "./host/sources.ts";
import { activeLessons, allLessons, setStatus } from "./lessons.ts";
import { processSession, recordExposure, report, type Llm } from "./pipeline.ts";
import { readSettings } from "./settings.ts";
import { FileStore } from "./store.ts";

// The slice of OpenClaw's plugin API this plugin uses (openclaw 2026.9.5,
// src/plugins/plugin-api.types.ts). Declared here so the plugin has no build-time
// dependency on the host package.
interface HookContext {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
}

interface CommandContext {
  args?: string;
}

interface CliCommand {
  command(spec: string): CliCommand;
  description(text: string): CliCommand;
  action(handler: (...args: unknown[]) => unknown): CliCommand;
}

export interface PluginApi {
  id: string;
  config?: { plugins?: { entries?: Record<string, { hooks?: { allowConversationAccess?: boolean } } | undefined> } };
  pluginConfig?: Record<string, unknown>;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  runtime?: {
    state?: { resolveStateDir?: () => string };
    llm?: {
      complete?: (params: Record<string, unknown>) => Promise<{ text: string }>;
    };
  };
  on(hook: string, handler: (event: unknown, ctx: HookContext) => unknown, options?: { timeoutMs?: number }): void;
  registerCommand?(command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    handler: (ctx: CommandContext) => { text: string } | Promise<{ text: string }>;
  }): void;
  registerCli?(
    registrar: (ctx: { program: CliCommand; workspaceDir?: string }) => void,
    options?: { commands?: string[]; descriptors?: Array<{ name: string; description: string; hasSubcommands: boolean }> },
  ): void;
}

const PLUGIN_DIR = "refine-cycle";
const PROMPT_HOOK_TIMEOUT_MS = 2_000;

function resolveStateDir(api: PluginApi): string {
  try {
    const dir = api.runtime?.state?.resolveStateDir?.();
    if (dir) return dir;
  } catch {
    // fall through to the host's documented default
  }
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

export default function register(api: PluginApi): void {
  const settings = readSettings(api.pluginConfig);
  const log = (message: string) => api.logger?.info?.(`[refine-cycle] ${message}`);
  const warn = (message: string) => (api.logger?.warn ?? api.logger?.info)?.(`[refine-cycle] ${message}`);
  if (!settings.enabled) {
    log("disabled in settings");
    return;
  }

  // OpenClaw only calls before_prompt_build and agent_end for a non-bundled plugin
  // the user has granted conversation access; without it the plugin is inert.
  if (api.config?.plugins?.entries?.[api.id]?.hooks?.allowConversationAccess !== true) {
    warn(
      `needs plugins.entries.${api.id}.hooks.allowConversationAccess = true in openclaw.json; ` +
        "until then OpenClaw does not call its hooks, so nothing is learned or injected",
    );
  }

  const stateDir = resolveStateDir(api);
  const store = new FileStore(path.join(stateDir, "plugin-data", PLUGIN_DIR));
  let storeError: string | null = null;
  try {
    store.open();
  } catch (error) {
    storeError = String(error);
    warn(`store unusable, nothing will be injected or learned: ${storeError}`);
  }

  /** What the prompt hook injected per session, recorded to the effect ledger after the turn. */
  const injected = new Map<string, Block>();

  api.on(
    "before_prompt_build",
    (_event, ctx) => {
      if (storeError || !settings.injectEnabled) return undefined;
      try {
        const block = formatBlock(activeLessons(store), settings.maxInjectedChars);
        if (!block) return undefined;
        if (ctx?.sessionId) injected.set(ctx.sessionId, block);
        return { prependContext: block.text };
      } catch (error) {
        warn(`injection skipped: ${String(error)}`);
        return undefined;
      }
    },
    { timeoutMs: PROMPT_HOOK_TIMEOUT_MS },
  );

  const complete = api.runtime?.llm?.complete;
  const llm: Llm | null =
    complete
      ? {
        async complete(systemPrompt, userMessage, timeoutMs) {
          const result = await complete({
            messages: [{ role: "user", content: userMessage }],
            systemPrompt,
            purpose: "refine-cycle: propose a lesson from a repeated failure",
            maxTokens: 400,
            temperature: 0,
            // No agentId: OpenClaw refuses a plugin call that names a target agent
            // ("cannot override the target agent"); the default is the agent's own model.
            signal: AbortSignal.timeout(timeoutMs),
          });
          return String(result?.text ?? "");
        },
      }
      : null;

  let queue: Promise<void> = Promise.resolve();
  const queued = new Set<string>();
  const enqueue = (ctx: HookContext) => {
    const sessionId = ctx.sessionId;
    if (!sessionId || queued.has(sessionId)) return;
    queued.add(sessionId);
    const agentId = ctx.agentId || "main";
    const workspaceDir = ctx.workspaceDir;
    queue = queue.then(async () => {
      queued.delete(sessionId);
      try {
        const block = injected.get(sessionId);
        injected.delete(sessionId);
        if (block) recordExposure(store, sessionId, block, new Date());
        const history = sqliteHistory(settings.historyDbPath || agentDatabasePath(stateDir, agentId));
        const decision = await processSession(
          {
            store,
            history,
            llm,
            sources: () => readSources(workspaceDir, settings.instructionFiles, settings.skillDirs),
            settings,
            now: () => new Date(),
            log,
          },
          sessionId,
          agentId,
        );
        if (decision.outcome !== "no_failures") log(`session ${sessionId}: ${decision.outcome}`);
      } catch (error) {
        warn(`learning skipped for ${sessionId}: ${String(error)}`);
      }
    });
  };

  api.on("agent_end", (_event, ctx) => {
    if (storeError || !ctx) return;
    enqueue(ctx);
  });

  const control = (args: string): string => {
    if (storeError) return `Refine Cycle cannot use its store: ${storeError}`;
    const [verb = "list", id = ""] = args.trim().split(/\s+/);
    const now = new Date();
    if (verb === "list") {
      const lessons = allLessons(store).filter((lesson) => lesson.status !== "deleted");
      if (lessons.length === 0) return "No lessons yet.";
      return lessons.map((lesson) => `${lesson.id} [${lesson.status}] ${lesson.text}`).join("\n");
    }
    if (verb === "disable" || verb === "delete") {
      if (!id) return `Usage: ${verb} <lesson id>`;
      const changed = setStatus(store, id, verb === "disable" ? "disabled" : "deleted", now);
      return changed ? `Lesson ${id} ${changed.status}.` : `No lesson ${id}.`;
    }
    if (verb === "report" || verb === "status") return JSON.stringify(report(store), null, 2);
    return "Usage: list | disable <id> | delete <id> | report";
  };

  api.registerCommand?.({
    name: "refine",
    description: "Refine Cycle lessons: list, disable <id>, delete <id>, report",
    acceptsArgs: true,
    handler: (ctx) => ({ text: control(ctx?.args ?? "") }),
  });

  api.registerCli?.(
    ({ program }) => {
      const root = program.command("refine-cycle").description("Refine Cycle: lessons learned from repeated failures");
      root.command("list").description("List lessons").action(() => console.log(control("list")));
      root.command("disable <id>").description("Stop injecting a lesson").action((id) => console.log(control(`disable ${String(id)}`)));
      root.command("delete <id>").description("Delete a lesson (kept as a tombstone)").action((id) => console.log(control(`delete ${String(id)}`)));
      root.command("report").description("What the learning loop decided, by rule").action(() => console.log(control("report")));
    },
    {
      commands: ["refine-cycle"],
      // Parse-time metadata: without it OpenClaw 2026.9.6 does not know the command.
      descriptors: [{ name: "refine-cycle", description: "Refine Cycle: lessons learned from repeated failures", hasSubcommands: true }],
    },
  );

  log(`ready, store at ${store.root}`);
}
