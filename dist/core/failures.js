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
import { fingerprint, normalizeError } from "./fingerprint.js";
import { py } from "./pyre.js";
/** Bumped whenever extraction changes, so stored summaries from an older parser get re-read. */
export const SUMMARY_FORMAT = 5;
const SAMPLE_CHARS = 600;
/**
 * The Hermes plugin fingerprints at most 4000 characters of an error: the first
 * 1000 and the last 3000 (core.collect_evidence). Same bound here, so both plugins
 * give a long error the same identity, and a huge one cannot stall the host.
 */
const ERROR_HEAD_CHARS = 1000;
const ERROR_TAIL_CHARS = 3000;
function boundError(text) {
    return text.length <= ERROR_HEAD_CHARS + ERROR_TAIL_CHARS
        ? text
        : `${text.slice(0, ERROR_HEAD_CHARS)}\n…\n${text.slice(-ERROR_TAIL_CHARS)}`;
}
const ARGS_CHARS = 400;
const OCCURRENCES_KEPT = 20;
/** How many steps after a failure are read to see what the agent did about it. */
const RESOLUTION_LOOKAHEAD = 24;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * The text of a message's content. The embedded runtime writes `{type: "text"}`
 * parts; the Codex runtime (the ChatGPT-subscription route) writes one
 * `{type: "toolResult", text, content}` part per result. Any part's `text` counts,
 * then its nested `content`.
 */
function textOf(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const texts = [];
    for (const part of content) {
        if (!isRecord(part) || part.type === "toolCall" || part.type === "image")
            continue;
        const text = typeof part.text === "string" ? part.text : textOf(part.content);
        if (text)
            texts.push(text);
    }
    return texts.join("\n");
}
/**
 * OpenClaw routes most tools through one `tool_call` tool whose `id` argument
 * names the real tool. The real tool is what a lesson is about.
 */
function effectiveCall(name, args) {
    if (name === "tool_call" && typeof args.id === "string" && args.id) {
        return { tool: args.id, args: isRecord(args.args) ? args.args : {} };
    }
    return { tool: name, args };
}
/** The host writes `message.timestamp` in ms and `event.timestamp` as ISO text. */
function eventTime(message, event) {
    if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp))
        return message.timestamp;
    const parsed = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
    return Number.isNaN(parsed) ? -1 : parsed;
}
function toSteps(rows) {
    const calls = new Map();
    const steps = [];
    for (const row of rows) {
        const event = row.event;
        if (!isRecord(event) || event.type !== "message" || !isRecord(event.message))
            continue;
        const message = event.message;
        const role = message.role;
        if (role === "user") {
            steps.push({ kind: "user", seq: row.seq });
        }
        else if (role === "assistant") {
            const found = [];
            if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string")
                        continue;
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
        }
        else if (role === "toolResult") {
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
const REQUIRED_PARAM = py(String.raw `(?i)\b([a-z][a-z0-9_]{1,40})\s+is\s+required\b`, "g");
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
export function isSelfCorrectingError(content) {
    if (!content)
        return false;
    let matchedInWindow = false;
    for (const match of content.matchAll(REQUIRED_PARAM)) {
        const subject = match[1].toLowerCase();
        const forms = [subject];
        if (subject.endsWith("s"))
            forms.push(subject.slice(0, -1));
        if (forms.some((form) => NON_PARAM_SUBJECTS.has(form)))
            return false;
        if (forms.some((form) => NON_PARAM_SUFFIXES.some((suffix) => form.endsWith(suffix))))
            return false;
        if (match.index <= ANCHOR_CHARS)
            matchedInWindow = true;
    }
    return matchedInWindow;
}
// -- Dropped arguments ------------------------------------------------------------
const MISSING_PARAMETER = [
    py(String.raw `(?i)\b([A-Za-z_][\w.-]{0,60})\s+is\s+(?:a\s+)?required\b`, "g"),
    py(String.raw `(?i)\bmissing\s+(?:required\s+)?(?:parameter|argument|field|property|key)s?\s*[:=]?\s*[\x27"\x60]?([A-Za-z_][\w.-]{0,60})`, "g"),
    py(String.raw `(?i)\brequired\s+(?:parameter|argument|field|property|key)\s*[:=]?\s*[\x27"\x60]?([A-Za-z_][\w.-]{0,60})`, "g"),
];
/** Parameter names an error says are missing. */
export function missingParameters(text) {
    const names = new Set();
    for (const pattern of MISSING_PARAMETER) {
        for (const match of text.matchAll(pattern))
            names.add(match[1].replace(/^[\x27"`]|[\x27"`.]$/g, ""));
    }
    return [...names];
}
// -- Extraction -------------------------------------------------------------------
function boundedJson(value, limit) {
    let text;
    try {
        text = JSON.stringify(value) ?? "";
    }
    catch {
        text = "";
    }
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
/**
 * The command a shell-like call runs (its first word). For tools such as Bash, any later
 * success of the same tool is not a correction of this failure: only a success of the
 * same command is. Tools without a command argument compare by tool alone.
 */
function leadingCommand(args) {
    for (const key of ["command", "cmd", "script"]) {
        const value = args[key];
        if (typeof value === "string" && value.trim()) {
            const first = value.trim().split(/\s+/)[0];
            return first.split(/[\\/]/).pop().toLowerCase();
        }
    }
    return null;
}
function sameAction(failed, later) {
    const a = leadingCommand(failed);
    const b = leadingCommand(later);
    return a === null || b === null || a === b;
}
function resolve(steps, fingerprints, index, fp, tool, args) {
    const end = Math.min(steps.length, index + 1 + RESOLUTION_LOOKAHEAD);
    for (let i = index + 1; i < end; i++) {
        const step = steps[i];
        if (step.kind === "user")
            break;
        if (step.kind !== "result")
            continue;
        if (step.isError) {
            if (fingerprints.get(i) === fp)
                return "repeated";
            continue;
        }
        if (step.tool !== tool)
            return "switched";
        if (sameAction(args, step.args))
            return "corrected";
        // The same tool succeeded at something else: the failure is not resolved yet.
    }
    return "unknown";
}
export function summarizeSession(sessionId, agentId, rows) {
    const steps = toSteps(rows);
    // Each failed row is fingerprinted once; resolve() looks ahead over the same rows.
    const fingerprints = new Map();
    steps.forEach((step, index) => {
        if (step.kind === "result" && step.isError && step.text)
            fingerprints.set(index, fingerprint(step.tool, step.text));
    });
    const byFingerprint = new Map();
    /** Argument names each tool has been called with successfully so far. */
    const usedArgs = new Map();
    let errorCount = 0;
    let suppressed = 0;
    steps.forEach((step, index) => {
        if (step.kind !== "result")
            return;
        if (!step.isError) {
            const seen = usedArgs.get(step.tool) ?? new Set();
            for (const key of Object.keys(step.args))
                seen.add(key);
            usedArgs.set(step.tool, seen);
            return;
        }
        if (!step.text)
            return;
        errorCount++;
        if (isSelfCorrectingError(step.text)) {
            suppressed++;
            return;
        }
        const fp = fingerprints.get(index);
        const occurrence = {
            seq: step.seq,
            eventId: step.eventId,
            toolCallId: step.callId,
            resolution: resolve(steps, fingerprints, index, fp, step.tool, step.args),
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
        if (pattern.occurrences.length < OCCURRENCES_KEPT)
            pattern.occurrences.push(occurrence);
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
/**
 * Sum patterns over sessions. Each session contributes its own summary once, so
 * re-reading a session that grew replaces its contribution instead of adding to it.
 */
export function aggregate(summaries) {
    const out = new Map();
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
            if (!entry.sessionIds.includes(summary.sessionId))
                entry.sessionIds.push(summary.sessionId);
            entry.droppedArgument ||= pattern.droppedArgument;
        }
    }
    return out;
}
