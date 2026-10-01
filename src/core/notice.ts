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

/** Past the soft limit the line says what it costs and what to do about it. */
export const OVER_LIMIT_ADVICE = "every turn now costs more tokens; /refine audit shows which lessons to turn off";

export function lessonNotice(used: number, limit: number): string {
  const words = usageNote(used, limit);
  const note = used > limit ? `${words}: ${OVER_LIMIT_ADVICE}` : words;
  return `${BRAND} — new lesson learned (${used}/${limit}${note ? `, ${note}` : ""})`;
}

/** The same, as a sentence the agent can pass on where the plugin cannot send (webchat). */
export function lessonSentence(used: number, limit: number): string {
  const words = usageNote(used, limit);
  const advice = used > limit ? `; ${OVER_LIMIT_ADVICE}` : "";
  return `Refine Cycle learned a new lesson; lessons use ${used} of ${limit} characters${words ? ` (${words}${advice})` : ""}.`;
}

/** Over the soft limit with nothing the tidy may switch off: said once, not on every turn. */
export function overLimitNotice(used: number, limit: number): string {
  return `${BRAND} — lessons use ${used}/${limit} characters, over the soft limit, and none can be switched off yet: ${OVER_LIMIT_ADVICE}`;
}

export function overLimitSentence(used: number, limit: number): string {
  return `Refine Cycle's lessons use ${used} of ${limit} characters, over the soft limit, and none can be switched off yet; ${OVER_LIMIT_ADVICE}.`;
}

/** "2 lessons that did not help and 1 unused lesson", from what the tidy switched off. */
function tidyWhat(verdicts: string[]): string {
  const helped = verdicts.filter((v) => v === "did not help").length;
  const unused = verdicts.filter((v) => v === "unused").length;
  const parts = [
    ...(helped ? [`${helped} lesson${helped === 1 ? "" : "s"} that did not help`] : []),
    ...(unused ? [`${unused} unused lesson${unused === 1 ? "" : "s"}`] : []),
  ];
  return parts.join(" and ");
}

/** One line per tidy that switched something off. */
export function tidyNotice(verdicts: string[], used: number, limit: number): string {
  return `${BRAND} — switched off ${tidyWhat(verdicts)}, lessons now ${used}/${limit}${used > limit ? ", still over the soft limit" : ""}`;
}

export function tidySentence(verdicts: string[], used: number, limit: number): string {
  return `Refine Cycle switched off ${tidyWhat(verdicts)}; lessons now use ${used} of ${limit} characters.`;
}

/**
 * A notice given to the agent as a system event, for a chat a plugin cannot send to
 * (webchat): the agent passes it on in its next reply. Worded so it is relayed, not acted on.
 */
export function agentNotice(sentence: string): string {
  return `Tell the user in one short sentence, then go on with their request; this is a notice, not a task: ${sentence}`;
}

/**
 * The same for notices put in front of the agent's next user turn with the prompt (the
 * Tray, the web UI): one line, after the lessons block, never inside it.
 */
export function agentNotices(sentences: string[]): string {
  return `[Refine Cycle notice] ${agentNotice(sentences.join(" "))}`;
}

/**
 * A chat message as a sentence for the agent to pass on: the brand mark dropped, lines
 * joined, so a command's late result reads as one notice.
 */
export function plainSentence(text: string): string {
  return text.replace(/^♾️\s*/, "").replace(/:\s*\n+\s*/g, ": ").replace(/\s*\n+\s*/g, "; ").trim();
}


/**
 * What a user reads when the plugin cannot use its store: the folder, the likely cause
 * read from the error, and what to do. The plugin is idle until then (it fails open).
 */
export function storeErrorText(root: string, error: string): string {
  let cause: string;
  let fix: string;
  if (/\bE(ACCES|PERM)\b|cannot be set aside/.test(error)) {
    cause = "the gateway's user may not write to that folder (permissions)";
    fix = "give the user OpenClaw runs as write access to the folder, e.g. `chown -R <user> <folder>`";
  } else if (/\b(ENOSPC|EDQUOT)\b/.test(error)) {
    cause = "the disk (or the user's quota) is full";
    fix = "free space on that disk";
  } else if (/\bEROFS\b/.test(error)) {
    cause = "the folder is on a read-only file system";
    fix = "mount it writable, or move OpenClaw's state directory to a writable disk";
  } else if (/\bstore schema\b/.test(error)) {
    cause = "the folder was written by another version of Refine Cycle";
    fix = "update Refine Cycle to that version, or move the folder aside to start an empty store";
  } else {
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

/** The same in one sentence for the agent to pass on: the folder and the likely cause, no stack of details. */
export function storeErrorSentence(root: string, error: string): string {
  const [, , cause, fix] = storeErrorText(root, error).split("\n");
  return `Refine Cycle is switched off because it cannot use its folder ${root} (${cause.replace(/^likely cause: /, "")}); ${fix.replace(/^fix: /, "")}`;
}
