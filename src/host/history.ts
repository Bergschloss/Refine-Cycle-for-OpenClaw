/**
 * Past sessions, read straight from the agent's SQLite database, read-only.
 *
 * The host's own history API only works inside a Gateway request (the spike hit
 * RequestScopedSubagentRuntimeError from a background job), so the plugin reads
 * `transcript_events` itself. The database runs in WAL mode, so a reader does not
 * block the host's writer.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { TranscriptRow } from "../core/failures.ts";
import type { History } from "../pipeline.ts";

export function agentDatabasePath(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function withDatabase<T>(file: string, body: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return body(db);
  } finally {
    db.close();
  }
}

export function sqliteHistory(file: string): History {
  return {
    readSession(sessionId) {
      return withDatabase(file, (db) => {
        const rows = db
          .prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
          .all(sessionId) as Array<{ seq: number; event_json: string }>;
        const out: TranscriptRow[] = [];
        for (const row of rows) {
          try {
            out.push({ seq: Number(row.seq), event: JSON.parse(row.event_json) });
          } catch {
            // A row the host wrote and we cannot parse is not ours to judge; skip it.
          }
        }
        return out;
      });
    },
    recentSessions(limit) {
      if (limit <= 0) return [];
      return withDatabase(file, (db) =>
        (
          db
            .prepare(
              "SELECT session_id, MAX(seq) AS last_seq, MAX(created_at) AS last_at FROM transcript_events " +
                "GROUP BY session_id ORDER BY last_at DESC LIMIT ?",
            )
            .all(limit) as Array<{ session_id: string; last_seq: number }>
        ).map((row) => ({ sessionId: row.session_id, lastSeq: Number(row.last_seq) })),
      );
    },
  };
}
