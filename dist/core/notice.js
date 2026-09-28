/**
 * The one message the plugin sends by itself. One plain line, by owner decision (as in
 * the Hermes plugin): no lesson text, no id, no markup, so it does not distract and
 * reads the same on every channel. `/refine` shows the lessons themselves.
 */
export const BRAND = "♾️ Refine Cycle";
export function lessonNotice(count) {
    return count > 1 ? `${BRAND} — ${count} new lessons learned` : `${BRAND} — new lesson learned`;
}
