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

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatBlock, type Block } from "./core/injection.ts";
import { sqliteHistory, agentDatabasePath } from "./host/history.ts";
import { readSources } from "./host/sources.ts";
import { activeLessons, allLessons, DEFAULT_AGENT, lessonAgent, recover, setStatus } from "./lessons.ts";
import { processSession, recordExposure, report, type Llm } from "./pipeline.ts";
import { replay } from "./replay.ts";
import { readSettings } from "./settings.ts";
import { FileStore, StoreError } from "./store.ts";

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
  agentId?: string;
}

interface CliCommand {
  command(spec: string): CliCommand;
  description(text: string): CliCommand;
  action(handler: (...args: unknown[]) => unknown): CliCommand;
}

export interface PluginApi {
  id: string;
  /** "full", "cli-metadata", ...: in "cli-metadata" the runtime is deliberately unavailable. */
  registrationMode?: string;
  config?: {
    plugins?: {
      entries?: Record<string, { hooks?: { allowConversationAccess?: boolean; allowPromptInjection?: boolean } } | undefined>;
    };
  };
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
const MAX_BLOCKS_PER_SESSION = 20;
const MAX_SESSIONS_REMEMBERED = 500;

/**
 * OpenClaw runs a turn and its hooks inside an "async work scope" held in these
 * process-global AsyncLocalStorage slots (src/shared/async-work-scope.ts), and closes
 * it as soon as agent_end returns. Work started from the hook inherits the scope, so
 * anything it does later (a model call after a yield) fails with "Async work scope is
 * closed". The host's own runOutsideAsyncWorkScope() exits exactly these slots; so do
 * we. On a host without them this simply runs `run`.
 */
const HOST_WORK_SCOPE_SLOTS = [Symbol.for("openclaw.asyncWorkScope"), Symbol.for("openclaw.asyncWorkScopeAncestry")];

function runOutsideHostWorkScope<T>(run: () => T): T {
  let wrapped = run;
  for (const slot of HOST_WORK_SCOPE_SLOTS) {
    const storage = (globalThis as Record<PropertyKey, unknown>)[slot];
    if (storage instanceof AsyncLocalStorage) {
      const inner = wrapped;
      wrapped = () => storage.exit(inner);
    }
  }
  return wrapped();
}

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
  // OpenClaw registers plugins once only to read their CLI command names (taken from
  // the manifest's cliCommands) and blocks the runtime while doing so. Nothing here may
  // open the store or recover the journal then; the full registration does it.
  if (api.registrationMode === "cli-metadata") return;

  // OpenClaw only calls before_prompt_build and agent_end for a non-bundled plugin
  // the user has granted conversation access; without it the plugin is inert.
  const hookPolicy = api.config?.plugins?.entries?.[api.id]?.hooks;
  if (hookPolicy?.allowConversationAccess !== true) {
    warn(
      `needs plugins.entries.${api.id}.hooks.allowConversationAccess = true in openclaw.json; ` +
        "until then OpenClaw does not call its hooks, so nothing is learned or injected",
    );
  }

  // Prompt changes are allowed unless the user sets this to false
  // (OpenClaw's resolvePromptInjectionAllowed). When it is false the host drops the
  // block, so nothing is injected and no exposure may be recorded.
  const injectionAllowed = hookPolicy?.allowPromptInjection !== false;
  if (!injectionAllowed) {
    warn(`plugins.entries.${api.id}.hooks.allowPromptInjection is false: lessons are learned but never shown to the model`);
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
  if (!storeError) {
    // Finish what a crash left half-done before anything reads the lessons.
    try {
      recover(store, new Date());
    } catch (error) {
      warn(`journal recovery skipped: ${String(error)}`);
    }
  }

  /**
   * What the prompt hook injected per session, recorded to the effect ledger after
   * the turn. `shownAtMs` is when the block was built: failures after it happened
   * with the lesson in view.
   * Bounded, because a run that never reaches agent_end leaves its entry behind.
   */
  const injected = new Map<string, Array<{ block: Block; shownAtMs: number }>>();
  let lastOmitted = "";
  const remember = (sessionId: string, block: Block) => {
    const entries = injected.get(sessionId) ?? [];
    if (!entries.some((entry) => entry.block.hash === block.hash)) entries.push({ block, shownAtMs: Date.now() });
    injected.delete(sessionId);
    injected.set(sessionId, entries.slice(-MAX_BLOCKS_PER_SESSION));
    while (injected.size > MAX_SESSIONS_REMEMBERED) injected.delete(injected.keys().next().value!);
  };

  api.on(
    "before_prompt_build",
    (_event, ctx) => {
      if (storeError || !settings.injectEnabled || !injectionAllowed) return undefined;
      try {
        const block = formatBlock(activeLessons(store, ctx?.agentId || DEFAULT_AGENT), settings.maxInjectedChars);
        if (!block) return undefined;
        if (ctx?.sessionId) remember(ctx.sessionId, block);
        const omitted = (block.omittedIds ?? []).join(",");
        if (omitted && omitted !== lastOmitted) {
          warn(`${block.omittedIds!.length} active lesson(s) do not fit maxInjectedChars and are not shown: ${omitted}`);
        }
        lastOmitted = omitted;
        return { prependContext: block.text };
      } catch (error) {
        warn(`injection skipped: ${String(error)}`);
        return undefined;
      }
    },
    { timeoutMs: PROMPT_HOOK_TIMEOUT_MS },
  );

  // Read through a guard: during some registration passes the runtime is a proxy that
  // throws. Whether the host offers a model call at all is decided here, once; the
  // function itself is looked up again for each call.
  const hostComplete = () => {
    try {
      return api.runtime?.llm?.complete;
    } catch {
      return undefined;
    }
  };
  const llm: Llm | null =
    hostComplete()
      ? {
        async complete(systemPrompt, userMessage, timeoutMs) {
          const complete = hostComplete();
          if (!complete) throw new Error("the host offers no model call");
          // A synchronous throw from the host becomes a rejection here, so it is handled
          // like any other failure; the timer is armed only once the call exists.
          const call = Promise.resolve().then(() =>
            complete({
              messages: [{ role: "user", content: userMessage }],
              systemPrompt,
              purpose: "refine-cycle: propose a lesson from a repeated failure",
              maxTokens: 400,
              temperature: 0,
              // No agentId: OpenClaw refuses a plugin call that names a target agent
              // ("cannot override the target agent"); the default is the agent's own model.
              signal: AbortSignal.timeout(timeoutMs),
            }),
          );
          // If the timeout wins, the call may still reject later: that must not surface
          // as an unhandled rejection in the host's process.
          call.catch(() => undefined);
          // The host is asked to abort via `signal`; the plugin does not rely on it.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`model call timed out after ${timeoutMs} ms`)), timeoutMs);
          });
          try {
            const result = await Promise.race([call, timeout]);
            return String(result?.text ?? "");
          } finally {
            clearTimeout(timer);
          }
        },
      }
      : null;

  let queue: Promise<void> = Promise.resolve();
  const queued = new Set<string>();
  const enqueue = (ctx: HookContext) => {
    const sessionId = ctx.sessionId;
    if (!sessionId || queued.has(sessionId)) return;
    queued.add(sessionId);
    const agentId = ctx.agentId || DEFAULT_AGENT;
    const workspaceDir = ctx.workspaceDir;
    queue = queue.then(async () => {
      queued.delete(sessionId);
      try {
        const shown = injected.get(sessionId) ?? [];
        injected.delete(sessionId);
        for (const { block, shownAtMs } of shown) recordExposure(store, sessionId, block, shownAtMs, new Date());
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
    // The queue is chained outside the turn's work scope, so the learning work (and
    // its model call) does not run inside a scope the host closes when this returns.
    runOutsideHostWorkScope(() => enqueue(ctx));
  });

  /** `agentId` limits a chat command to that agent's lessons; the command line sees all of them. */
  const control = (args: string, agentId?: string): string => {
    if (storeError) return `Refine Cycle cannot use its store: ${storeError}`;
    const [verb = "list", id = ""] = args.trim().split(/\s+/).filter(Boolean);
    const now = new Date();
    const mine = allLessons(store).filter((lesson) => agentId === undefined || lessonAgent(lesson) === agentId);
    if (verb === "list") {
      const lessons = mine.filter((lesson) => lesson.status !== "deleted");
      if (lessons.length === 0) return "No lessons yet.";
      return lessons.map((lesson) => `${lesson.id} [${lesson.status}] ${lesson.text}`).join("\n");
    }
    if (verb === "disable" || verb === "delete") {
      if (!id) return `Usage: ${verb} <lesson id>`;
      if (!mine.some((lesson) => lesson.id === id)) return `No lesson ${id}.`;
      recover(store, now); // non-blocking: skipped while another process holds the lock
      let changed;
      try {
        // In chat the gateway thread must not wait; the command line may.
        changed = setStatus(store, id, verb === "disable" ? "disabled" : "deleted", now, agentId === undefined ? 5_000 : 0);
      } catch (error) {
        if (error instanceof StoreError) return "The lesson store is busy; try again in a moment.";
        throw error;
      }
      return changed ? `Lesson ${id} ${changed.status}.` : `No lesson ${id}.`;
    }
    if (verb === "report" || verb === "status") return JSON.stringify(report(store), null, 2);
    return "Usage: list | disable <id> | delete <id> | report";
  };

  api.registerCommand?.({
    name: "refine",
    description: "Refine Cycle lessons: list, disable <id>, delete <id>, report",
    acceptsArgs: true,
    handler: (ctx) => ({ text: control(ctx?.args ?? "", ctx?.agentId || DEFAULT_AGENT) }),
  });

  api.registerCli?.(
    ({ program }) => {
      const root = program.command("refine-cycle").description("Refine Cycle: lessons learned from repeated failures");
      root.command("list").description("List lessons").action(() => console.log(control("list")));
      root.command("disable <id>").description("Stop injecting a lesson").action((id) => console.log(control(`disable ${String(id)}`)));
      root.command("delete <id>").description("Delete a lesson (kept as a tombstone)").action((id) => console.log(control(`delete ${String(id)}`)));
      root.command("report").description("What the learning loop decided, by rule").action(() => console.log(control("report")));
      root
        .command("replay <corpus> <storeDir> [sourcesDir]")
        .description("Measurement: run the loop over a recorded corpus (JSONL) into a separate store")
        .action(async (corpus, storeDir, sourcesDir) => {
          const dir = typeof sourcesDir === "string" ? sourcesDir : undefined;
          const result = await runOutsideHostWorkScope(() => replay({
            corpusFile: String(corpus),
            storeDir: String(storeDir),
            llm,
            // Every top-level .md in the directory is an instruction file, plus skills/**/SKILL.md.
            sources: dir
              ? readSources(dir, fs.readdirSync(dir).filter((name) => name.endsWith(".md")), [path.join(dir, "skills")])
              : [],
            // One run, many sessions: the daily cap is for live use, not the harness.
            settings: { ...settings, maxModelCallsPerDay: 100_000 },
            log: (message) => console.log(message),
          }));
          console.log(JSON.stringify({ ...result, lessons: result.lessons.length }, null, 2));
        });
    },
    {
      commands: ["refine-cycle"],
      // Parse-time metadata: without it OpenClaw 2026.9.6 does not know the command.
      descriptors: [{ name: "refine-cycle", description: "Refine Cycle: lessons learned from repeated failures", hasSubcommands: true }],
    },
  );

  log(`ready, store at ${store.root}`);
}
