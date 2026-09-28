/**
 * The block put in front of the model. Marked as coming from this
 * plugin, and built only from lessons already active: no model call, no history
 * read, no write happens on this path.
 */
import { createHash } from "node:crypto";
const OPEN = "<refine_cycle_lessons>";
const CLOSE = "</refine_cycle_lessons>";
const HEADER = "Lessons from this agent's own repeated failures, added by the Refine Cycle plugin. " +
    "Apply one only when its situation comes up.";
/**
 * Every lesson, in the given order, whole. The size limit is soft (owner decision,
 * the Hermes memory limit's number): no active lesson is ever left out for size; the
 * lesson message tells the user when the block gets near or over the limit.
 * No lesson means no block.
 */
export function formatBlock(lessons) {
    const lines = [];
    const ids = [];
    for (const lesson of lessons) {
        // Lesson files are the plugin's own, but a hand-edited or older one must still not open or close tags.
        const line = `- ${lesson.text.replace(/\s+/g, " ").replace(/</g, "‹").replace(/>/g, "›").trim()}`;
        if (line.length <= 2)
            continue;
        lines.push(line);
        ids.push(lesson.id);
    }
    if (lines.length === 0)
        return null;
    const text = [OPEN, HEADER, ...lines, CLOSE].join("\n");
    return { text, lessonIds: ids, hash: createHash("sha256").update(text).digest("hex").slice(0, 16) };
}
