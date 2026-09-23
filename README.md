# Refine Cycle for OpenClaw

An OpenClaw plugin that learns from the agent's own repeated failures: it looks across past sessions, finds the mistakes that keep coming back, writes one small lesson, puts that lesson in front of the agent in later sessions, and afterwards checks whether the failure stopped.

Private, and not yet built. This repository currently holds the design and the research it rests on.

## Where this comes from

There is a working version of this idea for another agent, [Refine Cycle for Hermes Agent](https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent): 23k lines of Python, 1,278 tests, and a pre-registered measurement with placebo controls — with a lesson the agent handled the repeated mistake correctly 66 times out of 131, without it 28 out of 133, and two placebo notes scored 28 and 30. The result was reproduced on 2026-09-20 on a current model: 65/130 against 29/130.

This is not a port. OpenClaw takes TypeScript plugins, so the code is new. What carries over is the loop, the measurement, and what the Hermes version cost us to learn.

## What carries over

- **Count failures over the whole session.** Reading only the newest rows hid the first failure in 58% of repeated-failure groups, and in 95% of sessions longer than 300 rows.
- **A lesson with no observed repeated failure behind it is worthless**, and must be refused.
- **Most repeats cannot be fixed by a lesson**: roughly 46% are knowledge gaps, 37% a wrong tool choice, 6% the agent dropping an argument it had already used. Saying "nothing to write here" has to be cheap and common.
- **The restatement trap.** Lessons that survive usually repeat what the agent's own skills already say. On a real corpus: 0 useful lessons out of 33 candidate sessions. Check what exists before proposing.
- **Cheap refusals before expensive ones.** Everything that can refuse without a model call runs first.
- **Crash safety.** Write the record, apply, then mark. A record a crash cut short must not stop the plugin for good.
- **Every change reversible.**
- **The grader stays frozen.** `lesson_effect_checker.py` decides whether a lesson helped, deterministically and without a model. It is pinned by hash, because the published result was measured with it.

## What is deliberately not built

The Hermes version carries an installer, a patch to eight host files, a self-update path, a Fix command, a host restart, a desktop status bar and unsolicited chat messages. Every one of those exists because that host made it necessary. OpenClaw installs plugins from its own registry, refuses an incompatible one instead of crashing, and needs no patch — so none of that is here.

## How lessons reach the agent

Through `before_prompt_build`, which prepends a bounded block of active lessons to the prompt. No exclusive slot is taken: the user's memory plugin and context engine stay theirs. The plugin keeps lessons in its own durable store and never edits `AGENTS.md`, `SOUL.md` or any other file the user owns.

## The spike says yes

On 2026-09-22 a probe plugin was built and run against OpenClaw 2026.9.5 with a local model. All four things the design depends on work, and none of them needs a patch to the host ([the report](docs/spike-2026-09-22/REPORT.md), [the probe](docs/spike-2026-09-22/probe-plugin)):

- **A lesson reaches the model.** `before_prompt_build` returning `prependContext` put a token in front of the model in a fresh session, after the whole process was killed and restarted, with no user action. The host ignores prompt changes unless the plugin declares `allowPromptInjection`, which is the right kind of gate: the user grants it at install.
- **Past sessions are readable.** Transcripts and tool outcomes live in SQLite (`transcript_events`) and can be read across sessions.
- **The model can be called from the plugin** on the user's own route and budget: `api.runtime.llm.complete`, no key of the plugin's own.
- **`agent_end` fires with the rows already written**, so a session can be analysed the moment it ends.

Also measured: a 10 KB injected block passed without complaint, a hook that throws does not break the user's turn, and two plugins prepending context are concatenated rather than fighting.

Two corrections to the design came out of it: read history straight from SQLite rather than through the request-scoped runtime API, and declare `allowPromptInjection` from the start.

## Status

| | |
|---|---|
| Spike | done, all four gates pass — [docs/spike-2026-09-22/](docs/spike-2026-09-22) |
| Design | [docs/ARCHITECTURE-DRAFT-2026-09-22.md](docs/ARCHITECTURE-DRAFT-2026-09-22.md), to be revised with the two corrections |
| Can a plugin inject lessons at all | [docs/RESEARCH-lesson-injection.md](docs/RESEARCH-lesson-injection.md) |
| Port or rebuild | [docs/RESEARCH-port-feasibility.md](docs/RESEARCH-port-feasibility.md) |
| Code | none yet |

Next: [the first milestone](docs/MILESTONE-1.md) — the loop end to end on one host, measurable, with nothing from the "not built" list above.
