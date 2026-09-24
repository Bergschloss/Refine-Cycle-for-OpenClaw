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
import type { Block } from "./core/injection.ts";
import { activate, activeLessons, allLessons, lessonId, recover } from "./lessons.ts";
import { safeName, type FileStore } from "./store.ts";
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
  | "lesson";

export interface Decision {
  sessionId: string;
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
}

const REPLY_KEPT_CHARS = 2000;

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
  const relative = budgetPath(now);
  const day = store.read<BudgetDay>(relative);
  if (!day && store.exists(relative)) return { rule: "budget_unreadable" };
  const calls = day?.calls ?? [];
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
  exposures: Array<{ lessonId: string; blockHash: string; at: string }>;
  /** Per exposed lesson: how many times its failure happened in this session. */
  recurrence: Record<string, number>;
}

function effectsPath(sessionId: string): string {
  return `effects/${safeName(sessionId)}.json`;
}

/** Remember which lessons a session was shown. Called after the turn, never from the prompt hook. */
export function recordExposure(store: FileStore, sessionId: string, block: Block, now: Date): void {
  const current = store.read<EffectRecord>(effectsPath(sessionId));
  const exposures = current?.exposures ?? [];
  const fresh = block.lessonIds.filter(
    (id) => !exposures.some((exposure) => exposure.lessonId === id && exposure.blockHash === block.hash),
  );
  if (fresh.length === 0) return;
  store.write(effectsPath(sessionId), {
    sessionId,
    exposures: [...exposures, ...fresh.map((id) => ({ lessonId: id, blockHash: block.hash, at: now.toISOString() }))],
    recurrence: current?.recurrence ?? {},
  });
}

function updateRecurrence(store: FileStore, summary: SessionSummary): void {
  const current = store.read<EffectRecord>(effectsPath(summary.sessionId));
  if (!current || current.exposures.length === 0) return;
  const fingerprintOf = new Map(allLessons(store).map((lesson) => [lesson.id, lesson.fingerprint]));
  const recurrence: Record<string, number> = {};
  for (const exposure of current.exposures) {
    const fp = fingerprintOf.get(exposure.lessonId);
    recurrence[exposure.lessonId] = summary.patterns.find((pattern) => pattern.fingerprint === fp)?.count ?? 0;
  }
  store.write(effectsPath(summary.sessionId), { ...current, recurrence });
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

/** Re-read recent sessions whose stored summary is missing or behind the host. */
function backfill(deps: Deps, agentId: string, except: string): void {
  for (const { sessionId, lastSeq } of deps.history.recentSessions(deps.settings.backfillSessions)) {
    if (sessionId === except) continue;
    const stored = deps.store.read<SessionSummary>(sessionPath(sessionId));
    if (stored && stored.format === SUMMARY_FORMAT && stored.lastSeq >= lastSeq) continue;
    summarizeAndStore(deps, sessionId, agentId);
  }
}

function refuse(
  deps: Deps,
  pattern: AggregatePattern,
  local: SessionPattern,
  sources: () => Source[],
): Refusal | null {
  const { minSessions, minOccurrences } = deps.settings;
  const sessions = pattern.sessionIds.length;
  if (!(sessions >= minSessions || pattern.count >= minOccurrences)) {
    return { rule: "below_bar", detail: `${pattern.count}× in ${sessions} session(s)` };
  }
  if (local.occurrences.length > 0 && local.occurrences.every((o) => o.resolution === "corrected")) {
    return { rule: "self_corrected" };
  }
  const shape = lessonShape(pattern);
  if (shape) return { rule: `not_lesson_shaped:${shape}` };
  const active = activeLessons(deps.store);
  const same = active.find((lesson) => lesson.fingerprint === pattern.fingerprint);
  if (same) return { rule: "covered_by_lesson", detail: same.id };
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

  const summary = summarizeAndStore(deps, sessionId, agentId);
  backfill(deps, agentId, sessionId);
  updateRecurrence(store, summary);

  const base = { sessionId, at: now.toISOString(), called: false, evaluated: [] as Evaluated[] };
  const prior = store.read<Decision>(candidatePath(sessionId));
  if (prior?.called) return prior;
  const finish = (decision: Decision): Decision => {
    store.write(candidatePath(sessionId), decision);
    return decision;
  };

  if (!settings.learnEnabled) return finish({ ...base, outcome: "learning_disabled" });
  if (summary.patterns.length === 0) return finish({ ...base, outcome: "no_failures" });

  const summaries = store
    .list("sessions")
    .map((name) => store.read<SessionSummary>(`sessions/${name}.json`))
    .filter((s): s is SessionSummary & { $v: number } => !!s && Array.isArray(s.patterns));
  const patterns = aggregate(summaries);
  let cachedSources: Source[] | null = null;
  const sources = () => (cachedSources ??= deps.sources());

  const ordered = summary.patterns
    .map((local) => ({ local, pattern: patterns.get(local.fingerprint)! }))
    .sort((a, b) => b.pattern.sessionIds.length - a.pattern.sessionIds.length || b.pattern.count - a.pattern.count);

  const evaluated: Evaluated[] = [];
  let chosen: (typeof ordered)[number] | null = null;
  for (const entry of ordered) {
    const refusal = refuse(deps, entry.pattern, entry.local, sources);
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
    return finish({ ...base, evaluated, outcome: "all_refused" });
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

  const active = activeLessons(store);
  const validation = validateLesson(proposal, fp, active, sources(), settings.maxLessonChars);
  if (!validation.ok) {
    return finish({
      ...called,
      outcome: "refused_after_model",
      refusal: { rule: validation.rule, ...(validation.covering ? { covering: validation.covering } : {}) },
    });
  }

  const id = lessonId(fp, proposal.lesson);
  const lesson = activate(
    store,
    {
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
    },
    now,
  );
  deps.log(`lesson ${lesson.id} active for ${fp}`);
  return finish({ ...called, outcome: "lesson", lessonId: lesson.id, lessonText: lesson.text });
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

export function report(store: FileStore): Report {
  const decisions = store
    .list("candidates")
    .map((name) => store.read<Decision>(`candidates/${name}.json`))
    .filter((d): d is Decision & { $v: number } => !!d);
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
  for (const lesson of allLessons(store)) lessons[lesson.status]++;
  const sessions = store.list("sessions");
  const withFailures = sessions.filter((name) => {
    const summary = store.read<SessionSummary>(`sessions/${name}.json`);
    return !!summary && summary.patterns.length > 0;
  }).length;
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
