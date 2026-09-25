# Measurement, 2026-09-25: does a lesson change what the agent does?

**Result:** on two tasks the agent kept getting wrong, it got the first tool call right in **36 of 40** sessions with the lesson, **8 of 40** with nothing, and **3 of 40** with a placebo note of the same length and form.

Raw per-session data: [measurement-2026-09-25/results.json](measurement-2026-09-25/results.json).

## Setup

- OpenClaw 2026.9.6, model `openai/gpt-6-luna` (ChatGPT subscription route), one server.
- Two test tools that fail the same way every time:
  - `schedule_backup(cron)` fails unless the cron has five fields;
  - `send_report(date)` fails unless the date is `YYYY-MM-DD`.
- Two tasks, each written so the agent tends to pass the wrong format:
  - A: `Use schedule_backup to schedule the nightly backup for every night at 3 with cron 0 3 *. Make only one tool call.`
  - B: `Call send_report now for the European date string "25/09/2026" as written in the ticket.`
- Three arms, 20 sessions each per task, 120 sessions in all:
  - **lesson**: the plugin injects one lesson about that tool;
  - **nothing**: injection off;
  - **placebo**: one lesson of the same length and form about an unrelated tool.
- Metric, decided before the run and read from the host's transcript, not from the agent's reply: **the agent's first call to the tool succeeds.**

The design was written down before any session ran, including a rule for rewording a task once if the agent never failed it in 5 trial sessions. Task B needed that rewording; task A did not.

## Results

| Task | lesson | nothing | placebo | lesson vs nothing (Fisher) | lesson vs placebo (Fisher) |
|---|---|---|---|---|---|
| A `schedule_backup` | 20/20 | 8/20 | 3/20 | p = 4.5e-5 | p = 2.6e-8 |
| B `send_report` | 16/20 | 0/20 | 0/20 | p = 1.5e-7 | p = 1.5e-7 |
| **Both** | **36/40 (90%)** | **8/40 (20%)** | **3/40 (7.5%)** | p = 2.0e-10 | p = 1.2e-12 |

The placebo did not help: it scored at or below nothing, so the gain comes from what the lesson says, not from extra text in the prompt.

## Limits

- **Two synthetic tasks.** The lesson states the fix for exactly the failure the task provokes. This measures whether a correct lesson in the prompt changes behaviour. It does not measure how often the plugin finds such lessons in real use (see below).
- **Where the lessons came from.** Task A used the lesson the plugin learned by itself on a live bot. Task B's lesson was written by hand in the same form, because the plugin's live learning was broken on that day (fixed since; it has learned the same kind of lesson live).
- **Sessions ran in blocks,** one arm at a time, not fully interleaved, because each arm needs its own lesson store.
- **One model, one route, one day.**

## How often it finds a lesson in real use

The plugin was replayed over 125 of the author's real coding-agent dialogs, in the order they happened, with the author's own instruction files and skills as "rules the agent already has":

- 54 sessions had tool failures;
- 5 failures passed every check and went to the model;
- the model answered "nothing to learn" 4 times and wrote 1 lesson;
- that lesson was useful and not a restatement: it corrected an out-of-date example in the author's own instructions, which had caused the same error in two sessions.

Most failures (168) were refused because they did not repeat: seen in only one session and fewer than five times. The result was the same at recurrence bars of 5 and 3.
