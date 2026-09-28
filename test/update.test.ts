import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDue, failureReason, hostUpdateLine, isNewer, latestTag, toAnnounce, availableText, updatedText, upToDateText, failedText } from "../src/core/update.ts";

const NOW = new Date("2026-09-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

test("the check runs at most once a day, and an hour after a failed one", () => {
  assert.equal(checkDue(undefined, NOW), true);
  assert.equal(checkDue({ announced: [], checkedAt: ago(23 * 3600e3), ok: true }, NOW), false);
  assert.equal(checkDue({ announced: [], checkedAt: ago(24 * 3600e3), ok: true }, NOW), true);
  assert.equal(checkDue({ announced: [], checkedAt: ago(59 * 60e3), ok: false }, NOW), false);
  assert.equal(checkDue({ announced: [], checkedAt: ago(60 * 60e3), ok: false }, NOW), true);
  assert.equal(checkDue({ announced: [], checkedAt: new Date(NOW.getTime() + 3600e3).toISOString(), ok: true }, NOW), true, "a clock that went back does not block it");
});

test("each new version is announced once, and only a newer release", () => {
  const state = { announced: [] as string[], ok: true, installed: "0.1.0", latest: "0.2.0" };
  assert.equal(toAnnounce(state), "0.2.0");
  assert.equal(toAnnounce({ ...state, announced: ["0.2.0"] }), null);
  assert.equal(toAnnounce({ ...state, latest: "0.1.0" }), null);
  assert.equal(toAnnounce({ ...state, ok: false }), null);
  assert.equal(toAnnounce({ ...state, latest: null }), null);
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("1.0.0-beta.1", "0.9.0"), false, "a pre-release is not a release");
});

test("the newest release tag, and the host's update lines, are read exactly", () => {
  const tags = "aaa\trefs/tags/v0.1.0\nbbb\trefs/tags/v0.10.0\nccc\trefs/tags/v0.9.0\nddd\trefs/tags/nightly\neee\trefs/tags/v0.11.0-rc.1\n";
  assert.equal(latestTag(tags), "0.10.0");
  assert.equal(latestTag(""), null);
  assert.deepEqual(hostUpdateLine("Cloning…\nWould update refine-cycle: 0.1.0 -> 0.2.0.\n", "refine-cycle", "would"), { from: "0.1.0", to: "0.2.0" });
  assert.deepEqual(hostUpdateLine("Updated refine-cycle: 0.1.0 -> 0.2.0.\nUpdates saved", "refine-cycle", "updated"), { from: "0.1.0", to: "0.2.0" });
  assert.equal(hostUpdateLine("Updated other-plugin: 1.0.0 -> 2.0.0.", "refine-cycle", "updated"), null);
});

test("the messages are the owner's words", () => {
  assert.equal(availableText("0.2.0"), "♾️ Refine Cycle — update available: 0.2.0");
  assert.equal(updatedText("0.2.0"), "♾️ Refine Cycle updated to 0.2.0.");
  assert.equal(upToDateText(), "♾️ Refine Cycle is up to date.");
  assert.equal(failedText("no network"), "♾️ Refine Cycle update failed. no network");
  assert.equal(failureReason("Cloning x\n", "\x1b[31mError: git clone failed: could not resolve host\x1b[0m\n"), "Error: git clone failed: could not resolve host");
});
