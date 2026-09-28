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
export function usageNote(used: number, limit: number): string {
  if (used > limit) return "over the soft limit";
  if (used * 100 >= limit * TIGHT_PERCENT) return "getting tight";
  return "";
}

export function lessonNotice(used: number, limit: number): string {
  const words = usageNote(used, limit);
  return `${BRAND} — new lesson learned (lessons ${used}/${limit}${words ? `, ${words}` : ""})`;
}
