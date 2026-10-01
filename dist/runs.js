/**
 * The agent runs in progress, as the plugin's own hooks saw them: a prompt was built and
 * the run has not ended. The host offers a plugin no idle signal (OpenClaw 2026.9.6), and
 * the automatic update and its restart must never cut a run off, so this is what tells them
 * the gateway is quiet. A run is keyed by its session with all its ids, because the two
 * hooks need not carry the same fields, and an end that shares any id ends it. A run that
 * never ends (one that failed in the host before `agent_end`) stops counting after
 * `lostAfterMs`, and at most `max` runs are kept.
 */
export class Runs {
    seen = new Map();
    now;
    max;
    constructor(now = Date.now, max = 200) {
        this.now = now;
        this.max = max;
    }
    started(ids) {
        if (ids.length === 0)
            return;
        this.seen.delete(ids[0]);
        this.seen.set(ids[0], { since: this.now(), ids });
        while (this.seen.size > this.max)
            this.seen.delete(this.seen.keys().next().value);
    }
    ended(ids) {
        const ending = new Set(ids);
        for (const [key, run] of this.seen)
            if (run.ids.some((id) => ending.has(id)))
                this.seen.delete(key);
    }
    /** The runs still in progress; those older than `lostAfterMs` are dropped, and returned as `lost`. */
    inProgress(lostAfterMs) {
        const cutoff = this.now() - lostAfterMs;
        const lost = [];
        for (const [key, run] of this.seen) {
            if (run.since < cutoff) {
                this.seen.delete(key);
                lost.push(run);
            }
        }
        return { running: [...this.seen.values()], lost };
    }
}
