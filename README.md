# Refine Cycle for OpenClaw

**Your agent keeps repeating the same mistake. This makes it stop.**

**Refine Cycle** watches your OpenClaw agent's tool failures across sessions. When the same failure comes back, it writes one short lesson and puts it in front of the agent from then on. Later, it records whether the failure came back.

**Cross-session by design.** An agent can make the same mistake in conversation after conversation: the same wrong date format, the same missing flag, the same command that never works on your machine. Refine Cycle remembers across conversations, so you stop explaining the same thing twice. A mistake the agent puts right by itself a moment later, in the same conversation, is left alone.

**Measured:** on two tasks the agent kept getting wrong, it got the tool call right **20%** of the time on its own and **90%** with the plugin's lesson. A placebo note of the same length scored **7.5%**.

[**Install on your OpenClaw →**](#install)

## A simple three-step loop

1. **Notice what keeps going wrong.** One failed call may be noise. The same failure in two sessions, or five times, is a pattern.
2. **Write the smallest useful lesson.** One sentence, such as *"When calling send_report, format the date as YYYY-MM-DD, such as 2026-09-25, rather than DD/MM/YYYY."* The model may also answer that there is nothing to learn, and often does.
3. **Check the result.** Each later session records which lessons it saw and whether the failure came back after it.

## You stay in control

- At most one model call per session and three a day, on the model and account your agent already uses. The plugin has no key of its own.
- `/refine list` shows every lesson; `/refine disable <id>` and `/refine delete <id>` take one away, and a lesson you took away is never learned again.
- It never edits your `AGENTS.md`, `SOUL.md`, skills or memory. Lessons live in the plugin's own folder.
- It does not filter your conversation or its lessons. The evidence for a lesson goes to the model your agent already uses, as your agent would send it; the lessons and the plugin's records stay on your machine.
- If a hook fails or the store is unreadable, your agent's turn goes on as if the plugin were not there, and the log says why.

## How it works

After each turn, the plugin reads the whole session from OpenClaw's history and turns each failed tool call into a fingerprint, so the same error with a different path, id or timestamp counts once. Most failures stop here, without a model call: they did not repeat, the agent fixed them straight away, they were a timeout, or the agent's own instructions and skills already cover them. A failure that gets through goes to the model with its evidence. A lesson the model writes must name the observed failure and the failing tool, fit in 200 characters, and not repeat a rule the agent already has. It is journaled before it becomes active, so a crash never leaves a half-written lesson. From the next prompt on, the agent's active lessons are placed ahead of its turn in a short, marked block.

Design, host contract and code layout: [docs/DESIGN.md](docs/DESIGN.md).

## What the testing shows

In a 120-session test on OpenClaw 2026.9.6 with GPT-6 Luna, the agent got the first tool call right in 36 of 40 sessions with the lesson, 8 of 40 with nothing, and 3 of 40 with a placebo note. The placebo did no better than nothing, so the gain comes from what the lesson says. The tasks were two test tools built to provoke one specific mistake each, so this shows that a correct lesson changes behaviour; how often the plugin finds one in real use is a separate number.

On 125 of the author's real coding-agent dialogs, replayed in order, the plugin sent 5 failures to the model and got 1 lesson back. That lesson was useful: it corrected an out-of-date example in the author's own instructions that had caused the same error twice. Method, limits and raw data: [docs/MEASUREMENT-2026-09-25.md](docs/MEASUREMENT-2026-09-25.md).

## Install

Tested on OpenClaw 2026.9.6 (2026.9.5 is supported), Node 24 or newer.

**1. Install the plugin.** OpenClaw asks you to trust the source and to accept what the plugin can do; review both, then:

```bash
openclaw plugins install git:github.com/Bergschloss/Refine-Cycle-for-OpenClaw --accept-capabilities
```

**2. Let it see your sessions.** OpenClaw gives a plugin your conversation only when you allow it. Without this, Refine Cycle stays idle and says so in the log.

```bash
openclaw config set plugins.entries.refine-cycle.hooks.allowConversationAccess true
```

**3. Restart the gateway**, so the plugin loads.

```bash
openclaw gateway restart
```

**4. Check it.** It answers "No lessons yet." until a failure has repeated.

```bash
openclaw refine-cycle list
```

## Commands

| In chat | On the command line | |
|---|---|---|
| `/refine list` | `openclaw refine-cycle list` | Lessons and their status |
| `/refine disable <id>` | `openclaw refine-cycle disable <id>` | Stop showing a lesson |
| `/refine delete <id>` | `openclaw refine-cycle delete <id>` | Delete a lesson (kept as a tombstone) |
| `/refine report` | `openclaw refine-cycle report` | What the loop decided, by rule |

In chat, the commands see only the lessons of the agent you are talking to.

## Settings

Under `plugins.entries.refine-cycle.config` in `openclaw.json`. All are optional.

| Setting | Default | |
|---|---|---|
| `injectEnabled` | `true` | Show active lessons to the agent |
| `learnEnabled` | `true` | Look for repeated failures and write lessons |
| `maxModelCallsPerDay` | `3` | Model calls for writing lessons, per day |
| `minSessions` / `minOccurrences` | `2` / `5` | How often a failure must repeat (either one) |
| `maxInjectedChars` | `1000` | Size of the lessons block in the prompt |
| `maxLessonChars` | `200` | Longest lesson accepted |
| `instructionFiles` | `AGENTS.md`, `TOOLS.md`, `SOUL.md` | Files checked so a lesson never repeats a rule you already wrote |

## Documentation

| | |
|---|---|
| [DESIGN.md](docs/DESIGN.md) | How it works inside, the OpenClaw host contract, code layout |
| [MEASUREMENT-2026-09-25.md](docs/MEASUREMENT-2026-09-25.md) | The placebo-controlled test and the real-dialog replay, with raw data |
| [MILESTONE-1.md](docs/MILESTONE-1.md) | What the first version set out to do |

The idea and its first measurement come from [Refine Cycle for Hermes Agent](https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent), which adapts the `/refine` concept from [Prime Intellect's Prime Agent](https://www.primeintellect.ai/blog/prime-agent).

## License

MIT © 2026 Taras Boiko
