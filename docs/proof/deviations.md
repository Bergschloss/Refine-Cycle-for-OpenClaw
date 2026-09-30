# Deviations from the pre-registered protocol

Logged in the order they happened, in the three-part form of `PROTOCOL.md` §12: what happened;
the consequence for the metric, threshold or verdict; harmless or breach. The frozen artifacts
(`FREEZE.md`) are unchanged by every entry below.

## DEV-1 — R1 called the live model (2026-09-29, 22:40–22:45 UTC)

**What happened.**
- §8 plans R1 as an offline replay with **0** model calls, plus an optional stub-model arm
  capped at 20.
- The runner replayed both corpora with the live model: **44 calls** (23 without arguments, 21
  with arguments). It produced 10 lessons in each arm.

**Consequence.**
- The calls count against the shared envelope: 44 of 920 hard, 800 soft.
- R1's primary metric (H1, surfacing) is computed from the raw lines and does not depend on the
  model's replies.
- The R1 lessons are **supplementary**. Graded, they are reported apart from the primary H3
  denominator, which the protocol draws from R2 and R3.

**Harmless or breach.** A budget breach for R1, with no effect on the primary endpoints. It is
reported as such.

## DEV-2 — R2 and R4 run consecutively, not across three UTC days (owner decision, 2026-09-30)

**What happened.**
- §9 schedules R2 across at least three UTC days, so that a lesson could reach the audit's
  `working` verdict live.
- That verdict needs 3 quiet sessions **and** an age of at least 3 days.
- The owner decided that the synthetic runs do not wait for the calendar. R2 and R4 run their
  sessions back to back.

**Consequence for H5 (the audit tells the truth):**
- no lesson in R2 or R4 reaches an age of 3 days, so none can be `working` live;
- the live part of H5 checks that `/refine audit` agrees with the ledger at every read (100%);
- it also checks that before day 3 the audit says `too early` and never an early `working`;
- the transition `too early → working` (3 quiet sessions and 3 days) is **not observed live**;
- that transition is covered by frozen unit tests that inject the clock:
  - `test/audit.test.ts` (lines 12–31: the 2-day and 3-day boundaries, and 2 and 3 shown
    sessions);
  - `test/pipeline.test.ts` ("the audit's verdicts over time: too early, then working…").

  Those tests are at the pinned code commit `5f5dd44`.
- The H5 verdict reports the transition clause as **tested by unit tests, not live**.

**Harmless or breach.**
- The day floor is deterministic code (`ageDays = floor((now − createdAt) / 86 400 000)`), and a
  live wait would exercise the same comparison against a wall clock.
- The breach is limited to the live observation of that one clause, and it is stated.

## DEV-3 — R2's daily model-call cap raised to 50 (runner configuration)

**What happened.**
- To fit the compressed schedule of DEV-2, the runner sets `maxModelCallsPerDay = 50` for R2.
  The default is 3.
- R4's budget check (C2) runs separately, with the cap set to 1.

**Consequence.**
- More failures can reach the model on one day than on a default install, so R2's pace of
  learning is not a default install's daily pace.
- H6(b) is judged against the configured cap: "the budget never exceeds `maxModelCallsPerDay`".
  That is tested in R4 C2, and in R2 against 50.
- Recall and usefulness (S1, S3, S5) are not affected by the cap's value, as long as it is never
  the reason a scenario went unlearned. The runner reports any `budget_spent` refusal in R2.

**Harmless or breach.** Harmless for the verdict if R2 records no `budget_spent` refusal.
Otherwise the affected scenarios are named in the report.

## DEV-4 — First-call scoring counts the first call of the target tool (2026-09-30)

**What happened.**
- §6 scores R3 (and R2's recurrence sessions) by the agent's first tool call.
- On this host the agent's first call is almost always an `exec` discovery script that lists the
  available tools. The raw runner scored that call, so every arm of R3 read 0 of 120.
- The rescoring (`rescore.py`, outputs `r2-rescored.jsonl` and `r3-rescored.jsonl`) scores the
  first call of the **target** tool instead: a direct call (`<tool>` or `openclaw__<tool>`), or an
  `exec` whose code calls `openclaw__<tool>({...})`, with the parameter read from that call. The
  pass rule is the frozen `validate_first_call` of the runner, unchanged.
- The rule was fixed while every arm stood at 0 of 120, before any per-arm number was seen.

**Consequence.**
- The endpoint is "the first attempt at the target tool is correct", not "the first tool call of
  any kind is correct". A session that never calls the target tool scores as a failure.
- The same rule applies to all three arms, so the comparison between arms is unaffected.

**Harmless or breach.** A breach of the literal §6 wording, made blind to arms and applied
equally. Both the raw and the rescored files are kept.

## DEV-5 — Packet builder input adapted (2026-09-30)

**What happened.**
- The frozen `make_packets.py` reads sessions whose `outcome` is `"learned"` and takes the tool
  and shape from a `candidate` object.
- The plugin writes `outcome: "lesson"` and keeps the tool and shape under `lesson` and
  `failures` (`RAW-FORMAT.md`). The builder produced 0 packets.
- `adapt_packets.py` renames the outcome and fills `candidate` from those fields. The frozen
  builder then runs unchanged.

**Consequence.** None for the metrics: the packets hold the same six keys and the same text.

**Harmless or breach.** Harmless. The frozen file is unchanged; the adapter is kept beside the
raw files.

## DEV-6 — Two grader families instead of three (2026-09-30)

**What happened.**
- Amendment A1 requires three LLM graders from three families, none OpenAI.
- Available: Anthropic Claude (Opus 5.5, blind subagent) and Google Gemini (3.1 Pro High). The
  only open-weight model on offer was GPT-OSS, which is OpenAI and excluded; no local Qwen or
  Llama was available.
- The primary packets (R2, 10 lessons) are graded by both. The supplementary R1 packets are
  graded by Claude only, because their `existing_rules` hold the owner's private instructions,
  which are not sent to an outside model.

**Consequence.**
- A 2-of-3 majority is not possible. The label is the agreed one when both agree; when they
  differ, the more severe label is taken (the conservative tie-break of §5).
- Fleiss' κ over three graders cannot be computed; agreement between the two is reported
  instead, together with each grader's own rate.

**Harmless or breach.** A breach of A1. It is reported as a stated limit next to §11 T5.
