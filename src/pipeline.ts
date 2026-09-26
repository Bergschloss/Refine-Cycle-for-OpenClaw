/**
 * The learning loop for one ended turn. Host-independent: the host hands in a
 * history reader, a model call and the text of the agent's skills and
 * instructions, so the whole loop runs in tests against a fake host.
 *
 * Order: read the whole session, count its failures, then refuse everything that
 * can be refused without a model call; only one survivor per session may reach
 * the model, and only within the day's budget, which is spent before the call.
 */

import { aggregate, summarizeSession, SUMMARY_FORMAT, type AggregatePattern, type SessionPattern, type SessionSummary, type TranscriptRow } from "./core/failures.ts";
import { findCoveringRule, type Covering, type Source } from "./core/covered.ts";
import { lessonShape } from "./core/shape.ts";
import { buildUserMessage, parseProposal, SYSTEM_PROMPT, validateLesson } from "./core/proposal.ts";
import { formatBlock, type Block } from "./core/injection.ts";
import { activate, activeLessons, allLessons, DEFAULT_AGENT, lessonAgent, LessonExistsError, lessonId, recover, type Lesson } from "./lessons.ts";
import { safeName, StoreError, type FileStore } from "./store.ts";
import type { Settings } from "./settings.ts";

export interface History {
  readSession(sessionId: string): TranscriptRow[];
  /** The most recently active sessions, newest first, with their highest `seq`. */
  recentSessions(limit: number): Array<{ sessionId: string; lastSeq: number }>;
}

export interface Llm {
  complete(systemPrompt: string, userMessage: string, timeoutMs: number): Promise<string>;
}

export interface Deps {
  store: FileStore;
  history: History;
  /** Null when the host offers no model call: the loop then stops before proposing. */
  llm: Llm | null;
  /** The agent's skills and instruction files, read when first needed. */
  sources: () => Source[];
  settings: Settings;
  now: () => Date;
  log: (message: string) => void;
}

export interface Refusal {
  rule: string;
  detail?: string;
  covering?: Covering;
}

export interface Evaluated {
  fingerprint: string;
  tool: string;
  shape: string;
  count: number;
  sessions: number;
  refusal?: Refusal;
}

export type Outcome =
  | "learning_disabled"
  | "no_failures"
  | "all_refused"
  | "pending"
  | "model_unavailable"
  | "model_error"
  | "invalid_reply"
  | "nothing"
  | "refused_after_model"
  | "apply_deferred"
  | "lesson";

export interface Decision {
  sessionId: string;
  /** The agent the session belongs to; absent in records written before it was kept. */
  agentId?: string;
  at: string;
  outcome: Outcome;
  /** True once a model call was made (or started) for this session: never again for it. */
  called: boolean;
  evaluated: Evaluated[];
  fingerprint?: string;
  reply?: string;
  lessonId?: string;
  lessonText?: string;
  refusal?: Refusal;
  /** A validated lesson the store lock kept from being applied; the session's next run applies it. */
  deferred?: Omit<Lesson, "status" | "changedAt">;
}

const REPLY_KEPT_CHARS = 2000;
/** Files read between two yields to the event loop: the host's other sessions keep running. */
const FILES_PER_SLICE = 200;

/** Let the host's event loop run. The learning work shares the gateway's process. */
function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// -- Budget -----------------------------------------------------------------------

interface BudgetDay {
  day: string;
  calls: Array<{ sessionId: string; fingerprint: string; at: string }>;
}

function budgetPath(now: Date): string {
  return `budget/${now.toISOString().slice(0, 10)}.json`;
}

/** Spend one call before making it. False when the day is spent or its record cannot be trusted. */
function reserveCall(store: FileStore, now: Date, max: number, sessionId: string, fingerprint: string): Refusal | null {
  let release: () => void;
  try {
    release = store.lock("budget", 0);
  } catch (error) {
    if (error instanceof StoreError) return { rule: "budget_busy" };
    throw error;
  }
  try {
    return reserveLocked(store, now, max, sessionId, fingerprint);
  } finally {
    release();
  }
}

function reserveLocked(store: FileStore, now: Date, max: number, sessionId: string, fingerprint: string): Refusal | null {
  const relative = budgetPath(now);
  const day = store.read<BudgetDay>(relative);
  if (!day && store.exists(relative)) return { rule: "budget_unreadable" };
  const calls = day?.calls ?? [];
  // One call per session, even if a crash lost the session's own record of it.
  if (calls.some((call) => call.sessionId === sessionId)) return { rule: "already_called" };
  if (calls.length >= max) return { rule: "budget_spent", detail: `${calls.length}/${max} calls today` };
  store.write(relative, {
    day: now.toISOString().slice(0, 10),
    calls: [...calls, { sessionId, fingerprint, at: now.toISOString() }],
  });
  return null;
}

// -- Effects ----------------------------------------------------------------------

interface EffectRecord {
  sessionId: string;
  /** `shownAtMs`: when the prompt hook built the block. Failures after it happened with the lesson in view. */
  exposures: Array<{ lessonId: string; blockHash: string; at: string; shownAtMs: number }>;
  /** Per exposed lesson: how many times its failure happened in this session after it was first shown. */
  recurrence: Record<string, number>;
  /** Per exposed lesson: occurrences of its failure the host gave no time for, so before/after is unknown. */
  unplaced?: Record<string, number>;
}

function effectsPath(sessionId: string): string {
  return `effects/${safeName(sessionId)}.json`;
}

/** Remember which lessons a session was shown. Called after the turn, never from the prompt hook. */
export function recordExposure(store: FileStore, sessionId: string, block: Block, shownAtMs: number, now: Date): void {
  const current = store.read<EffectRecord>(effectsPath(sessionId));
  const exposures = current?.exposures ?? [];
  const fresh = block.lessonIds.filter(
    (id) => !exposures.some((exposure) => exposure.lessonId === id && exposure.blockHash === block.hash),
  );
  if (fresh.length === 0) return;
  store.write(effectsPath(sessionId), {
    ...current,
    sessionId,
    exposures: [...exposures, ...fresh.map((id) => ({ lessonId: id, blockHash: block.hash, at: now.toISOString(), shownAtMs }))],
    recurrence: current?.recurrence ?? {},
  });
}

function updateRecurrence(store: FileStore, summary: SessionSummary): void {
  const current = store.read<EffectRecord>(effectsPath(summary.sessionId));
  if (!current || current.exposures.length === 0) return;
  const fingerprintOf = new Map(allLessons(store).map((lesson) => [lesson.id, lesson.fingerprint]));
  // Only failures after the lesson was first shown count against it. The time comes
  // from the prompt hook itself, so it does not depend on how far the background
  // summary had got; an occurrence the host gave no time for cannot be placed and is not counted.
  const firstShown = new Map<string, number>();
  for (const exposure of current.exposures) {
    const shown = typeof exposure.shownAtMs === "number" ? exposure.shownAtMs : Date.parse(exposure.at);
    firstShown.set(exposure.lessonId, Math.min(firstShown.get(exposure.lessonId) ?? shown, shown));
  }
  const recurrence: Record<string, number> = {};
  const unplaced: Record<string, number> = {};
  for (const [lessonIdValue, shown] of firstShown) {
    const fp = fingerprintOf.get(lessonIdValue);
    const pattern = summary.patterns.find((entry) => entry.fingerprint === fp);
    const times = pattern && Array.isArray(pattern.times) ? pattern.times : [];
    recurrence[lessonIdValue] = times.filter((time) => time >= 0 && time > shown).length;
    const unknown = times.filter((time) => time < 0).length;
    if (unknown) unplaced[lessonIdValue] = unknown;
  }
  store.write(effectsPath(summary.sessionId), { ...current, recurrence, unplaced });
}

// -- The loop ---------------------------------------------------------------------

function sessionPath(sessionId: string): string {
  return `sessions/${safeName(sessionId)}.json`;
}

function candidatePath(sessionId: string): string {
  return `candidates/${safeName(sessionId)}.json`;
}

function summarizeAndStore(deps: Deps, sessionId: string, agentId: string): SessionSummary {
  const summary = summarizeSession(sessionId, agentId, deps.history.readSession(sessionId));
  deps.store.write(sessionPath(sessionId), summary);
  return summary;
}

interface BackfillMark {
  at: string;
}

/**
 * Re-read recent sessions whose stored summary is missing or behind the host.
 * Scanning the host's history for recent sessions is the expensive part, so it
 * runs at most once per `backfillIntervalMinutes` per agent, and yields between sessions.
 */
async function backfill(deps: Deps, agentId: string, except: string, now: Date): Promise<void> {
  const { backfillSessions, backfillIntervalMinutes } = deps.settings;
  if (backfillSessions <= 0) return;
  const markPath = `backfill/${safeName(agentId)}.json`;
  const mark = deps.store.read<BackfillMark>(markPath);
  if (mark && now.getTime() - Date.parse(mark.at) < backfillIntervalMinutes * 60_000) return;
  for (const { sessionId, lastSeq } of deps.history.recentSessions(backfillSessions)) {
    if (sessionId === except) continue;
    const stored = deps.store.read<SessionSummary>(sessionPath(sessionId));
    if (stored && stored.format === SUMMARY_FORMAT && stored.lastSeq >= lastSeq) continue;
    summarizeAndStore(deps, sessionId, agentId);
    await yieldToHost();
  }
  deps.store.write(markPath, { at: now.toISOString() });
}

/** This agent's session summaries, read in slices so a long history does not stall the host. */
async function agentSummaries(store: FileStore, agentId: string): Promise<SessionSummary[]> {
  const out: SessionSummary[] = [];
  const names = store.list("sessions");
  for (let i = 0; i < names.length; i++) {
    if (i > 0 && i % FILES_PER_SLICE === 0) await yieldToHost();
    const summary = store.read<SessionSummary>(`sessions/${names[i]}.json`);
    if (summary && Array.isArray(summary.patterns) && (summary.agentId || "main") === agentId) out.push(summary);
  }
  return out;
}

function refuse(
  deps: Deps,
  agentId: string,
  pattern: AggregatePattern,
  local: SessionPattern,
  sources: () => Source[],
): Refusal | null {
  const { minSessions, minOccurrences } = deps.settings;
  const sessions = pattern.sessionIds.length;
  if (!(sessions >= minSessions || pattern.count >= minOccurrences)) {
    return { rule: "below_bar", detail: `${pattern.count}× in ${sessions} session(s)` };
  }
  // A failure the agent fixed each time is not worth a lesson; one it had to "fix" as
  // often as the occurrence bar within this very session keeps coming back, so it is.
  if (
    local.count < minOccurrences &&
    local.occurrences.length > 0 &&
    local.occurrences.every((o) => o.resolution === "corrected")
  ) {
    return { rule: "self_corrected" };
  }
  const shape = lessonShape(pattern);
  if (shape) return { rule: `not_lesson_shaped:${shape}` };
  const known = allLessons(deps.store).filter((lesson) => lessonAgent(lesson) === agentId);
  const same = known.find((lesson) => lesson.fingerprint === pattern.fingerprint && lesson.status !== "draft");
  if (same?.status === "active") {
    // An active lesson the block has no room for is never shown: say so instead of calling it covered.
    const shown = formatBlock(activeLessons(deps.store, agentId), deps.settings.maxInjectedChars)?.lessonIds ?? [];
    if (!shown.includes(same.id)) return { rule: "lesson_over_cap", detail: same.id };
    return { rule: "covered_by_lesson", detail: same.id };
  }
  // The user took this lesson away; learning it again would undo their decision.
  if (same) return { rule: "withdrawn_by_user", detail: `${same.id} (${same.status})` };
  const active = known.filter((lesson) => lesson.status === "active");
  const lessonSources = active.map((lesson) => ({ name: `lesson:${lesson.id}`, text: lesson.text }));
  const covering = findCoveringRule(pattern.tool, pattern.shape, [...sources(), ...lessonSources]);
  if (covering) return { rule: "already_covered", covering };
  return null;
}

export async function processSession(deps: Deps, sessionId: string, agentId: string): Promise<Decision> {
  const { store, settings } = deps;
  const now = deps.now();
  const recovered = recover(store, now);
  if (recovered.finished || recovered.abandoned || recovered.unreadable) {
    deps.log(`journal recovery: ${JSON.stringify(recovered)}`);
  }

  await yieldToHost();
  const summary = summarizeAndStore(deps, sessionId, agentId);
  await yieldToHost();
  try {
    await backfill(deps, agentId, sessionId, now);
  } catch (error) {
    // Older sessions are a bonus; this session's own learning goes on without them.
    deps.log(`backfill skipped: ${String(error)}`);
  }
  await applyDeferred(deps, agentId, now);
  updateRecurrence(store, summary);

  const base = { sessionId, agentId, at: now.toISOString(), called: false, evaluated: [] as Evaluated[] };
  const prior = store.read<Decision>(candidatePath(sessionId));
  if (prior?.called) return prior;
  const finish = (decision: Decision): Decision => {
    store.write(candidatePath(sessionId), decision);
    return decision;
  };

  if (!settings.learnEnabled) return finish({ ...base, outcome: "learning_disabled" });
  if (summary.patterns.length === 0) return finish({ ...base, outcome: "no_failures" });

  const patterns = aggregate(await agentSummaries(store, agentId));
  let cachedSources: Source[] | null = null;
  const sources = () => (cachedSources ??= deps.sources());

  const ordered = summary.patterns
    .map((local) => ({ local, pattern: patterns.get(local.fingerprint)! }))
    .sort((a, b) => b.pattern.sessionIds.length - a.pattern.sessionIds.length || b.pattern.count - a.pattern.count);

  const evaluated: Evaluated[] = [];
  let chosen: (typeof ordered)[number] | null = null;
  for (const entry of ordered) {
    // The already-covered check reads every instruction and skill file: one pattern
    // at a time, so a session with many patterns does not hold the host's thread.
    if (evaluated.length > 0) await yieldToHost();
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
  if (!chosen) return finish({ ...base, evaluated, outcome: "all_refused" });
  const last = evaluated[evaluated.length - 1];

  if (!deps.llm) {
    last.refusal = { rule: "model_unavailable" };
    return finish({ ...base, evaluated, outcome: "model_unavailable" });
  }
  const budget = reserveCall(store, now, settings.maxModelCallsPerDay, sessionId, chosen.pattern.fingerprint);
  if (budget) {
    last.refusal = budget;
    return finish({ ...base, evaluated, outcome: "all_refused", called: budget.rule === "already_called" });
  }

  const fp = chosen.pattern.fingerprint;
  finish({ ...base, evaluated, called: true, outcome: "pending", fingerprint: fp });
  let reply: string;
  try {
    reply = await deps.llm.complete(
      SYSTEM_PROMPT,
      buildUserMessage(chosen.pattern, chosen.local.occurrences, settings.maxLessonChars),
      settings.proposalTimeoutMs,
    );
  } catch (error) {
    return finish({ ...base, evaluated, called: true, outcome: "model_error", fingerprint: fp, reply: String(error).slice(0, 300) });
  }
  const called = { ...base, evaluated, called: true, fingerprint: fp, reply: reply.slice(0, REPLY_KEPT_CHARS) };
  const proposal = parseProposal(reply);
  if (!proposal) return finish({ ...called, outcome: "invalid_reply" });
  if (proposal.decision === "nothing") return finish({ ...called, outcome: "nothing" });

  const known = allLessons(store).filter((lesson) => lessonAgent(lesson) === agentId && lesson.status !== "draft");
  const validation = validateLesson(proposal, fp, chosen.pattern.tool, known, sources(), settings.maxLessonChars);
  if (!validation.ok) {
    return finish({
      ...called,
      outcome: "refused_after_model",
      refusal: { rule: validation.rule, ...(validation.covering ? { covering: validation.covering } : {}) },
    });
  }

  const id = lessonId(agentId, fp, proposal.lesson);
  const lesson: Omit<Lesson, "status" | "changedAt"> = {
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
function applyLesson(deps: Deps, decision: Decision, lesson: Omit<Lesson, "status" | "changedAt">, now: Date): Decision {
  const marker = deferredPath(decision.sessionId);
  const finish = (next: Decision): Decision => {
    // The marker goes first: a crash after it leaves a marker the sweep can resolve,
    // never a deferred lesson nothing points to.
    if (next.outcome === "apply_deferred") deps.store.write(marker, { sessionId: decision.sessionId });
    deps.store.write(candidatePath(decision.sessionId), next);
    if (next.outcome !== "apply_deferred") deps.store.remove(marker);
    return next;
  };
  const { deferred: _drop, ...rest } = decision;
  // The world may have moved while the lesson waited: another session learned it, or the user withdrew it.
  const same = allLessons(deps.store).find(
    (known) => lessonAgent(known) === lessonAgent(lesson as Lesson) && known.fingerprint === lesson.fingerprint && known.status !== "draft",
  );
  // This very lesson is already active: journal recovery finished an activation that a
  // crash or an error cut short. It was learned from this session.
  if (same?.id === lesson.id && same.status === "active") {
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
  } catch (error) {
    if (error instanceof LessonExistsError) {
      // Another writer for the same agent got there first (a second process on this store).
      return finish({ ...rest, outcome: "refused_after_model", refusal: { rule: "duplicate", detail: lesson.id } });
    }
    // A busy lock, or a write that failed (a full disk, a permission): the lesson waits
    // for the next run instead of leaving the decision pending for good.
    if (!(error instanceof StoreError)) deps.log(`lesson ${lesson.id} not applied yet: ${String(error)}`);
    return finish({ ...rest, outcome: "apply_deferred", deferred: lesson });
  }
}

function deferredPath(sessionId: string): string {
  return `deferred/${safeName(sessionId)}.json`;
}

/**
 * Apply every lesson a busy store lock deferred, from whatever session ends next:
 * a deferred lesson must not wait for its own session to come back.
 */
async function applyDeferred(deps: Deps, agentId: string, now: Date): Promise<void> {
  if (!deps.settings.learnEnabled) return;
  for (const name of deps.store.list("deferred")) {
    const marker = deps.store.read<{ sessionId: string }>(`deferred/${name}.json`);
    if (!marker) continue;
    const decision = deps.store.read<Decision>(candidatePath(marker.sessionId));
    if (!decision || decision.outcome !== "apply_deferred" || !decision.deferred) {
      deps.store.remove(`deferred/${name}.json`);
      continue;
    }
    if (lessonAgent(decision.deferred as Lesson) !== agentId) continue;
    applyLesson(deps, decision, decision.deferred, now);
    await yieldToHost();
  }
}

// -- The number -------------------------------------------------------------------

export interface Report {
  sessions: number;
  sessionsWithFailures: number;
  outcomes: Record<string, number>;
  /** Every refused failure, by rule, counted once per session it was evaluated in. */
  refusals: Record<string, number>;
  modelCalls: number;
  lessons: { active: number; disabled: number; deleted: number; draft: number };
  restatementsCaught: number;
}

/** What the loop decided. With `agentId`, only that agent's sessions and lessons. */
export function report(store: FileStore, agentId?: string): Report {
  const summaries = new Map<string, SessionSummary>();
  for (const name of store.list("sessions")) {
    const summary = store.read<SessionSummary>(`sessions/${name}.json`);
    if (summary && Array.isArray(summary.patterns)) summaries.set(summary.sessionId, summary);
  }
  const agentOf = (sessionId: string, recorded?: string) => recorded || summaries.get(sessionId)?.agentId || DEFAULT_AGENT;
  const decisions = store
    .list("candidates")
    .map((name) => store.read<Decision>(`candidates/${name}.json`))
    .filter((d): d is Decision & { $v: number } => !!d)
    .filter((d) => agentId === undefined || agentOf(d.sessionId, d.agentId) === agentId);
  const outcomes: Record<string, number> = {};
  const refusals: Record<string, number> = {};
  let restatements = 0;
  for (const decision of decisions) {
    outcomes[decision.outcome] = (outcomes[decision.outcome] ?? 0) + 1;
    for (const entry of decision.evaluated ?? []) {
      if (entry.refusal) refusals[entry.refusal.rule] = (refusals[entry.refusal.rule] ?? 0) + 1;
    }
    if (decision.refusal) {
      const rule = `after_model:${decision.refusal.rule}`;
      refusals[rule] = (refusals[rule] ?? 0) + 1;
      if (decision.refusal.rule === "restatement") restatements++;
    }
  }
  const lessons = { active: 0, disabled: 0, deleted: 0, draft: 0 };
  for (const lesson of allLessons(store)) if (agentId === undefined || lessonAgent(lesson) === agentId) lessons[lesson.status]++;
  const sessions = [...summaries.values()].filter((summary) => agentId === undefined || agentOf(summary.sessionId) === agentId);
  const withFailures = sessions.filter((summary) => summary.patterns.length > 0).length;
  return {
    sessions: sessions.length,
    sessionsWithFailures: withFailures,
    outcomes,
    refusals,
    modelCalls: decisions.filter((d) => d.called).length,
    lessons,
    restatementsCaught: restatements,
  };
}
