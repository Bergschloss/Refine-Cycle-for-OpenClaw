/**
 * The measurement harness: run the learning loop over a recorded corpus, session
 * by session in the order they happened, as if the plugin had been installed
 * from the start. Each session sees only the sessions before it (no backfill),
 * which is what a live install would have seen.
 *
 * Input is JSONL, one session per line: `{"sessionId", "startedAt", "rows": [{seq, event}]}`
 * with events in OpenClaw's transcript shape. The tool calls go in the assistant message
 * as the host writes them, `{type: "toolCall", id, name, arguments: {...}}` parts (or
 * through the host's `tool_call` wrapper), and each result names its call by
 * `toolCallId`: then the failing call's arguments, the call that fixed it and the
 * self-correction rule reach the loop exactly as they do live
 * (`test/fixtures/corpus-with-args.jsonl`). A corpus without them still replays, with
 * the tool name from `toolName` and no arguments. Output is the store (every decision
 * and lesson, traceable) and a result file with the numbers and the lessons.
 */

import fs from "node:fs";
import path from "node:path";
import type { TranscriptRow } from "./core/failures.ts";
import type { Source } from "./core/covered.ts";
import { allLessons } from "./lessons.ts";
import { processSession, RAW_FORMAT, report, type Llm, type RawRunLine, type RawSessionLine } from "./pipeline.ts";
import type { Settings } from "./settings.ts";
import { FileStore } from "./store.ts";

export interface CorpusSession {
  sessionId: string;
  startedAt?: string | number;
  rows: TranscriptRow[];
}

/** Sessions in the order they happened (`startedAt`); lines without it keep their place after the dated ones. */
export function readCorpus(file: string): CorpusSession[] {
  const out: CorpusSession[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const session = JSON.parse(line) as CorpusSession;
    if (typeof session.sessionId === "string" && Array.isArray(session.rows)) out.push(session);
  }
  const time = (value: CorpusSession["startedAt"]): number => {
    if (typeof value === "number") return value;
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  };
  return out
    .map((session, index) => ({ session, index, at: time(session.startedAt) }))
    .sort((x, y) => (x.at === y.at ? x.index - y.index : x.at < y.at ? -1 : 1))
    .map((entry) => entry.session);
}

export interface ReplayResult {
  corpus: string;
  sessions: number;
  report: ReturnType<typeof report>;
  lessons: Array<{ id: string; text: string; fingerprint: string; tool: string; sourceSessionId: string; sessionIds: string[]; reason: string }>;
}

export async function replay(options: {
  corpusFile: string;
  storeDir: string;
  llm: Llm | null;
  sources: Source[];
  settings: Settings;
  log: (message: string) => void;
  /** Write the raw record here, one JSON line per session after a `run` line (docs/proof/RAW-FORMAT.md). */
  rawFile?: string;
  /** The plugin version, for the raw record's `run` line. */
  version?: string;
}): Promise<ReplayResult> {
  const sessions = readCorpus(options.corpusFile);
  const byId = new Map(sessions.map((session) => [session.sessionId, session.rows]));
  // A store that already holds a run would mix its decisions into this one's numbers.
  if (fs.existsSync(options.storeDir) && fs.readdirSync(options.storeDir).length > 0) {
    throw new Error(`replay needs an empty store directory: ${options.storeDir}`);
  }
  // So would a raw file that already holds lines.
  if (options.rawFile && fs.existsSync(options.rawFile) && fs.statSync(options.rawFile).size > 0) {
    throw new Error(`replay needs a new or empty raw file: ${options.rawFile}`);
  }
  const store = new FileStore(options.storeDir);
  store.open();
  // No backfill: a session may only learn from the sessions already replayed. No pruning:
  // it ages summaries by the real clock, and the corpus's sessions are all "old".
  const settings: Settings = { ...options.settings, backfillSessions: 0, keepSessionDays: 0, keepSessions: 0 };
  const history = {
    readSession: (sessionId: string) => byId.get(sessionId) ?? [],
    recentSessions: () => [],
  };
  const rawFile = options.rawFile;
  const writeRaw = (line: object) => fs.appendFileSync(rawFile!, `${JSON.stringify(line)}\n`);
  if (rawFile) {
    fs.mkdirSync(path.dirname(path.resolve(rawFile)), { recursive: true });
    const run: RawRunLine = {
      kind: "run", format: RAW_FORMAT, at: new Date().toISOString(), source: "replay", version: options.version ?? "",
      corpus: path.basename(options.corpusFile), sessions: sessions.length, sources: options.sources.length,
      // No paths: the raw file is meant to be handed to someone else.
      settings: { ...settings, historyDbPath: settings.historyDbPath ? "set" : "", skillDirs: settings.skillDirs.length },
    };
    fs.writeFileSync(rawFile, `${JSON.stringify(run)}\n`);
  }
  let index = 0;
  for (const session of sessions) {
    index++;
    const raw = rawFile
      ? (line: RawSessionLine) => writeRaw({ ...line, corpusStartedAt: session.startedAt ?? null })
      : undefined;
    const decision = await processSession(
      { store, history, llm: options.llm, sources: () => options.sources, settings, now: () => new Date(), log: options.log, ...(raw ? { raw } : {}) },
      session.sessionId,
      "replay",
    );
    if (decision.outcome !== "no_failures") options.log(`${index}/${sessions.length} ${session.sessionId}: ${decision.outcome}`);
  }
  const result: ReplayResult = {
    corpus: path.basename(options.corpusFile),
    sessions: sessions.length,
    report: report(store),
    lessons: allLessons(store).map((lesson) => ({
      id: lesson.id,
      text: lesson.text,
      fingerprint: lesson.fingerprint,
      tool: lesson.tool,
      sourceSessionId: lesson.sourceSessionId,
      sessionIds: lesson.evidence.sessionIds,
      reason: lesson.reason,
    })),
  };
  fs.writeFileSync(path.join(options.storeDir, "replay-result.json"), JSON.stringify(result, null, 2));
  return result;
}
