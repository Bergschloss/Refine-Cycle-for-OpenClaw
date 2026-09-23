# Milestone 1: the loop, end to end, measurable

The smallest version that runs on a real OpenClaw and answers one question with a number: **in these sessions, is there a lesson worth writing, and does it help?**

Budget: 10–15 person-days. Nothing from the "not built" list in the README goes in.

## Decisions already made (by the spike, 2026-09-22; do not reopen)

| Need | Use | Evidence |
|---|---|---|
| Put a lesson in front of the model | `api.on("before_prompt_build", …)` returning `{ prependContext }`; the plugin declares `hooks.allowPromptInjection: true` | [spike report](spike-2026-09-22/REPORT.md), gate 1 |
| Read past sessions | Read the host's SQLite **directly, read-only** (`agents/<agentId>/agent/openclaw-agent.sqlite`, table `transcript_events`). **Not** `api.runtime.subagent.getSessionMessages` — it only works inside a Gateway request | gate 2 |
| Call the model | `api.runtime.llm.complete({ messages, purpose })` — the user's route, no key of the plugin's own | gate 3 |
| Know a session ended | `agent_end` (rows are already committed when it fires); `session_end` for resets | gate 4 |
| Plugin's own durable store | **A plugin-private file store** under the plugin's state directory, written atomically (temp file + rename). **Not** `api.runtime.state.openKeyedStore`: OpenClaw only allows that for bundled or trusted-official plugins (`assertTrustedPluginRuntime` → `PluginTrustRefusalError`), which a ClawHub plugin is not | architecture §3 |
| Host patch | None, anywhere | — |

## What to build

1. **Plugin skeleton.** TypeScript ESM, `openclaw.plugin.json` manifest, `openclaw.compat.pluginApi` and `install.minHostVersion` set to the version the spike ran on (OpenClaw 2026.9.5). The manifest declares prompt injection.
2. **Store v1.** Record families: `meta`, `config`, `budget/<day>`, `failures`, `candidates`, `lessons`, `journal`, `effects`. Every record carries `$v`. Atomic writes. An unreadable store means: inject nothing, learn nothing, and say so in the log. Never crash the turn.
3. **Injection.** `before_prompt_build` reads active lessons only, formats one bounded block, and returns `prependContext`. In this hook: no model calls, no history reads, no writes, and a short timeout; on any error return nothing. The size cap is a setting (default 1,000 characters). The block is marked clearly as coming from this plugin.
4. **Ingest on `agent_end`.** Hand the session id to background work and return at once. The background worker reads the **whole** session from SQLite, not the newest rows.
5. **Failure fingerprint.** Port `normalize_error` and `fingerprint` from the Hermes plugin (`patterns.py`) to TypeScript, and port its tests with it. Fingerprint = hash of `tool | normalized error`, 12 characters. Keep session, message and tool-call ids next to it, so every lesson traces back to real rows.
6. **Cheap refusals, before any model call.**
   - The session was already processed.
   - The failure is below the recurrence bar: `sessions_seen >= 2` or `count >= 5` (configurable).
   - The error was self-corrected in the same session.
   - The failure is not lesson-shaped: the agent dropped an argument it had already used, or chose the wrong tool, or hit a transient error.
   - An active lesson already covers it.
   - The day budget is spent.
7. **Already-covered check, before the model.** Search the agent's skills and instruction files the plugin can read, and the active lessons, for the rule. If it is there, record where and do not propose. This is the check the Hermes plugin never had, and its absence is why its survivors were restatements.
8. **One proposal call per session, at most 3 a day**, both counted in the durable budget *before* the call. The model may answer `nothing`, which is a normal outcome. The schema requires the observed fingerprint.
9. **Validation.** Refuse a lesson with no observed fingerprint, a lesson over the length limit, a duplicate, or a restatement.
10. **Apply through the journal.** Write the intent, then an inactive draft, then activate, then mark. A record cut short by a crash is skipped on read and never stops the plugin.
11. **Controls.** List lessons, disable one, delete one — through whatever the host offers for plugin commands; if nothing, through a small CLI entry point.
12. **Effect ledger.** Record exposure per session (which lessons were injected, a hash of the block) and later recurrence of the fingerprint. The frozen grader `lesson_effect_checker.py` (Python, pinned by SHA-256) is run by the measurement harness, not by the runtime plugin.

## Tests

- Host-independent: fingerprinting (ported from Hermes, same cases, same expected outputs), refusals, budget, journal and crash recovery, validation, injection formatting and size cap.
- Against a real OpenClaw: a probe like the spike's, run in CI or by hand. A lesson is written, the process restarts, and the next session's model sees it.
- A fake-host drift check: whatever the unit tests fake about OpenClaw (hook payloads, SQLite schema, the llm API shape) is compared against a real install. A drifted fake host is how the Hermes plugin once shipped a broken rollback.

## Done means

1. On a real OpenClaw (the spike's install on the server is fine; everything stays in `~/openclaw-spike/`, and the Hermes bot there is never touched):
   - seed sessions with a repeated failure;
   - the plugin detects it, refuses what it should, proposes at most one lesson, journals and activates it;
   - the next session's model receives it.
2. A deliberate crash at each write point leaves the plugin working.
3. A hook error or a slow store never breaks the user's turn.
4. **The number:** run the plugin over a set of real or realistic sessions and report how many produced a lesson, how many were refused and why (by rule), and how many survivors are *not* restatements. This is the question the Hermes plugin answered with 0 of 33; the milestone exists to answer it here.

No publishing to ClawHub yet.
