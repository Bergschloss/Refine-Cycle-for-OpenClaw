/**
 * The block put in front of the model. Bounded, marked as coming from this
 * plugin, and built only from lessons already active: no model call, no history
 * read, no write happens on this path.
 */

import { createHash } from "node:crypto";

export interface InjectableLesson {
  id: string;
  text: string;
}

export interface Block {
  text: string;
  lessonIds: string[];
  hash: string;
}

const OPEN = "<refine_cycle_lessons>";
const CLOSE = "</refine_cycle_lessons>";
const HEADER =
  "Lessons from this agent's own repeated failures, added by the Refine Cycle plugin. " +
  "Apply one only when its situation comes up.";

/**
 * Lessons are taken in the given order; one that would push the block past
 * `maxChars` is left out whole, never cut. No lesson that fits means no block.
 */
export function formatBlock(lessons: InjectableLesson[], maxChars: number): Block | null {
  const fixed = OPEN.length + 1 + HEADER.length + 1 + CLOSE.length;
  let used = fixed;
  const lines: string[] = [];
  const ids: string[] = [];
  for (const lesson of lessons) {
    const line = `- ${lesson.text.replace(/\s+/g, " ").trim()}`;
    if (line.length <= 2) continue;
    if (used + line.length + 1 > maxChars) continue;
    lines.push(line);
    ids.push(lesson.id);
    used += line.length + 1;
  }
  if (lines.length === 0) return null;
  const text = [OPEN, HEADER, ...lines, CLOSE].join("\n");
  return { text, lessonIds: ids, hash: createHash("sha256").update(text).digest("hex").slice(0, 16) };
}
