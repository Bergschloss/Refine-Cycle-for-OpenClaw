/**
 * The OpenClaw entry point: the only file that knows the host.
 *
 * - `before_prompt_build` puts the active lessons in front of the model. It reads
 *   lesson files and nothing else, and returns nothing on any error.
 * - `agent_end` queues the ended turn's session for the learning loop and
 *   returns at once; the loop runs in the background, one session at a time.
 * - `/refine` in chat and `openclaw refine-cycle` on the command line list, judge,
 *   disable and delete lessons, report what the loop decided and what blocks it,
 *   start a pass by hand, choose the model and update the plugin.
 * - The optional `refine_run` tool lets the agent ask for a pass.
 *
 * Nothing here patches the host or writes the user's files. It sends two messages by
 * itself, both owner decisions: one line when a lesson is learned, and one when a new
 * release is out (with an Update button).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatBlock, type Block } from "./core/injection.ts";
import { sqliteHistory, agentDatabasePath } from "./host/history.ts";
import { warmUpNormalizer } from "./core/fingerprint.ts";
import { readSources } from "./host/sources.ts";
import { activeLessons, allLessons, DEFAULT_AGENT, enable, lessonAgent, recover, setStatus } from "./lessons.ts";
import { audit, callsToday, describeAudit, describePass, ensureLedger, describeReport, describeStatus, knownAgents, processSession, RAW_FORMAT, recordExposure, report, status, tidy, type Decision, type Deps, type Llm, type PassOptions, type RawLessonStatusLine } from "./pipeline.ts";
import { replay } from "./replay.ts";
import { readSettings } from "./settings.ts";
import { agentNotices, lessonNotice, overLimitNotice, overLimitSentence, plainSentence, lessonSentence, storeErrorSentence, storeErrorText, tidyNotice, tidySentence } from "./core/notice.ts";
import {
  actionLine, autoFailedText, autoUpdatedText, availableText, restartNeededText, checkDue, failedText, failureReason, hostUpdateLine, isNewer, latestTag, parseVersion, toAnnounce, toInstall,
  UPDATE_COMMAND, updatedText, upToDateText, type UpdateState,
} from "./core/update.ts";
import { dropNotice, handNotices, keepNotice, settleNotices } from "./notices.ts";
import { Runs, type RunSeen } from "./runs.ts";
import { FileStore, StoreError } from "./store.ts";

// The slice of OpenClaw's plugin API this plugin uses (openclaw 2026.9.5,
// src/plugins/plugin-api.types.ts). Declared here so the plugin has no build-time
// dependency on the host package.
interface HookContext {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  /** The chat the turn came from, when it came from a channel (telegram, …). */
  channel?: string;
  accountId?: string;
  chatId?: string;
  /** What started the run (2026.9.6 PluginHookAgentContext): user, heartbeat, cron, manual, memory, overflow. */
  trigger?: string;
  /** The host's id for this agent run; the same in before_prompt_build and agent_end (buildAgentHookContext). */
  runId?: string;
}

/** Runs no person started: their session is not where the user reads a reply. */
const BACKGROUND_TRIGGERS: ReadonlySet<string> = new Set(["heartbeat", "cron", "memory", "overflow"]);

/** Where to reach the user: a channel, its chat id, and the channel account. */
interface Chat {
  channel: string;
  to: string;
  accountId?: string;
}

/** A channel's outbound adapter, as far as the plugin uses it (plugin-sdk ChannelOutboundAdapter). */
interface OutboundAdapter {
  sendText?: (ctx: { cfg: unknown; to: string; text: string; accountId?: string | null }) => Promise<unknown>;
  /** A payload with a `presentation` (buttons): the channel renders it natively or as text (2026.9.6). */
  sendPayload?: (ctx: { cfg: unknown; to: string; text: string; accountId?: string | null; payload: Record<string, unknown> }) => Promise<unknown>;
  presentationCapabilities?: { supported?: boolean; buttons?: boolean };
}

/** The part of the host's ReplyPayload a command answers with (2026.9.6 PluginCommandResult). */
interface CommandReply {
  text: string;
  presentation?: Presentation;
}

type Presentation = { blocks: Array<{ type: "buttons"; buttons: Array<{ label: string; action: { type: "command"; command: string } }> }> };

/** The Update button: it runs `/refine update` in the chat it is pressed in. */
const UPDATE_BUTTON: Presentation = { blocks: [{ type: "buttons", buttons: [{ label: "Update", action: { type: "command", command: UPDATE_COMMAND } }] }] };

interface CommandContext {
  args?: string;
  /** False when the sender is not on the channel's allowlist (the host refuses them unless a command opts out). */
  isAuthorizedSender?: boolean;
  /** The host's session for the chat, when the command has one. */
  sessionId?: string;
  /** The host's agent for the command's session; absent when the command has no session. */
  agentId?: string;
  sessionKey?: string;
  /**
   * The chat the command came from (2026.9.6 PluginCommandContext): the channel, and `to`,
   * the host's own routing target for the reply (Telegram: `telegram:<chatId>`, which its
   * outbound adapter reads as the chat id), with the channel account.
   */
  channel?: string;
  to?: string;
  accountId?: string;
}

/** The chat a command came from, when its context names one. */
function commandChat(ctx: CommandContext | undefined): Chat | null {
  return ctx?.channel && ctx.to ? { channel: ctx.channel, to: ctx.to, ...(ctx.accountId ? { accountId: ctx.accountId } : {}) } : null;
}

/** The agent a chat command belongs to: the host's, else the one its session key names (`agent:<id>:…`). */
function commandAgent(ctx: CommandContext | undefined): string | undefined {
  return ctx?.agentId || /^agent:([^:]+):/i.exec(ctx?.sessionKey ?? "")?.[1] || undefined;
}

/** What a tool factory is given for one agent run (2026.9.6 OpenClawPluginToolContextBase, the part used here). */
interface ToolContext {
  agentId?: string;
  sessionId?: string;
  workspaceDir?: string;
}

/** An agent tool as the host takes it (2026.9.6 AnyAgentTool, the part used here). */
interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

interface CliCommand {
  command(spec: string): CliCommand;
  description(text: string): CliCommand;
  option(flags: string, description: string): CliCommand;
  action(handler: (...args: unknown[]) => unknown): CliCommand;
}

export interface PluginApi {
  id: string;
  /** "full", "cli-metadata", ...: in "cli-metadata" the runtime is deliberately unavailable. */
  registrationMode?: string;
  config?: {
    agents?: { defaults?: { model?: string | { primary?: string } } };
    plugins?: {
      entries?: Record<string, {
        hooks?: { allowConversationAccess?: boolean; allowPromptInjection?: boolean };
        /** The host's own policy for this plugin's model calls (2026.9.6 runtime-llm): a model is sent only when allowed. */
        llm?: { allowModelOverride?: boolean; allowedModels?: string[] };
      } | undefined>;
    };
  };
  pluginConfig?: Record<string, unknown>;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  runtime?: {
    state?: { resolveStateDir?: () => string };
    llm?: {
      complete?: (params: Record<string, unknown>) => Promise<{ text: string }>;
    };
    agent?: { resolveAgentWorkspaceDir?: (cfg: unknown, agentId: string) => string };
    system?: {
      runCommandWithTimeout?: (argv: string[], options: { timeoutMs?: number; maxOutputBytes?: number }) => Promise<{ stdout: string; stderr: string; code: number | null }>;
    };
    channel?: { outbound?: { loadAdapter?: (id: string) => Promise<OutboundAdapter | undefined> } };
  };
  on(hook: string, handler: (event: unknown, ctx: HookContext) => unknown, options?: { timeoutMs?: number }): void;
  registerTool?(tool: (ctx: ToolContext) => AgentTool | null, options?: { name?: string; optional?: boolean }): void;
  registerCommand?(command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    handler: (ctx: CommandContext) => CommandReply | Promise<CommandReply>;
  }): void;
  registerCli?(
    registrar: (ctx: { program: CliCommand; workspaceDir?: string }) => void,
    options?: { commands?: string[]; descriptors?: Array<{ name: string; description: string; hasSubcommands: boolean }> },
  ): void;
}

const PLUGIN_DIR = "refine-cycle";
/** How long a chat command waits for its pass before it answers "started" and sends the result later. Tests shorten it. */
/**
 * `quietMs`: how long the gateway must be quiet (no run, no turn) before an automatic
 * update, which reloads plugins and would break a conversation in progress. `lostRunMs`: a run
 * not seen to end in this long (one that failed before `agent_end`) no longer holds that update;
 * 0 means the host's own agent timeout plus five minutes. `restartPollMs`: after `/refine update`,
 * how often the restart looks again for a moment with no run in progress, and `restartMaxWaitMs`
 * how long at most before it restarts anyway (with `--safe`, which drains admitted work).
 * `serviceTries`/`serviceRetryMs` and `adapterTries`/`adapterRetryMs`: right after `plugins
 * update` the host is still reloading, and a `gateway status` call or a channel adapter lookup
 * made then can fail (live, 2026-10-01: a systemd service taken for none, a Telegram chat taken
 * for one that cannot be sent to); they are tried again this many times, this far apart.
 * Tests shorten them.
 */
export const timing = {
  chatWaitMs: 10_000,
  quietMs: 10 * 60_000,
  lostRunMs: 0,
  restartPollMs: 5_000,
  restartMaxWaitMs: 30 * 60_000,
  serviceTries: 3,
  serviceRetryMs: 5_000,
  adapterTries: 5,
  adapterRetryMs: 3_000,
};

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
/**
 * When a started gateway warms the error normalizer up: the first Unicode-aware match
 * costs V8 ~200 ms once per process (measured on 2026.9.6, Node 26), and it should not
 * land in a user's first learning pass. A timer the process does not wait for, so a
 * command-line run, which ends first, never pays it.
 */
const WARM_UP_DELAY_MS = 30_000;
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
  // `openclaw plugins validate` calls a package's default export with no argument, to
  // read defineToolPlugin() metadata. This plugin registers through the API instead, so
  // there is nothing to register without one; returning lets the host say so.
  if (!api || typeof api.on !== "function") return;
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
  /** The store error was passed to the agent for the user: once per process. */
  let storeErrorTold = false;
  try {
    store.open();
    if (store.repairedMeta) warn(`meta.json was unreadable; it is kept as ${store.repairedMeta} and a new one was written`);
  } catch (error) {
    storeError = String(error);
    warn(`store unusable, nothing will be injected or learned. ${storeErrorText(store.root, storeError).replace(/\n/g, "; ")}`);
  }
  /** The last journal recovery this process ran, for `status`. */
  let lastRecovery: { at: string; finished: number; abandoned: number; unreadable: number; skipped?: boolean } | null = null;
  if (!storeError) {
    // Finish what a crash left half-done before anything reads the lessons.
    try {
      lastRecovery = { at: new Date().toISOString(), ...recover(store, new Date()) };
    } catch (error) {
      warn(`journal recovery skipped: ${String(error)}`);
    }
  }

  /**
   * The model lessons are written with, as in Hermes' `/refine model`: the one set with
   * `/refine model` first, then the `model` setting, else none (the default agent's). It
   * is sent only when OpenClaw lets this plugin choose (`llm.allowModelOverride`); a model
   * that is set but not allowed is dropped, and `status` says so.
   */
  const MODEL_OVERRIDE = "model.json";
  const effectiveModel = (): { chosen?: string; source: "command" | "setting" | "default"; sent?: string; dropped?: string } => {
    const command = store.read<{ model?: string }>(MODEL_OVERRIDE)?.model;
    const chosen = command || settings.model || undefined;
    const source = command ? "command" : settings.model ? "setting" : "default";
    if (!chosen) return { source };
    const allowed = api.config?.plugins?.entries?.[api.id]?.llm?.allowModelOverride === true;
    return allowed ? { chosen, source, sent: chosen } : { chosen, source, dropped: chosen };
  };

  /** The workspace each agent was last seen working in; else the host's own answer. */
  const workspaces = new Map<string, string>();
  const workspaceFor = (agentId: string): string | undefined => {
    const known = workspaces.get(agentId);
    if (known) return known;
    try {
      return api.runtime?.agent?.resolveAgentWorkspaceDir?.(api.config, agentId) || undefined;
    } catch {
      return undefined;
    }
  };
  /** With `rawLog` on, one raw line to today's file in the store (docs/proof/RAW-FORMAT.md). */
  const writeRaw = (line: object) => store.appendLine(`raw/${new Date().toISOString().slice(0, 10)}.jsonl`, JSON.stringify(line));
  /** What the loop needs for one agent: its history, its instructions and skills, the model call. */
  const depsFor = (agentId: string, workspaceDir = workspaceFor(agentId)): Deps => ({
    store,
    history: sqliteHistory(settings.historyDbPath || agentDatabasePath(stateDir, agentId)),
    llm,
    sources: () => readSources(workspaceDir, settings.instructionFiles, settings.skillDirs),
    settings,
    now: () => new Date(),
    log,
    ...(settings.rawLog ? { raw: writeRaw } : {}),
  });

  /**
   * What the prompt hook injected per session, recorded to the effect ledger after
   * the turn. `shownAtMs` is when the block was built: failures after it happened
   * with the lesson in view.
   * Bounded, because a run that never reaches agent_end leaves its entry behind.
   */
  const injected = new Map<string, Array<{ block: Block; shownAtMs: number }>>();
  let lastOver = false;
  const remember = (sessionId: string, block: Block) => {
    const entries = injected.get(sessionId) ?? [];
    if (!entries.some((entry) => entry.block.hash === block.hash)) entries.push({ block, shownAtMs: Date.now() });
    injected.delete(sessionId);
    injected.set(sessionId, entries.slice(-MAX_BLOCKS_PER_SESSION));
    while (injected.size > MAX_SESSIONS_REMEMBERED) injected.delete(injected.keys().next().value!);
  };

  /**
   * A notice asking for a restart to finish the update to the version running now, kept by
   * an earlier process: the restart has happened (live, 2026-10-01: after a manual restart the
   * agent still asked for one). Done here, in the first prompt hook per agent, not at
   * registration: the command line (`openclaw refine-cycle ...`) registers the plugin in its
   * own new process too, and the gateway there may still need its restart. A hot reload keeps
   * the process, so a notice kept since it is not dropped.
   */
  const processStart = new Date(Date.now() - process.uptime() * 1000);
  const restartChecked = new Set<string>();
  const dropRestartNotice = (agentId: string) => {
    if (restartChecked.has(agentId)) return;
    restartChecked.add(agentId);
    if (dropNotice(store, agentId, `restart ${version}`, processStart)) log(`restart ${version}: OpenClaw was restarted since; the notice asking for it is dropped`);
  };

  /**
   * Notices waiting for the agent, handed to this run when a person started it (not the
   * heartbeat, a cron job, memory or overflow: nobody reads those replies). Never throws.
   */
  const handNoticesTo = (ctx: HookContext | undefined): string | null => {
    if (BACKGROUND_TRIGGERS.has(ctx?.trigger ?? "")) return null;
    try {
      dropRestartNotice(ctx?.agentId || DEFAULT_AGENT);
      const inProgress = (holder: string[]) => runsInProgress().some((run) => run.ids.some((id) => holder.includes(id)));
      const sentences = handNotices(store, ctx?.agentId || DEFAULT_AGENT, runIds(ctx), inProgress, new Date());
      return sentences ? agentNotices(sentences) : null;
    } catch (error) {
      warn(`notices not handed to the agent: ${String(error)}`);
      return null;
    }
  };

  /** A run ended: the notices it was handed are done if it replied; otherwise the next run gets them. */
  const settleNoticesOf = (ctx: HookContext, replied: boolean) => {
    try {
      const result = settleNotices(store, ctx.agentId || DEFAULT_AGENT, runIds(ctx), replied);
      if (result) log(result === "passed" ? "notices passed to the user through the agent" : "the run that had the notices ended without a reply; the next turn gets them");
    } catch (error) {
      warn(`notices not settled: ${String(error)}`);
    }
  };

  api.on(
    "before_prompt_build",
    (_event, ctx) => {
      runStarted(ctx);
      if (!injectionAllowed) return undefined;
      // A store it cannot use leaves the plugin idle (fail open); the user hears it once, from
      // the agent, since the notice mailbox lives in that store too.
      if (storeError) {
        if (storeErrorTold || runIds(ctx).length === 0 || BACKGROUND_TRIGGERS.has(ctx?.trigger ?? "")) return undefined;
        storeErrorTold = true;
        return { prependContext: agentNotices([storeErrorSentence(store.root, storeError)]) };
      }
      try {
        const block = settings.injectEnabled ? formatBlock(activeLessons(store, ctx?.agentId || DEFAULT_AGENT)) : null;
        if (block && ctx?.sessionId) remember(ctx.sessionId, block);
        if (block) {
          // The limit is soft: every lesson is shown; the log says once when the block passes it.
          const over = block.text.length > settings.maxInjectedChars;
          if (over && !lastOver) {
            warn(`the lessons block is ${block.text.length} characters, over the soft limit of ${settings.maxInjectedChars}; every lesson is still shown`);
          }
          lastOver = over;
        }
        const notices = handNoticesTo(ctx);
        const text = [block?.text, notices].filter(Boolean).join("\n\n");
        return text ? { prependContext: text } : undefined;
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
              // Only a model the host lets this plugin choose; otherwise none, and the host uses its default agent's.
              ...(effectiveModel().sent ? { model: effectiveModel().sent } : {}),
              maxTokens: 400,
              temperature: 0,
              // No agentId: OpenClaw refuses a plugin call that names a target agent
              // ("cannot override the target agent"); the host then uses its default agent's model.
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

  let queue: Promise<unknown> = Promise.resolve();
  const queued = new Set<string>();
  /** The channel's outbound adapter; none on a channel without one, or when the host's lookup fails. */
  const adapterFor = async (channel: string): Promise<OutboundAdapter | undefined> => {
    try {
      return await api.runtime?.channel?.outbound?.loadAdapter?.(channel);
    } catch (error) {
      log(`channel ${channel}: the host did not load its adapter: ${String(error).slice(0, 200)}`);
      return undefined;
    }
  };
  /**
   * The adapter of a chat known to take messages, looked up again while the host is still
   * reloading after an update (`settle`): a lookup made then can come back empty.
   */
  const settledAdapter = async (channel: string, settle: boolean): Promise<OutboundAdapter | undefined> => {
    for (let attempt = 1; ; attempt++) {
      const adapter = await adapterFor(channel);
      if (adapter?.sendText || adapter?.sendPayload || !settle || attempt >= timing.adapterTries) return adapter;
      await pause(timing.adapterRetryMs);
    }
  };
  /** Can a plugin send to this chat? The web UI, gateway `chat.send` and the heartbeat's channel cannot. */
  const reachable = async (chat: Chat | null, settle = false): Promise<boolean> => {
    if (!chat) return false;
    const adapter = await settledAdapter(chat.channel, settle);
    return !!(adapter?.sendText || adapter?.sendPayload);
  };

  /**
   * The chat the user is talking from: the current turn's, when a plugin can send to it,
   * else the last such chat this agent was talked to from, kept in the store so a restart
   * does not forget it. A turn with no chat (a cron job, the command line) or one a plugin
   * cannot reach (webchat, the heartbeat) leaves it as it is: that is what lost every
   * message in R5, when the heartbeat's webchat turn replaced the Telegram chat.
   * Written only when it changes.
   */
  const currentChat = async (agentId: string, turn: Chat | null): Promise<Chat | null> => {
    const path = `chats/${agentId}.json`;
    const stored = store.read<Chat>(path);
    const known = stored && stored.channel && stored.to ? stored : null;
    if (!turn || !(await reachable(turn))) return known;
    if (!known || known.channel !== turn.channel || known.to !== turn.to || known.accountId !== turn.accountId) {
      store.write(path, turn);
    }
    return turn;
  };

  /**
   * Where a chat command's late result goes: the chat the command came from, else (no chat
   * in its context, or one a plugin cannot reach) the chat the agent is talked to from.
   */
  const replyChat = async (agentId: string, from: Chat | null): Promise<Chat | null> =>
    (await reachable(from)) ? from : currentChat(agentId, null);

  /** "In this chat", or where the late result will go instead. */
  const followsIn = (target: Chat | null, from: Chat | null): string =>
    target && from && target.channel === from.channel && target.to === from.to
      ? "in this chat"
      : target
        ? `in your ${target.channel} chat`
        : "in my next reply to you";

  /**
   * A command's late result: to the chat it is for, and when there is none a plugin can send
   * to (webchat, the Tray) or the send fails, through the agent's next reply. Never lost to
   * the log alone. The chat's adapter is looked up again while it comes back empty: the
   * result of an update arrives while the host is reloading its channels.
   */
  const sayLate = async (agentId: string, target: Chat | null, text: string, what: string): Promise<void> => {
    if (target && (await say(target, text, what, true))) return;
    tellThroughAgent(agentId, plainSentence(text), what);
  };

  /** Send one message to a chat; false (and a log line) when there is no chat or the channel takes none. */
  const say = async (chat: Chat | null, text: string, what: string, settle = false): Promise<boolean> => {
    if (!chat) {
      log(`${what}: no chat to tell (the agent has not yet been talked to from a channel a plugin can send to; webchat and the heartbeat cannot take one)`);
      return false;
    }
    try {
      const adapter = await settledAdapter(chat.channel, settle);
      if (!adapter?.sendText) {
        log(`${what}: channel ${chat.channel} cannot take a message from a plugin`);
        return false;
      }
      await adapter.sendText({ cfg: api.config, to: chat.to, text, accountId: chat.accountId ?? null });
      log(`${what}: told the user on ${chat.channel}`);
      return true;
    } catch (error) {
      warn(`${what}: could not tell the user on ${chat.channel}: ${String(error)}`);
      return false;
    }
  };

  /**
   * Tell the user that new lessons were learned: one line, in the chat they are talking
   * from. Once per run that activated lessons (the caller compares the active lessons
   * before and after); a send that fails is logged, not retried.
   */
  const announce = async (agentId: string, lessonIds: string[], chat: Chat | null) => {
    if (!settings.notifyOnLesson || lessonIds.length === 0) return;
    const used = formatBlock(activeLessons(store, agentId))?.text.length ?? 0;
    await notify(agentId, chat, lessonNotice(used, settings.maxInjectedChars), lessonSentence(used, settings.maxInjectedChars), `lesson ${lessonIds.join(", ")}`);
  };

  /**
   * Give a notice to the agent for the user, for a chat a plugin cannot send to (webchat,
   * the Tray): kept in the store (`src/notices.ts`) and handed by the prompt hook to the
   * next turn a person starts. False when it cannot be stored.
   */
  const tellThroughAgent = (agentId: string, sentence: string, what: string): boolean => {
    try {
      keepNotice(store, agentId, what, sentence, new Date());
      log(`${what}: no chat a plugin can send to; the agent passes it on in its next reply`);
      return true;
    } catch (error) {
      warn(`${what}: could not keep the notice for the agent: ${String(error)}`);
      return false;
    }
  };

  /**
   * One notice, once: straight to a chat a plugin can send to, else through the agent in the
   * next turn the user starts. A direct send that fails goes through the agent instead, so
   * it is not lost; never both. True when it was sent or kept for the agent.
   */
  const notify = async (agentId: string, chat: Chat | null, text: string, sentence: string, what: string, settle = false): Promise<boolean> => {
    if ((await reachable(chat, settle)) && (await say(chat, text, what, settle))) return true;
    return tellThroughAgent(agentId, sentence, what);
  };

  /** Run `job` after everything queued before it: one learning pass at a time in this process. */
  const schedule = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  /** The per-lesson ledger, built once from the effect records an older version left; the audit waits for it. */
  const ledgerReady: Promise<boolean> = storeError
    ? Promise.resolve(false)
    : runOutsideHostWorkScope(() => schedule(() => ensureLedger(store, new Date()))).catch((error: unknown) => {
      warn(`ledger build skipped: ${String(error)}`);
      return false;
    });

  /** Whether the last tidy found nothing it may switch off: said once, not on every turn. */
  let tidyStuck = false;
  /** Marks that the user was told the block is over the limit with nothing to switch off; removed once it fits. */
  const overLimitPath = (agentId: string) => `tidy/over-limit-${agentId}.json`;

  /**
   * Over the soft limit, the tidy (`autoTidy`): switch off lessons the audit judges useless
   * until the block fits, then one line about it. With nothing it may switch off, or with
   * the setting off, the user is told once (not only the log), until the block fits again.
   */
  const tidyUp = async (agentId: string, chat: Chat | null) => {
    const result = settings.autoTidy ? tidy(store, agentId, new Date(), settings.maxInjectedChars) : null;
    const used = result ? result.after : formatBlock(activeLessons(store, agentId))?.text.length ?? 0;
    if (used <= settings.maxInjectedChars) {
      tidyStuck = false;
      if (store.exists(overLimitPath(agentId))) store.remove(overLimitPath(agentId));
      if (!result?.disabled.length) return;
    } else if (!result || result.disabled.length === 0) {
      if (!tidyStuck) warn(`tidy: the lessons block is ${used} characters, over the soft limit of ${settings.maxInjectedChars}, and ${settings.autoTidy ? "no lesson is judged 'did not help' or 'unused'" : "autoTidy is off"}; nothing was switched off`);
      tidyStuck = true;
      if (result?.busy) log("tidy: the lesson store is busy; tried again after the next turn");
      if (!store.exists(overLimitPath(agentId))) {
        const told = await notify(agentId, chat, overLimitNotice(used, settings.maxInjectedChars), overLimitSentence(used, settings.maxInjectedChars), "over limit");
        if (told) store.write(overLimitPath(agentId), { at: new Date().toISOString(), used });
      }
      return;
    }
    if (result.busy) log("tidy: the lesson store is busy; tried again after the next turn");
    log(`tidy: switched off ${result.disabled.map((d) => `${d.id} (${d.verdict})`).join(", ")}; lessons ${result.before} -> ${result.after}/${result.limit}`);
    for (const { id, verdict: why } of result.disabled) {
      if (!settings.rawLog) break;
      try {
        const line: RawLessonStatusLine = { kind: "lesson_status", format: RAW_FORMAT, at: new Date().toISOString(), lessonId: id, agentId, status: "disabled", by: `tidy: ${why}` };
        writeRaw(line);
      } catch (error) {
        warn(`raw record for ${id} not written: ${String(error)}`);
      }
    }
    const verdicts = result.disabled.map((d) => d.verdict);
    await notify(agentId, chat, tidyNotice(verdicts, result.after, result.limit), tidySentence(verdicts, result.after, result.limit), "tidy");
  };

  /** One learning pass over one session, then the tidy and the lesson message for whatever it activated. */
  const learn = async (
    agentId: string,
    sessionId: string,
    workspaceDir: string | undefined,
    turnChat: Chat | null,
    options: PassOptions = {},
  ) => {
    const chat = await currentChat(agentId, turnChat);
    const before = new Set(activeLessons(store, agentId).map((lesson) => lesson.id));
    const shown = injected.get(sessionId) ?? [];
    injected.delete(sessionId);
    for (const { block, shownAtMs } of shown) recordExposure(store, sessionId, block, shownAtMs, new Date());
    const decision = await processSession(depsFor(agentId, workspaceDir), sessionId, agentId, options);
    if (decision.outcome !== "no_failures") log(`session ${sessionId}: ${decision.outcome}`);
    // Every lesson that became active during this run, whichever way it got there
    // (this session, a deferred one, a recovered activation).
    const learned = activeLessons(store, agentId).filter((lesson) => !before.has(lesson.id)).map((lesson) => lesson.id);
    // A lesson just learned is not the tidy's: until a later session ends, its verdict is `no recurrence window`.
    try {
      await tidyUp(agentId, chat);
    } catch (error) {
      warn(`tidy skipped: ${String(error)}`);
    }
    await announce(agentId, learned, chat);
    return decision;
  };

  const enqueue = (ctx: HookContext) => {
    const sessionId = ctx.sessionId;
    if (!sessionId || queued.has(sessionId)) return;
    queued.add(sessionId);
    const agentId = ctx.agentId || DEFAULT_AGENT;
    const workspaceDir = ctx.workspaceDir;
    if (workspaceDir) workspaces.set(agentId, workspaceDir);
    const turnChat: Chat | null = ctx.channel && ctx.chatId ? { channel: ctx.channel, to: ctx.chatId, ...(ctx.accountId ? { accountId: ctx.accountId } : {}) } : null;
    void schedule(async () => {
      queued.delete(sessionId);
      try {
        await learn(agentId, sessionId, workspaceDir, turnChat);
      } catch (error) {
        warn(`learning skipped for ${sessionId}: ${String(error)}`);
      }
      let chat: Chat | null = null;
      try {
        chat = await currentChat(agentId, turnChat);
      } catch {
        // no chat known: the update check still runs, its message waits
      }
      afterTurn(agentId, chat);
    });
  };

  // -- Update available, and /refine update -------------------------------------------

  /** Run the host's own CLI, with the running gateway's entry point, state dir and config. */
  const hostCli = async (args: string[], timeoutMs: number) => {
    const run = api.runtime?.system?.runCommandWithTimeout;
    if (!run) throw new Error("OpenClaw offers the plugin no way to run its CLI");
    const entry = process.argv[1];
    if (!entry) throw new Error("cannot tell how OpenClaw was started");
    return run([process.execPath, entry, ...args], { timeoutMs, maxOutputBytes: 4_000_000 });
  };

  interface InstallInfo {
    /** git, clawhub, npm, or path: loaded from a directory and not installed. */
    source: string;
    version: string;
    gitUrl?: string;
    gitCommit?: string;
    path?: string;
  }

  /** Where the plugin was installed from, from the host's own install record (`plugins inspect --json`). */
  const installInfo = async (): Promise<InstallInfo> => {
    const result = await hostCli(["plugins", "inspect", api.id, "--json"], 60_000);
    const start = result.stdout.indexOf("{");
    if (result.code !== 0 || start < 0) throw new Error(`plugins inspect: ${failureReason(result.stdout, result.stderr)}`);
    const data = JSON.parse(result.stdout.slice(start)) as {
      plugin?: { version?: string; source?: string };
      install?: { source?: string; version?: string; gitUrl?: string; gitCommit?: string };
    };
    const install = data.install;
    return {
      source: install?.source || "path",
      version: install?.version || data.plugin?.version || version,
      ...(install?.gitUrl ? { gitUrl: install.gitUrl } : {}),
      ...(install?.gitCommit ? { gitCommit: install.gitCommit } : {}),
      ...(data.plugin?.source ? { path: data.plugin.source } : {}),
    };
  };

  const UPDATE_STATE = "update/state.json";
  let checking = false;

  /**
   * At most once a day, an hour after a failure: find the newest release. A git install
   * compares release tags (`git ls-remote --tags`, refs only, no code); a ClawHub or npm
   * install asks the host (`plugins update --dry-run`). A failed check is logged, not shown.
   */
  const checkForUpdate = async (now: Date): Promise<UpdateState | undefined> => {
    const state = store.read<UpdateState>(UPDATE_STATE) ?? { announced: [] };
    if (!settings.checkForUpdates || checking || !checkDue(state, now)) return state;
    checking = true;
    try {
      const info = await installInfo();
      let latest: string | null = null;
      if (info.source === "git" && info.gitUrl) {
        const run = api.runtime?.system?.runCommandWithTimeout;
        if (!run) throw new Error("OpenClaw offers the plugin no way to run git");
        const tags = await run(["git", "ls-remote", "--tags", "--refs", info.gitUrl], { timeoutMs: 30_000, maxOutputBytes: 1_000_000 });
        if (tags.code !== 0) throw new Error(`git ls-remote: ${failureReason(tags.stdout, tags.stderr)}`);
        latest = latestTag(tags.stdout);
      } else if (info.source === "clawhub" || info.source === "npm") {
        const dry = await hostCli(["plugins", "update", api.id, "--dry-run"], 120_000);
        if (dry.code !== 0) throw new Error(`plugins update --dry-run: ${failureReason(dry.stdout, dry.stderr)}`);
        const output = `${dry.stdout}\n${dry.stderr}`;
        const would = hostUpdateLine(output, api.id, "would");
        // 2026.9.6 says "<id> is up to date (<version>)." in a dry run and "<id> already at
        // <version>." in a real one (update-attempt, buildDryRunPluginUpdateOutcome). An install
        // pinned to an exact version says "<id> is pinned to <spec> …": the host will not move
        // it, so there is nothing this plugin can install; the log keeps the host's words.
        const pinned = output.split("\n").find((line) => line.includes(`${api.id} is pinned to `));
        if (pinned) log(`update check: ${pinned.trim()}`);
        // Neither of these: the host changed its wording, and reading it as "no newer version"
        // would switch the announcement off without a word.
        if (!would && !pinned && !/already at|up to date/i.test(output)) throw new Error("plugins update --dry-run: could not read the host's answer");
        latest = would?.to ?? info.version;
      }
      const next: UpdateState = { ...state, checkedAt: now.toISOString(), ok: true, source: info.source, installed: info.version, latest };
      delete next.error;
      store.write(UPDATE_STATE, next);
      log(`update check: ${info.source} install ${info.version}, latest ${latest ?? (info.source === "git" ? "(no release tags yet)" : "(nothing to compare: loaded from a path)")}`);
      return next;
    } catch (error) {
      const next: UpdateState = { ...state, checkedAt: now.toISOString(), ok: false, error: String(error).slice(0, 300) };
      store.write(UPDATE_STATE, next);
      warn(`update check failed, next try in an hour: ${next.error}`);
      return next;
    } finally {
      checking = false;
    }
  };

  /**
   * One message per new version, in the chat the user talks from, with an Update button
   * where the channel has buttons; with no chat a plugin can send to, through the agent.
   * Marked announced only once it was sent or queued.
   */
  const announceUpdate = async (agentId: string, state: UpdateState | undefined, chat: Chat | null): Promise<void> => {
    const latest = toAnnounce(withRunning(state));
    if (!latest || !state) return;
    const text = availableText(latest);
    let sent = false;
    if (!chat || !(await reachable(chat))) {
      sent = tellThroughAgent(agentId, `Refine Cycle ${latest} is available; sending /refine update installs it.`, `update ${latest}`);
      if (sent) store.write(UPDATE_STATE, { ...state, announced: [...state.announced, latest].slice(-20) });
      return;
    }
    try {
      const adapter = await api.runtime?.channel?.outbound?.loadAdapter?.(chat.channel);
      if (adapter?.sendPayload && adapter.presentationCapabilities?.buttons !== false && adapter.presentationCapabilities?.supported !== false) {
        await adapter.sendPayload({
          cfg: api.config,
          to: chat.to,
          text,
          accountId: chat.accountId ?? null,
          payload: { text, presentation: UPDATE_BUTTON },
        });
        sent = true;
        log(`update ${latest}: told the user on ${chat.channel}, with the Update button`);
      } else {
        sent = await say(chat, `${text}\n${actionLine()}`, `update ${latest}`);
      }
    } catch (error) {
      warn(`update ${latest}: could not tell the user on ${chat.channel}: ${String(error)}`);
    }
    if (sent) store.write(UPDATE_STATE, { ...state, announced: [...state.announced, latest].slice(-20) });
  };

  /**
   * The update state with the version that is running now as `installed`. The stored one
   * is only what the last check saw, and a plugin installed since (`openclaw plugins
   * install`) runs a newer version than it says (live check, 2026-09-30: 0.1.4 running,
   * the state still said 0.1.2 and offered 0.1.3).
   */
  const withRunning = (state: UpdateState | undefined): UpdateState | undefined =>
    state && parseVersion(version) ? { ...state, installed: version } : state;

  /**
   * `autoUpdate`: install the newer release the check found, with the host's own update
   * (no restart), once per version whatever the result, then one line about it. The version
   * is recorded as tried before the update starts, so a crash under it never loops. Called
   * only when the gateway is quiet (`whenQuiet`): the host's update reloads plugins, which
   * breaks a conversation in progress.
   */
  const installByItself = async (agentId: string, state: UpdateState | undefined, chat: Chat | null): Promise<void> => {
    const latest = toInstall(withRunning(state));
    if (!latest || !state) return;
    // Without a service the host can restart, the hot reload of an update would leave the
    // Codex harness failing until the user restarts by hand: offer the update instead.
    if (!(await serviceLoaded())) {
      log(`update ${latest}: OpenClaw does not run as a service, so it is offered, not installed by itself`);
      return announceUpdate(agentId, state, chat);
    }
    store.write(UPDATE_STATE, { ...state, attempted: [...(state.attempted ?? []), latest].slice(-20) });
    const result = await hostUpdate();
    (result.ok ? log : warn)(`automatic update to ${latest}: ${result.text}`);
    if (result.ok && !result.to) return; // the host found nothing newer after all: nothing to say
    const to = result.to ?? latest;
    if (!result.ok) {
      const reason = result.reason ?? "no reason given";
      const told = await notify(agentId, chat, autoFailedText(latest, reason), `Refine Cycle could not update itself to ${latest}: ${reason}.`, `update ${latest}`, true);
      markAnnounced(latest, told);
      return;
    }
    // Updated: the hot reload alone is not enough (the Codex harness), so a full restart
    // finishes it, here in the same quiet window. The service was checked before the update.
    // The host is reloading plugins and channels now: the chat's adapter is looked up again.
    const told = await notify(agentId, chat, autoUpdatedText(to), `Refine Cycle updated itself to ${to}.`, `update ${latest}`, true);
    markAnnounced(latest, told);
    const restart = await restartGateway(true);
    if (!restart.ok) {
      warn(`restart after the update failed: ${restart.reason}`);
      await notify(agentId, chat, restartNeededText(to), `Refine Cycle updated itself to ${to}; OpenClaw needs a restart to finish it.`, `restart ${to}`, true);
    }
  };

  const markAnnounced = (version: string, told: boolean) => {
    if (!told) return;
    const now = store.read<UpdateState>(UPDATE_STATE);
    if (now) store.write(UPDATE_STATE, { ...now, announced: [...now.announced, version].slice(-20) });
  };

  /**
   * Agent runs in progress, as the hooks saw them (`src/runs.ts`): what tells the automatic
   * update and its restart that the gateway is quiet. A run that never reaches `agent_end`
   * (one that failed in the host before it, like the Codex handoff error on 2026-09-30)
   * stops counting after the host's own agent timeout plus a margin (`lostRunMs`).
   */
  const runs = new Runs();
  const runIds = (ctx: HookContext | undefined): string[] =>
    [ctx?.sessionId, ctx?.sessionKey, ctx?.runId].filter((id): id is string => typeof id === "string" && id.length > 0);
  const runStarted = (ctx: HookContext | undefined) => runs.started(runIds(ctx));
  const runEnded = (ctx: HookContext | undefined) => runs.ended(runIds(ctx));
  /** The host's agent timeout (`agents.defaults.timeoutSeconds`, 600 s by default in 2026.9.6) and five minutes. */
  const lostRunMs = (): number => {
    if (timing.lostRunMs > 0) return timing.lostRunMs;
    const seconds = (api.config?.agents?.defaults as { timeoutSeconds?: unknown } | undefined)?.timeoutSeconds;
    return (typeof seconds === "number" && seconds > 0 ? seconds : 600) * 1000 + 5 * 60_000;
  };
  const runsInProgress = (): RunSeen[] => {
    const { running, lost } = runs.inProgress(lostRunMs());
    for (const run of lost) log(`run ${run.ids[0]} was counted as in progress for over ${Math.round(lostRunMs() / 60_000)} min without ending: treated as lost`);
    return running;
  };
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let quietJob: (() => Promise<void>) | undefined;

  /**
   * Run `job` once the gateway has been quiet for `timing.quietMs`: no run in progress, and
   * no turn started or ended in that time. Every turn postpones it; a newer job replaces an
   * older one. Started outside the host's work scope, and the timer does not hold the
   * process open. The host exposes no idle signal to a plugin (2026.9.6), so this is the
   * plugin's own count of the runs its hooks saw. True when a job was not already waiting.
   */
  const whenQuiet = (job: () => Promise<void>): boolean => {
    const fresh = !quietJob;
    quietJob = job;
    armQuiet();
    return fresh;
  };
  const armQuiet = () => {
    if (!quietJob) return;
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = runOutsideHostWorkScope(() =>
      setTimeout(() => {
        quietTimer = undefined;
        const busy = runsInProgress();
        if (busy.length > 0) {
          const now = Date.now();
          log(`automatic update waits: ${busy.length} run(s) still in progress: ${busy.map((run) => `${run.ids.join("/")} (${Math.round((now - run.since) / 60_000)} min)`).join(", ")}`);
          return armQuiet();
        }
        const job = quietJob;
        quietJob = undefined;
        void job?.().catch((error: unknown) => warn(`automatic update skipped: ${String(error)}`));
      }, timing.quietMs),
    );
    quietTimer.unref?.();
  };

  /**
   * After a turn: the daily check, off the learning queue; then the message about a new
   * version at once, or the update itself once the gateway is quiet.
   */
  const afterTurn = (agentId: string, chat: Chat | null) => {
    if (!settings.checkForUpdates || storeError) return;
    void runOutsideHostWorkScope(async () => {
      try {
        const state = await checkForUpdate(new Date());
        if (!settings.autoUpdate) return await announceUpdate(agentId, state, chat);
        if (!toInstall(withRunning(state))) return;
        // The newest state and chat when it fires, not the ones of this turn.
        const armed = whenQuiet(async () => installByItself(agentId, store.read<UpdateState>(UPDATE_STATE), await currentChat(agentId, null)));
        if (armed) log(`update ${toInstall(withRunning(state))}: installed once the gateway has been quiet for ${Math.round(timing.quietMs / 60_000)} min`);
      } catch (error) {
        warn(`update check skipped: ${String(error)}`);
      }
    });
  };

  /**
   * A full gateway restart after an update, as a user would run it: `openclaw gateway
   * restart --safe`, which the host runs only once its admitted work has drained. Needed
   * because on 2026.9.6 the hot reload that `plugins update` does leaves the Codex harness
   * failing every turn ("Codex session policy handoff failed … reconnect before retrying")
   * until a restart (live, 2026-09-30, after both an automatic update and an install).
   * Only a gateway installed as a service can be restarted this way (`gateway status
   * --json`: `service.loaded`); otherwise `ok` is false and the user is told to restart.
   */
  const serviceLoaded = async (): Promise<boolean> => {
    // OpenClaw sets these in the environment of a gateway it runs as a service (2026.9.6:
    // a systemd unit, a Windows task, a launchd marker): no CLI call, which can be refused
    // while the host is busy (live, 2026-10-01: a systemd service taken for none).
    const env = process.env;
    if (env.OPENCLAW_SERVICE_KIND === "gateway" && (env.OPENCLAW_SYSTEMD_UNIT || env.OPENCLAW_WINDOWS_TASK_NAME || env.OPENCLAW_SERVICE_MARKER)) return true;
    let reason = "";
    for (let attempt = 1; attempt <= timing.serviceTries; attempt++) {
      try {
        const status = await hostCli(["gateway", "status", "--json"], 60_000);
        const start = status.stdout.indexOf("{");
        const data = start >= 0 ? (JSON.parse(status.stdout.slice(start)) as { service?: { loaded?: boolean } }) : undefined;
        if (data?.service) {
          if (data.service.loaded !== true) log("OpenClaw does not run as a service (gateway status: not loaded)");
          return data.service.loaded === true;
        }
        reason = `gateway status exited ${status.code}: ${failureReason(status.stdout, status.stderr)}`;
      } catch (error) {
        reason = String(error).replace(/^Error: /, "").slice(0, 200);
      }
      if (attempt < timing.serviceTries) await pause(timing.serviceRetryMs);
    }
    warn(`could not tell whether OpenClaw runs as a service, so it is taken for none: ${reason}`);
    return false;
  };
  const restartGateway = async (serviceKnown = false): Promise<{ ok: boolean; reason?: string }> => {
    try {
      if (!serviceKnown && !(await serviceLoaded())) return { ok: false, reason: "OpenClaw is not running as a service, so it cannot restart itself" };
      log("restarting OpenClaw to finish the update (gateway restart --safe)");
      // On success this process is stopped by the restart, and the call never returns.
      const result = await hostCli(["gateway", "restart", "--safe", "--json"], 300_000);
      return result.code === 0 ? { ok: true } : { ok: false, reason: failureReason(result.stdout, result.stderr) };
    } catch (error) {
      return { ok: false, reason: String(error).replace(/^Error: /, "").slice(0, 200) };
    }
  };

  /**
   * Restart once no run is in progress: a restart mid-run would cut that conversation off.
   * An agent that is never idle gets the restart after `restartMaxWaitMs` anyway: the
   * host's `--safe` drains its admitted work first, and a broken harness is worse.
   */
  const restartWhenIdle = (then: (result: { ok: boolean; reason?: string }) => void) => {
    const giveUpAt = Date.now() + timing.restartMaxWaitMs;
    const tick = () => {
      if (runsInProgress().length > 0 && Date.now() < giveUpAt) {
        const timer = setTimeout(tick, timing.restartPollMs);
        timer.unref?.();
        return;
      }
      void restartGateway().then(then);
    };
    // First the answer that says so reaches the chat.
    const timer = runOutsideHostWorkScope(() => setTimeout(tick, timing.restartPollMs));
    timer.unref?.();
  };

  let updating = false;

  /**
   * The host's own update of this plugin, as a user would run it: `openclaw plugins
   * update <id>`. With a running gateway the host applies it without a restart. A failure
   * leaves the installed version in place (the host rolls back) and is said in one line.
   */
  const runUpdate = async (fromChat: boolean): Promise<UpdateOutcome> => {
    const result = await hostUpdate();
    if (result.ok && result.to) {
      // The hot reload alone leaves the Codex harness broken (2026.9.6): a full restart
      // finishes the update, or the user is told to restart.
      if (!(await serviceLoaded())) {
        result.text = restartNeededText(result.to);
      } else if (fromChat) {
        result.text = `${result.text} OpenClaw restarts to finish it once no conversation is running.`;
        restartWhenIdle((restart) => {
          if (!restart.ok) warn(`restart after /refine update failed: ${restart.reason}`);
        });
      } else {
        // The command line is its own process: the gateway's drain (--safe) is the wait.
        const restart = await restartGateway();
        result.text = restart.ok ? `${result.text} OpenClaw was restarted to finish it.` : `${restartNeededText(result.to)} (${restart.reason})`;
      }
    }
    // The log keeps the answer too: a chat that takes no message from a plugin still has it there.
    (result.ok ? log : warn)(`/refine update: ${result.text}`);
    return result;
  };

  /** What the host's update did: `to` when it moved to another version, `reason` when it failed. */
  interface UpdateOutcome {
    text: string;
    ok: boolean;
    to?: string;
    reason?: string;
  }

  const hostUpdate = async (): Promise<UpdateOutcome> => {
    const failed = (reason: string): UpdateOutcome => ({ text: failedText(reason), ok: false, reason });
    if (updating) return failed("An update is already running.");
    updating = true;
    try {
      const before = await installInfo();
      if (before.source === "path") {
        return failed(`It is loaded from a path (${before.path ?? "a directory"}), not installed, so OpenClaw cannot update it; update that directory instead.`);
      }
      const result = await hostCli(["plugins", "update", api.id], 300_000);
      if (result.code !== 0) return failed(failureReason(result.stdout, result.stderr));
      const output = `${result.stdout}\n${result.stderr}`;
      // The host says "<id> already at <version>." when there is nothing newer (2026.9.6).
      if (output.includes(`${api.id} already at `)) return { text: upToDateText(), ok: true };
      const after = await installInfo().catch(() => undefined);
      const line = hostUpdateLine(output, api.id, "updated");
      const changed = !!after && (after.version !== before.version || (after.gitCommit ?? "") !== (before.gitCommit ?? ""));
      if (!line && !changed) return { text: upToDateText(), ok: true };
      const to = after?.version ?? line?.to ?? "the latest version";
      const state = store.read<UpdateState>(UPDATE_STATE);
      if (state) store.write(UPDATE_STATE, { ...state, installed: to });
      return { text: updatedText(to), ok: true, to };
    } catch (error) {
      return failed(String(error).replace(/^Error: /, "").slice(0, 200));
    } finally {
      updating = false;
    }
  };

  /**
   * A pass started by hand: queued behind the automatic ones, outside the host's work
   * scope. The same budget and rules apply; only the session and the focus are chosen.
   */
  const passByHand = (agentId: string, sessionId: string, options: PassOptions): Promise<Decision> =>
    runOutsideHostWorkScope(() => schedule(() => learn(agentId, sessionId, workspaceFor(agentId), null, options)));
  api.on("agent_end", (event, ctx) => {
    if (!ctx) return;
    runEnded(ctx);
    // Every turn that ends postpones an automatic update by the whole quiet period.
    armQuiet();
    if (storeError) return;
    // `success: false` (2026.9.6 PluginHookAgentEndEvent): the run ended with an error and
    // the user saw no reply (R-live: the Codex handoff error), so its notices are given again.
    settleNoticesOf(ctx, (event as { success?: boolean } | undefined)?.success !== false);
    // The queue is chained outside the turn's work scope, so the learning work (and
    // its model call) does not run inside a scope the host closes when this returns.
    runOutsideHostWorkScope(() => enqueue(ctx));
  });

  /** The plugin's own version, from its package.json. */
  const version = (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
      return typeof pkg.version === "string" ? pkg.version : "unknown";
    } catch {
      return "unknown";
    }
  })();

  /** The model lessons are written with, in words. */
  const modelRoute = (): string => {
    const target = effectiveModel();
    if (target.sent) return `${target.sent} (source: ${target.source}; OpenClaw allows this plugin to choose it)`;
    const configured = api.config?.agents?.defaults?.model;
    const name = typeof configured === "string" ? configured : configured?.primary;
    return `${name || "the host's default"} (the default agent's model: OpenClaw chooses it, the plugin sends none)`;
  };

  interface Scope {
    /** A chat command: that agent's lessons and report only. Absent on the command line, which sees all agents. */
    agentId?: string;
    /** The chat's own session, when the host gives it. */
    sessionId?: string;
    /** From the host: is the sender on the channel's allowlist. */
    authorized?: boolean;
    /** The chat the command came from, when the host names one. */
    chat?: Chat | null;
    json?: boolean;
  }

  const USAGE = "Usage: list | status | audit | report | run [reason] | session <id> [reason] | dry-run [session <id>] [reason] | model [auto | <provider>/<model>] | update | disable <id> | enable <id> | delete <id> | rollback <id>";

  /** `model`, `model auto`, `model <provider/model>`: show, clear or set the model lessons are written with. */
  const modelCommand = (value: string, scope: Scope): { text: string; ok: boolean } => {
    const allowed = api.config?.plugins?.entries?.[api.id]?.llm?.allowModelOverride === true;
    const trust = `OpenClaw lets this plugin choose its model: ${allowed ? "yes" : "no"} (plugins.entries.${api.id}.llm.allowModelOverride)`;
    const denied = `⚠ OpenClaw does not let this plugin choose its model, so it is not sent: set plugins.entries.${api.id}.llm.allowModelOverride to true to use it.`;
    if (!value) {
      const target = effectiveModel();
      const lines = [`model: ${target.chosen ?? "(the default agent's)"}`, `source: ${target.source}`, trust];
      if (target.dropped) lines.push(denied);
      return { text: lines.join("\n"), ok: true };
    }
    if (scope.agentId !== undefined && scope.authorized === false) return { text: "Only an authorized sender may change the model.", ok: false };
    if (value === "auto") {
      const had = store.read<{ model?: string }>(MODEL_OVERRIDE)?.model;
      if (had) store.remove(MODEL_OVERRIDE);
      const target = effectiveModel();
      return { text: `${had ? "Override removed." : "No override was set."} Effective model: ${target.chosen ?? "(the default agent's)"} (source: ${target.source})`, ok: true };
    }
    if (!/^[A-Za-z0-9._:-]+(\/[A-Za-z0-9._:@-]+)?$/.test(value)) {
      return { text: "Invalid model. Usage: model [auto | <model> | <provider>/<model>]", ok: false };
    }
    store.write(MODEL_OVERRIDE, { model: value, at: new Date().toISOString() });
    return { text: [`Override set: model=${value}`, ...(allowed ? [] : [denied])].join("\n"), ok: true };
  };

  /** An update the last check found, and a model that is set but not sent, for `status`. */
  const updateWarnings = (): string[] => {
    const dropped = effectiveModel().dropped;
    const modelWarning = dropped
      ? [`Model ${dropped} is set (${effectiveModel().source}) but OpenClaw does not let this plugin choose its model, so it is dropped before the call; set plugins.entries.${api.id}.llm.allowModelOverride to true to use it.`]
      : [];
    const state = withRunning(store.read<UpdateState>(UPDATE_STATE));
    return [
      ...modelWarning,
      ...(state?.ok && state.latest && state.installed && isNewer(state.latest, state.installed)
        ? [`Refine Cycle ${state.latest} is available (installed ${state.installed}): \`${UPDATE_COMMAND}\``]
        : []),
    ];
  };

  /** Is a newer release known? Then a chat `status` offers the Update button. */
  const updateKnown = (): boolean => {
    const state = withRunning(store.read<UpdateState>(UPDATE_STATE));
    return !!(state?.ok && state.latest && state.installed && isNewer(state.latest, state.installed));
  };

  /**
   * Does the chat render buttons? The same test as the update notice: a channel that says it
   * has none, or has no payload send at all, gets the command as text. Telegram makes only
   * `/refine` of `/refine update` a link (a bot command has no space), so there the button
   * is the only way to update with one tap.
   */
  const hasButtons = async (chat: Chat | null | undefined): Promise<boolean> => {
    if (!chat) return false;
    const adapter = await adapterFor(chat.channel);
    return !!adapter?.sendPayload && adapter.presentationCapabilities?.buttons !== false && adapter.presentationCapabilities?.supported !== false;
  };

  /**
   * One place for chat and command line. `ok` is false when the command did not do what
   * was asked (no such lesson, a busy store, bad usage), so the command line can exit 1.
   */
  const control = async (args: string, scope: Scope = {}): Promise<{ text: string; ok: boolean; presentation?: Presentation }> => {
    const [verb = "list", id = ""] = args.trim().split(/\s+/).filter(Boolean);
    const { agentId } = scope;
    if (storeError) return { text: storeErrorText(store.root, storeError), ok: false };
    const now = new Date();
    const mine = allLessons(store).filter((lesson) => agentId === undefined || lessonAgent(lesson) === agentId);
    if (verb === "list") {
      const lessons = mine.filter((lesson) => lesson.status !== "deleted");
      const budget = `model calls today: ${callsToday(store, now)}/${settings.maxModelCallsPerDay}`;
      if (lessons.length === 0) return { text: `No lessons yet.\n${budget}`, ok: true };
      // The command line lists every agent's lessons, so it says whose each one is.
      const owner = (lesson: (typeof lessons)[number]) => (agentId === undefined ? ` (agent ${lessonAgent(lesson)})` : "");
      return { text: [...lessons.map((lesson) => `${lesson.id} [${lesson.status}]${owner(lesson)} ${lesson.text}`), budget].join("\n"), ok: true };
    }
    // `enable` turns a disabled lesson back on (the tidy's, or the user's own); a deleted one stays deleted.
    if (verb === "enable") {
      if (!id) return { text: "Usage: enable <lesson id>", ok: false };
      const lesson = mine.find((candidate) => candidate.id === id);
      if (!lesson) return { text: `No lesson ${id}.`, ok: false };
      if (lesson.status === "deleted") return { text: `Lesson ${id} was deleted; a deleted lesson stays deleted.`, ok: false };
      if (lesson.status !== "disabled") return { text: `Lesson ${id} is ${lesson.status}; only a disabled lesson can be enabled.`, ok: false };
      recover(store, now);
      let changed;
      try {
        changed = enable(store, id, now, agentId === undefined ? 5_000 : 0);
      } catch (error) {
        if (error instanceof StoreError) return { text: "The lesson store is busy; try again in a moment.", ok: false };
        throw error;
      }
      if (changed?.status === "active" && settings.rawLog) {
        try {
          const line: RawLessonStatusLine = { kind: "lesson_status", format: RAW_FORMAT, at: now.toISOString(), lessonId: id, agentId: lessonAgent(changed), status: "active" };
          writeRaw(line);
        } catch (error) {
          warn(`raw record for ${id} not written: ${String(error)}`);
        }
      }
      return changed?.status === "active"
        ? { text: `Lesson ${id} enabled. The tidy will not switch it off again.`, ok: true }
        : { text: `No lesson ${id}.`, ok: false };
    }
    // `rollback` is the Hermes plugin's name for taking a lesson back; here it is `delete`: a tombstone.
    if (verb === "disable" || verb === "delete" || verb === "rollback") {
      if (!id) return { text: `Usage: ${verb} <lesson id>`, ok: false };
      if (!mine.some((lesson) => lesson.id === id)) return { text: `No lesson ${id}.`, ok: false };
      recover(store, now); // non-blocking: skipped while another process holds the lock
      let changed;
      try {
        // In chat the gateway thread must not wait; the command line may.
        changed = setStatus(store, id, verb === "disable" ? "disabled" : "deleted", now, agentId === undefined ? 5_000 : 0);
      } catch (error) {
        if (error instanceof StoreError) return { text: "The lesson store is busy; try again in a moment.", ok: false };
        throw error;
      }
      if (changed && settings.rawLog && changed.status !== mine.find((lesson) => lesson.id === id)?.status) {
        try {
          const line: RawLessonStatusLine = {
            kind: "lesson_status", format: RAW_FORMAT, at: now.toISOString(), lessonId: id, agentId: lessonAgent(changed),
            status: changed.status as "disabled" | "deleted",
          };
          writeRaw(line);
        } catch (error) {
          warn(`raw record for ${id} not written: ${String(error)}`);
        }
      }
      return changed ? { text: `Lesson ${id} ${changed.status}.`, ok: true } : { text: `No lesson ${id}.`, ok: false };
    }
    if (verb === "audit") {
      await ledgerReady;
      const rows = audit(store, now, agentId);
      const command = agentId === undefined ? "openclaw refine-cycle rollback" : "/refine rollback";
      return { text: scope.json ? JSON.stringify(rows, null, 2) : describeAudit(rows, agentId !== undefined, (id) => `${command} ${id}`), ok: true };
    }
    if (verb === "report") {
      const numbers = report(store, agentId, { now, limit: settings.maxModelCallsPerDay });
      return { text: scope.json ? JSON.stringify(numbers, null, 2) : describeReport(numbers), ok: true };
    }
    if (verb === "status") {
      // As Hermes' status does, it starts the day's update check when one is due: the
      // command line waits for it, a chat does not (the next status shows what it found).
      if (settings.checkForUpdates) {
        const check = runOutsideHostWorkScope(() => checkForUpdate(now)).catch(() => undefined);
        if (agentId === undefined) await check;
      }
      const agents = agentId === undefined ? knownAgents(store) : [agentId];
      // Its audit line comes from the same ledger as `audit`, once that is built.
      await ledgerReady;
      const s = await status(depsFor(agents[0]), {
        agentIds: agents,
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
        version,
        model: modelRoute(),
        llmAvailable: llm !== null,
        conversationAccess: hookPolicy?.allowConversationAccess === true,
        promptInjection: injectionAllowed,
        hostWarnings: updateWarnings(),
        recovery: lastRecovery,
      }, (agent) => depsFor(agent));
      if (scope.json) return { text: JSON.stringify(s, null, 2), ok: true };
      const text = describeStatus(s, agentId !== undefined);
      // In a chat with buttons, the update the status names is one tap away.
      if (agentId !== undefined && updateKnown() && (await hasButtons(scope.chat))) return { text, ok: true, presentation: UPDATE_BUTTON };
      return { text, ok: true };
    }
    if (verb === "run" || verb === "session" || verb === "dry-run") {
      return passCommand(args, scope);
    }
    if (verb === "model") return modelCommand(args.trim().split(/\s+/).slice(1).join(" "), scope);
    if (verb === "update") {
      if (agentId === undefined) return runUpdate(false);
      // The host already refuses senders off the allowlist; this holds if a host lets one through.
      if (scope.authorized === false) return { text: "Only an authorized sender may update Refine Cycle.", ok: false };
      const update = runUpdate(true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timing.chatWaitMs);
      });
      const first = await Promise.race([update, late]);
      clearTimeout(timer);
      if (first) return first;
      const target = await replyChat(agentId, scope.chat ?? null);
      void update.then((result) => sayLate(agentId, target, result.text, "update"));
      return { text: `Updating Refine Cycle; the result follows ${followsIn(target, scope.chat ?? null)}.`, ok: true };
    }
    return { text: USAGE, ok: false };
  };


  /**
   * `run [reason]`, `session <id> [reason]`, `dry-run [session <id>] [reason]`. In chat the
   * answer comes within the host's command time: the pass itself runs in the background,
   * and a result not ready in time is sent to the chat when it is.
   */
  const passCommand = async (args: string, scope: Scope): Promise<{ text: string; ok: boolean }> => {
    const words = args.trim().split(/\s+/).filter(Boolean);
    const verb = words[0];
    const dryRun = verb === "dry-run";
    let rest = words.slice(1);
    let sessionId: string | undefined;
    if (verb === "session" || (dryRun && rest[0] === "session")) {
      if (dryRun) rest = rest.slice(1);
      sessionId = rest[0];
      rest = rest.slice(1);
      if (!sessionId) return { text: `Usage: ${dryRun ? "dry-run session <id> [reason]" : "session <id> [reason]"}`, ok: false };
    } else {
      sessionId = scope.sessionId;
      if (!sessionId) {
        return {
          text: scope.agentId === undefined
            ? "The command line has no current session: use `session <id> [reason]` or `dry-run session <id> [reason]`."
            : "This chat has no session the host names; use `/refine session <id>`.",
          ok: false,
        };
      }
    }
    const reason = rest.join(" ");
    // The session must exist in the agent's own history; on the command line, in any agent's.
    const candidates = scope.agentId === undefined ? knownAgents(store) : [scope.agentId];
    let agentId: string | undefined;
    try {
      agentId = candidates.find((agent) => depsFor(agent).history.hasSession?.(sessionId!) ?? true);
    } catch (error) {
      return { text: `Refine Cycle cannot read the history to confirm that session: ${String(error)}`, ok: false };
    }
    if (!agentId) return { text: `No session ${sessionId}${scope.agentId ? ` for agent ${scope.agentId}` : ""}.`, ok: false };
    const pass = passByHand(agentId, sessionId, { ...(reason ? { reason } : {}), ...(dryRun ? { dryRun: true } : {}) });
    const answer = (decision: Decision) => describePass(decision, dryRun);
    if (scope.agentId === undefined) {
      // The command line may wait for the whole pass.
      try {
        const decision = await pass;
        return { text: answer(decision), ok: true };
      } catch (error) {
        return { text: `The pass failed: ${String(error)}`, ok: false };
      }
    }
    const owner = agentId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timing.chatWaitMs);
    });
    const first = await Promise.race([pass.catch((error: unknown) => ({ failed: String(error) })), late]);
    clearTimeout(timer);
    if (first && "failed" in first) return { text: `The pass failed: ${first.failed}`, ok: false };
    if (first) return { text: answer(first), ok: true };
    const target = await replyChat(owner, scope.chat ?? null);
    void pass.then(
      (decision) => sayLate(owner, target, answer(decision), `pass over ${sessionId}`),
      (error: unknown) => sayLate(owner, target, `The pass over session ${sessionId} failed: ${String(error)}`, `pass over ${sessionId}`),
    );
    return { text: `${dryRun ? "Dry run" : "Pass"} over session ${sessionId} started; the result follows ${followsIn(target, scope.chat ?? null)} when the model has answered.`, ok: true };
  };

  api.registerCommand?.({
    name: "refine",
    description: "Refine Cycle: list, status, audit, report, run [reason], session <id>, dry-run, model, update, disable <id>, enable <id>, delete <id>, rollback <id>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const agentId = commandAgent(ctx);
      // Guessing an agent could show or change another agent's lessons.
      if (!agentId && !storeError) {
        return { text: "Refine Cycle cannot tell which agent this chat belongs to. Use `openclaw refine-cycle` on the command line." };
      }
      const result = await control(ctx?.args ?? "", {
        agentId: agentId ?? DEFAULT_AGENT,
        ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx?.isAuthorizedSender !== undefined ? { authorized: ctx.isAuthorizedSender } : {}),
        chat: commandChat(ctx),
      });
      return { text: result.text, ...(result.presentation ? { presentation: result.presentation } : {}) };
    },
  });

  /** Print a command-line result; a command that did not do what was asked exits 1, for scripts. */
  const print = (result: { text: string; ok: boolean }) => {
    console.log(result.text);
    if (!result.ok) process.exitCode = 1;
  };

  api.registerCli?.(
    ({ program }) => {
      const root = program.command("refine-cycle").description("Refine Cycle: lessons learned from repeated failures");
      const json = (options: unknown) => (options as { json?: boolean } | undefined)?.json === true;
      root.command("list").description("List lessons, with the agent each belongs to").action(async () => print(await control("list")));
      root
        .command("status")
        .description("Whether learning and injection work, what blocks them, the budget, the queue; --json for the raw record")
        .option("--json", "the raw record as JSON")
        .action(async (options) => print(await control("status", { json: json(options) })));
      root
        .command("audit")
        .description("Did each lesson help? A verdict per lesson, from how often it was shown and whether its failure came back; --json")
        .option("--json", "the rows as JSON")
        .action(async (options) => print(await control("audit", { json: json(options) })));
      const words = (...parts: unknown[]) => parts.flat().filter((part): part is string => typeof part === "string").join(" ");
      root
        .command("run [reason...]")
        .description("A learning pass by hand; the command line has no current session, so use session <id>")
        .action(async (reason) => print(await control(`run ${words(reason)}`)));
      root
        .command("session <id> [reason...]")
        .description("A learning pass over one exact session, with an optional focus for the model")
        .action(async (id, reason) => print(await control(`session ${String(id)} ${words(reason)}`)));
      root
        .command("dry-run [args...]")
        .description("dry-run session <id> [reason]: propose and check a lesson, save nothing (the call is spent like any other)")
        .action(async (rest) => print(await control(`dry-run ${words(rest)}`)));
      root
        .command("model [value]")
        .description("Show the model lessons are written with; `model auto` clears it, `model <provider>/<model>` sets it")
        .action(async (value) => print(await control(`model ${typeof value === "string" ? value : ""}`)));
      root
        .command("update")
        .description("Update the plugin with OpenClaw's own plugins update, and say to which version")
        .action(async () => print(await control("update")));
      root.command("disable <id>").description("Stop injecting a lesson").action(async (id) => print(await control(`disable ${String(id)}`)));
      root.command("enable <id>").description("Turn a disabled lesson back on; the tidy will not switch it off again").action(async (id) => print(await control(`enable ${String(id)}`)));
      root.command("delete <id>").description("Delete a lesson (kept as a tombstone)").action(async (id) => print(await control(`delete ${String(id)}`)));
      root.command("rollback <id>").description("The Hermes name for delete: take a lesson back for good").action(async (id) => print(await control(`rollback ${String(id)}`)));
      root
        .command("report")
        .description("What the learning loop decided, by rule; --json for the raw numbers")
        .option("--json", "the raw numbers as JSON")
        .action(async (options) => print(await control("report", { json: json(options) })));
      root
        .command("replay <corpus> <storeDir> [sourcesDir]")
        .description("Measurement: run the loop over a recorded corpus (JSONL) into a separate store; --raw <file.jsonl> for the raw record")
        .option("--raw <file>", "write one raw JSON line per session to this new file (docs/proof/RAW-FORMAT.md)")
        .action(async (corpus, storeDir, sourcesDir, options) => {
          const dir = typeof sourcesDir === "string" ? sourcesDir : undefined;
          const rawFile = (options as { raw?: unknown } | undefined)?.raw;
          const result = await runOutsideHostWorkScope(() => replay({
            corpusFile: String(corpus),
            storeDir: String(storeDir),
            llm,
            ...(typeof rawFile === "string" && rawFile ? { rawFile, version } : {}),
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

  /**
   * `refine_run`: the agent may ask for a pass over its own failures, as in the Hermes
   * plugin. Optional: OpenClaw exposes it only when the user allows it (`tools.alsoAllow`),
   * because every call spends a model call from the user's budget. It answers at once;
   * the pass runs in the background under the same budget and rules, so the agent's turn
   * never waits for the model.
   */
  api.registerTool?.(
    (toolContext) => ({
      name: "refine_run",
      label: "Refine Cycle",
      description:
        "Ask Refine Cycle for one learning pass over this agent's repeated tool failures, now instead of at the end of the turn. " +
        "It runs in the background under the same limits as the automatic pass (one model call per session, maxModelCallsPerDay a day, 3 by default) and may find nothing; " +
        "a lesson it writes is shown from the next turn on. Use dry_run to see the proposed lesson without saving it.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Optional issue or area to focus on; passed to the model as the request's words." },
          session_id: { type: "string", description: "Optional exact past session id of this agent to look at; default is the current session." },
          dry_run: { type: "boolean", description: "Propose and check a lesson, save nothing. The model call is spent like any other." },
        },
        additionalProperties: false,
      },
      async execute(_toolCallId, raw) {
        const params = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
        if (params.reason !== undefined && typeof params.reason !== "string") throw new Error("reason must be a string.");
        if (params.dry_run !== undefined && typeof params.dry_run !== "boolean") throw new Error("dry_run must be a boolean.");
        if (params.session_id !== undefined && typeof params.session_id !== "string") throw new Error("session_id must be a string.");
        if (storeError) throw new Error(storeErrorText(store.root, storeError));
        const agentId = toolContext?.agentId || DEFAULT_AGENT;
        if (toolContext?.workspaceDir) workspaces.set(agentId, toolContext.workspaceDir);
        const explicit = typeof params.session_id === "string" && params.session_id.trim() ? params.session_id.trim() : undefined;
        const sessionId = explicit ?? toolContext?.sessionId;
        if (!sessionId) throw new Error("No session to look at: the host gave this run none; pass session_id.");
        if (explicit && depsFor(agentId).history.hasSession?.(explicit) === false) throw new Error(`No session ${explicit} for agent ${agentId}.`);
        const dryRun = params.dry_run === true;
        const reason = typeof params.reason === "string" ? params.reason : "";
        // Not awaited: the answer is the start, the pass's result is in /refine report.
        passByHand(agentId, sessionId, { ...(reason ? { reason } : {}), ...(dryRun ? { dryRun } : {}) }).then(
          (decision) => log(`refine_run over ${sessionId}: ${decision.earlier ? `already had its call (${decision.outcome})` : decision.outcome}`),
          (error: unknown) => warn(`refine_run over ${sessionId} failed: ${String(error)}`),
        );
        const details = { started: true, session: sessionId, dryRun };
        return {
          content: [{
            type: "text",
            text: `${dryRun ? "Dry run" : "Learning pass"} over session ${sessionId} started in the background. ` +
              "It follows the usual limits and may find nothing; a new lesson is announced and shown from the next turn on; `/refine report` has the result.",
          }],
          details,
        };
      },
    }),
    { name: "refine_run", optional: true },
  );

  if (!storeError && settings.learnEnabled) {
    const warmUp = async () => {
      for (let i = 0; warmUpNormalizer(i); i++) await new Promise((resolve) => setImmediate(resolve));
    };
    setTimeout(() => void runOutsideHostWorkScope(() => schedule(warmUp)).catch(() => undefined), WARM_UP_DELAY_MS).unref?.();
  }

  log(`ready, store at ${store.root}`);
}
