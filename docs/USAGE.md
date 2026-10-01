# Using Refine Cycle for OpenClaw

Everything the [README](../README.md) leaves out: every command, every setting, the messages, and the rules the plugin follows. Design and host contract: [DESIGN.md](DESIGN.md).

## Install, in detail

Tested on OpenClaw 2026.9.6 (2026.9.5 is supported). The plugin runs inside OpenClaw, so it needs what OpenClaw itself needs: Node 24.16+ or 26.1+.

**1. Install the plugin from ClawHub.** `--accept-capabilities` accepts what the plugin declares it can do.

```bash
openclaw plugins install clawhub:refine-cycle --accept-capabilities
openclaw plugins enable refine-cycle
```

The second line changes nothing on a first install. It matters when you install again after `openclaw plugins uninstall`: OpenClaw 2026.9.6 keeps a removed plugin switched off, and a new install does not switch it back on.

It also installs straight from GitHub. OpenClaw then warns that a git source is outside ClawHub review and asks `Install this non-ClawHub plugin source? [y/N]`; review the source, then answer `y` (in a script, with no terminal to answer, add `--force` after reviewing it):

```bash
openclaw plugins install git:github.com/Bergschloss/Refine-Cycle-for-OpenClaw --accept-capabilities
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
| `/refine enable <id>` | `openclaw refine-cycle enable <id>` | Show a disabled lesson again, one the tidy switched off or you did; the tidy never switches it off again. A deleted lesson stays deleted |
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
| `checkForUpdates` | `true` | Once a day, look for a newer release (off: no check, no update, no message) |
| `autoUpdate` | `true` | Install a newer release by itself, with OpenClaw's own `plugins update`, once per version, then restart OpenClaw to finish it, and tell you in one line. Only when OpenClaw runs as a service it can restart; otherwise, and with `false`, a message with an **Update** button instead. A plugin loaded from a directory, or a git install with no release tags, is never updated |
| `autoTidy` | `true` | Past `maxInjectedChars`, switch off (never delete) lessons the audit judges `did not help`, then `unused`, oldest first, until the block fits, and tell you in one line; `false`: only the warning |
| `backfillSessions` / `backfillIntervalMinutes` | `10` / `60` | Recent sessions re-read, at most this often, so failures from before an install or a restart still count |
| `keepSessionDays` / `keepSessions` | `30` / `500` | Once a day, the summaries of sessions older than this (by their last message), and all past the newest 500 per agent, are folded into one record per agent (`folded/<agent>.json`) and removed. The fold keeps each session's failure counts, so the recurrence bar, the queue and the report count exactly as before; a folded session is not re-read unless it grows. `0` turns either limit off |
| `proposalTimeoutMs` | `120000` | How long the model may take for one lesson |
| `skillDirs` | none | Extra directories searched for `SKILL.md`, besides the workspace's `skills/` |
| `historyDbPath` | `""` | The agent's history database, for a single-agent install that keeps it somewhere else |
| `rawLog` | `false` | For measurement: one raw JSON line per learning pass and per lesson you take away, in `raw/<date>.jsonl` in the plugin's data folder ([format](proof/RAW-FORMAT.md)). `openclaw refine-cycle replay … --raw <file.jsonl>` writes the same lines for a replay |
| `enabled` | `true` | `false` turns the whole plugin off |

## What it promises, and the messages it sends

- At most one model call per session and three a day, on the model and account OpenClaw uses for your default agent, or on a model you choose with `/refine model` if you let OpenClaw allow that. The plugin has no key of its own.
- `/refine list` shows your lessons and their status, and `/refine audit` whether each one helped; `/refine disable <id>` and `/refine delete <id>` take one away, and a lesson you took away is never learned again.
- It never edits your `AGENTS.md`, `SOUL.md`, skills or memory. Lessons live in the plugin's own folder.
- It does not filter your conversation or its lessons. The evidence for a lesson (the failing call's error and arguments, and the call that fixed it) goes to that model, as your agent would send it; the lessons and the plugin's records, which keep short excerpts of failed calls, stay in its folder on your machine. With several agents, the evidence from every agent goes to the default agent's model: OpenClaw does not let a plugin's background call choose the agent.
- It needs no command. Everything it has to tell you reaches you by itself: in your chat when the channel takes a plugin's message (Telegram and the like), and otherwise, in the web UI and the Tray (`webchat`), through your agent, which passes it on in one short sentence in its next reply to you, in whichever session you write next. A reply that fails does not use it up: the next one passes it on. Never both.
- When it learns a lesson, it tells you in one line, such as "♾️ Refine Cycle — new lesson learned (412/4400)", in the chat you are talking from, or the last one you talked from when the turn came from a cron job, the command line, the heartbeat or the web UI. The numbers are how many characters your active lessons take in the prompt, against a soft limit of 4400; it says `getting tight` from 90%, and past it `over the soft limit: every turn now costs more tokens; /refine audit shows which lessons to turn off`. Every active lesson is still shown. `notifyOnLesson: false` turns this line off.
- Past the soft limit it tidies itself (`autoTidy`): it switches off lessons the audit judges `did not help`, oldest first, then `unused` ones (never shown in 14 days), until the block fits, and says so once: "♾️ Refine Cycle — switched off 2 lessons that did not help, lessons now 3900/4400". A lesson that is `working`, `too early` or has had no chance yet is never touched; with nothing it may switch off, it only warns. Switched-off lessons stay in `/refine list` as disabled, the audit says `disabled by tidy: did not help`, and like any lesson you took away they are not learned again. `/refine enable <id>` brings one back, and the tidy leaves it alone from then on. With nothing it may switch off (or `autoTidy: false`), it tells you once: "♾️ Refine Cycle — lessons use 4600/4400 characters, over the soft limit, and none can be switched off yet: …", and again only after the block has fitted once.
- It updates itself (`autoUpdate`): when the daily check finds a newer release, it runs OpenClaw's own `plugins update` once per version, when the gateway has been quiet for 10 minutes (no conversation in progress: the update reloads plugins), then restarts OpenClaw to finish it (a reload alone leaves the Codex route failing on OpenClaw 2026.9.6; `/refine update` restarts it too, once no conversation is running, or after 30 minutes at most), and says "♾️ Refine Cycle — updated to <version>." or "♾️ Refine Cycle — update to <version> failed: <reason>". A version that failed is not tried again; the next one is. When OpenClaw does not run as a service it can restart, it does not install by itself (a reload without a restart would leave the agent failing): it sends the **Update** message below, and `/refine update` then answers "updated to <version>; restart OpenClaw to finish". With `autoUpdate: false` it says "♾️ Refine Cycle — update available: <version>" once instead, with an **Update** button (on a channel without buttons, the command to copy); pressing it runs `/refine update`, which answers "updated to <version>", "is up to date" or "update failed" with the reason, in the chat you pressed it in. While a newer release is known, `/refine status` offers the same button. `checkForUpdates: false` turns the check off.
- If a hook fails, your agent's turn goes on as if the plugin were not there, and the log says why. If the store cannot be used, the plugin stays idle and your agent tells you once, with the folder and the likely cause.
- A command whose result comes later (`/refine update`, `run`, `session`) sends it to the chat you typed it in, or, from the web UI or the Tray, your agent passes it on in its next reply. A message a channel fails to deliver is passed on by the agent the same way.

## The rules, step by step

After each turn, the plugin reads the whole session from OpenClaw's history and turns each failed tool call into a fingerprint, so the same error with a different path, id or timestamp counts once. Most failures stop here, without a model call: they did not repeat, they were a network timeout or an outage, or the agent's own instructions and skills already cover them. A command that hits the tool's own time limit every time it runs is not an outage, and does get a lesson. A failure that gets through goes to the model with its evidence; when the agent fixed the call itself, the call that then succeeded is part of that evidence. A session gets one model call at most; a session with no failure of its own worth it spends its call on the oldest failure that passed every check but never reached the model (or came back in a new session since the model answered it), so a failure crowded out by another one in its own session is not lost. When the model finds nothing to learn from a failure, it is not asked about it again for 7 days, unless the failure comes back in a new session. A lesson the model writes must name the observed failure and the failing tool, and not repeat a rule the agent already has. The model is asked for about 120 characters; a lesson over the 200-character limit gets one request to say the same thing shorter, keeping the situation, the steps and the tool, and is refused only if it cannot be. That request is a second model call, made only while the day's budget has room. It is journaled before it becomes active, so a crash never leaves a half-written lesson. From the next prompt on, the agent's active lessons are placed ahead of its turn in a short, marked block.

## What the testing shows, in full

In the pre-registered proof run on OpenClaw 2026.9.6 with GPT-6 Luna ([docs/proof/](proof/)), the plugin learned a lesson in each of the 10 scripted scenarios where one was possible, and two graders from different model families (Claude and Gemini) rated all 10 useful. On 120 new tasks the agent then got the first call to the tool right in 109 with the lesson, 9 with nothing, and 79 with a note of the same length that stated the right format as a plain fact without telling the agent to use it (the protocol meant it as a note with nothing useful in it; see [DEV-7](proof/deviations.md)). Scoring counts the first call to the task's tool, since the agent often looks up its tools first ([DEV-4](proof/deviations.md)). The tasks use test tools built to provoke one specific mistake each, so this shows that a lesson the plugin learned changes behaviour; how often the plugin finds one in real use is a separate number. An earlier, smaller test with two lessons, one of them written by hand (36 of 40 with the lesson, 8 of 40 with nothing) is in [MEASUREMENT-2026-09-25.md](MEASUREMENT-2026-09-25.md).

On 125 of the author's real coding-agent dialogs, replayed in order, the plugin sent 7 failures to the model and got 1 lesson back (commit `d7b0831`; 5 and 1 before the self-correction change). That lesson was useful: it corrected an out-of-date example in the author's own instructions that had caused the same error twice. These dialogs keep no tool-call arguments, so the model saw less than it would on a live install; most of its "nothing to learn" answers said so. On the same replay with a stub model that always answers "nothing" (so only what reaches the model is counted), 20 different failures reach it at commit `955ea0f`, against 7 at `7d64d59`: 12 that another failure had crowded out of their session's one call come back through the queue, and one command that timed out every time is no longer written off as an outage. What the model would write for them was not measured. Method, limits and raw data: [docs/MEASUREMENT-2026-09-25.md](MEASUREMENT-2026-09-25.md).
