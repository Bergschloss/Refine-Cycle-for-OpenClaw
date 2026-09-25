/**
 * Lessons and the journal that makes every change to them crash-safe.
 *
 * Order of writes for a new lesson: journal intent, inactive draft, activate,
 * mark the journal applied. A crash between any two leaves a state `recover()`
 * finishes on the next run; only `status: "active"` ever reaches the model.
 * Disabling and deleting go through the same journal, and nothing is erased:
 * a deleted lesson stays as a tombstone for the audit.
 */
import { createHash } from "node:crypto";
import { FileStore, safeName, StoreError } from "./store.js";
export const DEFAULT_AGENT = "main";
export function lessonAgent(lesson) {
    return lesson.agentId || DEFAULT_AGENT;
}
/** A lesson with this id already exists and is not a leftover draft; it is never overwritten. */
export class LessonExistsError extends Error {
}
const JOURNAL_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Scoped by agent: the same failure and text for two agents are two lessons. */
export function lessonId(agentId, fingerprint, text) {
    return createHash("sha1").update(`${agentId}|${fingerprint}|${text.toLowerCase().trim()}`).digest("hex").slice(0, 10);
}
const STATUSES = new Set(["draft", "active", "disabled", "deleted"]);
function isLesson(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const lesson = value;
    return (typeof lesson.id === "string" &&
        typeof lesson.text === "string" &&
        typeof lesson.fingerprint === "string" &&
        typeof lesson.createdAt === "string" &&
        typeof lesson.status === "string" &&
        STATUSES.has(lesson.status));
}
function lessonPath(id) {
    return `lessons/${safeName(id)}.json`;
}
function journalPath(id) {
    return `journal/${safeName(id)}.json`;
}
function newJournalId(now, lessonIdValue, op) {
    return `${now.toISOString().replace(/[:.]/g, "-")}-${op}-${lessonIdValue}`;
}
export function readLesson(store, id) {
    return store.read(lessonPath(id));
}
export function allLessons(store) {
    const out = [];
    for (const name of store.list("lessons")) {
        // A record missing any field the filters and the sort rely on is skipped, like a torn one.
        const lesson = store.read(`lessons/${name}.json`);
        if (isLesson(lesson))
            out.push(lesson);
    }
    return out;
}
/** Active lessons (of one agent, when given), oldest first: a stable order keeps the injected block stable. */
export function activeLessons(store, agentId) {
    return allLessons(store)
        .filter((lesson) => lesson.status === "active" && (agentId === undefined || lessonAgent(lesson) === agentId))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
/** `waitMs`: how long to wait for the store lock. The gateway passes 0 and never blocks. */
export function activate(store, lesson, now, waitMs = 5_000) {
    const release = store.lock("lessons", waitMs);
    try {
        return activateLocked(store, lesson, now);
    }
    finally {
        release();
    }
}
function activateLocked(store, lesson, now) {
    // Same agent, fingerprint and text give the same id. An existing lesson, and above all
    // one the user disabled or deleted, must not be overwritten by a relearned copy;
    // only a draft a crash left behind may be.
    const existing = readLesson(store, lesson.id);
    if (existing && existing.status !== "draft") {
        throw new LessonExistsError(`lesson ${lesson.id} already exists (${existing.status})`);
    }
    const draft = { ...lesson, status: "draft", changedAt: now.toISOString() };
    const journalId = newJournalId(now, lesson.id, "activate");
    const record = {
        id: journalId,
        op: "activate",
        lessonId: lesson.id,
        state: "intent",
        at: now.toISOString(),
        lesson: draft,
    };
    store.write(journalPath(journalId), record);
    store.write(lessonPath(lesson.id), draft);
    const active = { ...draft, status: "active" };
    store.write(lessonPath(lesson.id), active);
    store.write(journalPath(journalId), { ...record, state: "applied" });
    return active;
}
export function setStatus(store, id, status, now, waitMs = 5_000) {
    const release = store.lock("lessons", waitMs);
    try {
        return setStatusLocked(store, id, status, now);
    }
    finally {
        release();
    }
}
function setStatusLocked(store, id, status, now) {
    const lesson = readLesson(store, id);
    if (!lesson)
        return undefined;
    // A tombstone stays a tombstone, and a repeated command changes nothing.
    if (lesson.status === "deleted" || lesson.status === status)
        return lesson;
    const op = status === "disabled" ? "disable" : "delete";
    const journalId = newJournalId(now, id, op);
    const record = {
        id: journalId,
        op,
        lessonId: id,
        state: "intent",
        at: now.toISOString(),
        previousStatus: lesson.status,
    };
    store.write(journalPath(journalId), record);
    const changed = { ...lesson, status, changedAt: now.toISOString() };
    store.write(lessonPath(id), changed);
    store.write(journalPath(journalId), { ...record, state: "applied" });
    return changed;
}
/**
 * Finish or abandon every journal record a crash left at `intent`. An activation
 * is rolled forward (the lesson passed validation before its intent was written);
 * a disable or delete is re-applied. A record that cannot be read is skipped.
 */
export function recover(store, now) {
    // Recovery rewrites lesson files, so it takes the same lock as a user's disable or
    // delete; if another process holds it, recovery waits for the next run.
    let release;
    try {
        release = store.lock("lessons", 0);
    }
    catch (error) {
        if (error instanceof StoreError)
            return { finished: 0, abandoned: 0, unreadable: 0, skipped: true };
        throw error;
    }
    try {
        return recoverLocked(store, now);
    }
    finally {
        release();
    }
}
function recoverLocked(store, now) {
    let finished = 0;
    let abandoned = 0;
    let unreadable = 0;
    for (const name of store.list("journal")) {
        const record = store.read(`journal/${name}.json`);
        if (!record || typeof record.lessonId !== "string") {
            unreadable++;
            continue;
        }
        if (record.state !== "intent") {
            // A closed record only matters to a crash; kept a week for inspection, then pruned
            // so recovery on every turn does not read a history that grows forever.
            if (now.getTime() - Date.parse(record.at) > JOURNAL_KEEP_MS)
                store.remove(`journal/${name}.json`);
            continue;
        }
        const current = readLesson(store, record.lessonId);
        if (record.op === "activate") {
            const base = current ?? record.lesson;
            if (!base) {
                store.write(journalPath(record.id), { ...record, state: "abandoned" });
                abandoned++;
                continue;
            }
            if (base.status === "draft" || !current) {
                store.write(lessonPath(record.lessonId), { ...base, status: "active", changedAt: now.toISOString() });
            }
        }
        else if (current) {
            const status = record.op === "disable" ? "disabled" : "deleted";
            // A later change (a delete after a crashed disable) wins; a tombstone stays one.
            const changedLater = Date.parse(current.changedAt) > Date.parse(record.at);
            if (current.status !== status && current.status !== "deleted" && !changedLater) {
                store.write(lessonPath(record.lessonId), { ...current, status, changedAt: now.toISOString() });
            }
        }
        store.write(journalPath(record.id), { ...record, state: "applied" });
        finished++;
    }
    return { finished, abandoned, unreadable };
}
