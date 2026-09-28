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
import zlib from "node:zlib";
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

function hasColumn(db: DatabaseSync, column: string): boolean {
  return db.prepare("SELECT 1 FROM pragma_table_info('transcript_events') WHERE name = ?").get(column) !== undefined;
}

/**
 * Since OpenClaw 2026.9.6 a large event is stored zstd-compressed in
 * `event_zstd` with `event_json` NULL; earlier versions have only `event_json`.
 */
function eventText(row: { event_json: string | null; event_zstd?: Uint8Array | null }): string | null {
  if (typeof row.event_json === "string") return row.event_json;
  if (row.event_zstd) return zlib.zstdDecompressSync(row.event_zstd).toString("utf8");
  return null;
}

/** Rows read per query; the host gets its turn between two of them. */
const ROWS_PER_SLICE = 500;

export function sqliteHistory(file: string, pause: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve))): History {
  return {
    /**
     * In slices of rows by `seq`: a real 28,775-row session (31 MB) took 360 ms to read
     * and parse in one query, and a long-lived chat session is read again after every turn.
     */
    async readSession(sessionId) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const columns = hasColumn(db, "event_zstd") ? "seq, event_json, event_zstd" : "seq, event_json";
        const query = db.prepare(
          `SELECT ${columns} FROM transcript_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ${ROWS_PER_SLICE}`,
        );
        const out: TranscriptRow[] = [];
        let after = Number.MIN_SAFE_INTEGER;
        for (;;) {
          const rows = query.all(sessionId, after) as Array<{ seq: number; event_json: string | null; event_zstd?: Uint8Array | null }>;
          for (const row of rows) {
            try {
              const text = eventText(row);
              if (text !== null) out.push({ seq: Number(row.seq), event: JSON.parse(text) });
            } catch {
              // A row the host wrote and we cannot decode is not ours to judge; skip it.
            }
          }
          if (rows.length < ROWS_PER_SLICE) return out;
          after = Number(rows[rows.length - 1].seq);
          await pause();
        }
      } finally {
        db.close();
      }
    },
    hasSession(sessionId) {
      return withDatabase(file, (db) => db.prepare("SELECT 1 FROM transcript_events WHERE session_id = ? LIMIT 1").get(sessionId) !== undefined);
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
