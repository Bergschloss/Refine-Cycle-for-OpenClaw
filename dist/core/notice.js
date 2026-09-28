/**
 * The one message the plugin sends by itself: a new lesson, in the chat it was learned
 * from. Everything else the user sees is an answer to `/refine`.
 */
export const BRAND = "♾️ Refine Cycle";
export function lessonNotice(lesson) {
    return [
        `${BRAND}: new lesson learned`,
        lesson.text,
        "",
        "See all lessons: /refine",
        `Turn this one off: /refine disable ${lesson.id}`,
    ].join("\n");
}
