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
export function agentDatabasePath(stateDir, agentId) {
    return path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
}
function withDatabase(file, body) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        return body(db);
    }
    finally {
        db.close();
    }
}
function hasColumn(db, column) {
    return db.prepare("SELECT 1 FROM pragma_table_info('transcript_events') WHERE name = ?").get(column) !== undefined;
}
/**
 * Since OpenClaw 2026.9.6 a large event is stored zstd-compressed in
 * `event_zstd` with `event_json` NULL; earlier versions have only `event_json`.
 */
function eventText(row) {
    if (typeof row.event_json === "string")
        return row.event_json;
    if (row.event_zstd)
        return zlib.zstdDecompressSync(row.event_zstd).toString("utf8");
    return null;
}
export function sqliteHistory(file) {
    return {
        readSession(sessionId) {
            return withDatabase(file, (db) => {
                const columns = hasColumn(db, "event_zstd") ? "seq, event_json, event_zstd" : "seq, event_json";
                const rows = db
                    .prepare(`SELECT ${columns} FROM transcript_events WHERE session_id = ? ORDER BY seq`)
                    .all(sessionId);
                const out = [];
                for (const row of rows) {
                    try {
                        const text = eventText(row);
                        if (text !== null)
                            out.push({ seq: Number(row.seq), event: JSON.parse(text) });
                    }
                    catch {
                        // A row the host wrote and we cannot decode is not ours to judge; skip it.
                    }
                }
                return out;
            });
        },
        recentSessions(limit) {
            if (limit <= 0)
                return [];
            return withDatabase(file, (db) => db
                .prepare("SELECT session_id, MAX(seq) AS last_seq, MAX(created_at) AS last_at FROM transcript_events " +
                "GROUP BY session_id ORDER BY last_at DESC LIMIT ?")
                .all(limit).map((row) => ({ sessionId: row.session_id, lastSeq: Number(row.last_seq) })));
        },
    };
}
