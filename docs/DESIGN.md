# Design notes

For people who work on the plugin. Users start at the [README](../README.md).

## Where this comes from

The same idea runs as [Refine Cycle for Hermes Agent](https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent): a pre-registered measurement with placebo controls, where with a lesson the agent handled the repeated mistake correctly 66 times out of 131, without it 28 out of 133, and two placebo notes scored 28 and 30.

This is not a port. OpenClaw takes TypeScript plugins, so the code is new. What carries over is the loop, the measurement, and what the Hermes version cost to learn. The one piece carried over line for line is the error fingerprint (`src/core/fingerprint.ts`), which must give the same identity as the Python original; a 382-row golden corpus recorded from it pins that.

## What carries over

- **Count failures over the whole session.** Reading only the newest rows hid the first failure in 58% of repeated-failure groups, and in 95% of sessions longer than 300 rows.
- **A lesson with no observed repeated failure behind it is worthless**, and is refused.
- **Most repeats cannot be fixed by a lesson**: roughly 46% are knowledge gaps, 37% a wrong tool choice, 6% the agent dropping an argument it had already used. Saying "nothing to write here" has to be cheap and common.
- **The restatement trap.** Lessons that survive usually repeat what the agent's own skills already say. The plugin checks the agent's instructions and skills before and after the model call.
- **Cheap refusals before expensive ones.** Everything that can refuse without a model call runs first.
- **A failure that repeats across sessions is never lost to self-correction** (owner decision, 2026-09-26). The agent fixing the call a moment later, every time, is the case the plugin exists for; the successful follow-up call (`correctionArgs` in the session summary) is shown to the model as the agent's own fix. Only a failure seen in one session, fewer than `minOccurrences` times and fixed each time is refused as `self_corrected`, and with the default bar it is already `below_bar`.
- **No failure is lost to the one-call slot** (owner decision, 2026-09-28). Each session still gets one call and the day three. A session with no eligible failure of its own spends its call on the oldest eligible failure of the same agent the model never answered (`fromQueue` in `src/pipeline.ts`). A call reserved writes `proposed/<agent>--<fingerprint>.json` under the budget lock; the answer (`lesson`, `nothing`, `invalid`, `error`) is added after the call. A failure whose call ended in an error, or was cut short by a crash, has no answer and stays in the queue. On the 125-dialog replay (stub model, 2026-09-28) the queue brought 12 of the 13 failures K1 found crowded out to the model; the thirteenth already reached it since `d7b0831`.
- **A command that times out every time is a lesson** (owner decision, 2026-09-28). A tool's own command timeout ("Command timed out after …", `OWN_COMMAND_TIMEOUT` in `src/core/failures.ts`) is not `transient` when, in every session, no run of the very same command text succeeded (`commandTimesOut`). Rate limits, network errors and remote timeouts ("request timed out", "connection timed out") stay transient. A command the history kept no text for never counts as "the same", the lean the command comparison always takes.
- **A 7-day pause after "nothing"** (owner decision, 2026-09-28). When the model answered "nothing" for a failure, it is refused as `paused_after_nothing` for 7 days (`pausedUntil` in `src/pipeline.ts`), unless it has since been seen in a session it had not been seen in when the model answered: new evidence ends the pause. A call that ended in an error gave no answer and pauses nothing.
- **Crash safety.** Write the record, apply, then mark. A record a crash cut short must not stop the plugin for good.
- **Every change reversible.** Disabling and deleting keep a tombstone; nothing the user took away comes back.
- **No content filter on lessons.** A lesson may carry a URL, a command or a credential name if the model saw it; there is no scrubber and no URL ban. This is the owner's decision, carried over from the Hermes plugin, where those filters were removed because they cost valid lessons and protected nothing. What the plugin refuses is structural: markup that could close the injected block, a lesson that does not name the failing tool, and unobserved fingerprints.

## Passes started by hand

`/refine run [reason]`, `/refine session <id> [reason]` and `/refine dry-run [session <id>] [reason]` (and `session`, `dry-run` on the command line) run the same `processSession` as the automatic pass, queued behind it in the same process and started outside the host's work scope. Every rule and the budget apply unchanged: a session that already had its call answers that it did, and the day's cap counts a hand-started pass like any other. The reason reaches the model as the user's words inside `<untrusted_tool_result>`, as Hermes passes it as untrusted run context. A dry run spends the call, runs the validation, records `dry_run` with the lesson and whether it would be saved, and saves nothing; its lesson does not count as the failure's answer, so the queue may still offer it. Hermes counts a dry run against its daily model runs and not its edits; here there is one counter, and a model call is a model call. In chat the command waits up to 10 s for the pass, then answers that it started and sends the result to the chat the agent is talked to from (the lesson message's target); the command line waits for the whole pass.
## The audit

`/refine audit` gives each lesson a verdict with the Hermes plugin's vocabulary and rules (`ledger.py` `audit()`), from a durable record per lesson (`ledger/<lesson>.json`): each session it was shown in, and how often its failure came back there after it was shown (or came with no time to place it). Rules, first match wins: deleted is `rolled back`, disabled is `disabled`; no session of the agent ended since it was learned is `no recurrence window`; its failure came back after it was shown is `did not help`; failures that could not be placed make it `unreliable`; never shown is `unused` after 14 days, `too early` before; shown and quiet is `working` after 3 days (Hermes' recurrence horizon), `too early` before. `churning`, `unverified fingerprint` and `unclear` cannot happen here and are left out (`src/core/audit.ts` says why). `unused` and `did not help` are listed as candidates for removal; nothing is deleted. `working` means the failure has not come back while the lesson was shown, not that its situation came up: the same limit as the Hermes verdict for memory lessons.
## What is deliberately not built

The Hermes version carries an installer, a patch to eight host files, a self-update path, a Fix command, a host restart, a desktop status bar and unsolicited chat messages. Every one of those exists because that host made it necessary. OpenClaw installs plugins through its own CLI, refuses an incompatible one instead of crashing, and needs no patch, so none of that is here.

## The loop

![How the Refine Cycle plugin works on OpenClaw: a session ends, repeated failures are found across sessions, the gate opens only on recurrence, one lesson is proposed, safety checks run, the lesson is journaled and then shown to the agent, and it is checked later, with three exits where the plugin stops, rejects, or you turn the lesson off](media/refine-cycle.gif)

## How lessons reach the agent

Through `before_prompt_build`, which prepends a marked block of the agent's active lessons to the prompt. Every active lesson is in it, whole: `maxInjectedChars` (4400, the Hermes memory limit's number, owner decision 2026-09-28) is a soft limit. Nothing is left out for size; the lesson message says `getting tight` from 90% of it and `over the soft limit` past it, and the log says so once when the block passes it. At the limit the block adds about 4,400 characters, roughly 1,100 tokens, to every prompt: about 20 lessons of the longest allowed length (200 characters) or 40 like the two live ones (384 characters for both). No exclusive slot is taken: the user's memory plugin and context engine stay theirs. The plugin keeps lessons in its own store and never edits `AGENTS.md`, `SOUL.md` or any other file the user owns.

## Host contract (OpenClaw 2026.9.5–2026.9.6)

- `before_prompt_build` and `agent_end` reach a non-bundled plugin only with `plugins.entries.<id>.hooks.allowConversationAccess: true`. Prompt changes apply unless `allowPromptInjection` is `false`.
- `agent_end` runs inside an async work scope the host closes when the hook returns. Background work is started outside that scope (`runOutsideHostWorkScope` in `src/plugin.ts`), the way the host's own `runOutsideAsyncWorkScope` does; otherwise the model call fails with "Async work scope is closed".
- A chat command's context carries `agentId` (the host's agent for the command's session) and `sessionKey`; `agentId` is absent when the command has no session (checked in the 2026.9.6 type definitions). `/refine` then reads the agent from an `agent:<id>:…` session key, and otherwise refuses rather than guess.
- The model call is `api.runtime.llm.complete` without `agentId` (naming the agent is an override the host refuses). It runs outside the turn's work scope, so no session agent is bound to it and the host resolves the ambient owner agent (`resolveAmbientOwnerAgentId`, `src/plugins/runtime/runtime-llm.runtime.ts`, 2026.9.5 source): every agent's lessons are written by the default agent's model and account. Read in the source on 2026-09-27; not observed with two different models, since that run could use only one.
- A turn that came from a channel carries `channel`, `accountId` and `chatId` in the `agent_end` context (2026.9.6 type definitions). A new lesson is told in one plain line in that chat (or the last chat the agent was talked to from, kept in `chats/<agent>.json`) through `api.runtime.channel.outbound.loadAdapter(channel).sendText({ cfg, to: chatId, text, accountId })`; `api.runtime.gateway.request` is closed to plugins that are not bundled or trusted-official (checked live on 2026.9.6, 2026-09-27).
- History is read straight from the agent's SQLite (`transcript_events`), read-only. From 2026.9.6 large events are zstd-compressed in `event_zstd`. A session is read in slices by `seq > ?`, which relies on `PRIMARY KEY (session_id, seq)`: read from the live 2026.9.6 schema and the 2026.9.2 and 2026.9.3 fixtures on 2026-09-27.
- A plugin is installed from git or npm only as compiled JavaScript, so `dist/` is committed and `package.json` points at `dist/plugin.js`.
- OpenClaw 2026.9.6 declares `engines.node` `>=24.16.0 <25 || >=26.1.0`; the plugin runs in its process and declares the same. A fresh `plugins install git:…` asks `[y/N]` on a terminal and cancels without one unless `--force` is given; `allowConversationAccess` is hot-reloaded by a running gateway (checked on a fresh 2026.9.6 install, 2026-09-27).
- Root CLI commands must be listed in the manifest's `cliCommands`; in the `cli-metadata` registration pass the runtime is unavailable, and the plugin returns at once. The host runs the command from the full registration: `openclaw refine-cycle list` and `report` were checked on 2026.9.6 with this return in place (2026-09-26).

`scripts/drift-check.ts` compares what the tests assume about the host with a live install.

## Layout

- `src/plugin.ts`: the only file that knows OpenClaw. Hooks, the background queue, `/refine` and `openclaw refine-cycle`.
- `src/pipeline.ts`: the learning loop for one ended turn, host-independent.
- `src/core/`: pure functions. The fingerprint, failure extraction, the refusal rules, the already-covered check, the injected block, the proposal and its validation.
- `src/store.ts`, `src/lessons.ts`: atomic JSON files with `$v`, a cross-process lock, and the journal that makes lesson changes crash-safe.
- `src/host/`: reading the agent's SQLite history and its skills and instruction files.
- `src/replay.ts`: the measurement harness, `openclaw refine-cycle replay`.
- `dist/`: the compiled plugin OpenClaw loads. Rebuild with `npm run build` after changing `src/`; a test compiles `src/` and fails if `dist/` differs.

The plugin has no runtime dependencies. For development, `npm install` brings TypeScript and Node's types; then `npm test`, `npm run typecheck` and `npm run build`, on Node 24+.

## Research behind it

| | |
|---|---|
| The spike: does the host allow it at all | [spike-2026-09-22/](spike-2026-09-22) |
| First architecture | [ARCHITECTURE-DRAFT-2026-09-22.md](ARCHITECTURE-DRAFT-2026-09-22.md) |
| Can a plugin inject lessons | [RESEARCH-lesson-injection.md](RESEARCH-lesson-injection.md) |
| Port or rebuild | [RESEARCH-port-feasibility.md](RESEARCH-port-feasibility.md) |
| The first milestone | [MILESTONE-1.md](MILESTONE-1.md) |
| Measurement | [MEASUREMENT-2026-09-25.md](MEASUREMENT-2026-09-25.md) |
