/**
 * Notices for a chat a plugin cannot send to (webchat, the Tray, a send that failed): they
 * wait in the store (`notices/<agent>.json`) for the next run a person starts, which is
 * handed them to pass on, and are removed only when that run ends with a reply. So a
 * notice is never lost to another session, to a run that failed, or to a restart, and is
 * never told twice. The host never appears here: the plugin wires these to its hooks,
 * decides which runs a person started, and logs; these functions may throw on a store
 * error, and the caller fails open.
 */

import type { FileStore } from "./store.ts";

/** At most this many notices wait; the oldest goes first. */
export const MAX_NOTICES = 10;

export interface NoticeBox {
  notices: Array<{ what: string; sentence: string; at: string }>;
  /**
   * The run that was handed them, by its ids, and exactly which notices it was handed.
   * `runKey` alone in records from before `runIds`; `ids` absent before exact hand-over.
   */
  handedTo?: { runKey: string; runIds?: string[]; at: string; ids?: string[] };
}

export function noticesPath(agentId: string): string {
  return `notices/${agentId}.json`;
}

/** One notice, as the hand-over names it: what it is about and when it was stored. */
function noticeId(notice: { what: string; at: string }): string {
  return `${notice.what}@${notice.at}`;
}

function handedRun(handed: NonNullable<NoticeBox["handedTo"]>): string[] {
  return handed.runIds ?? [handed.runKey];
}

/**
 * Keep a notice for the agent. One per `what`: a later one replaces it. The hand-over
 * record stays, so a run that has the earlier notices still settles them.
 */
export function keepNotice(store: FileStore, agentId: string, what: string, sentence: string, now: Date): void {
  const path = noticesPath(agentId);
  const box = store.read<NoticeBox>(path);
  const pending = (box?.notices ?? []).filter((notice) => notice.what !== what);
  store.write(path, { ...box, notices: [...pending, { what, sentence, at: now.toISOString() }].slice(-MAX_NOTICES) });
}

/**
 * Hand the waiting notices to a run (by its ids): their sentences, or null when there are
 * none, or when another run that has them is still in progress (`inProgress`): that run
 * passes them on, not this one too.
 */
export function handNotices(
  store: FileStore,
  agentId: string,
  runIds: string[],
  inProgress: (holderIds: string[]) => boolean,
  now: Date,
): string[] | null {
  if (runIds.length === 0) return null;
  const path = noticesPath(agentId);
  const box = store.read<NoticeBox>(path);
  if (!box?.notices?.length) return null;
  const holder = box.handedTo ? handedRun(box.handedTo) : [];
  if (holder.length && !holder.some((id) => runIds.includes(id)) && inProgress(holder)) return null;
  store.write(path, { ...box, handedTo: { runKey: runIds[0], runIds, at: now.toISOString(), ids: box.notices.map(noticeId) } });
  return box.notices.map((notice) => notice.sentence);
}

/**
 * A run ended. The same run when any of its ids match: the two hooks need not carry the
 * same fields. With a reply, exactly the notices it was handed go (one that arrived while
 * it ran stays); without one, all stay for the next run. Null when it was not handed any.
 */
export function settleNotices(store: FileStore, agentId: string, runIds: string[], replied: boolean): "passed" | "kept" | null {
  if (runIds.length === 0) return null;
  const path = noticesPath(agentId);
  const box = store.read<NoticeBox>(path);
  if (!box?.handedTo || !handedRun(box.handedTo).some((id) => runIds.includes(id))) return null;
  const handed = new Set(box.handedTo.ids ?? []);
  const left = replied ? box.notices.filter((notice) => !handed.has(noticeId(notice))) : box.notices;
  if (left.length === 0) store.remove(path);
  else store.write(path, { notices: left });
  return replied ? "passed" : "kept";
}
