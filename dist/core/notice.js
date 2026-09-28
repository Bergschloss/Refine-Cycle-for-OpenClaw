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
/**
 * What a user reads when the plugin cannot use its store: the folder, the likely cause
 * read from the error, and what to do. The plugin is idle until then (it fails open).
 */
export function storeErrorText(root, error) {
    let cause;
    let fix;
    if (/\bE(ACCES|PERM)\b|cannot be set aside/.test(error)) {
        cause = "the gateway's user may not write to that folder (permissions)";
        fix = "give the user OpenClaw runs as write access to the folder, e.g. `chown -R <user> <folder>`";
    }
    else if (/\b(ENOSPC|EDQUOT)\b/.test(error)) {
        cause = "the disk (or the user's quota) is full";
        fix = "free space on that disk";
    }
    else if (/\bEROFS\b/.test(error)) {
        cause = "the folder is on a read-only file system";
        fix = "mount it writable, or move OpenClaw's state directory to a writable disk";
    }
    else if (/\bstore schema\b/.test(error)) {
        cause = "the folder was written by another version of Refine Cycle";
        fix = "update Refine Cycle to that version, or move the folder aside to start an empty store";
    }
    else {
        cause = "the folder cannot be created or read";
        fix = "check that it exists and that the gateway's user can read and write it";
    }
    return [
        `Refine Cycle cannot use its store: ${error}`,
        `folder: ${root}`,
        `likely cause: ${cause}`,
        `fix: ${fix}, then restart the gateway. Until then nothing is learned or injected; the agent works as without the plugin.`,
    ].join("\n");
}
