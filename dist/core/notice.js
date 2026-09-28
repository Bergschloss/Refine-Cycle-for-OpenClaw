/**
 * The one message the plugin sends by itself. One plain line, by owner decision (as in
 * the Hermes plugin): no lesson text, no id, no markup, so it does not distract and
 * reads the same on every channel. `/refine` shows the lessons themselves.
 *
 * It carries how much of the lessons block's soft limit the active lessons take, as
 * the Hermes line carries memory use: every lesson is still shown, but the space in
 * front of the agent is not free.
 */
export const BRAND = "♾️ Refine Cycle";
/** At this share of the limit the line says so in words as well as in numbers. */
const TIGHT_PERCENT = 90;
/** The block's use in words: nothing, `getting tight` at 90%, `over the soft limit` past it. */
export function usageNote(used, limit) {
    if (used > limit)
        return "over the soft limit";
    if (used * 100 >= limit * TIGHT_PERCENT)
        return "getting tight";
    return "";
}
/** Past the soft limit the line says what it costs and what to do about it. */
export const OVER_LIMIT_ADVICE = "every turn now costs more tokens; /refine audit shows which lessons to turn off";
export function lessonNotice(used, limit) {
    const words = usageNote(used, limit);
    const note = used > limit ? `${words}: ${OVER_LIMIT_ADVICE}` : words;
    return `${BRAND} — new lesson learned (${used}/${limit}${note ? `, ${note}` : ""})`;
}
