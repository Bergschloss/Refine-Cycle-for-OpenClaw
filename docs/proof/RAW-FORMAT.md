# Raw record format (format 1)

Refine Cycle writes the raw record so that the proof runs can be counted again from these
files alone, without the plugin's code. Two sources write it:

- **Replay:** `openclaw refine-cycle replay <corpus> <storeDir> [sourcesDir] --raw <file.jsonl>`.
  The file must be new or empty. It gets one `run` line, then one `session` line per corpus
  session, in replay order.
- **Live:** with the setting `rawLog: true` (default `false`), each learning pass appends a
  `session` line to `<store>/raw/<YYYY-MM-DD>.jsonl`, and each `disable`, `delete` or
  `rollback` appends a `lesson_status` line. The store is `<OpenClaw state dir>/plugin-data/refine-cycle`.
  The date is the UTC day the line was written.

The format is JSON Lines: one JSON object per line, UTF-8, `\n` after each line. Every line
has `kind` and `format` (always `1` here). Times are ISO 8601 UTC strings unless a field
says otherwise. A field shown as `T | null` is always present and is `null` when there is
nothing to record.

The record holds only what the plugin's store already keeps: tool names, fingerprints,
normalized error shapes (at most 300 characters), the model's reply (at most 2,000
characters) and the lesson texts. It holds no user messages, no prompt text and no tool
output beyond those shapes.

## How to count

- **One line per pass.** Live, a session gets a line after each turn that ends in it, so one
  session can have several lines. Take the **last line per `(agentId, sessionId)`**: it has
  the session's final decision. A replay has exactly one line per session.
- **Live files are per UTC day** and start when `rawLog` is turned on. Read every file of the
  run together: a session that ends on two days has lines in both. The live `/refine report`
  also counts what the plugin did before `rawLog` was on, so it matches the raw files only
  for a store that had `rawLog` on from the start; the replay's file always matches its report.
- A line with `earlier: true` is a pass over a session that already had its model call. It
  repeats that earlier decision and records no new model call (`modelCalls` is empty).
- The replay's report (`replay-result.json`, and `report` in the command's output) is
  exactly this computed from the last lines:

  | Report number | From the raw record |
  |---|---|
  | `sessions` | number of distinct `(agentId, sessionId)` |
  | `sessionsWithFailures` | of those, lines with a non-empty `failures` |
  | `outcomes[x]` | lines with `outcome` = `x` |
  | `refusals[rule]` | entries of `evaluated` with that `rule`, plus `after_model:<refusedAfterModel>` |
  | `modelCalls` | lines with `called: true` (sessions that spent their call) |
  | `queuedCalls` | lines with `called: true` and `queue.used: true` |
  | `lessons.active` | ids in any `activated`, less those a later `lesson_status` took away |

  `test/replay.test.ts` ("replay --raw …") recomputes these from the file and checks them
  against the report.
- **Model calls made** (not sessions): the entries of `modelCalls` over all lines, the
  shortening calls included. Per UTC day this is the number the daily cap
  (`maxModelCallsPerDay`) is checked against; `budget.callsToday` is the plugin's own count
  at the time the line was written.
- **The audit** (`/refine audit`): for a lesson `L`, each last line whose `effects.shown`
  contains `L` is one session it was shown in; `effects.recurrence[L] > 0` means its failure
  came back after it was shown there; `effects.unplaced[L]` counts failures the host gave no
  time for. The verdict rules are in `docs/DESIGN.md` ("audit"); `working` needs at least 3
  such sessions with no recurrence, and the lesson at least 3 days old.

## `run` (replay only, first line)

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"run"` | |
| `format` | number | `1` |
| `at` | string | when the replay started |
| `source` | `"replay"` | |
| `version` | string | plugin version |
| `corpus` | string | the corpus file's name (no directory) |
| `sessions` | number | sessions in the corpus |
| `settings` | object | every setting the replay ran with (`docs/USAGE.md`), after the replay's own overrides: `backfillSessions`, `keepSessionDays` and `keepSessions` are `0`, and `maxModelCallsPerDay` is the command's `100000`. No paths: `historyDbPath` is `"set"` or `""`, `skillDirs` is how many there are |
| `sources` | number | instruction and skill files the already-covered check read |

## `session`

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"session"` | |
| `format` | number | `1` |
| `at` | string | when the pass ended |
| `agentId` | string | the agent (`"replay"` in a replay) |
| `sessionId` | string | the host's session id |
| `startedAt`, `endedAt` | string \| null | first and last message time in the session, from the host's timestamps |
| `corpusStartedAt` | string \| number \| null | replay only: the corpus line's `startedAt`, as given |
| `settings` | object | `minSessions`, `minOccurrences` (the recurrence bar), `maxModelCallsPerDay`, `maxLessonChars` (numbers), `injectEnabled`, `learnEnabled` (booleans) |
| `errorCount` | number | tool results the host marked as errors in the session |
| `selfCorrectingSuppressed` | number | of those, errors that state their own remedy ("x is required"): never a candidate |
| `failures` | array | the session's failures, one entry per fingerprint (below) |
| `evaluated` | array | the failures checked against the refusal rules, in order, until one passed (below) |
| `notEvaluated` | string[] | fingerprints of this session's failures after the one that passed: not checked, because a session gets one model call |
| `outcome` | string | the pass's decision (below). When the pass threw (`error` is set), the decision it had stored, e.g. `history_unreadable`, or `"pass_failed"` when it stored none |
| `called` | boolean | the session has spent its one model call (in this pass or, with `earlier`, before) |
| `earlier` | boolean | see "How to count" |
| `modelCalls` | array | every model call this pass made (below) |
| `shortening` | object \| null | a lesson over `maxLessonChars` and the one request to shorten it: `from` (length before), `to` (after) or `refused` (why not: `budget_spent`, `empty`, `model_error: …`) |
| `lesson` | object \| null | the lesson this session's pass saved: `id`, `text`, `length` (characters), `fingerprint`, `tool` |
| `proposedLesson` | string \| null | a dry run's lesson (`outcome: "dry_run"`), not saved |
| `refusedAfterModel` | string \| null | the rule that refused the model's lesson (`outcome: "refused_after_model"`): `restatement`, `duplicate`, `withdrawn_by_user`, `off_topic`, `ungrounded`, `too_long`, `markup`, `empty` |
| `preview` | object \| null | a dry run: `wouldSave` (boolean), `rule` when it would not |
| `queue` | object | `used` (boolean): the call went to a failure from the agent's queue (one that passed every rule in an earlier session but never reached the model), not to this session's own; `fingerprint`: that failure, else `null` |
| `effects` | object | `shown`: ids of the lessons injected in this session; `recurrence`: per shown lesson, how many times its failure happened after it was first shown; `unplaced`: per shown lesson, occurrences with no time |
| `budget` | object | `day` (UTC date), `callsToday` (calls recorded in the plugin's budget that day, shortening included), `limit` (`maxModelCallsPerDay`) |
| `activated` | array | every lesson that became active during the pass: `id`, `agentId`, `text`, `length`, `fingerprint`, `tool`, `sourceSessionId`. Usually this session's `lesson`; also a lesson a busy store had deferred from another session, or one journal recovery finished |
| `error` | string \| null | when the pass threw: why (at most 300 characters) |

**`failures[]`**

| Field | Type | Meaning |
|---|---|---|
| `fingerprint` | string | the failure's identity: tool and normalized error |
| `tool` | string | the failing tool |
| `count` | number | occurrences in this session |
| `shape` | string | the normalized error the fingerprint is made from (at most 300 characters) |
| `resolutions` | object | over the first 20 occurrences, how many the agent `corrected` (the same action succeeded next), `repeated`, `switched` (moved to another tool) or left `unknown` |
| `correctionSeen` | boolean | the arguments of a correcting call were recorded (they are shown to the model as evidence) |

**`evaluated[]`**

| Field | Type | Meaning |
|---|---|---|
| `fingerprint`, `tool` | string | |
| `count` | number | occurrences over every session of the agent seen so far |
| `sessions` | number | sessions of the agent it was seen in so far |
| `rule` | string \| null | why it was not sent to the model, or `null` for the one that was |
| `detail` | string | when the rule has one (a lesson id, a count, a date) |
| `queued` | `true` | only on an entry taken from the queue |

The rules: `below_bar`, `self_corrected`, `not_lesson_shaped:transient`,
`not_lesson_shaped:wrong_tool`, `not_lesson_shaped:dropped_argument`, `covered_by_lesson`,
`lesson_not_shown`, `withdrawn_by_user`, `lesson_pending`, `paused_after_nothing`,
`already_covered`, and after the recurrence checks, on the chosen failure only:
`model_unavailable`, `budget_spent`, `budget_busy`, `budget_unreadable`, `already_called`,
`in_flight` (another session's pass was waiting on the model for the same failure; `detail`
is that session's id; from 2026-09-30).
Their meaning in words is in `describeReport` (`src/pipeline.ts`, `RULE_WORDS`).

**`outcome`**: `no_failures`, `all_refused`, `learning_disabled`, `history_unreadable`,
`model_unavailable`, `model_error`, `invalid_reply`, `nothing` (the model found nothing to
learn), `lesson`, `refused_after_model`, `apply_deferred` (a validated lesson waits for the
store lock), `dry_run`, `pending` (a call that never finished: a crash).

**`modelCalls[]`**

| Field | Type | Meaning |
|---|---|---|
| `purpose` | `"propose"` \| `"shorten"` | the proposal, or the one request to shorten a lesson over the limit |
| `at` | string | when the call started |
| `systemChars`, `promptChars` | number | characters of the system prompt and of the request |
| `outcome` | `"reply"` \| `"error"` | |
| `replyChars` | number | with a reply: its length |
| `reply` | string | with a reply: its first 2,000 characters |
| `error` | string | with an error: its first 300 characters |
| `ms` | number | how long the call took |

## `lesson_status` (live only)

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"lesson_status"` | |
| `format` | number | `1` |
| `at` | string | when |
| `lessonId`, `agentId` | string | the lesson and its agent |
| `status` | `"disabled"` \| `"deleted"` | what the user made it (`rollback` is `deleted`), or what the tidy made it (`disabled`) |
| `by` | string | only when the plugin did it itself: `tidy: did not help` or `tidy: unused` (`autoTidy`, from 2026-09-30); absent when the user did |

## Limits

- Two processes writing the same live file (the gateway and a command-line pass) each
  append whole lines in one write; on a local file system lines do not interleave.
- A line that cannot be written (a full disk) is skipped with a log line; the pass itself
  is not affected.
- A lesson withdrawn by a journal recovery (a `disable` a crash cut short, finished on the
  next turn) writes no `lesson_status` line; the command that started it did not finish.
