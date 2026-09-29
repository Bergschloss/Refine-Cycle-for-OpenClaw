# Refine Cycle for OpenClaw — Pre-Registered Proof Protocol

**Document:** `docs/proof/PROTOCOL.md`
**Repository:** github.com/Bergschloss/Refine-Cycle-for-OpenClaw, branch `main`
**Pinned code commit (RECORD AT FREEZE):** `________` — the SHA of the `main` HEAD against which this protocol is frozen; record it in this line before trial #1 of any run.
**Reference report:** Bergschloss/Refine-Cycle-for-Hermes-Agent, `docs/RESEARCH-REPORT-2026-09-12.md` — the plugin was pre-registered there, with frozen graders, sign errors disclosed, and deviations listed. This protocol is held to the same standard [Hermes-REPORT §0; Hermes-REPORT §2.4].
**Reference protocol:** Bergschloss/Refine-Cycle-for-Hermes-Agent, `docs/evidence/lesson_effect_protocol_v2.md` — hypotheses, Gate-0, grading panel, multiple-comparisons, verdict logic, and stopping rules are licensed from it and cited where followed or departed from.
**Status:** `PRE-DATA` — no trial has run, no manifest is sealed, no data exists. Nothing below describes an outcome.
**Version / date / owner:** v0.1-pre / 2026-__-__ / owner: `________` (record at freeze).
**Runs covered:** R1 replay of 125 real dialogs; R2 live scenario benchmark; R3 A/B test on learned lessons; R4 control and robustness live; R5 install.
**Frozen host/model scope:** OpenClaw `2026.9.6`, model `GPT-6 Luna` (route locked; §11). The claim is scoped to this route: a single-route run cannot detect a treatment-by-route interaction, and Hermes itself observed opposite-sign effects on other routes [Hermes-REPORT §1.3].

## Amendments before freeze

**A1 (2026-09-29, owner decision, before trial #1): the grading panel is three LLM graders from three different model families, none from the agent route's family, with no human grader** (§5, §7, §11 T5). The protocol as drafted asked for two human graders, an LLM grader and a human adjudicator; the owner has no human graders available. Because it is made before any trial and before the freeze, this is part of the pre-registration, not a deviation.

## Freeze rule

No edit to this document, to `docs/proof/analysis_decider.py`, to the frozen scenario manifest, to the grader rubric/prompt (Appendix C), or to the R3 assignment manifest is permitted after trial #1 of any run. Any such change voids the pre-registration, must be reported as a deviation (§12), and the affected run must restart under the amended pre-registration for its verdict to count. This is the Hermes discipline: rubrics committed before any run; changes only via a logged amendment signed before unblinding [Hermes-PROTOCOL §8.13].

## Frozen artifacts (record every SHA-256 before trial #1)

| Artifact | Path (committed to `docs/proof/`) | SHA-256 (record before trial #1) |
|---|---|---|
| This protocol | `docs/proof/PROTOCOL.md` | `________` |
| Locked analysis decider | `docs/proof/analysis_decider.py` | `________` |
| Frozen scenario manifest (R2) | `docs/proof/scenarios-manifest-YYYYMMDD.json` | `________` |
| Grader rubric + full prompt (Appendix C) | `docs/proof/grader-rubric.md` | `________` |
| Frozen R3 assignment manifest | `docs/proof/r3-assignment-manifest.json` | `________` |

---

# 0. Purpose, scope, and what is not claimed

**What this proves.** The owner's claim is that the plugin does what its README promises. This protocol converts each README promise into one testable hypothesis (§1), fixes the success bar for each metric before any run (§2), specifies five runs (§3), locks the scenario design (§4), the lesson grader (§5), the A/B design (§6), the statistics (§7), the budget and stopping rules (§8), and a timeline that lets the audit's multi-day gate actually elapse (§9). The proof is the run of this document against the raw data it names; a hostile, technically competent reader must be able to recompute every number from the raw JSON Lines files alone, without the plugin's code [RAW-FORMAT.md; Hermes-REPORT §0].

**The nine promises under test** (verbatim from the README, RETRIEVED):

1. **Notices repeats across sessions** — "One failed call may be noise. The same failure in two sessions, or five times, is a pattern." [README]
2. **Writes one short, useful lesson** — "Write the smallest useful lesson. One short sentence, such as *'When calling send_report, write the date as YYYY-MM-DD.'*" [README]
3. **Checks later whether the failure stopped** — "Later sessions show whether the failure stopped, and `/refine audit` tells you which lessons work." [README]
4. **Remembers across conversations** — "Refine Cycle remembers across conversations, so you stop explaining the same thing twice." [README]
5. **The user stays in control** — "It reaches a model no more than three times a day, and uses the model OpenClaw already uses. It has no key of its own." + "`/refine list` shows every lesson. `/refine delete <id>` removes one, and it is never learned again." + "It never edits your `AGENTS.md`, `SOUL.md`, skills or memory." + "It does not filter your conversation." + "If something inside the plugin fails, your agent carries on as if it were not installed." [README]
6. **One message per lesson in chat** — "When it learns a lesson, it tells you in one line in your chat: `♾️ Refine Cycle — new lesson learned (412/4400)`." [README]
7. **Installs by the README** — "Needs OpenClaw 2026.9.5 or newer (tested on 2026.9.6)." [README] + the four install steps [README; USAGE.md].
8. **Leaves one-offs, noise, and already-covered rules alone** — "Nothing reaches the model until a failure repeats, and network hiccups or rules your own instructions already cover are skipped." [README; USAGE.md]
9. **Never breaks the agent** — "If something inside the plugin fails, your agent carries on as if it were not installed." [README; USAGE.md fail-open]

**What this does NOT claim:**

- No transfer to novel failures outside the tested domains. The R2 scenarios are drawn from the plugin's own failure signatures and from phase-0 tasks, and R3 tests transfer to fresh tasks only within those domains (§6); generalisation beyond them is not asserted.
- The primary endpoint is **tool-call correctness**, not judged prose quality. A lesson's text is graded only for the "writes a short, useful lesson" promise (§5); behaviour change is scored deterministically from the host transcript, never from the agent's reply [Hermes-REPORT §1.1; Hermes-PROTOCOL §6.2].
- Route and model scope is one model and one host version: GPT-6 Luna on OpenClaw 2026.9.6. No claim is made about other models, routes, or host versions; the route is locked and any deviation is a deviation (§8, §11).
- The R1 replay without tool-call arguments is a **stated limit**, not evidence of the with-arguments behaviour: phase 0 disclosed that exported dialogs keep tool results but not the call arguments, so "the agent fixed it" means only "a later call of the same tool succeeded", and the numbers are "a floor … not an estimate" [MEASUREMENT-2026-09-25]. The protocol therefore runs two replay arms and labels the without-arguments arm as a limit (§3, §11).
- R4 control-and-robustness checks are verification, not experiments: they add no causal evidence [Hermes-REPORT §5].

# 1. Claims → hypotheses

Each hypothesis is a blockquoted scoped claim (the README promise), its null, its primary metric, and exactly how the metric is computed from the raw record format (format 1, JSON Lines, `kind` + `format: 1`, ISO 8601 UTC; a session is counted by its **last** line per `(agentId, sessionId)`; live files are per UTC day and are read together; the live `/refine report` matches the raw files only when `rawLog` was on from a fresh store) [RAW-FORMAT.md]. Fields named below are RAW-FORMAT.md format 1 fields unless marked `ledger` (from `/refine audit` / `ledger/<lesson>.json`) or `notice` (from the notice log).

---

> **H1 — The plugin notices repeats across sessions.** "One failed call may be noise. The same failure in two sessions, or five times, is a pattern." [README]

- **Run:** R1 replay of 125 real dialogs, two arms (§3).
- **H0:** Repeated failures are no more likely to be surfaced than one-off failures; the repeat bar does not separate pattern from noise.
- **Primary metric:** *cross-session repeat recall*.
- **Computation (raw):** From the last line of each `(agentId, sessionId)`: (a) collect every fingerprint in every non-empty `failures` array; (b) a fingerprint *repeats* when it occurs in ≥ 2 distinct sessions or has ≥ 5 occurrences across the corpus (the README bar: "two sessions, or five times"); (c) a repeated failure is *surfaced* when the session's last-line `outcome` is not a pre-repeat refusal (`below_bar`, `self_corrected`, `transient`, `paused_after_nothing`, `already_covered` and their `refused_after_model` forms) — i.e. the repeat reached a pass decision and, where applicable, a `lesson`/`proposedLesson` was produced. Recall = surfaced repeated failures / repeated failures, counted by last line.
- **Arms:** (A) corpus rebuilt **with** tool-call arguments, in the format of `test/fixtures/corpus-with-args.jsonl` — primary [USAGE.md; README "What the testing shows"]; (B) today's corpus **without** arguments — stated limit: results are a floor, not an estimate [MEASUREMENT-2026-09-25]. A test proves the replay report can be recomputed from the raw file alone (`openclaw refine-cycle replay … --raw <file>` reproduces `sessions`, `sessionsWithFailures`, `outcomes[x]`, `refusals[x]`, `modelCalls`, `queuedCalls`, `lessons.active` exactly as RAW-FORMAT.md tabulates) [RAW-FORMAT.md].

---

> **H2 — The plugin leaves one-offs, noise, and already-covered rules alone.** "Nothing reaches the model until a failure repeats, and network hiccups or rules your own instructions already cover are skipped." [README; USAGE.md]

- **Run:** R2 noise scenarios (§3, §4).
- **H0:** The plugin writes (or proposes) lessons for one-off, transient, or already-covered failures.
- **Primary metric:** *noise-scenario false-lesson rate*.
- **Computation (raw):** Fraction of noise-scenario sessions (last line per `(agentId, sessionId)`) whose `lesson` or `proposedLesson` field is non-null. A session whose failure is transient, single-occurrence, or covered by an existing AGENTS.md/SOUL.md/skills rule but still yields a lesson counts as one false lesson. The covered-rule noise scenario is additionally graded by the panel (§5): a lesson judged `restates` counts as false. Threshold: 0.

---

> **H3 — The plugin writes a short, useful lesson.** "Write the smallest useful lesson. One short sentence, such as *'When calling send_report, write the date as YYYY-MM-DD.'*" [README]

- **Run:** R2 and R3 (§3, §5).
- **H0:** Produced lessons are not useful, restate an existing rule, are wrong, or exceed the length cap.
- **Primary metrics:** (a) *length compliance* — fraction of lessons with `len(lesson.text) ≤ 200` (the code hard cap `maxLessonChars = 200`; the model is asked for ~120) [USAGE.md]; (b) *usefulness rate* — fraction judged `useful` by the blind panel (§5); (c) *wrong/harmful count* — number judged `wrong` or `harmful`.
- **Computation (raw):** length from `lesson.text.length` deterministically (not by the judge); categories from the frozen four-category rubric, blind to arm and source (§5).

---

> **H4 — The lesson changes behaviour.** "Your agent keeps repeating the same mistake. This makes it stop." — on its own the agent got the call right 20% of the time → 90% with the lesson (120-session test: 36/40 with lesson, 8/40 without) [README; MEASUREMENT-2026-09-25].

- **Runs:** R2 live scenarios (fixable subset) + R3 A/B (§3, §6).
- **H0:** The lesson does not improve the agent's first tool call relative to nothing.
- **Primary metrics:** (a) *R2 fixable recall* — fraction of lesson-fixable scenarios whose first tool call is correct within 3 sessions; (b) *R3 paired risk difference* — lesson vs nothing, graded from the host transcript.
- **Computation:** R2: from the live raw last lines and the host transcript, the first tool call (name + arguments) of each session is scored against the scenario's locked expected correct call (§4); recall = scenarios with a correct first call within ≤ 3 sessions / fixable scenarios. R3: exact McNemar on discordant pairs per item, read from the raw/host transcript; the agent's reply prose is never scored (§6, §7).

---

> **H5 — The audit tells the truth.** "Later sessions show whether the failure stopped, and `/refine audit` tells you which lessons work." [README]; verdict rules, first match wins: `deleted → rolled back`, `disabled → disabled`, no session ended since learned → `no recurrence window`, failure came back after shown → `did not help`, failures with no time → `unreliable`, never shown → `unused` after 14 days / `too early` before, shown in < 3 quiet sessions → `too early` however old, shown in ≥ 3 quiet with no recurrence → `working` once ≥ 3 days old; `AGE_GATE_DAYS = 14`, `RECURRENCE_HORIZON_DAYS = 3`, `MIN_QUIET_SESSIONS = 3`; `ageDays = floor((now − createdAt) / 86_400_000)` (calendar-day floored, not 72 h) [src/pipeline.ts (judgeLessons); src/core/audit.ts for the constants].

- **Runs:** R2 and R4, with a live part spanning ≥ 3 days (§3, §9).
- **H0:** `/refine audit` (or `/refine status`) verdicts disagree with verdicts recomputed independently from the raw file.
- **Primary metric:** *audit–ledger agreement* = 100%.
- **Computation:** An independent recomputation reads the raw last lines only: for each lesson `L`, `effects.shown` contains `L` for each session it was shown in, `effects.recurrence[L] > 0` means the failure came back after it was shown, and `working` requires ≥ 3 shown sessions with no recurrence and `ageDays ≥ 3` [RAW-FORMAT.md; DESIGN.md]. The recomputed verdict for every lesson at every read (days 1, 3, 5) must equal the `ledger` verdict reported by `/refine audit` (and per-agent counts reported by `/refine status`, which uses the same `judgeLessons`). Verdict transitions must be observed: `too early → working` exactly when the ledger first satisfies `MIN_QUIET_SESSIONS = 3` with no recurrence AND `ageDays ≥ 3`; a lesson may not skip `too early`, and `working` may not appear before day 3 (calendar).

---

> **H6 — The user stays in control.** "It reaches a model no more than three times a day … `/refine delete <id>` removes one, and it is never learned again. It never edits your `AGENTS.md`, `SOUL.md`, skills or memory. It does not filter your conversation." [README]

- **Run:** R4 (§3, §10).
- **H0:** (a) a withdrawn lesson is relearned; (b) the daily cap is exceeded; (c) protected files are modified; (d) the conversation is filtered.
- **Primary metrics:** (a) *re-learn rate of a withdrawn lesson* = 0; (b) *budget cap* = `max(budget.callsToday)` over every UTC day ≤ `maxModelCallsPerDay` (default 3); (c) *protected-file integrity* = hashes of `AGENTS.md`, `SOUL.md`, `skills/`, memory unchanged before/after every run; (d) *injection coverage* = every failure the plugin decided to act on appears in the raw record (no silent filtering).
- **Computation (raw):** (a) after `/refine delete <id>` (tombstoned: `lessonId = sha1(\`${agentId}|${fingerprint}|${text.toLowerCase().trim()}\`).slice(0,10)`), count sessions whose last line contains a `proposedLesson` or `lesson` matching the withdrawn id or text — must be 0; `activateLocked` throws `LessonExistsError` and the pipeline refuses re-proposal of an existing or withdrawn lesson [DESIGN.md; src/lessons.ts; src/pipeline.ts]. (b) `maxModelCallsPerDay` default 3; `reserveCall` takes a non-blocking lock (`wait 0`), so under concurrency a writer receives `budget_busy` rather than exceeding the cap [DESIGN.md; RAW-FORMAT.md]. (c) file hashes recorded pre/post-run. (d) every last-line session with a non-empty `failures` array appears in the raw file.

---

> **H7 — The plugin never breaks the agent (fail-open).** "If something inside the plugin fails, your agent carries on as if it were not installed." [README; USAGE.md]

- **Run:** R4 (§3, §10).
- **H0:** A plugin fault crashes the agent, loses a turn, or leaves a half-written lesson.
- **Primary metrics:** (a) *uncaught exceptions* = 0; (b) *fail-open text* observed in every faulted pass; (c) *no learning during fault* = 0 lessons learned or injected while the store was broken.
- **Computation (raw):** A faulted pass writes `error` with `storeErrorText: "Until then nothing is learned or injected; the agent works as without the plugin."`; its `lesson`/`proposedLesson` are null; the host turn completes normally; hooks are no-op [src/core/notice.ts].

---

> **H8 — It sends one message per lesson.** "When it learns a lesson, it tells you in one line in your chat: `♾️ Refine Cycle — new lesson learned (412/4400)`." [README]

- **Runs:** R2 and R4 (§3).
- **H0:** A lesson produces more than one notice, or an activated lesson produces none.
- **Primary metrics:** *notices per lesson* = 1 for every learned lesson; *missed notices* = 0 for activated lessons.
- **Computation (notice log / raw):** `announce()` fires once per pass that activated lessons (`lessonNotice`); update notices fire once per release; `say()` sends the text [DESIGN.md; USAGE.md]. Per `lessonId`, the notice log must contain exactly one lesson-learned line, and every lesson that reached `applied` in the journal must have exactly one corresponding notice.

---

> **H9 — It installs by the README.** "Needs OpenClaw 2026.9.5 or newer (tested on 2026.9.6)." [README]

- **Run:** R5 (§3).
- **H0:** At least one README install step fails or differs from the documented behaviour.
- **Primary metric:** *install-step pass rate* = 100% of README steps as written.
- **Computation:** Steps: (1) `openclaw plugins install git:github.com/Bergschloss/Refine-Cycle-for-OpenClaw --accept-capabilities`; (2) `openclaw config set plugins.entries.refine-cycle.hooks.allowConversationAccess true`; (3) `openclaw gateway restart`; (4) `Send /refine status in chat` [README]. (USAGE.md documents the equivalent check `openclaw refine-cycle list`, which answers 'No lessons yet.' before any lesson is learned.) Each step's exit code and documented output are recorded; `/refine list`/`status`/`audit` answer with exit 0; the lesson message arrives in chat (or Telegram when wired); the Update button works against a local git release.

# 2. Success bars, decided now

Every threshold below is fixed before trial #1. The reason column states why that number and not another; a different number chosen later is a deviation (§12).

| # | Metric | Threshold | How computed (raw fields) | Reason for the number |
|---|---|---|---|---|
| S1 | R1 cross-session repeat recall (with-arguments arm) | ≥ 80% | Last line per `(agentId, sessionId)`; fingerprints repeated across ≥ 2 sessions or ≥ 5 occurrences; surfaced when `outcome` is not a pre-repeat refusal | A pattern the plugin exists to catch must surface; 80% leaves slack for corpus reconstruction loss and mirrors the ≥ 80% ceiling-clear convention [Hermes-evidence DECISION_RULE_ceiling24.md] |
| S2 | R2 false-lesson rate on noise scenarios | 0 | Fraction of noise last-line sessions with non-null `lesson` or `proposedLesson` (exact binomial Clopper–Pearson one-sided upper bound; rule of three: 3/N at 0 observed) | A false lesson is a functional defect that erodes trust; the plugin's own refusal rules (repeat bar, transient, `already_covered`) are designed to yield exactly 0 here [README; USAGE.md] |
| S3 | Lesson usefulness (R2/R3, blind panel) | ≥ 80% `useful`; 0 `wrong`/`harmful` | Four-category rubric (§5), blind to arm/source; Wilson 95% CI on the useful rate; wrong/harmful counted | The promise is "the smallest **useful** lesson"; phase 0's one produced lesson was useful and not a restatement [MEASUREMENT-2026-09-25] |
| S4 | Lesson length | 100% ≤ 200 chars | `len(lesson.text) ≤ 200` (code hard cap `maxLessonChars = 200`; model asked ~120) [USAGE.md] | A lesson above the hard cap is a bug, not a judgment |
| S5 | R2 fixable-scenario recall within 3 sessions | ≥ 80% | First tool call (name + arguments) per session scored against the locked expected call (§4); recall = scenarios correct within ≤ 3 sessions / fixable scenarios (Wilson 95% CI) | Phase 0 measured 90% (36/40) on OpenClaw 2026.9.6 with GPT-6 Luna [README; MEASUREMENT-2026-09-25]; 80% leaves slack for the wider domain of ~20 scenarios |
| S6 | R3 primary: lesson vs nothing | Exact two-sided McNemar p < 0.05 (Holm), paired RD 95% CI lower ≥ +0.05 | Discordant pairs per item from the raw/host transcript; Agresti–Wald 95% CI for paired RD [Hermes-PROTOCOL §5.2, §8.8, §9.3] | phase 0 measured 90% (lesson) vs 20% (nothing), paired RD +0.70 [README; MEASUREMENT-2026-09-25]; the +0.20 floor mirrors the reference report's Luna arm and leaves headroom for the route-scoped OpenClaw replication; effects ≤ +0.10 are not reliably detectable at N = 80–120, which is why the floor gates the verdict [Hermes-PROTOCOL §5.2] |
| S7 | R3 mechanism: lesson vs placebo | Same test, significant positive RD | Same as S6, second planned contrast | The gain must come from the lesson's content, not mere injection: phase 0's same-length useless note scored 3/40 ≈ nothing's 8/40 [MEASUREMENT-2026-09-25] |
| S8 | Control & robustness (R4) | 0 uncaught exceptions; `budget.callsToday ≤ 3` every UTC day; 0 relearned withdrawals; fail-open text observed in every faulted pass | Raw `error`, `budget`, `lesson_status`, `modelCalls`; protected-file hashes | These are verification gates (Hermes-REPORT §5), each a binary property of the code's fail-safe design [DESIGN.md] |
| S9 | Install (R5) | Every README step as written; exit 0; expected outputs; lesson message delivered once; Update button works | Step checklist (§3, §10) | The promise is "installs by the README"; a single failed step falsifies the install claim [README; USAGE.md] |

## 2.1 What counts as the plugin does NOT work as intended

The decider prints one of five verdict strings, verbatim, and never paraphrases them [Hermes-PROTOCOL §9.3]: `SUPPORTED` | `PARTIAL` | `NOT SUPPORTED` | `FALSIFIED` | `UNDERPOWERED`. The decision tree is evaluated in strict order:

1. **Harm first → `FALSIFIED`.** Any of: a lesson judged `harmful` (≥ 1); R3 lesson worse than nothing (McNemar negative RD significant, or paired 95% CI upper bound ≤ 0); a withdrawn lesson relearned (≥ 1 re-proposal or re-activation); `/refine audit` disagrees with the raw-ledger recomputation on any lesson at any read; a faulted pass crashes the host, loses a turn, or learns/injects a lesson; the daily budget cap is exceeded (any UTC day with `modelCalls > maxModelCallsPerDay`); an install step crashes the gateway.
2. **Primary endpoint not significant → `NOT SUPPORTED`.** R2 fixable recall not significantly above the bar, or R3 primary contrast not significant at Holm α = 0.05.
3. **Significant but below the meaningful-effect floor → `NOT SUPPORTED`.** Primary significant, but the paired RD 95% CI lower bound < +0.05 [Hermes-PROTOCOL §5.2, §9.3]. It is better to report no verdict than to over-read noise.
4. **Primary significant with meaningful effect, but the mechanism gate fails → `PARTIAL`.** R3 primary (lesson vs nothing) significant with CI lower ≥ +0.05, but the mechanism contrast (lesson vs placebo) is not significant: the gain cannot be attributed to the lesson's content [Hermes-PROTOCOL §9.4 "PARTIAL" interpretation].
5. **Else → `SUPPORTED`.** R2 recall ≥ 80%; noise false-lesson rate = 0; usefulness ≥ 80% with 0 wrong/harmful; 100% lessons ≤ 200 chars; R3 primary and mechanism both significant with meaningful effects; audit–ledger agreement = 100% with the correct `too early → working` transitions; control & robustness gates all clear; install 100% [Hermes-PROTOCOL §9.4 "SUPPORTED" interpretation].
6. **Gate-0 fails → `UNDERPOWERED`.** Fewer than 80 completed trials per arm, fewer than 100 unique crossed items, a route deviation, a failed blinding audit, or misfire rate > 10%; no scientific verdict is reported [Hermes-PROTOCOL §9.1].

**Verdict licensing (verbatim, Hermes-PROTOCOL §9.4):**

- `SUPPORTED`: "An agent given these grounded lessons performs better, on held-out tasks from the lessons' failure domains, than the same agent without them — and the gain is attributable to the lessons' actionable content, not to mere injection or topic priming. Scope: the pre-specified route and prompt-kind lessons."
- `PARTIAL`: "The lesson arm outperforms nothing, but an equally topically-relevant non-directive memory achieves the same gain. We cannot distinguish 'this lesson helped' from 'any reminder of the failure domain changed behavior.' Claim not established."
- `NOT SUPPORTED`: "No evidence that receiving these lessons improves performance beyond chance at a meaningful magnitude."
- `FALSIFIED`: "Agents given these lessons perform significantly WORSE than agents given nothing (RD CI excludes 0 on the negative side / harm detected). Deploying these lessons as written would degrade performance."
- `UNDERPOWERED`: "Gate-0 validity requirements were not met; no scientific verdict is reported. Do not interpret as evidence of absence."

The falsification branches are stop-and-escalate: once a `FALSIFIED` branch fires, the run stops and no "rescue" continuation is permitted — the standing precedent that a second identical failure of the same sign compounds rather than erases the first. Sensitivity analyses (corrected CI formula, alternative dataset definitions, alternate grading regimes) run only AFTER the verdict is printed and cannot overturn it [Hermes-REPORT §2.3, §2.5, §11; Hermes-PROTOCOL §7.2].

# 3. The five runs

All live runs execute on **OpenClaw 2026.9.6** with **GPT-6 Luna** over the **real chat path**; `rawLog: true` is set from a **fresh store** so the live raw files match `/refine report` (the match holds only for a store that had `rawLog` on from the start) [RAW-FORMAT.md]. Every raw file is committed to `docs/proof/raw/` after each run.

## 3.1 R1 — Replay of 125 real dialogs

- **What is executed:** `openclaw refine-cycle replay <corpus> <storeDir> [sourcesDir] --raw <file.jsonl>` (CLI-only; writes the same raw lines as the live path) [USAGE.md; RAW-FORMAT.md].
- **Inputs:** 125 real coding-agent dialogs of the owner (RETRIEVED count). Two arms: (A) a rebuilt corpus carrying tool-call arguments in the format of `test/fixtures/corpus-with-args.jsonl` (both the direct `send_report` form and the `tool_call` wrapper form) — primary; (B) today's corpus, which carries **no** arguments until it is rebuilt — stated limit.
- **Settings:** replay overrides `backfillSessions = 0`, `keepSessionDays = 0`, `keepSessions = 0`, `maxModelCallsPerDay = 100000`; empty store and a new-or-empty raw file are required [USAGE.md].
- **Raw produced:** one `run` line, then one `session` line per corpus session; the report is recomputed from the last lines alone, and `test/replay.test.ts` ("replay --raw …") checks the recomputation against the report [RAW-FORMAT.md].
- **Model calls:** 0 unless the optional stub-model arm is run (≤ 20), which measures only what reaches the model and is not primary evidence.
- **Stated limit:** the without-arguments arm's numbers are a floor, not an estimate — phase 0 disclosed that exported dialogs keep tool results but not call arguments, so "the agent fixed it" means only "a later call of the same tool succeeded" [MEASUREMENT-2026-09-25].

## 3.2 R2 — Live scenario benchmark

- **What is executed:** ~20 scenarios, each run over several fresh sessions through the real chat path (§4): ~10 lesson-fixable, ~5 not-fixable (knowledge gap or wrong tool), ~5 noise (one-off failure, network outage, rule already stated in the agent's `AGENTS.md`).
- **Inputs:** the frozen scenario manifest, SHA-pinned in `docs/proof/` before trial #1 (§4).
- **Raw produced:** live `raw/<YYYY-MM-DD>.jsonl` (per UTC day, read together), last line per `(agentId, sessionId)` counts; `/refine audit`, `/refine status`, and the notice log are captured at the reads scheduled in §9.

## 3.3 R3 — A/B test on learned lessons

- **What is executed:** each lesson the plugin learned by itself in R1 and R2 is tested three ways on fresh tasks: (A) with the lesson; (B) with nothing; (C) with a same-length note that says nothing useful (§6).
- **Inputs:** the frozen R3 assignment manifest (§6); lessons included only if they clear S3/S4.
- **Metric:** whether the agent's first tool call is right, on fresh tasks, scored deterministically from the host transcript (§6).

## 3.4 R4 — Control and robustness, live

- **What is executed, as falsifiable checks (§10):** H-C1 a withdrawn lesson is never relearned; H-C2 the daily budget holds under concurrent sessions; H-C3 a broken store fails open; H-C4 the commands (`audit`, `status`, `run`, `dry-run`) and the `refine_run` tool work.

## 3.5 R5 — Install

- **R5.1** Clean install by the README on a fresh Linux host: the four steps verbatim — (1) `openclaw plugins install git:github.com/Bergschloss/Refine-Cycle-for-OpenClaw --accept-capabilities` (the non-ClawHub warning is answered after review); (2) `openclaw config set plugins.entries.refine-cycle.hooks.allowConversationAccess true`; (3) `openclaw gateway restart`; (4) send `/refine status` in chat [README]. (USAGE.md documents the equivalent check `openclaw refine-cycle list`, which answers 'No lessons yet.' before any lesson is learned.)
- **R5.2** The same on OpenClaw Tray (WSL on Windows).
- **R5.3** The Update button against a local git release: a new tag is pushed to the git remote; the "♾️ Refine Cycle — update available: <version>" notice appears once with an Update button; pressing it runs `/refine update`, which answers "updated to <version>", "is up to date", or "update failed" with the reason; `checkForUpdates: false` turns the notice off [USAGE.md].
- **R5.4** The lesson message in chat/Telegram: one line per learned lesson ("♾️ Refine Cycle — new lesson learned (412/4400)", or `getting tight` from 90% / past-soft-limit text), delivered once per activating pass (`announce()` fires once per pass that activated lessons; `say()` sends the text), with `notifyOnLesson: false` as the off switch [README; USAGE.md; DESIGN.md].

# 4. Scenario design rules for R2 (the benchmark cannot be tuned to the plugin)

**Fixed list, written before any run.** The ~20 scenarios are authored and SHA-pinned in `docs/proof/scenarios-manifest-*.json` before trial #1; the manifest records for every scenario: `scenario_id`, `category` (`fixable` / `not-fixable` / `noise`), the frozen applicability predicate (tool + error pattern, predicate-first, Hermes-PROTOCOL §2.4), the locked expected correct first tool call (name + arguments), the number of sessions, the prompt scaffold, the E1/E2 exclusion log, and a `reserve` flag. The SHA-256 of the manifest is recorded in the freeze table; any scenario added, removed, or edited after trial #1 voids pre-registration.

**No scenario dropped after seeing results.** Exclusions are logged with a reason and declared as a deviation (§12). If a scenario misfires (the injected failure never fires), the whole item is replaced from the frozen reserve pool — never a single arm (§6).

**Realistic tools and failure modes.** Scenarios are derived from (a) the plugin's own failure signatures and the phase-0 tasks — `schedule_backup(cron)` that fails unless all five cron fields are present; `send_report(date)` that fails unless the date is `YYYY-MM-DD` — and (b) the plugin's fingerprint taxonomy (`transient`, `wrong_tool`, `dropped_argument`, `commandTimesOut`) [MEASUREMENT-2026-09-25; DESIGN.md; src/core/shape.ts]. Failure modes mirror real recurrence: the same wrong date in a later session, the same missing flag, the same command that never works on this machine [README].

**Noise scenarios designed to tempt a false lesson.** The ~5 noise items are built so that a careless plugin would learn the wrong thing: a one-off failure that never recurs; a network outage/remote timeout with a different exit code (transient by design); a rule the agent's own `AGENTS.md` already states verbatim (the `already_covered` trap). The success bar S2 = 0 false lessons is what makes these discriminating rather than ornamental.

**Sessions per scenario (decided now):**
- *Fixable (~10):* up to 5 sessions, or until the first correct tool call; recall is measured over the first 3 sessions (matches the `MIN_QUIET_SESSIONS = 3` gate). Reason: a fixable scenario must be learnable within the plugin's own exposure window, and the audit's "working" verdict itself needs 3 quiet sessions [DESIGN.md].
- *Not-fixable (~5):* exactly 3 sessions; the expectation is defined per scenario in the manifest — either no lesson is produced, or a lesson names the gap (e.g. a missing tool or a wrong tool choice) rather than prescribing a fix that cannot work. Reason: "most repeats cannot be fixed by a lesson: roughly 46% are knowledge gaps, 37% a wrong tool choice" [DESIGN.md]; producing no false lesson here is the pass condition.
- *Noise (~5):* 1–2 sessions only, so evidence does not accumulate past the repeat bar. Reason: a noise scenario run until recurrence would manufacture a pattern and invalidate H2; 1–2 sessions is enough to show the refusal path fires.

**Prompting.** One identical scaffold for every scenario; only the task text varies; the system prompt is fixed and committed with the manifest. Reason: any scaffold difference between scenarios is a confound; arm differences exist only in R3 (§6), where the scaffold is also held fixed.

**Randomization.** Scenario order is randomized per day with a seeded, logged RNG (seed recorded in the run log); every scenario-run uses a fresh agent session; the day boundary is UTC. Reason: per-day randomization spreads any host-level drift across categories while keeping the audit's calendar-day clock honest (§9).

**Leakage screens (applied before any run; Hermes-PROTOCOL §2.3):**
- **E1 exact-fingerprint exclusion:** every conversation in a lesson's derivation set D(l) is excluded from that lesson's R3 item pool (and from probe seeding).
- **E2 surface near-duplicate screen:** for each candidate task, bigram Jaccard and TF-IDF cosine are computed against every conversation in D(l), against all R2 scenarios, and against previously used tasks; reject if bigram Jaccard > 0.15, or any full-sentence match, or TF-IDF cosine > 0.40. All exclusions are logged with scores.
- **R4 fresh surface content:** authored probes carry new entities, repositories, credentials, and error strings, so R3 measures transferable behaviour, not recall [Hermes-PROTOCOL §2.4].

**Raw integrity.** `rawLog: true` from a fresh store for R2/R4, so the live raw files match `/refine report`; without this the live report also counts pre-`rawLog` history and would not recompute [RAW-FORMAT.md].

# 5. Lesson grading

**Two-layer design.** This protocol departs from the Hermes plugin, whose primary endpoint grader was a deterministic SHA-pinned Python checker keyed only on tool calls (`lesson_effect_checker.py`, SHA-256 `d2834b94bf95a15a9dde118387ab348a64deeeabd4e1e2683d0b3f73d33ac7bc`) [Hermes-REPORT §2.1]. That design is kept for R3's primary endpoint (first-tool-call correctness, §6). The four-category lesson-quality rubric required here — `useful / restates an existing rule / wrong / harmful` — is NEW design work for this protocol and is graded by a blind panel, because it is a judgment no deterministic checker can make. Hermes's own largest deviation was replacing its pre-registered grader panel with the deterministic checker [Hermes-REPORT §2.4; Hermes-PROTOCOL §7.2]; this protocol commits to the panel and reports any replacement as a deviation.

**Blinding.** The judge receives only `{opaque_item_id, tool, failure_shape, lesson_text, session_context, existing_rules}`: the failing tool, the normalized error/shape (≤ 300 chars), a short redacted session-context excerpt (≤ 500 chars, with all memory/lesson text and parameter values stripped), the lesson text, and — for the `restates` check — the text of the agent's existing instruction/skill rules that cover the tool. The judge NEVER sees the arm, the source session, the scenario label, the route/model, or any study framing. The arm → random-code mapping is held by a separate operator until the adjudicated labels are frozen [Hermes-PROTOCOL §7.3]. Lesson length (≤ 200 chars) is computed deterministically from `raw lesson.text`, never by the judge (bar S4).

**Frozen rubric — four categories with decision rules:**

- **useful**: the lesson names the failing tool and the observed failure, states a concrete action that would have prevented or corrected it, and is not already covered by the agent's own instructions or skills. A competent agent following the lesson on the next recurrence would make the right first tool call.
- **restates an existing rule**: the advice duplicates a rule the agent already has. Grade `restates` if EITHER (a) the session context shows an existing rule covering this tool that already states what the lesson says, OR (b) ≥ 70% of the lesson's content words (letters-only tokens of length ≥ 3, case-folded) also appear in an existing rule text supplied in the packet. This mirrors the plugin's `covered.ts` already-covered check, but the ≥ 70% threshold is a protocol-specified grading rule, not a claim about the plugin's internal arithmetic. When both `useful` and `restates` seem possible, prefer `restates`.
- **wrong**: the lesson is actionable but would NOT fix this failure — it names the wrong tool, the wrong argument, an action that contradicts the `failure_shape` evidence, or an action that would leave the same failure recurring.
- **harmful**: following the lesson would cause a call that is currently correct to fail, or would suppress an action the agent needs to take, or would introduce a new failure. Harm overrides all other categories.
- **skipped** (administrative): `lesson_text` is empty or only punctuation/whitespace; reported as a row but excluded from the denominator.

**Decision order:** harmful first; then `restates` (covered-rule check); then `useful` vs `wrong`.

**Scramble-screen (directive-survival) question for the placebo arm, decided before grading (Hermes-PROTOCOL §3):** the judge answers, for every packet, `scramble_screen: YES | NO` — "Does this note tell the agent what to DO in a failure situation (name a concrete action to take when this failure recurs)?" A real lesson must be YES; a same-length placebo note that is YES FAILS the screen and is flagged in `notes` and excluded from arm C. A placebo that survives (NO) is topical vocabulary with no directive.

**Panel (amended before freeze, owner decision 2026-09-29; see Amendment A1):** three LLM graders, each from a different model family and none from the agent route's family (the route is OpenAI GPT-6 Luna): Anthropic Claude, Google Gemini, and one open-weight family (Qwen or Llama, whichever is available; the exact model ids are recorded in the frozen-artifacts table at freeze). There is no human grader: the owner has none available. Reason for three families: a single model family risks self-preference and shared blind spots; Hermes observed the same lessons flip sign across routes, +0.20 on Luna vs −0.20 on mimo-v2.5 [Hermes-REPORT §1.3]. Calibration: ~30 probes balanced across arms, graded by all three before full grading; acceptance = Fleiss' κ ≥ 0.60 across the three; below it, ambiguous rubric wording is rewritten and calibration repeats, before trial #1 only. Every item is graded by all three. The label is the 2-of-3 majority; with no majority, the most severe of the three labels is taken (harmful > wrong > restates > useful), a conservative tie-break that can only lower the useful rate. Each grader's own rate is reported beside the majority rate. The absence of a human grader is a stated limit (§11 T5).

## 5.1 Full grader prompt (committed with the rubric; also Appendix C)

```
You are grading short "lessons" that a coding-agent plugin may inject into an agent's prompt.
You are a BLIND judge. You must never try to infer which experimental arm, scenario, or source
session produced the lesson, and you must not score based on how much you like the prose.
Grade ONLY what is in the packet below.

PACKET (all you receive):
- item_id: an opaque string. Do not try to decode it.
- tool: the name of the failing tool.
- failure_shape: the normalized error/shape that recurred (at most 300 characters).
- session_context: a short excerpt of the session around the failure (at most 500 characters),
  with all memory/lesson text and tool parameter values redacted.
- existing_rules: the text of the agent's own instruction/skill rules that cover this tool
  (may be empty).
- lesson_text: the lesson sentence to grade (up to 200 characters); it may be empty.

STEP 1 — SCRAMBLE SCREEN (answer first, one word, YES or NO):
Does lesson_text tell the agent what to DO in a failure situation — that is, does it name a
concrete action the agent should take when this failure recurs?
YES = directive (normal for a real lesson; a SAME-LENGTH PLACEBO note that is YES fails the
placebo screen and must be flagged in `notes`).
NO = names no concrete action (required of a placebo note).

STEP 2 — LENGTH (compute exactly; do not guess):
length_chars = number of characters in lesson_text.
length_status = "ok" if length_chars <= 200, else "over_cap".
A lesson over 200 characters is defective regardless of content (hard code cap).

STEP 3 — CATEGORY (choose exactly one, in this order):
(a) harmful: following the lesson would cause a call that is currently correct to fail, or
    would suppress an action the agent needs, or would introduce a new failure.
(b) restates an existing rule: the advice duplicates a rule the agent already has — EITHER
    session_context shows an existing rule that already states this, OR at least 70% of
    lesson_text's content words (letters-only tokens of length >= 3, case-folded) also appear
    in existing_rules. When in doubt between useful and restates, choose restates.
(c) useful: the lesson names the failing tool and the observed failure, and states a concrete
    action that would have prevented or corrected it; it is not already covered by the agent's
    own instructions or skills; a competent agent following it on the next recurrence would
    make the right first tool call.
(d) wrong: the lesson is actionable but would NOT fix this failure (wrong tool, wrong
    argument, contradicts failure_shape, or leaves the same failure recurring).
(e) skipped: lesson_text is empty or only punctuation/whitespace.

STEP 4 — BLINDING CHECK:
If the packet contains any arm label, route/model name, scenario name, or study framing, do
not grade; set category = "skipped" and report it in `notes`.

OUTPUT (strict JSON, exactly these keys, nothing else):
{
  "item_id": "<copy the packet item_id exactly>",
  "scramble_screen": "YES" | "NO",
  "length_chars": <integer>,
  "length_status": "ok" | "over_cap",
  "category": "useful" | "restates" | "wrong" | "harmful" | "skipped",
  "confidence": <float 0.0-1.0>,
  "notes": "<one or two sentences; cite the specific words that drove the category; flag a
            directive placebo here if scramble_screen is YES>"
}
```

# 6. R3 design — A/B test on learned lessons

**Arms (within-item, three levels):**
- **A — real lesson:** the lesson text the plugin learned by itself in R1 or R2 (verbatim from the raw `lesson` field).
- **B — nothing:** no injection; empty memory for that item.
- **C — same-length useless note (placebo):** a note of the same length as the real lesson (± 1 word), built from topical vocabulary drawn from the failure domain but containing no directive; it must pass the scramble screen of §5 (`scramble_screen = NO`). Placebo construction follows the Hermes scramble design: same vocabulary, non-advisory prose [Hermes-PROTOCOL §3; Hermes-REPORT §2.1]. The directive-survival screen from §5 applies before a placebo is admitted.

**Item count and power (why N is enough).** The design is within-item: each fresh task is run crossed in all three arms, a fresh instance per cell. Target: **120 completed crossed items** (≈ 10 items per lesson if 12 lessons are available; the manifest blocks by lesson). Gate-0 minimum: **80 completed crossed items**. Power is taken from the Hermes protocol's paired-exact-McNemar table at RD = +0.20, two-sided α = 0.05 [Hermes-PROTOCOL §5.2]: N = 60 → 0.73–0.81; N = 80 → 0.85–0.92; N = 100 → 0.93–0.97; N = 130 → 0.97–0.99. At the target N = 120, power interpolates to ≈ 0.95 for RD = +0.20, and harm of RD = −0.20 would be detected with probability ≈ 0.93 (N = 100 → 0.93). The Gate-0 minimum of 80 still gives 0.85–0.92. Below 80 completed crossed items the decider returns `UNDERPOWERED` with no scientific verdict — it is better to report no verdict than to over-read noise [Hermes-PROTOCOL §5.2, §9.1].

**Per-lesson inference is DESCRIPTIVE ONLY.** With ≈ 8–10 items per lesson, paired-McNemar power at RD = +0.20 is under 1% [Hermes-PROTOCOL §5.3]. No causal claim is made for any single lesson; the pre-registered estimand is the pooled lesson-level effect, and per-lesson rates are reported as descriptive heterogeneity. This mirrors Hermes, whose only pre-registered per-lesson statement was the A/B on fingerprint `51ad58a9a362` [Hermes-REPORT §1.3].

**Randomization and blocking.** Items are blocked by lesson (all three arms of one item use the same lesson). Within each block, arm order is randomized per item with a seeded, logged RNG (seed recorded in the run log). Reason: blocking holds lesson difficulty constant across arms; per-item randomization of arm order guards against order effects — Hermes found blocked-arm ordering a weakness when arms ran in fixed blocks. Every `(item × arm)` cell runs in a newly instantiated agent session with ONLY that arm's memory text present; the rendered system+memory context digest is hashed and logged per cell (fresh-instance rule, non-negotiable) [Hermes-PROTOCOL §4.2].

**Route lock.** Provider, model (`GPT-6 Luna`), temperature, `top_p`, and max tokens are fixed and logged per trial; the same values are used for every cell including both placebos. Reason: a route change mid-run would confound every contrast; Hermes observed opposite-sign effects across routes, so a single-route run's claim is explicitly route-scoped [Hermes-REPORT §1.3; Hermes-PROTOCOL §4].

**Scoring rule — deterministic, from the host transcript, never from the agent's reply.** A checker reads the raw file / host transcript and scores the agent's **first tool call (name + arguments)** against the scenario's locked expected correct call (§4). Score only trials with `trigger_fired = true` (the injected failure actually occurred). Misfires are reported outside the denominator [Hermes-PROTOCOL §6.2; Hermes-evidence DECISION_RULE_ab.md scoring protocol]. The agent's prose reply is never scored. Reason: the endpoint is tool-call correctness, not judged prose [Hermes-REPORT §1.1].

**How a task counts as fresh.** Before admission, each candidate task passes: E1 exact-fingerprint exclusion against all R1 source sessions (both arms), all R2 scenarios, and all previously used R3 tasks; E2 surface near-duplicate screen (bigram Jaccard > 0.15, any full-sentence match, or TF-IDF cosine > 0.40) against the same sets; and the R4 fresh-surface rule — new entities, repositories, credentials, and error strings, so the trial measures transferable behaviour, not recall [Hermes-PROTOCOL §2.3–2.4].

**Misfires and replacement (decided in advance).**
- **Misfire:** the injected trigger never fires (the agent solved the task via a path that avoided it). The trial is excluded from the denominator, logged with reason, and never scored by the grader. Decision is made by the operator against a written checklist — never by the grader, never after seeing the outcome label [Hermes-PROTOCOL §6.2].
- **Provider failure / timeout:** retry once with identical parameters; if it fails again → MISFIRE. The aggregate provider-failure rate is reported; > 5% → `INVALID_RUN` [Hermes-PROTOCOL §6.2].
- **Replacement:** replace the WHOLE ITEM from a frozen reserve pool — never a single arm. The reserve pool is ≥ 20% of items; there are zero hybrid items (no item mixing lessons from different R2 scenarios). An audit of the assignment manifest confirms, before unblinding, that every item has exactly 3 arms, identical slotless scaffold digests within each item, and a single config digest across the run [Hermes-REPORT §2.5]. Reason: replacing a single arm would break the within-item pairing; whole-item replacement preserves it.

# 7. Analysis plan

All analyses are specified before trial #1. The locked `analysis_decider.py` (Appendix D) implements the statistics below and prints the verdict; no analysis is run outside it before the verdict is printed.

**Per-metric statistics:**

| Metric | Statistic |
|---|---|
| R1 cross-session repeat recall | Wilson 95% confidence interval for the proportion |
| R2 fixable-scenario recall (≤ 3 sessions) | Wilson 95% CI |
| R2 noise false-lesson rate | Exact binomial (Clopper–Pearson) one-sided 95% upper bound; with 0 observed events the rule of three gives an upper bound of 3/N |
| Lesson usefulness rate | Wilson 95% CI on the 2-of-3 majority label; each grader's own rate reported beside it |
| Wrong / harmful lesson count | Count = 0 required; if any, exact binomial upper bound reported |
| Lesson length compliance | Count and % with `len ≤ 200` (100% required) |
| Audit–ledger agreement | Proportion agreement with exact (Clopper–Pearson) 95% CI; must be 100% |
| Notices per lesson | Count per `lessonId`; 1 required, 0 missed |
| Budget cap | `max(budget.callsToday)` per UTC day ≤ `maxModelCallsPerDay`; any exceedance is a hard fail |
| R3 primary & mechanism contrasts | Exact two-sided McNemar on discordant pairs; Agresti–Wald 95% CI for the paired risk difference RD [Hermes-REPORT §2.3] |

**Multiple comparisons.** Holm correction at familywise α = 0.05 over EXACTLY the two pre-specified planned contrasts: C1 lesson vs nothing (primary, licensed from Hermes H0a [Hermes-PROTOCOL §1.3]) and C2 lesson vs placebo (mechanism gate, licensed from Hermes H0b). Any additional contrast (e.g. nothing vs placebo as a sanity check that the two controls do not differ) is exploratory and labeled so [Hermes-PROTOCOL §8.8]. Departure from Hermes-PROTOCOL §8.8: Hermes fixes three planned contrasts (C1 lesson-vs-nothing, C2 lesson-vs-topic-placebo, C3 lesson-vs-scramble-placebo); because OpenClaw R3 has three arms (lesson/nothing/placebo) and no topic-placebo arm, this protocol fixes exactly two (C1 lesson-vs-nothing as primary, C2 lesson-vs-placebo as mechanism) and treats any further contrast as exploratory. Reason: the familywise error rate is controlled only over contrasts fixed before data; each post-hoc contrast adds a tested hypothesis and inflates the false-positive rate.

**Meaningful-effect floor.** RD ≥ +0.05 is the pre-specified floor [Hermes-PROTOCOL §5.2, §9.3]. A primary contrast that is statistically significant but whose paired 95% CI lower bound is < +0.05 is reported as `NOT SUPPORTED`. Reason: with N = 120 the design is powered for effects near +0.20; a tiny significant RD is indistinguishable from scaffold artefact and would invite over-reading noise.

**Verdict logic (strict order, §2.1):** harm → `FALSIFIED`; primary not significant → `NOT SUPPORTED`; primary significant with CI lower < +0.05 → `NOT SUPPORTED`; primary significant with CI lower ≥ +0.05 but mechanism not significant → `PARTIAL`; else → `SUPPORTED`; Gate-0 failure → `UNDERPOWERED`. The decider prints the verdict string verbatim and nothing else is reported as the verdict.

**Sign-error discipline.** If a corrected computation differs from the frozen contract (as happened to Hermes's own decider, whose covariance sign widened intervals against significance [Hermes-REPORT §2.3]), the value under the frozen contract is the decision quantity and the corrected value is published as a labelled sensitivity analysis; all verdicts are reported under both. Reason: moving the decision rule after seeing data is outcome-definition drift, the deviation Hermes §8.13 was written to prevent.

**Deviations.** A deviation is any change to this protocol, the decider, the manifests, the rubric, or the analysis plan after trial #1, and any pre-registered check that was amended after it failed. Each deviation is reported in the three-part form: (1) what happened; (2) its consequence for the affected metric or verdict; (3) a harmlessness-or-breach argument. Checks amended after failing are reported with chronological honesty — the abort is stated before the amended pass, because a check made to pass after it failed, on a favourable run, is worth less than the abort plus the independent measurement [Hermes-REPORT §2.4, §2.6; Hermes-PROTOCOL §8.13].

# 8. Budget and stopping

**Budget.** All runs share about 800 GPT-6 Luna model calls. The allocation has a soft target and a hard cap per run; the operator queues runs so the cumulative total never exceeds 800, and the decider stops R3 early if the running total would exceed it (reporting the achieved N against Gate-0).

| Run | Soft target | Hard cap | Reason |
|---|---|---|---|
| R1 replay (no model) | 0 | 0 | offline replay; the loop reads history and refuses before any model call |
| R1 stub-model arm (optional) | 20 | 20 | measures only what reaches the model, as in the README phase-0 stub replay; not primary evidence |
| R2 live scenarios | 120 | 150 | ~20 scenarios × up to ~5 sessions; many sessions refuse without a model call (`below_bar` / `self_corrected` / `already_covered`) |
| R3 A/B | 360 | 400 | 120 items × 3 arms, one model call per single-turn task; the dominant cost |
| R4 control & robustness | 60 | 80 | C1 withdrawal re-triggers, C2 concurrency probes, C3 fault injection, C4 command runs |
| R5 install | 40 | 50 | two clean installs, Update verification, message verification |
| Slack / reserve | 200 | 220 | misfire retries, provider-blip re-runs, calibration probes, adjudication |
| **Total** | **800** | **920** | keep the shared envelope under ~800; hard caps bound the worst case |

Reason for the ~800 envelope: it is the ceiling the owner budgeted ("all runs share about 800 GPT-6 Luna calls"); the table keeps the dominant cost (R3, ~360) inside it with slack for misfires.

**Provider rate limits.** On rate limit or timeout: back off and queue; retry once with identical parameters; if it fails again → MISFIRE. The aggregate provider-failure rate is reported; > 5% → `INVALID_RUN` [Hermes-PROTOCOL §6.2]. The route is NOT switched (route lock, §6); if the provider is down for > 24 h the run pauses and the pause is recorded as a deviation. Reason: switching route would confound every contrast; a > 5% failure rate means the denominator is no longer representative.

**Stopping rules:**
1. **Gate-0 first.** ≥ 80 completed trials per arm, ≥ 100 unique crossed items, a single route, the blinding audit passes, misfire rate ≤ 10%. If any gate fails → `UNDERPOWERED` and no scientific verdict is reported [Hermes-PROTOCOL §9.1].
2. **Hard budget cap.** If the cumulative call total hits 800 before R3 completes, the run stops and is reported as-is, with the achieved N assessed against Gate-0.
3. **Falsification is terminal.** If any `FALSIFIED` branch of §2.1 fires (harm, withdrawn lesson relearned, audit–ledger disagreement, crash, lost turn, budget exceeded, install crash), the run stops immediately and prints `FALSIFIED` with no "rescue" continuation. The standing precedent is that a second identical failure of the same sign compounds rather than erases the first.
4. **Sensitivity after verdict.** All sensitivity analyses (corrected CI formula, alternative dataset definitions, alternate grading regimes, per-lesson descriptive rates) run only AFTER the verdict is printed and cannot overturn it [Hermes-REPORT §11; Hermes-PROTOCOL §7.2].

# 9. Timeline (the audit truth needs a live part spanning ≥ 3 days)

The audit's `working` verdict is calendar-day-floored: `ageDays = floor((now − createdAt) / 86_400_000)`, and it requires `MIN_QUIET_SESSIONS = 3` quiet sessions with no recurrence, "no earlier than 3 days after the lesson appeared" [DESIGN.md; src/core/audit.ts; README]. The timeline is therefore designed so the clock actually elapses, and no mechanism may bypass it.

| When | Activity | Reason |
|---|---|---|
| Day 0 | R5.1/R5.2 clean install on both hosts (fresh Linux, OpenClaw Tray WSL); freeze all manifests and record every SHA-256 in the freeze table; R1 replay of both corpus arms | Install must be proven on a clean host before it can be trusted for the live runs; freezing before any live trial anchors pre-registration |
| Days 0–3 | R2 live scenarios, scheduled across days (≈ 6–7 scenarios/day, order randomized per day with the logged seed) | The 3-day/3-session `working` gate is calendar-day-floored; spreading sessions across days prevents backdating or replaying the clock from satisfying it artificially |
| Day 1 | First `/refine audit` read (or ledger dump); every lesson must read `too early` (shown < 3 quiet sessions or age < 3 days) | Captures the pre-gate state so the transition can be observed |
| Day 3 | Second `/refine audit` read; verify each lesson's verdict; recompute the ledger from the raw files and compare | First date a lesson can be `working` (ageDays ≥ 3) |
| Day 5 | Third `/refine audit` read; final audit–ledger agreement check; transitions `too early → working` must match the ledger's first satisfying pass exactly | Confirms stability of the verdict and 100% audit–ledger agreement (S9 bar) |
| Day 3+ | R3 A/B (items blocked by lesson, arm order randomized) and R4 control & robustness checks | R3 depends on lessons learned in R1/R2; R4 can interleave once the store is proven stable by the day-3 audit |

**Explicit clock rule.** No backdated sessions, no store editing, and no replay of the system clock is permitted anywhere in this protocol. If a lesson needs to age to day 3, the run waits real time; a `working` verdict observed before day 3 is recorded as a protocol violation and the audit claim is reported as `FALSIFIED` for that lesson. Reason: `ageDays` is computed from the wall clock, and a synthetic clock would make the `working` gate untestable.

# 10. Control and robustness (R4) as falsifiable hypotheses

These four checks use the `HYPOTHESES.md` scaffold: **Title / What could be wrong / Why the codebase would produce it / The one probe / Confirms it / Clears it**. Live-server evidence is reported separately from synthetic/code evidence. These are VERIFICATION checks, not experiments — they add no causal evidence [Hermes-REPORT §5].

---

**H-C1 — A withdrawn lesson is relearned.**

- **What could be wrong:** after `/refine delete <id>`, reproducing the same failure causes the plugin to re-propose or re-activate the identical lesson.
- **Why the codebase would produce it:** `lessonId = sha1(\`${agentId}|${fingerprint}|${text.toLowerCase().trim()}\`).slice(0,10)` is content-addressed; if the tombstone is not consulted at propose/activate time, the identical text is accepted again. `activateLocked` is documented to throw `LessonExistsError`, and the pipeline refuses re-proposal of an existing or withdrawn lesson [DESIGN.md; src/lessons.ts; src/pipeline.ts] — the probe tests that this holds live, across processes.
- **The one probe:** `/refine delete <id>` a lesson whose failure is still reproducible; then run N = 5 new sessions that reproduce the same fingerprint (fresh sessions, same failure, real chat path); read the raw `lesson_status` lines and any `proposedLesson`/`lesson` fields.
- **Confirms it:** a raw `lesson_status`, `proposedLesson`, or `lesson` line carrying the deleted lesson's id or text; or a `LessonExistsError` that is swallowed without surfacing.
- **Clears it:** 0 re-proposals and 0 re-activations across the 5 sessions; the refusal path logs the expected error. Live evidence: the raw file. Synthetic evidence (reported separately): code read of the tombstone consult in `activateLocked` and the refusal path.

**H-C2 — The daily budget breaks under concurrent sessions.**

- **What could be wrong:** C concurrent sessions each demand a model call at the same instant; more than `maxModelCallsPerDay` (default 3) model calls are recorded in a single UTC day.
- **Why the codebase would produce it:** `reserveCall` takes a non-blocking lock (`store.lock("budget", 0)`, wait 0); under concurrency a writer receives `budget_busy`, but a race between the lock acquisition and the cap check could let two writers each reserve [DESIGN.md; src/pipeline.ts].
- **The one probe:** launch C = 10 concurrent sessions, each with a repeated failure requiring a call, across separate processes at the same instant; read raw `modelCalls[]` and `budget.callsToday` for that UTC day.
- **Confirms it:** any UTC day with `modelCalls > 3`, or with `budget.callsToday` exceeding `maxModelCallsPerDay` at any line.
- **Clears it:** exactly 3 `modelCalls` that day; the remaining 7 sessions recorded with `budget_busy` in the raw `error`/`outcome` field [RAW-FORMAT.md]. Live evidence: the raw file. Synthetic evidence (reported separately): the lock code and the cap check.

**H-C3 — A broken store breaks the agent (fail-open fails).**

- **What could be wrong:** a torn `meta.json` or `EACCES` on the store dir crashes the agent's turn, loses the turn, or leaves a half-written lesson.
- **Why the codebase would produce it:** a hook that throws without a catch would abort the host turn; a partial write could leave the store wedged.
- **The one probe:** corrupt the store (truncate `meta.json` to torn JSON; then separately `chmod 000` the store dir for `EACCES`), then run one normal agent turn that would otherwise trigger a learning pass.
- **Confirms it:** an uncaught exception, a lost/crashed turn (non-zero exit), or any `lesson`/`proposedLesson` written while the store was broken.
- **Clears it:** the turn completes normally; the raw line for that pass carries `error` with `storeErrorText: "Until then nothing is learned or injected; the agent works as without the plugin."`; `lesson`/`proposedLesson` are null; hooks are no-op [USAGE.md; DESIGN.md]. Live evidence: the raw file + host exit code. Synthetic evidence (reported separately): the store-error catch path in the hooks.

**H-C4 — The commands and the `refine_run` tool misreport or misbehave.**

- **What could be wrong:** `audit`/`status`/`run`/`dry-run` return wrong data, wrong exit codes, or the `refine_run` tool ignores the budget or blocks the agent's turn.
- **Why the codebase would produce it:** a hand-started pass that does not reuse `processSession`, or a `dry-run` that saves, or a CLI that exits 0 on an unknown id.
- **The one probe:** run each of `/refine audit`, `/refine status`, `/refine run [reason]`, `/refine dry-run [session <id>] [reason]` in chat and on the CLI with `--json`, and invoke the `refine_run` tool from an agent session that has a repeated failure; capture outputs and exit codes.
- **Confirms it:** an unknown id exits 0 (the CLI is documented to exit 1 on an unknown id or a busy store [USAGE.md]); `audit` verdicts disagree with the ledger; `dry-run` leaves a raw `lesson` line (it must save nothing); `refine_run` answers synchronously while the pass is still pending, or exceeds the daily cap; the agent's turn blocks waiting for the pass.
- **Clears it:** `audit`/`status`/`run`/`dry-run` produce their documented outputs with exit 0 (`--json` parses); `dry-run` records no lesson and saves nothing; `refine_run` answers at once ("started"), the pass completes in the background under the same limits, and the day's cap is respected [USAGE.md; DESIGN.md]. Live evidence: command outputs and raw lines. Synthetic evidence (reported separately): the shared `processSession` path and the background-queue code.

# 11. Threats to validity

Each threat states why it matters here and how it is handled or disclosed.

**T1 — A synthetic benchmark (authored R2 scenarios).**
- *Why it matters here:* authored tasks can be tuned, knowingly or not, to the plugin's refusal rules and lesson shape, inflating recall and usefulness.
- *How handled / disclosed:* scenarios are derived from phase-0 real failure signatures (`schedule_backup` cron fields, `send_report` date format) and from the plugin's own fingerprint taxonomy (`transient`, `wrong_tool`, `dropped_argument`, `commandTimesOut`) [MEASUREMENT-2026-09-25; DESIGN.md; src/core/shape.ts]; the frozen manifest, predicate-first sampling, no post-hoc drops, and the E1/E2 leakage screens (§4–§6) prevent tuning; the R1 replay of 125 real dialogs anchors realism (§3); `source_type` (authored vs replay) is logged and analysed as a heterogeneity covariate; the synthetic origin is disclosed in §0 and in the report. Departure from Hermes: Hermes drew probes from its own failure corpus with predicate-first sampling [Hermes-PROTOCOL §2.4]; the same discipline is applied here.

**T2 — One model (GPT-6 Luna) and one host version (OpenClaw 2026.9.6).**
- *Why it matters here:* the effect may not generalise, and may even flip sign; Hermes itself observed +0.20 on `opencode-go/gpt-5.6-luna` and −0.20 on `opencode-go/mimo-v2.5` at N = 20 per arm, so a treatment-by-route interaction cannot be detected from a single-route run [Hermes-REPORT §1.3].
- *How handled / disclosed:* the route is locked (§6) and the claim is explicitly scoped to this model and host in §0; no generality beyond it is asserted. The scoped-claim discipline is licensed from Hermes-REPORT §1.2 ("on this route, for these probes and this grader").

**T3 — The same team built the plugin and the benchmark.**
- *Why it matters here:* experimenter degrees of freedom (scenario selection, grading, analysis) can be exercised to favour the builder's plugin.
- *How handled / disclosed:* the anti-tuning package — frozen scenario manifest SHA-pinned before trial #1, no scenario dropped after results, blind grading (§5), the locked deterministic decider (§7), SHA-256 pins on all artifacts; the decider is written so an independent party can re-run it from the raw files alone (an hostile reader must be able to recompute every number) [Hermes-REPORT §0]; independent re-run of the decider is invited, following the Hermes `INDEPENDENT-REVIEW.md` precedent.

**T4 — The replay corpus lacks tool-call arguments.**
- *Why it matters here:* without arguments the model "never sees what the agent ran or what its fix changed", so "the agent fixed it" means only "a later call of the same tool succeeded", and the numbers are "a floor … not an estimate" [MEASUREMENT-2026-09-25].
- *How handled / disclosed:* two replay arms (§3); the with-arguments arm (rebuilt corpus in the format of `test/fixtures/corpus-with-args.jsonl`) is primary; the without-arguments arm is a STATED LIMIT and its numbers are labelled a floor, not an estimate — exactly the sign-error discipline Hermes applied to its own exported corpus [Hermes-REPORT §2.4; MEASUREMENT-2026-09-25].

**T5 — A grader that is itself a model.**
- *Why it matters here:* a same-family grader can exhibit self-preference bias, inflating the treatment; Hermes documented that the same route can flip conclusions [Hermes-REPORT §1.3].
- *How handled / disclosed:* three LLM graders from three different model families, none from the agent route's family (Amendment A1); Fleiss' κ ≥ 0.60 calibration before trial #1; the 2-of-3 majority label with a conservative tie-break (most severe label when there is no majority); each grader's rate reported beside the majority; labels frozen before unblinding; the primary R3 endpoint is scored from host transcripts, not by any grader. **Stated limit:** there is no human grader, so the three models may share blind spots no human checked; any grader replacement is reported as a deviation.

**T6 — Small per-lesson samples.**
- *Why it matters here:* with ≈ 8–10 items per lesson, per-lesson McNemar power at RD = +0.20 is under 1% [Hermes-PROTOCOL §5.3].
- *How handled / disclosed:* per-lesson results are DESCRIPTIVE ONLY; the only pre-registered causal estimand is the pooled lesson-level effect (§6). This is stated in §0 and §6.

**T7 — Session blocking / order confounds.**
- *Why it matters here:* if scenarios or arms run in fixed blocks, host-level drift (model updates, rate limits) confounds the comparison; Hermes identified blocked-arm ordering as a weakness.
- *How handled / disclosed:* scenario order is randomized per day with a logged seed; R3 arm order is randomized per item within lesson blocks; each cell is a fresh instance; the route is locked (§4, §6).

**T8 — Open question: the "5f5dd44" commit-tag discrepancy.**
- *Why it matters here:* the task brief refers to "phase 0 (Kiro, main `5f5dd44`)", but `docs/MEASUREMENT-2026-09-25.md` cites commits `5bda1ba`, `23cc57b`, `d7b0831`, `cd306d9`, `955ea0f`, `7d64d59` and never `5f5dd44` [MEASUREMENT-2026-09-25; repo-fact-report]. The wrong pinned commit would make the protocol's freeze unverifiable.
- *How handled / disclosed:* this protocol does not assert `5f5dd44`; it records whatever HEAD it is frozen against and writes that SHA in the freeze table before trial #1. The discrepancy is disclosed here and in §13.

# 12. Deviations and reporting

**Definition.** A deviation is any change to this protocol, to `analysis_decider.py`, to any frozen manifest or rubric, or to the pre-registered analysis plan, made after trial #1 of any run. No edits are permitted after data collection begins; any such change voids the pre-registration for the affected run, which must restart under the amended pre-registration for its verdict to count.

**Reporting form (three parts, Hermes-PROTOCOL §2.4 / §8.13):** (1) what happened; (2) its consequence for the affected metric, threshold, or verdict; (3) a harmlessness-or-breach argument. Every deviation is logged chronologically in `docs/proof/deviations.md`, which is committed alongside the report.

**Chronological honesty (Hermes-REPORT §2.6).** A check that was amended after it failed is reported in the order it happened: the abort is stated before the amended pass, because "a check made to pass after it failed, on a favourable run, is worth less than the abort plus the independent measurement."

**Rubric fidelity.** Rubrics are committed before any run; changes are permitted only via a logged amendment signed before unblinding [Hermes-PROTOCOL §8.13]. A grader replaced, a calibration threshold relaxed, or a double-grade rate cut is a deviation and is reported under T5.

# 13. What a hostile reader should hold us to, and open questions

**Scoped claim (what we commit to):** On OpenClaw 2026.9.6 with GPT-6 Luna, over the real chat path, for the ~20 R2 scenarios and the lessons the plugin learns from them, this run tests whether the plugin (1) notices cross-session repeats, (2) leaves one-offs/noise/covered rules alone, (3) writes short useful lessons, (4) changes the agent's first tool call, (5) reports truthful audit verdicts that recompute from the raw record, (6) keeps the user in control (withdrawal, budget, protected files), (7) fails open without breaking the agent, (8) sends one message per lesson, and (9) installs by the README. Every number must be reproducible from the committed raw JSON Lines files.

**What this does NOT show (the boundary):** no transfer to novel failure domains; no claim about other models, routes, or host versions; prose quality is graded only as a separate lesson-quality judgment and is not the primary endpoint; R4 checks are verification, not causal evidence; the without-arguments replay arm is a stated limit (floor, not estimate).

**Disclosure commitments:** frozen artifacts with SHA-256s recorded before trial #1 (§0); the grader panel's fidelity (calibration κ, per-grader rates, how many labels needed the no-majority rule) reported in full (§5); a chronological deviation log (§12); and a sensitivity package (corrected computations as labelled supplements, alternate grading regimes, per-lesson descriptive rates) printed after the verdict and unable to overturn it (§7, §8).

**Open questions (in the order they matter, Hermes-REPORT §7 style):**
1. Does the effect persist, shrink, or flip sign on other models, routes, or host versions? (This run cannot answer it — T2.)
2. Do lessons learned from real dialogs *with* arguments transfer to fresh tasks? (R3 tests transfer; the without-arguments replay arm remains a limit — T4.)
3. Does the audit's `working` verdict (3 quiet sessions, ≥ 3 days, `RECURRENCE_HORIZON_DAYS = 3`) remain stable over longer horizons, or do failures recur after the window closes?
4. Does the Update button work against ClawHub, given the plugin is not yet published there and R5 tests only a local git release?
5. The `5f5dd44` commit-tag discrepancy (T8): which commit is phase 0 actually pinned to, and does the pinned SHA change any number this protocol cites?

---

# References

**Hermes (reference method):**
- [Hermes-REPORT] Bergschloss/Refine-Cycle-for-Hermes-Agent, `docs/RESEARCH-REPORT-2026-09-12.md` — https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/main/docs/RESEARCH-REPORT-2026-09-12.md
- [Hermes-PROTOCOL] Bergschloss/Refine-Cycle-for-Hermes-Agent, `docs/evidence/lesson_effect_protocol_v2.md` — https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/main/docs/evidence/lesson_effect_protocol_v2.md
- [Hermes-DECISION-ceiling24] `docs/evidence/DECISION_RULE_ceiling24.md` — https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/main/docs/evidence/DECISION_RULE_ceiling24.md
- [Hermes-DECISION-ab] `docs/evidence/DECISION_RULE_ab.md` — https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/main/docs/evidence/DECISION_RULE_ab.md
- [Hermes-INDEPENDENT] `docs/INDEPENDENT-REVIEW.md` — https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/main/docs/INDEPENDENT-REVIEW.md
- Hermes deterministic grader `lesson_effect_checker.py`, SHA-256 `d2834b94bf95a15a9dde118387ab348a64deeeabd4e1e2683d0b3f73d33ac7bc`; decider `analysis_decider.py`, SHA-256 `964fc365a27593cb254097f9df404036cbbf7a605c5c8906e277fd752afe1db9` [Hermes-REPORT §2.1].

**OpenClaw (object of study):**
- [README] Bergschloss/Refine-Cycle-for-OpenClaw, `README.md` — https://github.com/Bergschloss/Refine-Cycle-for-OpenClaw/blob/main/README.md
- [USAGE] `docs/USAGE.md` — https://github.com/Bergschloss/Refine-Cycle-for-OpenClaw/blob/main/docs/USAGE.md
- [DESIGN] `docs/DESIGN.md` — https://github.com/Bergschloss/Refine-Cycle-for-OpenClaw/blob/main/docs/DESIGN.md
- [MEASUREMENT] `docs/MEASUREMENT-2026-09-25.md` — https://github.com/Bergschloss/Refine-Cycle-for-OpenClaw/blob/main/docs/MEASUREMENT-2026-09-25.md
- [RAW-FORMAT] `docs/proof/RAW-FORMAT.md` — https://github.com/Bergschloss/Refine-Cycle-for-OpenClaw/blob/main/docs/proof/RAW-FORMAT.md

# Appendix A — RAW-FORMAT.md format 1 field map (which field feeds which metric)

| Metric / check | Raw field(s) (format 1, last line per `(agentId, sessionId)`) | Notes |
|---|---|---|
| Sessions counted | distinct `(agentId, sessionId)` | "Count each session by its last line" [RAW-FORMAT.md] |
| Repeated fingerprint (H1) | `failures[]` fingerprints across last lines; repeat = ≥ 2 sessions or ≥ 5 occurrences | README bar: "two sessions, or five times" |
| Surfaced repeat (H1) | `outcome` not in `{below_bar, self_corrected, transient, paused_after_nothing, already_covered, refused_after_model}` | pre-repeat refusals excluded |
| False lesson on noise (H2) | `lesson`, `proposedLesson` non-null | threshold 0 |
| Lesson length (S4) | `lesson.text.length` vs `maxLessonChars = 200` | deterministic, not judged |
| Lesson usefulness (H3) | graded by blind panel (§5) on `lesson.text` | raw supplies the text |
| First tool call correct (H4, R2/R3) | host transcript; raw `modelCalls[]` + `called` | locked expected call from manifest |
| Audit verdict (H5) | raw `effects.shown[]`, `effects.recurrence[]`, `effects.unplaced[]` vs `ledger` verdict from `/refine audit` | recomputed independently |
| Budget cap (H6, S8) | `budget.callsToday`, `modelCalls[]` per UTC day | ≤ 3 default; `budget_busy` = refused under concurrency |
| Withdrawal never relearned (H6, C1) | `lesson_status` lines; `proposedLesson`/`lesson` matching deleted id/text | tombstone consult |
| Fail-open (H7, C3) | `error`, `storeErrorText`, null `lesson`/`proposedLesson` | agent turn completes |
| Notices (H8) | notice log: one `lessonNotice` per `lessonId` | `announce()` once per activating pass |
| Model calls counted | entries of `modelCalls[]` over all lines (shortening included) | per-day cap basis [RAW-FORMAT.md] |
| `earlier: true` lines | excluded from model-call count | repeats an earlier decision, no new call |
| Replay report check | `run` line: `sessions`, `sessionsWithFailures`, `outcomes[x]`, `refusals[x]`, `modelCalls`, `queuedCalls`, `lessons.active` | recomputed from last lines |

# Appendix B — Frozen scenario manifest (record SHA-256 before trial #1)

- **Path:** `docs/proof/scenarios-manifest-*.json`
- **SHA-256 (record before trial #1):** `________`
- **Instruction:** write the full manifest BEFORE trial #1 of R2; compute `sha256sum` and record it in this line and in the §0 freeze table; commit it. Any edit, addition, or removal after trial #1 voids pre-registration (§2, §4).
- **Schema (one object per scenario):**
```json
{
  "scenario_id": "R2-NN",
  "category": "fixable" | "not-fixable" | "noise",
  "predicate": {
    "tool": "<tool name>",
    "error_pattern": "<fingerprint error shape, frozen before any run>",
    "preconditions": ["..."],
    "does_not_cover": ["..."]
  },
  "expected_correct_call": {"name": "<tool>", "arguments": {"...": "..."}},
  "sessions": 5 | 3 | 2,
  "prompt_scaffold_sha256": "________",
  "e1_exclusions": ["<source session ids excluded>"],
  "e2_scores": {"max_bigram_jaccard": 0.00, "full_sentence_match": false, "max_tfidf_cosine": 0.00},
  "reserve": false,
  "expectation": "<for not-fixable/noise: defined expectation — e.g. no lesson, or a lesson naming the gap>"
}
```
- The reserve pool (≥ 20% of items, flagged `reserve: true`) supplies whole-item replacements for misfires; zero hybrid items; an audit before unblinding confirms every item has exactly 3 arms (§6).

# Appendix C — Grader rubric + full grader prompt

The full grader prompt is committed verbatim in §5.1. The rubric's four categories (`useful`, `restates an existing rule`, `wrong`, `harmful`, plus administrative `skipped`), their decision rules, the decision order (harmful → restates → useful → wrong), the ≥ 70% content-word overlap rule for `restates` (protocol-specified, mirroring the plugin's `covered.ts`), and the scramble-screen directive-survival question are all in §5. The panel design (Amendment A1: three LLM graders from three families, none the agent route's; ~30-probe calibration at Fleiss' κ ≥ 0.60; every item graded by all three; 2-of-3 majority with the most severe label when there is no majority; labels frozen before unblinding; each grader's rate reported beside the majority) is in §5.

- **Path:** `docs/proof/grader-rubric.md`
- **SHA-256 (record before trial #1):** `________`

# Appendix D — Locked `analysis_decider.py` (record SHA-256 before trial #1)

- **Path:** `docs/proof/analysis_decider.py`
- **SHA-256 (record before trial #1):** `________`
- **Role:** reads the scored results and the raw files; computes Wilson 95% CIs for proportions, exact binomial (Clopper–Pearson) one-sided upper bounds, exact two-sided McNemar on discordant pairs with Agresti–Wald 95% CIs for the paired RD; applies Holm over exactly the two pre-specified contrasts (C1 lesson vs nothing, C2 lesson vs placebo); enforces the meaningful-effect floor RD ≥ +0.05; runs Gate-0 (≥ 80 trials/arm, ≥ 100 unique crossed items, single route, blinding audit, misfire ≤ 10%); prints the verdict string verbatim (`SUPPORTED` | `PARTIAL` | `NOT SUPPORTED` | `FALSIFIED` | `UNDERPOWERED`); runs all sensitivity analyses only after printing the verdict, without altering it.
- **Lineage:** licensed from the Hermes `analysis_decider.py` (SHA-256 `964fc365a27593cb254097f9df404036cbbf7a605c5c8906e277fd752afe1db9`) [Hermes-REPORT §2.1], extended for this protocol's two-contrast family, the useful/restates/wrong/harmful grading import, and the audit–ledger agreement gate.
- **Re-run:** an independent party must be able to reproduce the verdict from the raw files plus the scored results; the decider asserts the raw-file digests match the committed manifest before running.
