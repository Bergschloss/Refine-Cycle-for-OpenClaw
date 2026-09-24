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
import { FileStore, safeName } from "./store.ts";

export type LessonStatus = "draft" | "active" | "disabled" | "deleted";

export interface Lesson {
  id: string;
  text: string;
  fingerprint: string;
  tool: string;
  status: LessonStatus;
  createdAt: string;
  changedAt: string;
  /** The session whose failure produced it, and the host rows behind it. */
  sourceSessionId: string;
  evidence: { sessionIds: string[]; eventIds: string[] };
  reason: string;
}

interface JournalRecord {
  id: string;
  op: "activate" | "disable" | "delete";
  lessonId: string;
  state: "intent" | "applied" | "abandoned";
  at: string;
  /** For `activate`: the lesson as it will be written, so recovery can finish the job. */
  lesson?: Lesson;
  previousStatus?: LessonStatus;
}

export function lessonId(fingerprint: string, text: string): string {
  return createHash("sha1").update(`${fingerprint}|${text.toLowerCase().trim()}`).digest("hex").slice(0, 10);
}

function lessonPath(id: string): string {
  return `lessons/${safeName(id)}.json`;
}

function journalPath(id: string): string {
  return `journal/${safeName(id)}.json`;
}

function newJournalId(now: Date, lessonIdValue: string, op: string): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${op}-${lessonIdValue}`;
}

export function readLesson(store: FileStore, id: string): Lesson | undefined {
  return store.read<Lesson>(lessonPath(id));
}

export function allLessons(store: FileStore): Lesson[] {
  const out: Lesson[] = [];
  for (const name of store.list("lessons")) {
    const lesson = store.read<Lesson>(`lessons/${name}.json`);
    if (lesson && typeof lesson.id === "string" && typeof lesson.text === "string") out.push(lesson);
  }
  return out;
}

/** Active lessons, oldest first: a stable order keeps the injected block stable. */
export function activeLessons(store: FileStore): Lesson[] {
  return allLessons(store)
    .filter((lesson) => lesson.status === "active")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function activate(store: FileStore, lesson: Omit<Lesson, "status" | "changedAt">, now: Date): Lesson {
  const draft: Lesson = { ...lesson, status: "draft", changedAt: now.toISOString() };
  const journalId = newJournalId(now, lesson.id, "activate");
  const record: JournalRecord = {
    id: journalId,
    op: "activate",
    lessonId: lesson.id,
    state: "intent",
    at: now.toISOString(),
    lesson: draft,
  };
  store.write(journalPath(journalId), record);
  store.write(lessonPath(lesson.id), draft);
  const active: Lesson = { ...draft, status: "active" };
  store.write(lessonPath(lesson.id), active);
  store.write(journalPath(journalId), { ...record, state: "applied" });
  return active;
}

export function setStatus(store: FileStore, id: string, status: "disabled" | "deleted", now: Date): Lesson | undefined {
  const lesson = readLesson(store, id);
  if (!lesson) return undefined;
  const op = status === "disabled" ? "disable" : "delete";
  const journalId = newJournalId(now, id, op);
  const record: JournalRecord = {
    id: journalId,
    op,
    lessonId: id,
    state: "intent",
    at: now.toISOString(),
    previousStatus: lesson.status,
  };
  store.write(journalPath(journalId), record);
  const changed: Lesson = { ...lesson, status, changedAt: now.toISOString() };
  store.write(lessonPath(id), changed);
  store.write(journalPath(journalId), { ...record, state: "applied" });
  return changed;
}

/**
 * Finish or abandon every journal record a crash left at `intent`. An activation
 * is rolled forward (the lesson passed validation before its intent was written);
 * a disable or delete is re-applied. A record that cannot be read is skipped.
 */
export function recover(store: FileStore, now: Date): { finished: number; abandoned: number; unreadable: number } {
  let finished = 0;
  let abandoned = 0;
  let unreadable = 0;
  for (const name of store.list("journal")) {
    const record = store.read<JournalRecord>(`journal/${name}.json`);
    if (!record || typeof record.lessonId !== "string") {
      unreadable++;
      continue;
    }
    if (record.state !== "intent") continue;
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
    } else if (current) {
      const status = record.op === "disable" ? "disabled" : "deleted";
      if (current.status !== status) {
        store.write(lessonPath(record.lessonId), { ...current, status, changedAt: now.toISOString() });
      }
    }
    store.write(journalPath(record.id), { ...record, state: "applied" });
    finished++;
  }
  return { finished, abandoned, unreadable };
}
