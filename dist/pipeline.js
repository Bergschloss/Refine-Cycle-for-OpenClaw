/**
 * The learning loop for one ended turn. Host-independent: the host hands in a
 * history reader, a model call and the text of the agent's skills and
 * instructions, so the whole loop runs in tests against a fake host.
 *
 * Order: read the whole session, count its failures, then refuse everything that
 * can be refused without a model call; only one survivor per session may reach
 * the model, and only within the day's budget, which is spent before the call.
 */
import { aggregate, summarizeSessionInSlices, SUMMARY_FORMAT } from "./core/failures.js";
import { findCoveringRule } from "./core/covered.js";
import { lessonShape } from "./core/shape.js";
import { buildShortenMessage, buildUserMessage, parseProposal, parseShortened, SHORTEN_SYSTEM_PROMPT, SYSTEM_PROMPT, validateLesson } from "./core/proposal.js";
import { formatBlock } from "./core/injection.js";
import { BRAND, usageNote } from "./core/notice.js";
import { AGE_GATE_DAYS, MIN_QUIET_SESSIONS, RECURRENCE_HORIZON_DAYS, REMOVAL_CANDIDATES, verdict } from "./core/audit.js";
import { activate, activeLessons, allLessons, DEFAULT_AGENT, journalState, lessonAgent, LessonExistsError, lessonId, recover } from "./lessons.js";
import { safeName, StoreError } from "./store.js";
const REPLY_KEPT_CHARS = 2000;
/** Files read between two yields to the event loop: the host's other sessions keep running. */
const FILES_PER_SLICE = 200;
/** Let the host's event loop run. The learning work shares the gateway's process. */
function yieldToHost() {
    return new Promise((resolve) => setImmediate(resolve));
}
function budgetPath(now) {
    return `budget/${now.toISOString().slice(0, 10)}.json`;
}
/** Model calls recorded today (UTC), the shortening calls included: what `budget/<date>.json` holds. */
export function callsToday(store, now) {
    return store.read(budgetPath(now))?.calls?.length ?? 0;
}
/** Spend one call before making it, and mark its failure proposed. A refusal when the day is spent or its record cannot be trusted. */
function reserveCall(store, now, max, sessionId, agentId, fingerprint) {
    let release;
    try {
        release = store.lock("budget", 0);
    }
    catch (error) {
        if (error instanceof StoreError)
            return { rule: "budget_busy" };
        throw error;
    }
    try {
        const refusal = reserveLocked(store, now, max, sessionId, fingerprint);
        // Written under the same lock, right after the budget: a call spent is a failure
        // proposed, and the queue never offers it again as a failure nobody has seen.
        if (!refusal)
            store.write(proposedPath(agentId, fingerprint), { agentId, fingerprint, sessionId, at: now.toISOString() });
        return refusal;
    }
    finally {
        release();
    }
}
/**
 * Without the lock, whether this session could still get its call today. Only a
 * shortcut before the queue's scan: the reservation itself decides, under the lock.
 */
function callLeft(store, now, max, sessionId) {
    const calls = store.read(budgetPath(now))?.calls ?? [];
    return calls.length < max && !calls.some((call) => call.sessionId === sessionId);
}
/**
 * Room in the day's budget for one more call of a session that already has its call
 * (the shortening request). The per-session rule does not apply to it; the daily cap does,
 * and the call is recorded so the cap counts every model call made.
 */
function reserveExtraCall(store, now, max, sessionId, fingerprint) {
    let release;
    try {
        release = store.lock("budget", 0);
    }
    catch (error) {
        if (error instanceof StoreError)
            return { rule: "budget_busy" };
        throw error;
    }
    try {
        const relative = budgetPath(now);
        const day = store.read(relative);
        if (!day && store.exists(relative))
            return { rule: "budget_unreadable" };
        const calls = day?.calls ?? [];
        if (calls.length >= max)
            return { rule: "budget_spent", detail: `${calls.length}/${max} calls today` };
        store.write(relative, {
            day: now.toISOString().slice(0, 10),
            calls: [...calls, { sessionId, fingerprint, at: now.toISOString(), purpose: "shorten" }],
        });
        return null;
    }
    finally {
        release();
    }
}
function reserveLocked(store, now, max, sessionId, fingerprint) {
    const relative = budgetPath(now);
    const day = store.read(relative);
    if (!day && store.exists(relative))
        return { rule: "budget_unreadable" };
    const calls = day?.calls ?? [];
    // One call per session, even if a crash lost the session's own record of it.
    if (calls.some((call) => call.sessionId === sessionId))
        return { rule: "already_called" };
    if (calls.length >= max)
        return { rule: "budget_spent", detail: `${calls.length}/${max} calls today` };
    store.write(relative, {
        day: now.toISOString().slice(0, 10),
        calls: [...calls, { sessionId, fingerprint, at: now.toISOString() }],
    });
    return null;
}
function proposedPath(agentId, fingerprint) {
    return `proposed/${safeName(`${agentId}--${fingerprint}`)}.json`;
}
export function readProposed(store, agentId, fingerprint) {
    const mark = store.read(proposedPath(agentId, fingerprint));
    return mark && mark.agentId === agentId && mark.fingerprint === fingerprint ? mark : undefined;
}
function markAnswered(deps, agentId, fingerprint, answer, sessionIds, now) {
    const mark = readProposed(deps.store, agentId, fingerprint);
    if (!mark)
        return;
    try {
        deps.store.write(proposedPath(agentId, fingerprint), { ...mark, answer, answeredAt: now.toISOString(), sessionIds: sessionIds.slice(0, 200) });
    }
    catch (error) {
        // Bookkeeping for the queue and the pause only: the answer itself (a lesson above
        // all) must still be saved. Without the mark the failure may be offered once more.
        deps.log(`could not record the model's answer for ${fingerprint}: ${String(error)}`);
    }
}
/** How long a failure the model answered "nothing" for is not sent again (owner decision 2026-09-28). */
export const PAUSE_AFTER_NOTHING_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The end of the pause (ISO) when the model's last answer for this failure was
 * "nothing", less than a week ago, and every session the failure is seen in now was
 * already seen then; otherwise null. A new session is new evidence and ends the pause.
 */
export function pausedUntil(mark, pattern, now) {
    if (mark?.answer !== "nothing" || !mark.answeredAt)
        return null;
    const until = Date.parse(mark.answeredAt) + PAUSE_AFTER_NOTHING_MS;
    if (!(now.getTime() < until))
        return null;
    const seen = new Set(mark.sessionIds ?? []);
    if (pattern.sessionIds.some((id) => !seen.has(id)))
        return null;
    return new Date(until).toISOString();
}
/**
 * Has the model had its say on this failure? A call that ended in an error, or that a
 * crash cut short, gave no answer, and a dry run's lesson was not saved: that failure
 * may still be offered from the queue.
 */
function answeredBefore(mark) {
    return !!mark?.answer && mark.answer !== "error" && mark.answer !== "preview";
}
/** Has the failure been seen in a session the model had not seen when it last answered? */
function seenSince(mark, pattern) {
    const seen = new Set(mark.sessionIds ?? []);
    return pattern.sessionIds.some((id) => !seen.has(id));
}
/** When a failure was first seen, over every session of the agent (ms; +Infinity when the host gave no time). */
function firstSeen(summaries) {
    const out = new Map();
    for (const summary of summaries) {
        for (const pattern of summary.patterns) {
            // A loop, not Math.min(...times): `times` is unbounded and a spread can overflow the stack.
            let first = Number.POSITIVE_INFINITY;
            for (const time of Array.isArray(pattern.times) ? pattern.times : [])
                if (time >= 0 && time < first)
                    first = time;
            out.set(pattern.fingerprint, Math.min(out.get(pattern.fingerprint) ?? Number.POSITIVE_INFINITY, first));
        }
    }
    return out;
}
/** The failure's own record in the latest session it was seen in: the evidence the model is shown. */
function latestLocal(summaries, fingerprint) {
    let best;
    for (const summary of summaries) {
        const local = summary.patterns.find((pattern) => pattern.fingerprint === fingerprint);
        if (!local)
            continue;
        let at = -1;
        for (const time of Array.isArray(local.times) ? local.times : [])
            if (time > at)
                at = time;
        if (!best || at >= best.at)
            best = { local, at };
    }
    return best?.local;
}
/**
 * The oldest failure of the agent that passes every rule and that the model has not
 * answered with the evidence there is now: what a session with nothing of its own spends its call on. Cheap filters
 * first (the bar, the mark), the full refusal rules only for the survivors, oldest first.
 */
async function fromQueue(deps, agentId, patterns, summaries, sources) {
    for (const { pattern, local } of queueCandidates(deps, agentId, patterns, summaries)) {
        await yieldToHost();
        if (!refuse(deps, agentId, pattern, local, sources))
            return { pattern, local };
    }
    return null;
}
function queueCandidates(deps, agentId, patterns, summaries) {
    const { minSessions, minOccurrences } = deps.settings;
    const seen = firstSeen(summaries);
    const out = [];
    for (const pattern of patterns.values()) {
        if (!(pattern.sessionIds.length >= minSessions || pattern.count >= minOccurrences))
            continue;
        const mark = readProposed(deps.store, agentId, pattern.fingerprint);
        // Answered once, and not seen in any session since: asking again would show the model
        // the same evidence. A new session is new evidence, as it is for the pause.
        if (answeredBefore(mark) && !seenSince(mark, pattern))
            continue;
        const local = latestLocal(summaries, pattern.fingerprint);
        if (local)
            out.push({ pattern, local, at: seen.get(pattern.fingerprint) ?? Number.POSITIVE_INFINITY });
    }
    return out.sort((a, b) => a.at - b.at || a.pattern.fingerprint.localeCompare(b.pattern.fingerprint));
}
/**
 * How many failures wait in the agent's queue: past the bar, not refused, never
 * answered by the model. Reads the instruction files, so it is for `status`, not the hot path.
 */
export async function queueLength(deps, agentId) {
    const summaries = await agentSummaries(deps.store, agentId);
    const patterns = aggregate(summaries);
    let cached = null;
    const sources = () => (cached ??= deps.sources());
    let n = 0;
    for (const { pattern, local } of queueCandidates(deps, agentId, patterns, summaries)) {
        await yieldToHost();
        if (!refuse(deps, agentId, pattern, local, sources))
            n++;
    }
    return n;
}
function effectsPath(sessionId) {
    return `effects/${safeName(sessionId)}.json`;
}
/** Remember which lessons a session was shown. Called after the turn, never from the prompt hook. */
export function recordExposure(store, sessionId, block, shownAtMs, now) {
    const current = store.read(effectsPath(sessionId));
    const exposures = current?.exposures ?? [];
    const fresh = block.lessonIds.filter((id) => !exposures.some((exposure) => exposure.lessonId === id && exposure.blockHash === block.hash));
    if (fresh.length === 0)
        return;
    store.write(effectsPath(sessionId), {
        ...current,
        sessionId,
        exposures: [...exposures, ...fresh.map((id) => ({ lessonId: id, blockHash: block.hash, at: now.toISOString(), shownAtMs }))],
        recurrence: current?.recurrence ?? {},
    });
}
function updateRecurrence(store, summary) {
    const current = store.read(effectsPath(summary.sessionId));
    if (!current || current.exposures.length === 0)
        return;
    const fingerprintOf = new Map(allLessons(store).map((lesson) => [lesson.id, lesson.fingerprint]));
    // Only failures after the lesson was first shown count against it. The time comes
    // from the prompt hook itself, so it does not depend on how far the background
    // summary had got; an occurrence the host gave no time for cannot be placed and is not counted.
    const firstShown = new Map();
    for (const exposure of current.exposures) {
        const shown = typeof exposure.shownAtMs === "number" ? exposure.shownAtMs : Date.parse(exposure.at);
        firstShown.set(exposure.lessonId, Math.min(firstShown.get(exposure.lessonId) ?? shown, shown));
    }
    const recurrence = {};
    const unplaced = {};
    for (const [lessonIdValue, shown] of firstShown) {
        const fp = fingerprintOf.get(lessonIdValue);
        const pattern = summary.patterns.find((entry) => entry.fingerprint === fp);
        const times = pattern && Array.isArray(pattern.times) ? pattern.times : [];
        recurrence[lessonIdValue] = times.filter((time) => time >= 0 && time > shown).length;
        const unknown = times.filter((time) => time < 0).length;
        if (unknown)
            unplaced[lessonIdValue] = unknown;
    }
    store.write(effectsPath(summary.sessionId), { ...current, recurrence, unplaced });
    recordLedger(store, summary.sessionId, recurrence, unplaced, new Date());
}
// -- The per-lesson ledger (what /refine audit rests on) ----------------------------
/** Sessions kept one by one per lesson; older ones are folded into totals, so a record stays small. */
const LEDGER_SESSIONS_KEPT = 1000;
function ledgerPath(lessonIdValue) {
    return `ledger/${safeName(lessonIdValue)}.json`;
}
function pendingLedgerPath(sessionId) {
    return `ledger-pending/${safeName(sessionId)}.json`;
}
/**
 * Add one session's effect to each shown lesson's record, under the ledger lock and
 * without waiting. If another process holds it, the session is marked and its effect
 * (kept in `effects/`) is added by the next update that gets the lock: never lost.
 */
/** Add one session's effect to each shown lesson's record. The caller holds the ledger lock. */
function applyToLedger(store, sessionId, recurrence, unplaced, now) {
    for (const [id, n] of Object.entries(recurrence)) {
        const record = store.read(ledgerPath(id)) ?? { lessonId: id, sessions: {}, folded: { shown: 0, cameBack: 0, recurrences: 0, unplaced: 0 }, updatedAt: "" };
        const sessions = { ...record.sessions, [sessionId]: { recurrence: n, unplaced: unplaced[id] ?? 0, at: now.toISOString() } };
        const folded = { ...record.folded };
        const ids = Object.keys(sessions);
        if (ids.length > LEDGER_SESSIONS_KEPT) {
            const oldest = ids.sort((a, b) => sessions[a].at.localeCompare(sessions[b].at)).slice(0, ids.length - LEDGER_SESSIONS_KEPT);
            for (const old of oldest) {
                const entry = sessions[old];
                folded.shown++;
                if (entry.recurrence > 0)
                    folded.cameBack++;
                folded.recurrences += entry.recurrence;
                folded.unplaced += entry.unplaced;
                delete sessions[old];
            }
        }
        store.write(ledgerPath(id), { lessonId: id, sessions, folded, updatedAt: now.toISOString() });
    }
}
/**
 * Add one session's effect to each shown lesson's record, under the ledger lock and
 * without waiting. If another process holds it, the session is marked and its effect
 * (kept in `effects/`) is added by the next update that gets the lock: never lost.
 */
function recordLedger(store, sessionId, recurrence, unplaced, now) {
    let release;
    try {
        release = store.lock("ledger", 0);
    }
    catch (error) {
        if (!(error instanceof StoreError))
            throw error;
        store.write(pendingLedgerPath(sessionId), { sessionId });
        return;
    }
    try {
        for (const name of store.list("ledger-pending")) {
            const marker = store.read(`ledger-pending/${name}.json`);
            const effect = marker && store.read(effectsPath(marker.sessionId));
            if (effect && marker.sessionId !== sessionId)
                applyToLedger(store, marker.sessionId, effect.recurrence ?? {}, effect.unplaced ?? {}, now);
            store.remove(`ledger-pending/${name}.json`);
        }
        applyToLedger(store, sessionId, recurrence, unplaced, now);
    }
    finally {
        release();
    }
}
/**
 * Once per store: build the ledger from the `effects/` records written before it existed,
 * so an update keeps every lesson's history. In slices; false while another process holds the lock.
 */
export async function ensureLedger(store, now, pause = yieldToHost) {
    if (store.exists("ledger-built.json"))
        return true;
    let release;
    try {
        release = store.lock("ledger", 0);
    }
    catch (error) {
        if (error instanceof StoreError)
            return false;
        throw error;
    }
    try {
        if (store.exists("ledger-built.json"))
            return true;
        const names = store.list("effects");
        for (let i = 0; i < names.length; i++) {
            if (i > 0 && i % FILES_PER_SLICE === 0)
                await pause();
            const effect = store.read(`effects/${names[i]}.json`);
            if (effect?.sessionId && effect.recurrence)
                applyToLedger(store, effect.sessionId, effect.recurrence, effect.unplaced ?? {}, now);
        }
        store.write("ledger-built.json", { at: now.toISOString(), sessions: names.length });
        return true;
    }
    finally {
        release();
    }
}
/** A lesson's counts, from its ledger record. */
export function ledgerCounts(store, lessonIdValue) {
    const record = store.read(ledgerPath(lessonIdValue));
    const counts = { ...(record?.folded ?? { shown: 0, cameBack: 0, recurrences: 0, unplaced: 0 }) };
    for (const entry of Object.values(record?.sessions ?? {})) {
        counts.shown++;
        if (entry.recurrence > 0)
            counts.cameBack++;
        counts.recurrences += entry.recurrence;
        counts.unplaced += entry.unplaced;
    }
    return counts;
}
/**
 * Every lesson's verdict (of one agent, when given), from its ledger record. Read-only:
 * `audit` and `status` both answer from this, so they cannot disagree.
 */
export function judgeLessons(store, now, agentId) {
    const decisions = store
        .list("candidates")
        .map((name) => store.read(`candidates/${name}.json`))
        .filter((d) => !!d);
    const rows = [];
    for (const lesson of allLessons(store)) {
        const owner = lessonAgent(lesson);
        if (lesson.status === "draft" || (agentId !== undefined && owner !== agentId))
            continue;
        const counts = ledgerCounts(store, lesson.id);
        const windowOpen = counts.shown > 0 || decisions.some((d) => (d.agentId || DEFAULT_AGENT) === owner && d.at > lesson.createdAt);
        const ageDays = Math.max(0, Math.floor((now.getTime() - Date.parse(lesson.createdAt)) / 86_400_000));
        const judged = verdict({ ...counts, status: lesson.status, ageDays, windowOpen });
        rows.push({ id: lesson.id, agentId: owner, text: lesson.text, status: lesson.status, ageDays, counts, ...judged });
    }
    return rows.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.ageDays - b.ageDays || a.id.localeCompare(b.id));
}
/**
 * Every lesson's verdict (of one agent, when given). The verdict and when it was given
 * are kept per lesson (`verdicts/`), best effort: the audit's answer does not depend on it.
 */
export function audit(store, now, agentId) {
    const rows = judgeLessons(store, now, agentId);
    for (const row of rows) {
        try {
            const last = store.read(`verdicts/${safeName(row.id)}.json`);
            if (last?.verdict !== row.verdict)
                store.write(`verdicts/${safeName(row.id)}.json`, { lessonId: row.id, verdict: row.verdict, why: row.why, at: now.toISOString() });
        }
        catch {
            // the verdict is shown either way
        }
    }
    return rows;
}
/** The audit for people, in the shape of the Hermes one: a row per lesson, then the removal candidates. */
export function describeAudit(rows, oneAgent, rollback) {
    if (rows.length === 0)
        return "No lessons yet.";
    const lines = [`Refine Cycle lessons (${rows.length}):`, "", `  ${"lesson".padEnd(oneAgent ? 10 : 22)} ${"age".padStart(5)}  ${"shown".padStart(5)}  ${"came back".padStart(9)}  verdict`];
    for (const row of rows) {
        const name = oneAgent ? row.id : `${row.id} (${row.agentId})`;
        lines.push(`  ${name.padEnd(oneAgent ? 10 : 22)} ${`${row.ageDays}d`.padStart(5)}  ${String(row.counts.shown).padStart(5)}  ${String(row.counts.cameBack).padStart(9)}  ${row.verdict}`);
        lines.push(`      ${row.text.length > 80 ? `${row.text.slice(0, 79)}…` : row.text}`);
        lines.push(`      why: ${row.why}`);
    }
    const candidates = rows.filter((row) => REMOVAL_CANDIDATES.has(row.verdict));
    if (candidates.length) {
        lines.push("", "Candidates for removal:", ...candidates.map((row) => `  ${row.id} — ${rollback(row.id)}`), "", "Nothing was deleted. Run the command yourself if you agree.");
    }
    lines.push("", `shown = sessions it was in front of the agent; came back = of those, sessions where its failure happened again after it was shown. ` +
        `working after ${MIN_QUIET_SESSIONS} sessions that showed it with no recurrence and ${RECURRENCE_HORIZON_DAYS} days; below that, too early; unused waits ${AGE_GATE_DAYS} days.`);
    return lines.join("\n");
}
// -- The loop ---------------------------------------------------------------------
function sessionPath(sessionId) {
    return `sessions/${safeName(sessionId)}.json`;
}
function candidatePath(sessionId) {
    return `candidates/${safeName(sessionId)}.json`;
}
async function summarizeAndStore(deps, sessionId, agentId) {
    const summary = await summarizeSessionInSlices(sessionId, agentId, await deps.history.readSession(sessionId), yieldToHost);
    deps.store.write(sessionPath(sessionId), summary);
    return summary;
}
/**
 * Re-read recent sessions whose stored summary is missing or behind the host.
 * Scanning the host's history for recent sessions is the expensive part, so it
 * runs at most once per `backfillIntervalMinutes` per agent, and yields between sessions.
 */
async function backfill(deps, agentId, except, now) {
    const { backfillSessions, backfillIntervalMinutes } = deps.settings;
    if (backfillSessions <= 0)
        return;
    const markPath = `backfill/${safeName(agentId)}.json`;
    const mark = deps.store.read(markPath);
    if (mark && now.getTime() - Date.parse(mark.at) < backfillIntervalMinutes * 60_000)
        return;
    for (const { sessionId, lastSeq } of deps.history.recentSessions(backfillSessions)) {
        if (sessionId === except)
            continue;
        const stored = deps.store.read(sessionPath(sessionId));
        if (stored && stored.format === SUMMARY_FORMAT && stored.lastSeq >= lastSeq)
            continue;
        await summarizeAndStore(deps, sessionId, agentId);
        await yieldToHost();
    }
    deps.store.write(markPath, { at: now.toISOString() });
}
/** This agent's session summaries, read in slices so a long history does not stall the host. */
async function agentSummaries(store, agentId) {
    const out = [];
    const names = store.list("sessions");
    for (let i = 0; i < names.length; i++) {
        if (i > 0 && i % FILES_PER_SLICE === 0)
            await yieldToHost();
        const summary = store.read(`sessions/${names[i]}.json`);
        if (summary && Array.isArray(summary.patterns) && (summary.agentId || "main") === agentId)
            out.push(summary);
    }
    return out;
}
function refuse(deps, agentId, pattern, local, sources) {
    const { minSessions, minOccurrences } = deps.settings;
    const sessions = pattern.sessionIds.length;
    if (!(sessions >= minSessions || pattern.count >= minOccurrences)) {
        return { rule: "below_bar", detail: `${pattern.count}× in ${sessions} session(s)` };
    }
    // A failure seen in this one session only, and fixed each time, is not worth a call.
    // The recurrence bar already refuses it with the default settings; this keeps it so
    // when the bar is lowered to one session. A failure that comes back in another
    // session is never refused for having been fixed: the agent makes it every time,
    // and the fix it found is the evidence the lesson is written from.
    if (sessions === 1 &&
        local.count < minOccurrences &&
        local.occurrences.length > 0 &&
        local.occurrences.every((o) => o.resolution === "corrected")) {
        return { rule: "self_corrected" };
    }
    const shape = lessonShape(pattern);
    if (shape)
        return { rule: `not_lesson_shaped:${shape}` };
    const known = allLessons(deps.store).filter((lesson) => lessonAgent(lesson) === agentId);
    const same = known.find((lesson) => lesson.fingerprint === pattern.fingerprint && lesson.status !== "draft");
    if (same?.status === "active") {
        // With injection off the lesson exists but the agent never sees it: say that, not "covered".
        return { rule: deps.settings.injectEnabled ? "covered_by_lesson" : "lesson_not_shown", detail: same.id };
    }
    // The user took this lesson away; learning it again would undo their decision.
    if (same)
        return { rule: "withdrawn_by_user", detail: `${same.id} (${same.status})` };
    // A validated lesson for it is waiting behind a busy lock: a second model call would
    // only propose it again.
    const pending = pendingLesson(deps.store, agentId, pattern.fingerprint);
    if (pending)
        return { rule: "lesson_pending", detail: pending };
    // The model looked at this failure and found nothing to learn: not asked again for a
    // week, unless the failure has since come back in a session it had not seen then.
    const paused = pausedUntil(readProposed(deps.store, agentId, pattern.fingerprint), pattern, deps.now());
    if (paused)
        return { rule: "paused_after_nothing", detail: `until ${paused}` };
    const active = known.filter((lesson) => lesson.status === "active");
    const lessonSources = active.map((lesson) => ({ name: `lesson:${lesson.id}`, text: lesson.text }));
    const covering = findCoveringRule(pattern.tool, pattern.shape, [...sources(), ...lessonSources]);
    if (covering)
        return { rule: "already_covered", covering };
    return null;
}
export async function processSession(deps, sessionId, agentId, options = {}) {
    const { store, settings } = deps;
    const now = deps.now();
    const recovered = recover(store, now);
    if (recovered.finished || recovered.abandoned || recovered.unreadable) {
        deps.log(`journal recovery: ${JSON.stringify(recovered)}`);
    }
    await yieldToHost();
    let summary;
    try {
        summary = await summarizeAndStore(deps, sessionId, agentId);
    }
    catch (error) {
        if (error instanceof StoreError)
            throw error;
        // The host's history could not be read (a missing or locked database, a new
        // schema): say so where the report looks, not only in the log.
        const decision = {
            sessionId, agentId, at: now.toISOString(), outcome: "history_unreadable", called: false, evaluated: [],
            reply: String(error).slice(0, 300),
        };
        const prior = store.read(candidatePath(sessionId));
        if (!prior?.called)
            store.write(candidatePath(sessionId), decision);
        throw error;
    }
    await yieldToHost();
    try {
        await backfill(deps, agentId, sessionId, now);
    }
    catch (error) {
        // Older sessions are a bonus; this session's own learning goes on without them.
        deps.log(`backfill skipped: ${String(error)}`);
    }
    await applyDeferred(deps, agentId, now);
    updateRecurrence(store, summary);
    const base = {
        sessionId, agentId, at: now.toISOString(), called: false, evaluated: [],
    };
    const prior = store.read(candidatePath(sessionId));
    // Returned, not stored: the caller learns that this is the session's earlier decision.
    if (prior?.called)
        return { ...prior, earlier: true };
    const finish = (decision) => {
        store.write(candidatePath(sessionId), decision);
        return decision;
    };
    if (!settings.learnEnabled)
        return finish({ ...base, outcome: "learning_disabled" });
    const summaries = await agentSummaries(store, agentId);
    const patterns = aggregate(summaries);
    let cachedSources = null;
    const sources = () => (cachedSources ??= deps.sources());
    const ordered = summary.patterns
        .map((local) => ({ local, pattern: patterns.get(local.fingerprint) }))
        .sort((a, b) => b.pattern.sessionIds.length - a.pattern.sessionIds.length || b.pattern.count - a.pattern.count);
    const evaluated = [];
    let chosen = null;
    for (const entry of ordered) {
        // The already-covered check reads every instruction and skill file: one pattern
        // at a time, so a session with many patterns does not hold the host's thread.
        if (evaluated.length > 0)
            await yieldToHost();
        const refusal = refuse(deps, agentId, entry.pattern, entry.local, sources);
        evaluated.push({
            fingerprint: entry.pattern.fingerprint,
            tool: entry.pattern.tool,
            shape: entry.pattern.shape.slice(0, 300),
            count: entry.pattern.count,
            sessions: entry.pattern.sessionIds.length,
            ...(refusal ? { refusal } : {}),
        });
        if (!refusal) {
            chosen = entry;
            break;
        }
    }
    // Nothing of its own worth the call: the session spends it on the oldest failure of
    // this agent that passed every rule but never reached the model, because the one
    // call of each session it appeared in went to another failure (owner decision 2026-09-28).
    let queued = false;
    if (!chosen && deps.llm && callLeft(store, now, settings.maxModelCallsPerDay, sessionId)) {
        const next = await fromQueue(deps, agentId, patterns, summaries, sources);
        if (next) {
            chosen = next;
            queued = true;
            evaluated.push({
                fingerprint: next.pattern.fingerprint,
                tool: next.pattern.tool,
                shape: next.pattern.shape.slice(0, 300),
                count: next.pattern.count,
                sessions: next.pattern.sessionIds.length,
                queued: true,
            });
        }
    }
    if (!chosen)
        return finish({ ...base, evaluated, outcome: summary.patterns.length === 0 ? "no_failures" : "all_refused" });
    const last = evaluated[evaluated.length - 1];
    if (queued)
        base.queued = true;
    if (!deps.llm) {
        last.refusal = { rule: "model_unavailable" };
        return finish({ ...base, evaluated, outcome: "model_unavailable" });
    }
    const budget = reserveCall(store, now, settings.maxModelCallsPerDay, sessionId, agentId, chosen.pattern.fingerprint);
    if (budget) {
        last.refusal = budget;
        return finish({ ...base, evaluated, outcome: "all_refused", called: budget.rule === "already_called" });
    }
    const fp = chosen.pattern.fingerprint;
    finish({ ...base, evaluated, called: true, outcome: "pending", fingerprint: fp });
    const answered = (answer) => markAnswered(deps, agentId, fp, answer, chosen.pattern.sessionIds, now);
    let reply;
    try {
        reply = await deps.llm.complete(SYSTEM_PROMPT, buildUserMessage(chosen.pattern, chosen.local.occurrences, settings.maxLessonChars, chosen.local.correctionArgs || chosen.pattern.correctionArgs, options.reason ?? ""), settings.proposalTimeoutMs);
    }
    catch (error) {
        answered("error");
        return finish({ ...base, evaluated, called: true, outcome: "model_error", fingerprint: fp, reply: String(error).slice(0, 300) });
    }
    const called = { ...base, evaluated, called: true, fingerprint: fp, reply: reply.slice(0, REPLY_KEPT_CHARS) };
    const proposal = parseProposal(reply);
    // A dry run's lesson is not saved, so the failure has not had its answer: the queue may still offer it.
    answered(!proposal ? "invalid" : proposal.decision === "lesson" && options.dryRun ? "preview" : proposal.decision);
    if (!proposal)
        return finish({ ...called, outcome: "invalid_reply" });
    if (proposal.decision === "nothing")
        return finish({ ...called, outcome: "nothing" });
    // A lesson over the hard limit gets one request to say the same thing shorter, as in
    // the Hermes plugin, instead of being lost as too long. It is a second model call of
    // this session, so it runs only while the day's budget has room, and is recorded there.
    let shortening;
    if (proposal.lesson.length > settings.maxLessonChars) {
        const room = reserveExtraCall(store, now, settings.maxModelCallsPerDay, sessionId, fp);
        if (room) {
            shortening = { from: proposal.lesson.length, refused: room.rule };
        }
        else {
            try {
                const shorter = parseShortened(await deps.llm.complete(SHORTEN_SYSTEM_PROMPT, buildShortenMessage(proposal.lesson, settings.maxLessonChars), settings.proposalTimeoutMs));
                shortening = shorter ? { from: proposal.lesson.length, to: shorter.length } : { from: proposal.lesson.length, refused: "empty" };
                if (shorter)
                    proposal.lesson = shorter;
            }
            catch (error) {
                shortening = { from: proposal.lesson.length, refused: `model_error: ${String(error).slice(0, 200)}` };
            }
        }
    }
    const known = allLessons(store).filter((lesson) => lessonAgent(lesson) === agentId && lesson.status !== "draft");
    const validation = validateLesson(proposal, fp, chosen.pattern.tool, known, sources(), settings.maxLessonChars);
    if (shortening)
        Object.assign(called, { shortening });
    if (options.dryRun) {
        return finish({
            ...called,
            outcome: "dry_run",
            lessonText: proposal.lesson,
            preview: { wouldSave: validation.ok, ...(validation.ok ? {} : { rule: validation.rule }) },
        });
    }
    if (!validation.ok) {
        return finish({
            ...called,
            outcome: "refused_after_model",
            refusal: { rule: validation.rule, ...(validation.covering ? { covering: validation.covering } : {}) },
        });
    }
    const id = lessonId(agentId, fp, proposal.lesson);
    const lesson = {
        id,
        text: proposal.lesson,
        fingerprint: fp,
        tool: chosen.pattern.tool,
        createdAt: now.toISOString(),
        sourceSessionId: sessionId,
        evidence: {
            sessionIds: chosen.pattern.sessionIds.slice(0, 20),
            eventIds: chosen.local.occurrences.map((o) => o.eventId).filter(Boolean).slice(0, 20),
        },
        reason: proposal.reason.slice(0, 300),
        agentId,
    };
    return applyLesson(deps, { ...called, outcome: "apply_deferred" }, lesson, now);
}
/**
 * Activate a validated lesson without ever waiting on the gateway thread. If
 * another process holds the store lock, the lesson is kept in the decision as
 * `apply_deferred` and the session's next run applies it: the model's work is not lost.
 */
function applyLesson(deps, decision, lesson, now) {
    const marker = deferredPath(decision.sessionId);
    const finish = (next) => {
        try {
            // The marker goes first: a crash after it leaves a marker the sweep can resolve,
            // never a deferred lesson nothing points to.
            if (next.outcome === "apply_deferred")
                deps.store.write(marker, { sessionId: decision.sessionId });
            deps.store.write(candidatePath(decision.sessionId), next);
            if (next.outcome !== "apply_deferred")
                deps.store.remove(marker);
        }
        catch (error) {
            // Nowhere left to keep it (a full disk, a store that turned read-only): the log is
            // the last place the model's work can be seen, so it says what was lost.
            if (next.outcome !== "lesson") {
                deps.log(`lesson ${lesson.id} for ${lesson.fingerprint} was validated but could not be saved (${String(error)}): ${lesson.text}`);
            }
            throw error;
        }
        return next;
    };
    const { deferred: _drop, ...rest } = decision;
    // The world may have moved while the lesson waited: another session learned it, or the user withdrew it.
    const same = allLessons(deps.store).find((known) => lessonAgent(known) === lessonAgent(lesson) && known.fingerprint === lesson.fingerprint && known.status !== "draft");
    // This very lesson, from this session, is already active: journal recovery finished an
    // activation that a crash or an error cut short. It was learned from this session.
    if (same?.id === lesson.id && same.status === "active" && same.sourceSessionId === decision.sessionId) {
        return finish({ ...rest, outcome: "lesson", lessonId: same.id, lessonText: same.text });
    }
    if (same) {
        const rule = same.status === "active" ? "duplicate" : "withdrawn_by_user";
        return finish({ ...rest, outcome: "refused_after_model", refusal: { rule, detail: same.id } });
    }
    try {
        const active = activate(deps.store, lesson, now, 0);
        deps.log(`lesson ${active.id} active for ${active.fingerprint}`);
        return finish({ ...rest, outcome: "lesson", lessonId: active.id, lessonText: active.text });
    }
    catch (error) {
        if (error instanceof LessonExistsError) {
            // Another writer for the same agent got there first (a second process on this store).
            return finish({ ...rest, outcome: "refused_after_model", refusal: { rule: "duplicate", detail: lesson.id } });
        }
        // A busy lock, or a write that failed (a full disk, a permission): the lesson waits
        // for the next run instead of leaving the decision pending for good.
        if (!(error instanceof StoreError))
            deps.log(`lesson ${lesson.id} not applied yet: ${String(error)}`);
        return finish({ ...rest, outcome: "apply_deferred", deferred: lesson });
    }
}
/** The id of a validated lesson for this agent and failure that waits to be applied, if any. */
function pendingLesson(store, agentId, fingerprint) {
    for (const name of store.list("deferred")) {
        const marker = store.read(`deferred/${name}.json`);
        const decision = marker && store.read(candidatePath(marker.sessionId));
        const lesson = decision?.outcome === "apply_deferred" ? decision.deferred : undefined;
        if (lesson && lesson.fingerprint === fingerprint && lessonAgent(lesson) === agentId)
            return lesson.id;
    }
    return null;
}
function deferredPath(sessionId) {
    return `deferred/${safeName(sessionId)}.json`;
}
/**
 * Apply every lesson a busy store lock deferred, from whatever session ends next:
 * a deferred lesson must not wait for its own session to come back.
 */
async function applyDeferred(deps, agentId, now) {
    if (!deps.settings.learnEnabled)
        return;
    for (const name of deps.store.list("deferred")) {
        const marker = deps.store.read(`deferred/${name}.json`);
        if (!marker)
            continue;
        const decision = deps.store.read(candidatePath(marker.sessionId));
        if (!decision || decision.outcome !== "apply_deferred" || !decision.deferred) {
            deps.store.remove(`deferred/${name}.json`);
            continue;
        }
        if (lessonAgent(decision.deferred) !== agentId)
            continue;
        applyLesson(deps, decision, decision.deferred, now);
        await yieldToHost();
    }
}
/** What the loop decided. With `agentId`, only that agent's sessions and lessons. */
export function report(store, agentId, budget) {
    const summaries = new Map();
    for (const name of store.list("sessions")) {
        const summary = store.read(`sessions/${name}.json`);
        if (summary && Array.isArray(summary.patterns))
            summaries.set(summary.sessionId, summary);
    }
    const agentOf = (sessionId, recorded) => recorded || summaries.get(sessionId)?.agentId || DEFAULT_AGENT;
    const decisions = store
        .list("candidates")
        .map((name) => store.read(`candidates/${name}.json`))
        .filter((d) => !!d)
        .filter((d) => agentId === undefined || agentOf(d.sessionId, d.agentId) === agentId);
    const outcomes = {};
    const refusals = {};
    let restatements = 0;
    for (const decision of decisions) {
        outcomes[decision.outcome] = (outcomes[decision.outcome] ?? 0) + 1;
        for (const entry of decision.evaluated ?? []) {
            if (entry.refusal)
                refusals[entry.refusal.rule] = (refusals[entry.refusal.rule] ?? 0) + 1;
        }
        if (decision.refusal) {
            const rule = `after_model:${decision.refusal.rule}`;
            refusals[rule] = (refusals[rule] ?? 0) + 1;
            if (decision.refusal.rule === "restatement")
                restatements++;
        }
    }
    const lessons = { active: 0, disabled: 0, deleted: 0, draft: 0 };
    for (const lesson of allLessons(store))
        if (agentId === undefined || lessonAgent(lesson) === agentId)
            lessons[lesson.status]++;
    const sessions = [...summaries.values()].filter((summary) => agentId === undefined || agentOf(summary.sessionId) === agentId);
    const withFailures = sessions.filter((summary) => summary.patterns.length > 0).length;
    return {
        sessions: sessions.length,
        sessionsWithFailures: withFailures,
        outcomes,
        refusals,
        modelCalls: decisions.filter((d) => d.called).length,
        queuedCalls: decisions.filter((d) => d.called && d.queued).length,
        lessons,
        restatementsCaught: restatements,
        ...(budget ? { budget: { callsToday: callsToday(store, budget.now), limit: budget.limit } } : {}),
    };
}
const OUTCOME_WORDS = {
    no_failures: "no tool failures",
    all_refused: "nothing worth a model call",
    nothing: "the model found nothing to learn",
    lesson: "a lesson learned",
    refused_after_model: "the model's lesson was refused",
    model_error: "the model call failed",
    invalid_reply: "the model's reply could not be read",
    model_unavailable: "no model call available",
    apply_deferred: "a lesson waits to be saved",
    pending: "a model call that did not finish",
    learning_disabled: "learning is off",
    history_unreadable: "the history could not be read",
    dry_run: "a dry run: a lesson was proposed and not saved",
};
const RULE_WORDS = {
    below_bar: "did not repeat enough",
    self_corrected: "seen in one session and fixed each time",
    "not_lesson_shaped:transient": "a timeout or an outage",
    "not_lesson_shaped:wrong_tool": "the agent called a tool that does not exist",
    "not_lesson_shaped:dropped_argument": "an argument already used was left out",
    covered_by_lesson: "an active lesson covers it",
    lesson_not_shown: "an active lesson is about it, but lessons are not shown (injectEnabled is off)",
    withdrawn_by_user: "you disabled or deleted its lesson",
    lesson_pending: "its lesson waits to be saved",
    paused_after_nothing: "the model found nothing to learn in the last 7 days and it has not come back since",
    already_covered: "your instructions or skills already say it",
    budget_spent: "the day's model calls were used up",
    budget_busy: "another process held the budget",
    budget_unreadable: "the budget record could not be read",
    already_called: "this session already had its model call",
    model_unavailable: "no model call available",
    "after_model:restatement": "the lesson repeated your instructions",
    "after_model:duplicate": "the lesson was already known",
    "after_model:withdrawn_by_user": "you had withdrawn that lesson",
    "after_model:off_topic": "the lesson did not name the failing tool",
    "after_model:ungrounded": "the lesson named a failure that was not seen",
    "after_model:too_long": "the lesson was too long",
    "after_model:markup": "the lesson contained markup",
    "after_model:empty": "the lesson was empty",
};
/** The report for people: what the loop did, in words, with the rule names kept for lookup. */
export function describeReport(r) {
    const counted = (entries, words) => Object.entries(entries)
        .sort((a, b) => b[1] - a[1])
        .map(([key, n]) => `  ${n} × ${words[key] ?? key}${words[key] ? ` (${key})` : ""}`);
    const decided = Object.values(r.outcomes).reduce((sum, n) => sum + n, 0);
    const others = [
        r.lessons.disabled && `${r.lessons.disabled} disabled`,
        r.lessons.deleted && `${r.lessons.deleted} deleted`,
        r.lessons.draft && `${r.lessons.draft} draft`,
    ].filter(Boolean);
    const lines = [
        `Lessons: ${r.lessons.active} active${others.length ? `, ${others.join(", ")}` : ""}.`,
        `Sessions read: ${r.sessions}, ${r.sessionsWithFailures} with tool failures. Model calls: ${r.modelCalls}` +
            (r.queuedCalls ? `, ${r.queuedCalls} of them on a failure that had waited in the queue.` : "."),
    ];
    if (r.budget)
        lines.push(`model calls today: ${r.budget.callsToday}/${r.budget.limit}`);
    if (decided > 0)
        lines.push(`Turns the loop looked at: ${decided}`, ...counted(r.outcomes, OUTCOME_WORDS));
    if (Object.keys(r.refusals).length > 0)
        lines.push("Failures not turned into a lesson, and why:", ...counted(r.refusals, RULE_WORDS));
    return lines.join("\n");
}
/** The agents the store knows: from lessons and session summaries; "main" when it knows none. */
export function knownAgents(store) {
    const ids = new Set();
    for (const lesson of allLessons(store))
        ids.add(lessonAgent(lesson));
    for (const name of store.list("sessions")) {
        const summary = store.read(`sessions/${name}.json`);
        if (summary)
            ids.add(summary.agentId || DEFAULT_AGENT);
    }
    return ids.size ? [...ids].sort() : [DEFAULT_AGENT];
}
/** Read-only: no lock, no write, no model call. The queue count reads the instruction files. */
export async function status(deps, input, depsOf = () => deps) {
    const { store, settings } = deps;
    const now = deps.now();
    const calls = store.read(budgetPath(now))?.calls ?? [];
    const decisions = store
        .list("candidates")
        .map((name) => store.read(`candidates/${name}.json`))
        .filter((d) => !!d);
    const agents = [];
    for (const agentId of input.agentIds) {
        const lessons = { active: 0, disabled: 0, deleted: 0 };
        for (const lesson of allLessons(store)) {
            if (lessonAgent(lesson) === agentId && lesson.status !== "draft")
                lessons[lesson.status]++;
        }
        const newest = decisions
            .filter((d) => (d.agentId || DEFAULT_AGENT) === agentId)
            .sort((a, b) => b.at.localeCompare(a.at))[0];
        const verdicts = {};
        for (const row of judgeLessons(store, now, agentId))
            verdicts[row.verdict] = (verdicts[row.verdict] ?? 0) + 1;
        agents.push({
            agentId,
            lessons,
            blockChars: formatBlock(activeLessons(store, agentId))?.text.length ?? 0,
            queue: settings.learnEnabled ? await queueLength(depsOf(agentId), agentId) : 0,
            verdicts,
            ...(newest?.outcome === "history_unreadable" ? { historyUnreadable: String(newest.reply ?? "").slice(0, 160) } : {}),
        });
    }
    const blockers = [];
    if (!input.conversationAccess) {
        blockers.push("OpenClaw does not call the plugin: set plugins.entries.refine-cycle.hooks.allowConversationAccess to true in openclaw.json.");
    }
    if (!input.promptInjection) {
        blockers.push("OpenClaw drops the lessons block: plugins.entries.refine-cycle.hooks.allowPromptInjection is false.");
    }
    if (!settings.learnEnabled)
        blockers.push("Learning is off in the settings (learnEnabled).");
    if (!settings.injectEnabled)
        blockers.push("Injection is off in the settings (injectEnabled).");
    if (!input.llmAvailable)
        blockers.push("OpenClaw offers the plugin no model call, so no lesson can be written.");
    if (calls.length >= settings.maxModelCallsPerDay) {
        blockers.push(`Today's model calls are used up (${calls.length}/${settings.maxModelCallsPerDay}); the next ones are tomorrow (UTC).`);
    }
    for (const agent of agents) {
        if (agent.historyUnreadable)
            blockers.push(`The history of agent ${agent.agentId}'s last session could not be read: ${agent.historyUnreadable}`);
    }
    const warnings = [...input.hostWarnings];
    for (const agent of agents) {
        if (agent.blockChars > settings.maxInjectedChars) {
            warnings.push(`Agent ${agent.agentId}'s lessons take ${agent.blockChars} characters, over the soft limit of ${settings.maxInjectedChars}; every lesson is still shown. Disable or delete the ones you no longer need.`);
        }
    }
    const journal = journalState(store);
    if (journal.unreadable)
        warnings.push(`${journal.unreadable} journal record(s) cannot be read and are skipped.`);
    return {
        version: input.version,
        learning: settings.learnEnabled && input.llmAvailable && input.conversationAccess,
        injection: settings.injectEnabled && input.promptInjection && input.conversationAccess,
        model: input.model,
        callsToday: calls.length,
        callsLimit: settings.maxModelCallsPerDay,
        ...(input.sessionId ? { sessionCalled: calls.some((call) => call.sessionId === input.sessionId) || decisions.some((d) => d.sessionId === input.sessionId && d.called) } : {}),
        softLimit: settings.maxInjectedChars,
        agents,
        journal,
        recovery: input.recovery ?? null,
        blockers,
        warnings,
    };
}
/** Status for people, in the order of the Hermes plugin's `/refine status`. */
export function describeStatus(s, oneAgent) {
    const lines = [`${BRAND} ${s.version} · ${s.blockers.length ? "not working" : "working"}`];
    lines.push(`learning: ${s.learning ? "on" : "off"} · injection: ${s.injection ? "on" : "off"}`);
    lines.push(`model: ${s.model}`);
    let calls = `model calls today: ${s.callsToday}/${s.callsLimit}`;
    if (s.sessionCalled !== undefined)
        calls += s.sessionCalled ? " · this session has had its call" : " · this session has not had its call yet";
    lines.push(calls);
    for (const agent of s.agents) {
        const who = oneAgent ? "" : `agent ${agent.agentId}: `;
        const words = usageNote(agent.blockChars, s.softLimit);
        lines.push(`${who}lessons: ${agent.lessons.active} active, ${agent.lessons.disabled} disabled, ${agent.lessons.deleted} deleted`);
        lines.push(`${who}lessons block: ${agent.blockChars}/${s.softLimit} characters${words ? `, ${words}` : ""}`);
        lines.push(`${who}queue: ${agent.queue} failure(s) waiting for a model call`);
        const judged = Object.entries(agent.verdicts).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${n} ${name}`);
        if (judged.length)
            lines.push(`${who}audit: ${judged.join(", ")}`);
    }
    lines.push(s.journal.open
        ? `journal: ${s.journal.open} unfinished change(s), finished by recovery on the next turn`
        : "journal: no unfinished changes");
    if (s.recovery) {
        lines.push(s.recovery.skipped
            ? `recovery (${s.recovery.at}): skipped, another process held the store`
            : `recovery (${s.recovery.at}): ${s.recovery.finished} finished, ${s.recovery.abandoned} abandoned, ${s.recovery.unreadable} unreadable`);
    }
    if (s.blockers.length)
        lines.push("blockers:", ...s.blockers.map((b) => `  • ${b}`));
    else
        lines.push("blockers: none — learning and injection are active");
    if (s.warnings.length)
        lines.push("warnings:", ...s.warnings.map((w) => `  ⚠ ${w}`));
    return lines.join("\n");
}
// -- A pass started by hand -------------------------------------------------------
/** One decision in words, for the answer to `/refine run`, `session` and `dry-run`. */
export function describePass(d, dryRun = false) {
    const head = dryRun ? "🔍 Dry run — nothing saved." : `${BRAND} — pass over session ${d.sessionId}:`;
    const lines = [head];
    if (dryRun)
        lines.push(`session: ${d.sessionId}`);
    if (d.earlier) {
        lines.push(`this session already had its model call (${OUTCOME_WORDS[d.outcome] ?? d.outcome}); a session gets one`);
        return lines.join("\n");
    }
    const chosen = d.fingerprint ? d.evaluated.find((e) => e.fingerprint === d.fingerprint) : undefined;
    if (chosen) {
        lines.push(`failure: ${chosen.tool || "(unknown tool)"} (${chosen.fingerprint}), ${chosen.count}× in ${chosen.sessions} session(s)${chosen.queued ? ", from the queue" : ""}`);
    }
    if (d.outcome === "dry_run") {
        lines.push(`lesson: ${d.lessonText ?? ""}`);
        lines.push(d.preview?.wouldSave ? "would be saved: yes" : `would be saved: no — ${RULE_WORDS[`after_model:${d.preview?.rule}`] ?? d.preview?.rule ?? "refused"}`);
    }
    else if (d.outcome === "lesson") {
        lines.push(`lesson learned: ${d.lessonText ?? ""}`);
    }
    else if (d.outcome === "nothing") {
        lines.push("the model found nothing to learn");
    }
    else if (d.outcome === "refused_after_model" && d.refusal) {
        lines.push(`the model's lesson was refused: ${RULE_WORDS[`after_model:${d.refusal.rule}`] ?? d.refusal.rule}`);
    }
    else {
        lines.push(OUTCOME_WORDS[d.outcome] ?? d.outcome);
    }
    // Why nothing reached the model, in the words the report uses.
    if (!d.called || d.outcome === "all_refused") {
        for (const entry of d.evaluated.filter((e) => e.refusal).slice(0, 5)) {
            lines.push(`  ${entry.tool || "?"}: ${RULE_WORDS[entry.refusal.rule] ?? entry.refusal.rule}${entry.refusal.detail ? ` (${entry.refusal.detail})` : ""}`);
        }
    }
    if (d.reply && (d.outcome === "model_error" || d.outcome === "history_unreadable"))
        lines.push(`  ${d.reply.slice(0, 200)}`);
    return lines.join("\n");
}
