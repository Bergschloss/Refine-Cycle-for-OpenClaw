/**
 * "Update available" and `/refine update`, as in the Hermes plugin (`update_check.py`,
 * `notices.py`): the rules and the words, without the host. The plugin itself fetches no
 * code and installs nothing; the host's own `openclaw plugins update` does the update.
 */
import { BRAND } from "./notice.js";
/** At most one check a day (Hermes `_CHECK_INTERVAL_SECONDS`)... */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** ...and, after a check that failed (no network, a broken source), another after an hour. */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
export function checkDue(state, now) {
    if (!state?.checkedAt)
        return true;
    const since = now.getTime() - Date.parse(state.checkedAt);
    if (!(since >= 0))
        return true;
    return since >= (state.ok ? CHECK_INTERVAL_MS : RETRY_AFTER_FAILURE_MS);
}
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;
/** A release version: `1.2.3` or `v1.2.3`; a pre-release or anything else is not one. */
export function parseVersion(text) {
    const match = VERSION.exec(text.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
/** True when `candidate` is a newer release than `installed`. */
export function isNewer(candidate, installed) {
    const a = parseVersion(candidate);
    const b = parseVersion(installed);
    if (!a || !b)
        return false;
    for (let i = 0; i < 3; i++)
        if (a[i] !== b[i])
            return a[i] > b[i];
    return false;
}
/** The newest release tag in `git ls-remote --tags` output, without its `v`. */
export function latestTag(lsRemote) {
    let best = null;
    for (const line of lsRemote.split("\n")) {
        const ref = /\trefs\/tags\/(.+?)(\^\{\})?\s*$/.exec(line)?.[1];
        if (!ref || !parseVersion(ref))
            continue;
        const version = ref.replace(/^v/, "");
        if (!best || isNewer(version, best))
            best = version;
    }
    return best;
}
/** `Would update <id>: A -> B.` (dry run) or `Updated <id>: A -> B.` in the host's output. */
export function hostUpdateLine(output, id, kind) {
    const word = kind === "would" ? "Would update" : "Updated";
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${word} ${escaped}: (\\S+) -> (\\S+?)\\.?\\s*$`, "m").exec(output);
    return match ? { from: match[1], to: match[2] } : null;
}
/** The version to announce now, if any: newer than the installed one and not announced before. */
export function toAnnounce(state) {
    if (!state?.ok || !state.latest || !state.installed)
        return null;
    if (!isNewer(state.latest, state.installed))
        return null;
    return state.announced.includes(state.latest) ? null : state.latest;
}
export const UPDATE_COMMAND = "/refine update";
export function availableText(version) {
    return `${BRAND} — update available: ${version}`;
}
/**
 * For a channel without buttons: the command to type, as Hermes' tap line. In code
 * formatting, so it can be copied whole: Telegram links only `/refine` of it.
 */
export function actionLine() {
    return `\`${UPDATE_COMMAND}\` — updates the plugin; no restart needed.`;
}
export function updatedText(version) {
    return `${BRAND} updated to ${version}.`;
}
export function upToDateText() {
    return `${BRAND} is up to date.`;
}
export function failedText(reason) {
    return `${BRAND} update failed. ${reason}`;
}
/** The last line of a failed host command that says something, for the one-line reason. */
export function failureReason(stdout, stderr) {
    const lines = `${stderr}\n${stdout}`
        .split("\n")
        .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim())
        .filter((line) => line && !/^\[plugins\]/.test(line) && !/manifest id .* differs from npm package name/.test(line));
    const pick = lines.find((line) => /error|fail|cannot|not found|denied|refus/i.test(line)) ?? lines[lines.length - 1] ?? "the host gave no reason";
    return pick.length > 200 ? `${pick.slice(0, 199)}…` : pick;
}
