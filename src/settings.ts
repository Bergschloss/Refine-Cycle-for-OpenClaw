/**
 * Settings come from the host: `plugins.entries.refine-cycle.config` in
 * openclaw.json, validated against the manifest's configSchema. Anything missing
 * or of the wrong type falls back to the default.
 */

export interface Settings {
  enabled: boolean;
  injectEnabled: boolean;
  learnEnabled: boolean;
  /** Soft limit of the injected block, in characters: every active lesson is shown; the lesson message warns near and past it. */
  maxInjectedChars: number;
  maxLessonChars: number;
  maxModelCallsPerDay: number;
  /** The recurrence bar: a failure qualifies when seen in this many sessions... */
  minSessions: number;
  /** ...or this many times in all. */
  minOccurrences: number;
  /** Recent sessions re-read, so failures from before the plugin ran (or a restart) still count. */
  backfillSessions: number;
  /** How often, at most, the host's history is scanned for those sessions. */
  backfillIntervalMinutes: number;
  proposalTimeoutMs: number;
  /** Instruction files in the agent workspace searched by the already-covered check. */
  instructionFiles: string[];
  /** Extra directories searched for SKILL.md files, besides `<workspace>/skills`. */
  skillDirs: string[];
  /** Override for the agent's transcript database; default is the host's standard location. */
  historyDbPath: string;
  /** Tell the user, in the chat the lesson came from, when a new lesson is learned. */
  notifyOnLesson: boolean;
  /** Once a day, look for a newer release and tell the user once, with an Update button. */
  checkForUpdates: boolean;
  /**
   * The model lessons are written with (`provider/model`); empty for the default agent's.
   * OpenClaw sends it only with `plugins.entries.refine-cycle.llm.allowModelOverride: true`.
   */
  model: string;
}

export const DEFAULTS: Settings = {
  enabled: true,
  injectEnabled: true,
  learnEnabled: true,
  maxInjectedChars: 4400,
  maxLessonChars: 200,
  maxModelCallsPerDay: 3,
  minSessions: 2,
  minOccurrences: 5,
  backfillSessions: 10,
  backfillIntervalMinutes: 60,
  proposalTimeoutMs: 120_000,
  instructionFiles: ["AGENTS.md", "TOOLS.md", "SOUL.md"],
  skillDirs: [],
  historyDbPath: "",
  notifyOnLesson: true,
  checkForUpdates: true,
  model: "",
};

export function readSettings(raw: unknown): Settings {
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = input[key];
    if (Array.isArray(fallback)) {
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) out[key] = value;
    } else if (typeof value === typeof fallback) {
      if (typeof value === "number" && !(Number.isFinite(value) && value >= 0)) continue;
      out[key] = value;
    }
  }
  return out as unknown as Settings;
}
