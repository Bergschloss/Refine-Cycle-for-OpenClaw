/**
 * Settings come from the host: `plugins.entries.refine-cycle.config` in
 * openclaw.json, validated against the manifest's configSchema. Anything missing
 * or of the wrong type falls back to the default.
 */
export const DEFAULTS = {
    enabled: true,
    injectEnabled: true,
    learnEnabled: true,
    maxInjectedChars: 1000,
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
};
export function readSettings(raw) {
    const input = typeof raw === "object" && raw !== null ? raw : {};
    const out = { ...DEFAULTS };
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
        const value = input[key];
        if (Array.isArray(fallback)) {
            if (Array.isArray(value) && value.every((item) => typeof item === "string"))
                out[key] = value;
        }
        else if (typeof value === typeof fallback) {
            if (typeof value === "number" && !(Number.isFinite(value) && value >= 0))
                continue;
            out[key] = value;
        }
    }
    return out;
}
