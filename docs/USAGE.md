# Using Refine Cycle for OpenClaw

Everything the [README](../README.md) leaves out: every command, every setting, the messages, and the rules the plugin follows. Design and host contract: [DESIGN.md](DESIGN.md).

## Install, in detail

Tested on OpenClaw 2026.9.6 (2026.9.5 is supported). The plugin runs inside OpenClaw, so it needs what OpenClaw itself needs: Node 24.16+ or 26.1+.

**1. Install the plugin.** OpenClaw warns that a git source is outside ClawHub review and asks `Install this non-ClawHub plugin source? [y/N]`; review the source, then answer `y`. `--accept-capabilities` accepts what the plugin declares it can do. In a script, with no terminal to answer the question, add `--force` after reviewing the source.

```bash
openclaw plugins install git:github.com/Bergschloss/Refine-Cycle-for-OpenClaw --accept-capabilities
```

Once the plugin is published on ClawHub (not yet), it will also install from there, with ClawHub's review and provenance instead of the git warning:

```bash
openclaw plugins install clawhub:refine-cycle-openclaw --accept-capabilities
```

**2. Let it see your sessions.** OpenClaw gives a plugin your conversation only when you allow it. Without this, Refine Cycle stays idle and says so in the log. A running gateway picks this setting up without a restart.

```bash
openclaw config set plugins.entries.refine-cycle.hooks.allowConversationAccess true
```

**3. Restart the gateway**, so it loads the newly installed plugin. `openclaw gateway restart` restarts a gateway installed as a service; a gateway you started by hand (`openclaw gateway run`) you stop and start again yourself.

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
| `/refine list` | `openclaw refine-cycle list` | Lessons and their status, and today's model calls against the daily cap |
| `/refine status` | `openclaw refine-cycle status` | Whether learning and injection work and what blocks them, the model, calls used today, the block's size against its soft limit, the queue, the journal (`--json` on the command line) |
| `/refine disable <id>` | `openclaw refine-cycle disable <id>` | Stop showing a lesson |
| `/refine delete <id>` | `openclaw refine-cycle delete <id>` | Delete a lesson (kept as a tombstone) |
| `/refine rollback <id>` | `openclaw refine-cycle rollback <id>` | The same as `delete`, under the Hermes plugin's name; `/refine audit` offers it for lessons that did not help or were never used |
| `/refine audit` | `openclaw refine-cycle audit` | Did each lesson help: a verdict per lesson (`working`, `did not help`, `unused`, `too early`, `no recurrence window`, `unreliable`), from the sessions it was shown in and whether its failure came back after (`working` only after at least 3 sessions that showed it with no recurrence); it lists the ones worth removing and deletes nothing |
| `/refine run [reason]` | — | A learning pass over this chat's session now, with an optional focus for the model; the same budget and rules as the automatic pass (the command line has no current session) |
| `/refine session <id> [reason]` | `openclaw refine-cycle session <id> [reason]` | The same, over one exact past session |
| `/refine dry-run [session <id>] [reason]` | `openclaw refine-cycle dry-run session <id> [reason]` | Propose and check a lesson and show it, save nothing; it spends the session's call and one of the day's, as any pass does |
| `/refine model [auto \| <provider>/<model>]` | `openclaw refine-cycle model [value]` | Show or choose the model lessons are written with; `auto` goes back to the default agent's. OpenClaw sends it only when you allow it: `plugins.entries.refine-cycle.llm.allowModelOverride: true` |
| `/refine update` | `openclaw refine-cycle update` | Update the plugin with OpenClaw's own `plugins update`, with no restart; only senders on the channel's allowlist; a plugin loaded from a directory is not updated |
| `/refine report` | `openclaw refine-cycle report` | What the loop decided and why, in words, with today's model calls against the daily cap (`--json` on the command line for the numbers) |

**The `refine_run` tool.** As in the Hermes plugin, the agent itself can ask for a pass over its own failures, with an optional `reason`, `session_id` and `dry_run`. It answers at once and the pass runs in the background under the same limits, so the agent's turn never waits for the model. It is an optional tool: OpenClaw shows it to the agent only when you add `refine_run` to `tools.alsoAllow` in `openclaw.json` (keep the entries already there), because each pass may spend one of the day's model calls.

A pass started in chat answers within a few seconds; when the model takes longer, the answer says so and the result follows in the chat you talk from. In chat, the commands see only the lessons of the agent you are talking to. On the command line they see every agent, and `list` says whose each lesson is; a command that did not do what was asked (an unknown id, a busy store) exits with status 1.

## Settings

Under `plugins.entries.refine-cycle.config` in `openclaw.json`. All are optional. Three switches that OpenClaw itself reads sit one level up, under `plugins.entries.refine-cycle`: `hooks.allowConversationAccess` (required, see Install), `hooks.allowPromptInjection` (lessons are shown unless it is `false`) and `llm.allowModelOverride` (lets `/refine model` and `model` take effect).

| Setting | Default | |
|---|---|---|
| `injectEnabled` | `true` | Show active lessons to the agent |
| `learnEnabled` | `true` | Look for repeated failures and write lessons |
| `maxModelCallsPerDay` | `3` | Model calls for writing lessons, per day |
| `minSessions` / `minOccurrences` | `2` / `5` | How often a failure must repeat (either one) |
| `maxInjectedChars` | `4400` | Soft limit of the lessons block in the prompt, in characters: every active lesson is still shown; the lesson message warns near and past it |
| `maxLessonChars` | `200` | Longest lesson accepted; the model is asked for about 120 |
| `instructionFiles` | `AGENTS.md`, `TOOLS.md`, `SOUL.md` | Files checked so a lesson never repeats a rule you already wrote |
| `notifyOnLesson` | `true` | One line in your chat when a new lesson is learned |
| `model` | `""` | The model lessons are written with, as `provider/model`; empty for the default agent's (needs `llm.allowModelOverride`, above) |
| `checkForUpdates` | `true` | Once a day, look for a newer release and tell you once, with an Update button |
| `backfillSessions` / `backfillIntervalMinutes` | `10` / `60` | Recent sessions re-read, at most this often, so failures from before an install or a restart still count |
| `proposalTimeoutMs` | `120000` | How long the model may take for one lesson |
| `skillDirs` | none | Extra directories searched for `SKILL.md`, besides the workspace's `skills/` |
| `historyDbPath` | `""` | The agent's history database, for a single-agent install that keeps it somewhere else |
| `enabled` | `true` | `false` turns the whole plugin off |

## What it promises, and the messages it sends

- At most one model call per session and three a day, on the model and account OpenClaw uses for your default agent, or on a model you choose with `/refine model` if you let OpenClaw allow that. The plugin has no key of its own.
- `/refine list` shows your lessons and their status, and `/refine audit` whether each one helped; `/refine disable <id>` and `/refine delete <id>` take one away, and a lesson you took away is never learned again.
- It never edits your `AGENTS.md`, `SOUL.md`, skills or memory. Lessons live in the plugin's own folder.
- It does not filter your conversation or its lessons. The evidence for a lesson (the failing call's error and arguments, and the call that fixed it) goes to that model, as your agent would send it; the lessons and the plugin's records, which keep short excerpts of failed calls, stay in its folder on your machine. With several agents, the evidence from every agent goes to the default agent's model: OpenClaw does not let a plugin's background call choose the agent.
- When it learns a lesson, it sends one line, such as "♾️ Refine Cycle — new lesson learned (412/4400)", to the chat you are talking from (or the last one you talked from, when the turn came from a cron job or the command line). The numbers are how many characters your active lessons take in the prompt, against a soft limit of 4400; it says `getting tight` from 90%, and past it `over the soft limit: every turn now costs more tokens; /refine audit shows which lessons to turn off`. Every active lesson is still shown: the limit is a warning, not a cut. `notifyOnLesson: false` turns this off. The only other message it sends by itself is "♾️ Refine Cycle — update available: <version>", once per new release, with an **Update** button (on a channel without buttons, the command to type); pressing it runs `/refine update`, which answers "updated to <version>", "is up to date" or "update failed" with the reason. `checkForUpdates: false` turns that off.
- If a hook fails or the store is unreadable, your agent's turn goes on as if the plugin were not there, and the log says why.

## The rules, step by step

After each turn, the plugin reads the whole session from OpenClaw's history and turns each failed tool call into a fingerprint, so the same error with a different path, id or timestamp counts once. Most failures stop here, without a model call: they did not repeat, they were a network timeout or an outage, or the agent's own instructions and skills already cover them. A command that hits the tool's own time limit every time it runs is not an outage, and does get a lesson. A failure that gets through goes to the model with its evidence; when the agent fixed the call itself, the call that then succeeded is part of that evidence. A session gets one model call at most; a session with no failure of its own worth it spends its call on the oldest failure that passed every check but never reached the model (or came back in a new session since the model answered it), so a failure crowded out by another one in its own session is not lost. When the model finds nothing to learn from a failure, it is not asked about it again for 7 days, unless the failure comes back in a new session. A lesson the model writes must name the observed failure and the failing tool, and not repeat a rule the agent already has. The model is asked for about 120 characters; a lesson over the 200-character limit gets one request to say the same thing shorter, keeping the situation, the steps and the tool, and is refused only if it cannot be. That request is a second model call, made only while the day's budget has room. It is journaled before it becomes active, so a crash never leaves a half-written lesson. From the next prompt on, the agent's active lessons are placed ahead of its turn in a short, marked block.

## What the testing shows, in full

In a 120-session test on OpenClaw 2026.9.6 with GPT-6 Luna, the agent got the first tool call right in 36 of 40 sessions with the lesson, 8 of 40 with nothing, and 3 of 40 with a placebo note. The placebo did no better than nothing, so the gain comes from what the lesson says. The tasks were two test tools built to provoke one specific mistake each, so this shows that a correct lesson changes behaviour; how often the plugin finds one in real use is a separate number.

On 125 of the author's real coding-agent dialogs, replayed in order, the plugin sent 7 failures to the model and got 1 lesson back (commit `d7b0831`; 5 and 1 before the self-correction change). That lesson was useful: it corrected an out-of-date example in the author's own instructions that had caused the same error twice. These dialogs keep no tool-call arguments, so the model saw less than it would on a live install; most of its "nothing to learn" answers said so. On the same replay with a stub model that always answers "nothing" (so only what reaches the model is counted), 20 different failures reach it at commit `955ea0f`, against 7 at `7d64d59`: 12 that another failure had crowded out of their session's one call come back through the queue, and one command that timed out every time is no longer written off as an outage. What the model would write for them was not measured. Method, limits and raw data: [docs/MEASUREMENT-2026-09-25.md](MEASUREMENT-2026-09-25.md).
