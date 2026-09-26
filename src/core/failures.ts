/**
 * From a session's transcript rows to counted failure patterns.
 *
 * A failure is a tool result the host marked `isError`. Its identity is the
 * fingerprint of `tool | normalized error`, so the same mistake with a different
 * path or request id counts as one pattern. Every occurrence keeps the host's own
 * ids (event, tool call, seq) so a lesson can always be traced back to real rows.
 *
 * The whole session is read, not the newest rows: in the Hermes plugin, reading
 * only the tail hid the first failure in 58% of repeated-failure groups.
 */

import { fingerprint, normalizeError } from "./fingerprint.ts";
import { py } from "./pyre.ts";

/** One row of OpenClaw's `transcript_events`, with `event_json` already parsed. */
export interface TranscriptRow {
  seq: number;
  event: unknown;
}

/** What happened right after a failure, before the user spoke again. */
export type Resolution = "repeated" | "corrected" | "switched" | "unknown";

export interface Occurrence {
  seq: number;
  eventId: string;
  toolCallId: string;
  resolution: Resolution;
}

export interface SessionPattern {
  fingerprint: string;
  tool: string;
  shape: string;
  /** The first occurrence's error text, bounded. */
  sample: string;
  /** The arguments of the first failing call, bounded JSON. */
  sampleArgs: string;
  count: number;
  /** The first occurrences, with host ids, as evidence (bounded). */
  occurrences: Occurrence[];
  /** The transcript seq of every occurrence, unbounded. */
  seqs: number[];
  /** When each occurrence happened (ms since epoch, -1 if the host gave no time), unbounded: what the effect ledger counts. */
  times: number[];
  /** The error names a parameter this tool had already been given successfully earlier in the session. */
  droppedArgument: boolean;
}

/** Bumped whenever extraction changes, so stored summaries from an older parser get re-read. */
export const SUMMARY_FORMAT = 5;

export interface SessionSummary {
  $v: 1;
  format: number;
  sessionId: string;
  agentId: string;
  lastSeq: number;
  errorCount: number;
  /** Errors that state their own remedy ("query is required"): seen, never a candidate. */
  selfCorrectingSuppressed: number;
  patterns: SessionPattern[];
}

const SAMPLE_CHARS = 600;
/**
 * The Hermes plugin fingerprints at most 4000 characters of an error: the first
 * 1000 and the last 3000 (core.collect_evidence). Same bound here, so both plugins
 * give a long error the same identity, and a huge one cannot stall the host.
 */
const ERROR_HEAD_CHARS = 1000;
const ERROR_TAIL_CHARS = 3000;

function boundError(text: string): string {
  return text.length <= ERROR_HEAD_CHARS + ERROR_TAIL_CHARS
    ? text
    : `${text.slice(0, ERROR_HEAD_CHARS)}\n…\n${text.slice(-ERROR_TAIL_CHARS)}`;
}
const ARGS_CHARS = 400;
const OCCURRENCES_KEPT = 20;
/** How many steps after a failure are read to see what the agent did about it. */
const RESOLUTION_LOOKAHEAD = 24;

// -- Transcript parsing -----------------------------------------------------------

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type Step =
  | { kind: "user"; seq: number }
  | { kind: "assistant"; seq: number; calls: ToolCall[] }
  | {
    kind: "result";
    seq: number;
    /** ms since epoch, or -1. */
    at: number;
    eventId: string;
    callId: string;
    tool: string;
    args: Record<string, unknown>;
    isError: boolean;
    text: string;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The text of a message's content. The embedded runtime writes `{type: "text"}`
 * parts; the Codex runtime (the ChatGPT-subscription route) writes one
 * `{type: "toolResult", text, content}` part per result. Any part's `text` counts,
 * then its nested `content`.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type === "toolCall" || part.type === "image") continue;
    const text = typeof part.text === "string" ? part.text : textOf(part.content);
    if (text) texts.push(text);
  }
  return texts.join("\n");
}

/**
 * OpenClaw routes most tools through one `tool_call` tool whose `id` argument
 * names the real tool. The real tool is what a lesson is about.
 */
function effectiveCall(name: string, args: Record<string, unknown>): { tool: string; args: Record<string, unknown> } {
  if (name === "tool_call" && typeof args.id === "string" && args.id) {
    return { tool: args.id, args: isRecord(args.args) ? args.args : {} };
  }
  return { tool: name, args };
}

/** The host writes `message.timestamp` in ms and `event.timestamp` as ISO text. */
function eventTime(message: Record<string, unknown>, event: Record<string, unknown>): number {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  const parsed = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  return Number.isNaN(parsed) ? -1 : parsed;
}

function toSteps(rows: TranscriptRow[]): Step[] {
  const calls = new Map<string, ToolCall>();
  const steps: Step[] = [];
  for (const row of rows) {
    const event = row.event;
    if (!isRecord(event) || event.type !== "message" || !isRecord(event.message)) continue;
    const message = event.message;
    const role = message.role;
    if (role === "user") {
      steps.push({ kind: "user", seq: row.seq });
    } else if (role === "assistant") {
      const found: ToolCall[] = [];
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string") continue;
          const call = {
            id: part.id,
            name: typeof part.name === "string" ? part.name : "",
            args: isRecord(part.arguments) ? part.arguments : {},
          };
          calls.set(call.id, call);
          found.push(call);
        }
      }
      steps.push({ kind: "assistant", seq: row.seq, calls: found });
    } else if (role === "toolResult") {
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const call = calls.get(callId);
      const name = typeof message.toolName === "string" && message.toolName ? message.toolName : call?.name ?? "";
      const { tool, args } = effectiveCall(name, call?.args ?? {});
      const details = isRecord(message.details) ? message.details : {};
      // The structured error is the failure itself; the text part may wrap it in JSON.
      const text = boundError(typeof details.error === "string" && details.error ? details.error : textOf(message.content));
      steps.push({
        kind: "result",
        seq: row.seq,
        at: eventTime(message, event),
        eventId: typeof event.id === "string" ? event.id : "",
        callId,
        tool,
        args,
        isError: message.isError === true,
        text,
      });
    }
  }
  return steps;
}

// -- Self-correcting errors (ported from patterns.py) -----------------------------

const REQUIRED_PARAM = py(String.raw`(?i)\b([a-z][a-z0-9_]{1,40})\s+is\s+required\b`, "g");
const ANCHOR_CHARS = 40;
const NON_PARAM_SUBJECTS = new Set([
  "access", "account", "apikey", "approval", "auth", "authentication",
  "authorisation", "authorization", "certificate", "confirmation", "consent",
  "credential", "credentials", "key", "keys", "license", "licence", "login",
  "password", "payment", "permission", "permissions", "scope", "scopes",
  "secret", "session", "signature", "subscription", "token", "tokens",
  "verification",
  "mfa", "otp", "passkey", "reauth", "reauthentication",
  "reauthorisation", "reauthorization", "sso", "totp",
]);
const NON_PARAM_SUFFIXES = [...NON_PARAM_SUBJECTS].sort().map((word) => `_${word}`);

/**
 * Whether an error states its own remedy ("query is required"), so there is
 * nothing to learn. A missing credential, permission or approval is not that:
 * the tool cannot supply it by retrying, so it stays a real failure.
 */
export function isSelfCorrectingError(content: string): boolean {
  if (!content) return false;
  let matchedInWindow = false;
  for (const match of content.matchAll(REQUIRED_PARAM)) {
    const subject = match[1].toLowerCase();
    const forms = [subject];
    if (subject.endsWith("s")) forms.push(subject.slice(0, -1));
    if (forms.some((form) => NON_PARAM_SUBJECTS.has(form))) return false;
    if (forms.some((form) => NON_PARAM_SUFFIXES.some((suffix) => form.endsWith(suffix)))) return false;
    if (match.index! <= ANCHOR_CHARS) matchedInWindow = true;
  }
  return matchedInWindow;
}

// -- Dropped arguments ------------------------------------------------------------

const MISSING_PARAMETER = [
  py(String.raw`(?i)\b([A-Za-z_][\w.-]{0,60})\s+is\s+(?:a\s+)?required\b`, "g"),
  py(String.raw`(?i)\bmissing\s+(?:required\s+)?(?:parameter|argument|field|property|key)s?\s*[:=]?\s*[\x27"\x60]?([A-Za-z_][\w.-]{0,60})`, "g"),
  py(String.raw`(?i)\brequired\s+(?:parameter|argument|field|property|key)\s*[:=]?\s*[\x27"\x60]?([A-Za-z_][\w.-]{0,60})`, "g"),
];

/** Parameter names an error says are missing. */
export function missingParameters(text: string): string[] {
  const names = new Set<string>();
  for (const pattern of MISSING_PARAMETER) {
    for (const match of text.matchAll(pattern)) names.add(match[1].replace(/^[\x27"`]|[\x27"`.]$/g, ""));
  }
  return [...names];
}

// -- Extraction -------------------------------------------------------------------

function boundedJson(value: unknown, limit: number): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    text = "";
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * What a shell-like call runs. For tools such as Bash, any later success of the same
 * tool is not a correction of this failure: only a success of the same command is.
 * The comparison leans to "not the same": a false match refuses a real repeated failure
 * as self-corrected, a false mismatch only lets it through to the other checks. Tools
 * without a command argument compare by tool alone.
 */
const WRAPPERS = new Set(["sudo", "env", "npx", "exec", "time", "nohup", "command"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd"]);
/** Programs whose standard input is code: a heredoc into them is the command itself. */
const INTERPRETER = /^(?:python[\d.]*|py|node|nodejs|deno|bun|ruby|perl|php|lua|rscript|psql|mysql|sqlite3|duckdb|mongosh|redis-cli)$/;
/** Flags whose value is inline code or a module: `python3 -c '…'`, `node -e`, `python3 -m pytest`. */
const CODE_FLAGS = new Set(["-c", "-e", "--eval", "-m"]);
/** Flags that take a directory or path before the subcommand: `git -C /repo push`, `npm --prefix app test`. */
const VALUE_FLAGS = new Set(["-C", "--prefix", "--cwd", "--dir", "--directory", "--git-dir", "--work-tree", "--manifest-path"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Project runners and container tools that run another command: that command is compared. */
const RUNNERS = new Set(["uv", "poetry", "pipenv", "pdm", "hatch", "rye", "conda", "mamba", "micromamba", "pixi"]);
const RUNNER_VALUE_FLAGS = new Set(["-n", "--name", "-p", "--prefix", "--with", "--env", "-e", "--env-file", "--python", "--project", "--directory", "--package", "--group", "--extra"]);
const CONTAINERS = new Set(["docker", "podman", "nerdctl"]);
const CONTAINER_VALUE_FLAGS = new Set([
  "-e", "--env", "--env-file", "-u", "--user", "-w", "--workdir", "-v", "--volume", "-p", "--publish", "--name",
  "--network", "--entrypoint", "--platform", "--mount", "-m", "--memory", "--cpus", "--gpus", "-l", "--label",
  "--add-host", "--device", "--shm-size", "--ulimit", "--cap-add", "--pull", "--restart", "-h", "--hostname", "--index",
]);
const TIMEOUT_VALUE_FLAGS = new Set(["-s", "--signal", "-k", "--kill-after"]);
/** A heredoc in a word list: this prefix, then the heredoc's body. */
const HEREDOC_MARK = "\u0001";

/**
 * Shell words with quotes kept together. A newline, `;`, `&&`, `||` or a background `&`
 * outside quotes ends a segment; a pipe stays in it as its own `|` word; comments are
 * dropped and line continuations joined. A heredoc (only outside quotes) becomes one
 * word holding its body, and its lines are not commands of their own.
 */
function shellSegments(text: string): string[][] {
  const segments: string[][] = [[]];
  const pending: { segment: string[]; at: number; delimiter: string; tabs: boolean }[] = [];
  let word = "";
  let inWord = false;
  let quote = "";
  const endWord = () => {
    if (inWord) segments[segments.length - 1].push(word);
    word = "";
    inWord = false;
  };
  /** Reads the bodies of the heredocs started on the line just ended; returns the last index read. */
  const readBodies = (from: number): number => {
    let at = from;
    for (const doc of pending) {
      const lines: string[] = [];
      while (at < text.length) {
        let end = text.indexOf("\n", at);
        if (end < 0) end = text.length;
        const line = text.slice(at, end).replace(/\r$/, "");
        at = end + 1;
        if ((doc.tabs ? line.replace(/^\t+/, "") : line).trim() === doc.delimiter) break;
        lines.push(line);
      }
      doc.segment[doc.at] = HEREDOC_MARK + lines.join("\n");
    }
    pending.length = 0;
    return at - 1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (ch === quote) quote = "";
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && (next === "\n" || (next === "\r" && text[i + 2] === "\n"))) {
      endWord();
      i += next === "\r" ? 2 : 1;
    } else if (ch === "\\" && next !== undefined) {
      word += next;
      inWord = true;
      i++;
    } else if (ch === "#" && !inWord) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (ch === "<" && next === "<" && text[i + 2] !== "<" && text[i - 1] !== "<") {
      endWord();
      let j = i + 2;
      const tabs = text[j] === "-";
      if (tabs) j++;
      while (text[j] === " " || text[j] === "\t") j++;
      let delimiter = "";
      if (text[j] === "'" || text[j] === '"') {
        const close = text.indexOf(text[j], j + 1);
        delimiter = text.slice(j + 1, close < 0 ? text.length : close);
        j = close < 0 ? text.length : close + 1;
      } else {
        while (j < text.length && !/[\s;&|<>()'"]/u.test(text[j])) delimiter += text[j++];
      }
      delimiter = delimiter.replace(/\\/g, "");
      if (delimiter) {
        const segment = segments[segments.length - 1];
        segment.push(HEREDOC_MARK);
        pending.push({ segment, at: segment.length - 1, delimiter, tabs });
      }
      i = j - 1;
    } else if (ch === "\n" || ch === ";" || (ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      endWord();
      segments.push([]);
      if (ch === "&" || ch === "|") i++;
      else if (ch === "\n" && pending.length > 0) i = readBodies(i + 1);
    } else if (ch === "&" && next !== ">" && text[i - 1] !== ">" && text[i - 1] !== "<") {
      endWord();
      segments.push([]);
    } else if (ch === "|") {
      endWord();
      segments[segments.length - 1].push("|");
    } else if (/\s/u.test(ch)) {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endWord();
  if (pending.length > 0) readBodies(text.length);
  return segments.filter((segment) => segment.length > 0);
}

const baseName = (word: string) => (word.trim().split(/\s+/)[0] ?? "").split(/[\\/]/).pop()!.toLowerCase();
const programName = (word: string) => baseName(word).replace(/\.exe$/, "");
const code = (text: string) => text.replace(/\s+/g, " ").trim();

/** The words after leading options, then after `operands` more words (a container, a duration). */
function afterOptions(words: string[], valueFlags: Set<string>, operands: number): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (word === "--") {
      i++;
      break;
    }
    if (!word.startsWith("-") || word.length === 1) break;
    i += valueFlags.has(word) ? 2 : 1;
  }
  return words.slice(i + operands);
}

/** The command that does the work, past env assignments, wrappers, runners and containers. */
function innerCommand(command: string[]): string[] {
  let words = command;
  for (let depth = 0; depth < 4; depth++) {
    while (words.length > 1 && (WRAPPERS.has(words[0].toLowerCase()) || ASSIGNMENT.test(words[0]))) words = words.slice(1);
    const program = programName(words[0] ?? "");
    const sub = (words[1] ?? "").toLowerCase();
    let rest: string[] = [];
    if (program === "timeout") rest = afterOptions(words.slice(1), TIMEOUT_VALUE_FLAGS, 1);
    else if (RUNNERS.has(program) && sub === "run") rest = afterOptions(words.slice(2), RUNNER_VALUE_FLAGS, 0);
    else if (CONTAINERS.has(program) && (sub === "exec" || sub === "run")) rest = afterOptions(words.slice(2), CONTAINER_VALUE_FLAGS, 1);
    else if (CONTAINERS.has(program) && sub === "compose" && /^(?:exec|run)$/i.test(words[2] ?? "")) {
      rest = afterOptions(words.slice(3), CONTAINER_VALUE_FLAGS, 1);
    } else if (program === "docker-compose" && (sub === "exec" || sub === "run")) rest = afterOptions(words.slice(2), CONTAINER_VALUE_FLAGS, 1);
    else if (program === "kubectl" && sub === "exec" && words.includes("--")) rest = words.slice(words.indexOf("--") + 1);
    if (rest.length === 0) return words;
    words = rest;
  }
  return words;
}

/** One command: the program and its first two arguments, past flags and redirections. */
function commandKey(command: string[], depth: number): string {
  const stdin = command.filter((word) => word.startsWith(HEREDOC_MARK)).map((word) => word.slice(HEREDOC_MARK.length));
  const words = innerCommand(command.filter((word) => !word.startsWith(HEREDOC_MARK)));
  if (words.length === 0) return "";
  const program = programName(words[0]);
  const found = [program];
  let args = 0;
  for (let i = 1; i < words.length && args < 2; i++) {
    const word = words[i];
    if (args === 0 && SHELLS.has(program) && (/^-[a-z]*c$/i.test(word) || /^-command$/i.test(word) || /^\/c$/i.test(word))) {
      // A shell running a script (`bash -lc 'cd /repo && pytest'`): compare the script.
      const script = words[i + 1] ?? "";
      found.push("-c", depth < 2 ? scriptKey(script, depth + 1) : code(script));
      return found.join(" ");
    }
    if (args === 0 && CODE_FLAGS.has(word)) {
      const value = words[i + 1] ?? "";
      found.push(word, word === "-m" ? baseName(value) : code(value));
      return found.join(" ");
    }
    if (VALUE_FLAGS.has(word)) {
      i++;
      continue;
    }
    if (/^(?:\d*|&)(?:>>?|<)$/.test(word)) {
      i++; // a redirection and its target
      continue;
    }
    if (word.startsWith("-") || /^(?:\d*|&)(?:>>?|<)/.test(word)) continue;
    found.push(baseName(word));
    args++;
  }
  // Code fed on standard input is the command: `python3 - <<EOF … EOF`. For anything
  // else (`cat > notes.md <<EOF`) the heredoc is data.
  if (stdin.length > 0 && SHELLS.has(program)) found.push("<<", depth < 2 ? scriptKey(stdin.join("\n"), depth + 1) : code(stdin.join("\n")));
  else if (stdin.length > 0 && INTERPRETER.test(program)) found.push("<<", code(stdin.join("\n")));
  return found.join(" ");
}

/** Every command of a script except bare directory changes, in order. */
function scriptKey(script: string, depth: number): string {
  const segments = shellSegments(script);
  const work = segments.filter((words) => !/^(?:cd|pushd|popd)$/i.test(words[0]));
  return (work.length > 0 ? work : segments)
    .map((words) => {
      const pipeline: string[][] = [[]];
      for (const word of words) {
        if (word === "|") pipeline.push([]);
        else pipeline[pipeline.length - 1].push(word);
      }
      return pipeline.map((command) => commandKey(command, depth)).join(" | ");
    })
    .join(" ; ");
}

function leadingCommand(args: Record<string, unknown>): string | null {
  for (const key of ["command", "cmd", "script"]) {
    const value = args[key];
    let found = "";
    if (typeof value === "string") found = scriptKey(value, 0);
    else if (Array.isArray(value) && value.length > 0 && value.every((word) => typeof word === "string")) {
      found = commandKey(value as string[], 0);
    }
    if (found) return found;
  }
  return null;
}

/** Whether a later success ran the same command as the failure; no command compares by tool. */
function sameAction(failed: string | null, later: string | null): boolean {
  return failed === null || later === null || failed === later;
}

function resolve(
  steps: Step[],
  fingerprints: Map<number, string>,
  index: number,
  fp: string,
  tool: string,
  commandAt: (index: number) => string | null,
): Resolution {
  const end = Math.min(steps.length, index + 1 + RESOLUTION_LOOKAHEAD);
  for (let i = index + 1; i < end; i++) {
    const step = steps[i];
    if (step.kind === "user") break;
    if (step.kind !== "result") continue;
    if (step.isError) {
      if (fingerprints.get(i) === fp) return "repeated";
      continue;
    }
    if (step.tool !== tool) return "switched";
    if (sameAction(commandAt(index), commandAt(i))) return "corrected";
    // The same tool succeeded at something else: the failure is not resolved yet.
  }
  return "unknown";
}

export function summarizeSession(sessionId: string, agentId: string, rows: TranscriptRow[]): SessionSummary {
  const steps = toSteps(rows);
  // Each failed row is fingerprinted once; resolve() looks ahead over the same rows.
  const fingerprints = new Map<number, string>();
  steps.forEach((step, index) => {
    if (step.kind === "result" && step.isError && step.text) fingerprints.set(index, fingerprint(step.tool, step.text));
  });
  // Each call's command is parsed once, however many failures look ahead at it.
  const commands = new Map<number, string | null>();
  const commandAt = (i: number) => {
    if (!commands.has(i)) {
      const step = steps[i];
      commands.set(i, step.kind === "result" ? leadingCommand(step.args) : null);
    }
    return commands.get(i)!;
  };
  const byFingerprint = new Map<string, SessionPattern>();
  /** Argument names each tool has been called with successfully so far. */
  const usedArgs = new Map<string, Set<string>>();
  let errorCount = 0;
  let suppressed = 0;

  steps.forEach((step, index) => {
    if (step.kind !== "result") return;
    if (!step.isError) {
      const seen = usedArgs.get(step.tool) ?? new Set<string>();
      for (const key of Object.keys(step.args)) seen.add(key);
      usedArgs.set(step.tool, seen);
      return;
    }
    if (!step.text) return;
    errorCount++;
    if (isSelfCorrectingError(step.text)) {
      suppressed++;
      return;
    }
    const fp = fingerprints.get(index)!;
    const occurrence: Occurrence = {
      seq: step.seq,
      eventId: step.eventId,
      toolCallId: step.callId,
      resolution: resolve(steps, fingerprints, index, fp, step.tool, commandAt),
    };
    const already = usedArgs.get(step.tool);
    const dropped = !!already && missingParameters(step.text).some((name) => already.has(name));
    const pattern = byFingerprint.get(fp);
    if (!pattern) {
      byFingerprint.set(fp, {
        fingerprint: fp,
        tool: step.tool,
        shape: normalizeError(step.text),
        sample: step.text.slice(0, SAMPLE_CHARS),
        sampleArgs: boundedJson(step.args, ARGS_CHARS),
        count: 1,
        occurrences: [occurrence],
        seqs: [step.seq],
        times: [step.at],
        droppedArgument: dropped,
      });
      return;
    }
    pattern.count++;
    pattern.seqs.push(step.seq);
    pattern.times.push(step.at);
    if (pattern.occurrences.length < OCCURRENCES_KEPT) pattern.occurrences.push(occurrence);
    pattern.droppedArgument ||= dropped;
  });

  const lastSeq = rows.reduce((max, row) => Math.max(max, row.seq), -1);
  return {
    $v: 1,
    format: SUMMARY_FORMAT,
    sessionId,
    agentId,
    lastSeq,
    errorCount,
    selfCorrectingSuppressed: suppressed,
    patterns: [...byFingerprint.values()].sort((a, b) => b.count - a.count),
  };
}

// -- Across sessions --------------------------------------------------------------

export interface AggregatePattern {
  fingerprint: string;
  tool: string;
  shape: string;
  sample: string;
  sampleArgs: string;
  count: number;
  sessionIds: string[];
  droppedArgument: boolean;
}

/**
 * Sum patterns over sessions. Each session contributes its own summary once, so
 * re-reading a session that grew replaces its contribution instead of adding to it.
 */
export function aggregate(summaries: SessionSummary[]): Map<string, AggregatePattern> {
  const out = new Map<string, AggregatePattern>();
  for (const summary of summaries) {
    for (const pattern of summary.patterns) {
      const entry = out.get(pattern.fingerprint);
      if (!entry) {
        out.set(pattern.fingerprint, {
          fingerprint: pattern.fingerprint,
          tool: pattern.tool,
          shape: pattern.shape,
          sample: pattern.sample,
          sampleArgs: pattern.sampleArgs,
          count: pattern.count,
          sessionIds: [summary.sessionId],
          droppedArgument: pattern.droppedArgument,
        });
        continue;
      }
      entry.count += pattern.count;
      if (!entry.sessionIds.includes(summary.sessionId)) entry.sessionIds.push(summary.sessionId);
      entry.droppedArgument ||= pattern.droppedArgument;
    }
  }
  return out;
}
