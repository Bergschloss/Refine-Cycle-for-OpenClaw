/**
 * Is this failure the kind a lesson can fix?
 *
 * Most repeats cannot be fixed by a lesson. On the Hermes corpus roughly 46% were
 * knowledge gaps, 37% a wrong tool choice and 6% the agent dropping an argument it
 * had already used; a transient outage is not the agent's mistake at all. These
 * rules say "nothing to write here" without a model call, and say which rule.
 */

import type { AggregatePattern } from "./failures.ts";

export type NotLessonShaped = "transient" | "wrong_tool" | "dropped_argument";

const TRANSIENT = new RegExp(
  [
    String.raw`\btime(?:d)?\s*out\b`, String.raw`\btimeout\b`, String.raw`\brate[\s_-]?limit`,
    String.raw`\btoo many requests\b`, String.raw`\bhttpstatus(?:429|50[0-4])\b`,
    String.raw`\be(?:connreset|connrefused|timedout|ai_again|pipe)\b`, String.raw`\bsocket hang up\b`,
    String.raw`\bconnection (?:reset|refused|closed|aborted)\b`, String.raw`\btemporar(?:il)?y unavailable\b`,
    String.raw`\bservice unavailable\b`, String.raw`\boverloaded\b`, String.raw`\btry again later\b`,
    String.raw`\bnetwork error\b`,
  ].join("|"),
  "iu",
);

const WRONG_TOOL = new RegExp(
  [
    String.raw`\bunknown tool\b`, String.raw`\bno such tool\b`, String.raw`\btool\b[^.]{0,60}\bnot found\b`,
    String.raw`\bnot an? (?:known|valid|available) tool\b`, String.raw`\btool\b[^.]{0,60}\bis not available\b`,
  ].join("|"),
  "iu",
);

/**
 * An error that says what must be done first ("the pane is not displayed, display it
 * and retry") fails the same way every time, even when it is reported as a timeout.
 */
const PREREQUISITE = /\b(?:is not (?:displayed|open|running|visible|enabled|installed)|must be|needs to be|display the|open the|start the)\b/iu;

export function lessonShape(pattern: AggregatePattern): NotLessonShaped | null {
  const text = `${pattern.shape}\n${pattern.sample}`;
  if (TRANSIENT.test(text) && !PREREQUISITE.test(text)) return "transient";
  if (WRONG_TOOL.test(text)) return "wrong_tool";
  if (pattern.droppedArgument) return "dropped_argument";
  return null;
}
