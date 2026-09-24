/**
 * Settings come from the host: `plugins.entries.refine-cycle.config` in
 * openclaw.json, validated against the manifest's configSchema. Anything missing
 * or of the wrong type falls back to the default.
 */

export interface Settings {
  enabled: boolean;
  injectEnabled: boolean;
  learnEnabled: boolean;
  /** Size cap of the injected block, in characters. */
  maxInjectedChars: number;
  maxLessonChars: number;
  maxModelCallsPerDay: number;
  /** The recurrence bar: a failure qualifies when seen in this many sessions... */
  minSessions: number;
  /** ...or this many times in all. */
  minOccurrences: number;
  /** Recent sessions re-read on each run, so failures from before a restart still count. */
  backfillSessions: number;
  proposalTimeoutMs: number;
  /** Instruction files in the agent workspace searched by the already-covered check. */
  instructionFiles: string[];
  /** Extra directories searched for SKILL.md files, besides `<workspace>/skills`. */
  skillDirs: string[];
  /** Override for the agent's transcript database; default is the host's standard location. */
  historyDbPath: string;
}

export const DEFAULTS: Settings = {
  enabled: true,
  injectEnabled: true,
  learnEnabled: true,
  maxInjectedChars: 1000,
  maxLessonChars: 200,
  maxModelCallsPerDay: 3,
  minSessions: 2,
  minOccurrences: 5,
  backfillSessions: 10,
  proposalTimeoutMs: 120_000,
  instructionFiles: ["AGENTS.md", "TOOLS.md", "SOUL.md"],
  skillDirs: [],
  historyDbPath: "",
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
