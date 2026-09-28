/**
 * `/refine audit`: did each lesson help? Same vocabulary and the same rules as the
 * Hermes plugin (`ledger.py` `audit()`, `docs/USAGE.md` "Audit"), applied to what this
 * plugin records: in how many sessions a lesson was shown, and in how many of them its
 * failure came back after it was shown. No model call; nothing is deleted.
 *
 * Hermes terms that cannot apply here, and why:
 * - `churning` (edited three times or more): a lesson is never edited, and a failure
 *   whose lesson the user withdrew is never learned again, so none can churn.
 * - `unverified fingerprint`: a lesson naming a failure that was not observed is refused
 *   before it is saved, so every saved lesson is grounded.
 * - `unclear`: with exposures counted exactly, every lesson reaches another verdict; it is
 *   what Hermes shows when it cannot count uses, which this plugin always can.
 * - `pending approval`, `recovery needed`, `session note …`: no approval queue, and the
 *   journal finishes an interrupted change on the next turn.
 */
/** Hermes: `unused` and the `too early` split wait 14 days. */
export const AGE_GATE_DAYS = 14;
/** Hermes `audit_recurrence_horizon_days`: silence counts as `working` after 3 days. */
export const RECURRENCE_HORIZON_DAYS = 3;
/** First rule that matches wins, in the Hermes order. */
export function verdict(input) {
    if (input.status === "deleted")
        return { verdict: "rolled back", why: "you deleted it" };
    if (input.status === "disabled")
        return { verdict: "disabled", why: "you disabled it" };
    if (!input.windowOpen)
        return { verdict: "no recurrence window", why: "no session of this agent has ended since it was learned" };
    if (input.cameBack > 0) {
        return { verdict: "did not help", why: `its failure came back after it was shown, in ${input.cameBack} of ${input.shown} session(s)` };
    }
    if (input.unplaced > 0) {
        return { verdict: "unreliable", why: `${input.unplaced} failure(s) came with no time, so before or after the lesson is unknown` };
    }
    if (input.shown === 0) {
        return input.ageDays >= AGE_GATE_DAYS
            ? { verdict: "unused", why: `never shown in ${input.ageDays} days` }
            : { verdict: "too early", why: `not shown yet, ${input.ageDays} of ${AGE_GATE_DAYS} days` };
    }
    if (input.ageDays >= RECURRENCE_HORIZON_DAYS) {
        return { verdict: "working", why: `shown in ${input.shown} session(s), its failure has not come back` };
    }
    return { verdict: "too early", why: `shown in ${input.shown} session(s), ${input.ageDays} of ${RECURRENCE_HORIZON_DAYS} days` };
}
/** Verdicts the audit offers to remove, as Hermes does: the user runs the command, nothing is deleted. */
export const REMOVAL_CANDIDATES = new Set(["unused", "did not help"]);
