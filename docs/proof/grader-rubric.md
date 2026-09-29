# Frozen Grader Rubric & Blind Judge Prompt (`grader-rubric.md`)

This file is frozen before any measured run (`R1`–`R5`) under `docs/proof/PROTOCOL.md` §5 and §5.1.
Sections 1 and 2 reproduce `docs/proof/PROTOCOL.md` §5 and §5.1 verbatim. Section 3 specifies the exact blind packet JSON format emitted by `make_packets.py` and the exact answer JSON schema required from each of the three blind LLM graders.

---

## 1. Protocol §5 — Lesson grading (verbatim from `docs/proof/PROTOCOL.md`)

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

---

## 2. Protocol §5.1 — Full grader prompt (verbatim from `docs/proof/PROTOCOL.md`)

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

---

## 3. Packet Format & Answer Format

### 3.1 Blind Packet JSON Format (`make_packets.py` output)

Each blind packet written by `make_packets.py` (one JSON file `packets/<item_id>.json` and one JSONL row in `packets.jsonl`) contains **only** the six keys permitted by §5:

```json
{
  "item_id": "pkt_a1b2c3d4e5f60718",
  "tool": "schedule_backup",
  "failure_shape": "cron expression <quoted> has <num> fields, expected <num>",
  "session_context": "tool=schedule_backup status=error shape=\"cron expression <quoted> has <num> fields, expected <num>\" resolution=corrected",
  "existing_rules": "",
  "lesson_text": "When calling schedule_backup, pass a 5-field cron expression (minute hour day-of-month month day-of-week)."
}
```

Invariants enforced by `make_packets.py`:
1. `Object.keys(packet)` is strictly `["item_id", "tool", "failure_shape", "session_context", "existing_rules", "lesson_text"]`.
2. `failure_shape` is at most 300 characters (`len(failure_shape) <= 300`).
3. `session_context` is at most 500 characters (`len(session_context) <= 500`), with all memory/lesson `<learned_lessons>` blocks and raw tool parameter values redacted (`<redacted>`).
4. `item_id` is a deterministic HMAC/SHA-256 opaque identifier (`pkt_<16 hex chars>`) keyed by a secret blinding salt stored only in the operator key file (`key_map.json`, withheld from graders until all 3 grader JSONL files are frozen).
5. No field in the packet may contain an experimental arm label (`arm_a`, `arm_b`, `arm_c`, `placebo`, `without-args`, `with-args`), route/model name (`gpt-6-luna`, `openai/gpt-6-luna`), scenario identifier (`fixable_`, `unfixable_`, `noise_`), or source session ID.

### 3.2 Grader Answer JSONL Format (`grader-1.jsonl`, `grader-2.jsonl`, `grader-3.jsonl`)

Each grader produces one JSON line per packet with **strictly** these seven keys:

```json
{
  "item_id": "pkt_a1b2c3d4e5f60718",
  "scramble_screen": "YES",
  "length_chars": 106,
  "length_status": "ok",
  "category": "useful",
  "confidence": 0.95,
  "notes": "Names schedule_backup and the 5-field cron failure, and specifies passing a 5-field cron expression."
}
```

Validation rules enforced by `analysis_decider.py`:
- `item_id`: non-empty string matching a packet in `packets.jsonl`.
- `scramble_screen`: `"YES"` or `"NO"`.
- `length_chars`: integer (note: bar S4 is computed deterministically by `analysis_decider.py` directly from `raw lesson.text`, never trusting the judge's arithmetic).
- `length_status`: `"ok"` or `"over_cap"`.
- `category`: `"useful"` | `"restates"` | `"wrong"` | `"harmful"` | `"skipped"`.
- `confidence`: float in `[0.0, 1.0]`.
- `notes`: non-empty string.
