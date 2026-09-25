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
- **Crash safety.** Write the record, apply, then mark. A record a crash cut short must not stop the plugin for good.
- **Every change reversible.** Disabling and deleting keep a tombstone; nothing the user took away comes back.
- **No content filter on lessons.** A lesson may carry a URL, a command or a credential name if the model saw it; there is no scrubber and no URL ban. This is the owner's decision, carried over from the Hermes plugin, where those filters were removed because they cost valid lessons and protected nothing. What the plugin refuses is structural: markup that could close the injected block, a lesson that does not name the failing tool, and unobserved fingerprints.

## What is deliberately not built

The Hermes version carries an installer, a patch to eight host files, a self-update path, a Fix command, a host restart, a desktop status bar and unsolicited chat messages. Every one of those exists because that host made it necessary. OpenClaw installs plugins through its own CLI, refuses an incompatible one instead of crashing, and needs no patch, so none of that is here.

## How lessons reach the agent

Through `before_prompt_build`, which prepends a bounded block of the agent's active lessons to the prompt. No exclusive slot is taken: the user's memory plugin and context engine stay theirs. The plugin keeps lessons in its own store and never edits `AGENTS.md`, `SOUL.md` or any other file the user owns.

## Host contract (OpenClaw 2026.9.5–2026.9.6)

- `before_prompt_build` and `agent_end` reach a non-bundled plugin only with `plugins.entries.<id>.hooks.allowConversationAccess: true`. Prompt changes apply unless `allowPromptInjection` is `false`.
- `agent_end` runs inside an async work scope the host closes when the hook returns. Background work is started outside that scope (`runOutsideHostWorkScope` in `src/plugin.ts`), the way the host's own `runOutsideAsyncWorkScope` does; otherwise the model call fails with "Async work scope is closed".
- The model call is `api.runtime.llm.complete` on the agent's own route, without `agentId` (naming the agent is an override the host refuses).
- History is read straight from the agent's SQLite (`transcript_events`), read-only. From 2026.9.6 large events are zstd-compressed in `event_zstd`.
- A plugin is installed from git or npm only as compiled JavaScript, so `dist/` is committed and `package.json` points at `dist/plugin.js`.
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
