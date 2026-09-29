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
