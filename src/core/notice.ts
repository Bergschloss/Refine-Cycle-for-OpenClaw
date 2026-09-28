/**
 * The one message the plugin sends by itself. One plain line, by owner decision (as in
 * the Hermes plugin): no lesson text, no id, no markup, so it does not distract and
 * reads the same on every channel. `/refine` shows the lessons themselves.
 *
 * It carries how much of the lessons block the active lessons take, as the Hermes line
 * carries memory use: a reminder that the space in front of the agent is finite.
 */

export const BRAND = "♾️ Refine Cycle";

/** At this share of the limit the line says so in words as well as in numbers. */
const TIGHT_PERCENT = 90;

export function lessonNotice(used: number, limit: number, full = false): string {
  let note = `lessons ${used}/${limit}`;
  if (full) note += ", full";
  else if (used * 100 >= limit * TIGHT_PERCENT) note += ", getting tight";
  return `${BRAND} — new lesson learned (${note})`;
}
