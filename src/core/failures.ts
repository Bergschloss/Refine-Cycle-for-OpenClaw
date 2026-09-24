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
  occurrences: Occurrence[];
  /** The error names a parameter this tool had already been given successfully earlier in the session. */
  droppedArgument: boolean;
}

export interface SessionSummary {
  $v: 1;
  sessionId: string;
  agentId: string;
  lastSeq: number;
  errorCount: number;
  /** Errors that state their own remedy ("query is required"): seen, never a candidate. */
  selfCorrectingSuppressed: number;
  patterns: SessionPattern[];
}

const SAMPLE_CHARS = 600;
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

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => (part as { text: string }).text)
    .join("\n");
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
      const text = typeof details.error === "string" && details.error ? details.error : textOf(message.content);
      steps.push({
        kind: "result",
        seq: row.seq,
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

function resolve(steps: Step[], index: number, fp: string, tool: string): Resolution {
  const end = Math.min(steps.length, index + 1 + RESOLUTION_LOOKAHEAD);
  for (let i = index + 1; i < end; i++) {
    const step = steps[i];
    if (step.kind === "user") break;
    if (step.kind !== "result") continue;
    if (step.isError) {
      if (fingerprint(step.tool, step.text) === fp) return "repeated";
      continue;
    }
    return step.tool === tool ? "corrected" : "switched";
  }
  return "unknown";
}

export function summarizeSession(sessionId: string, agentId: string, rows: TranscriptRow[]): SessionSummary {
  const steps = toSteps(rows);
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
    const fp = fingerprint(step.tool, step.text);
    const occurrence: Occurrence = {
      seq: step.seq,
      eventId: step.eventId,
      toolCallId: step.callId,
      resolution: resolve(steps, index, fp, step.tool),
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
        droppedArgument: dropped,
      });
      return;
    }
    pattern.count++;
    if (pattern.occurrences.length < OCCURRENCES_KEPT) pattern.occurrences.push(occurrence);
    pattern.droppedArgument ||= dropped;
  });

  const lastSeq = rows.reduce((max, row) => Math.max(max, row.seq), -1);
  return {
    $v: 1,
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
