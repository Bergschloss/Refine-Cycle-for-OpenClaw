## Unverified delivery claim

The answer claims the following deliverables were written, but no publishing manifest covers them for this round. A same-named historical file on disk does not put it in this round's download list.

- Claimed but unverified: `/outputs/tool`

---

# Apodex (Deep Research): the architecture for a Refine Cycle plugin on OpenClaw, decided up front

## 1. The design in one page: measured lessons, prompt injection, durable state, fail-open turns

The architecture is a TypeScript OpenClaw plugin that derives small lessons from repeated observed failures, stores them in its own durable namespace, injects only a bounded lesson block through `before_prompt_build`, and never occupies OpenClaw memory or context-engine exclusive slots. The prompt hook does no learning work: it reads already-active lessons, formats `prependContext`, and returns nothing if anything is unhealthy. Learning runs after a session boundary, behind cheap refusals, durable budgets, and a grounded proposal schema.

This design is pinned to `openclaw/openclaw` main at commit `cc2531654d` as used in the evidence set, dated 2026-09-21. At that commit, `before_prompt_build` has a default modifying-hook timeout of 15 seconds in `DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK`, and `api.on(name, handler, { timeoutMs })` supports per-registration timeout options [1]. Hook errors are handled by logging/dropping the failing handler result while retaining other results, and timed-out hook work is logged/skipped but not cancelled, so every background unit must be idempotent and budget-checked at write time [1]. The hook-name type surface has 42 members, not a larger count, in `PluginHookName` with a compile-time assertion [2].

| Component | Owns / responsibility | Host-bound? | Dependencies and direction | Durable writes | OpenClaw API cited |
|---|---|---:|---|---|---|
| `OpenClawAdapter` / plugin entrypoint | Registers hooks, opens stores, wraps model/history calls, maps OpenClaw payloads into core DTOs | Yes | Outer adapter depends inward on core services; core never imports OpenClaw SDK symbols | `refine.meta`, hook-processing markers | `PluginHookName`, hook event/result types [2] |
| `InjectionService` | Selects active lessons, clamps size, formats `prependContext` | Mostly no | Reads through `LessonStore`; returns one string | None in prompt path | `before_prompt_build` result supports `prependContext` [3] |
| `HistoryReader` | Reads completed sessions, messages, and tool results | Yes / **UNPROVEN exact symbols** | Feeds `FailureExtractor`; never writes lessons | Session processed markers | Session/history client symbols require experiment |
| `FailureExtractor` | Scans whole sessions, captures representative failing rows, computes failure IDs | No | Consumes history rows; emits candidate failure rows | `refine.failures` through store port | Hermes fingerprint basis [4] |
| `CheapRefusalEngine` | Rejects self-correcting, non-repeated, non-lesson-shaped, already-covered, over-budget candidates before model calls | No | Depends on failures, config, active lessons, instruction snapshots if readable | `refine.candidates` refusal rows | Hermes self-correction and apply-bar precedent [5][6] |
| `ProposalGenerator` | Calls model only after deterministic filters; model may return `lesson` or `nothing` | Host-bound at model seam / **UNPROVEN exact symbol and route behavior** | Consumes one candidate; emits proposal JSON | `refine.candidates`, budget events | Proposal schema precedent [7] |
| `GroundingValidator` | Enforces observed `failure_id` / `pattern_fingerprint`, length bounds, duplicate checks, restatement checks | No | Reads current candidate set and active lessons | Validation result in `refine.candidates` | Hermes grounding refusal for unobserved fingerprint [7] |
| `LessonStore`, `JournalStore`, `EffectLedger` | Versioned persistence wrapper, write-ahead journal, lesson rows, exposure/effect rows | Yes | Store port is only persistence dependency; core receives interfaces | All `refine.*` stores | `openKeyedStore` trust gate [8] |
| `EffectEvaluator` | Runs frozen deterministic grader and writes verdicts | Mostly no | Reads effect rows and exported trajectory files; no model calls | `refine.effects` | Hermes grader behavior [9] |
| `MeasurementHarness` | Opt-in replay, treatment/control/placebo arms, exported trajectories | Partly | Drives OpenClaw externally if CLI/API supports it; runtime plugin does not depend on it | `refine.measure` / exported artifacts | Host-driving API **UNPROVEN** |
| `Config/BudgetManager` | Defaults, daily counters, caps before model call and before activation | Mostly no | Reads config; writes durable counters via store port | `refine.config`, `refine.budget.day.<date>` | Store port via `openKeyedStore` if trusted [8] |

The loop is deliberately simple:

1. A session lifecycle hook fires after agent work. `session_end` is verified as a hook type with required `sessionId` and `messageCount`, while `reason`, `sessionKey`, `durationMs`, `sessionFile`, `transcriptArchived`, `nextSessionId`, and `nextSessionKey` are optional [2]. The exact best lifecycle trigger remains **UNPROVEN** until a probe plugin confirms event order and payload completeness.
2. The adapter reads the entire completed session plus a bounded relevant history window. If history access is unavailable, the loop stops before model calls.
3. `FailureExtractor` scans the whole session, not just recent rows, and stores representative failing rows plus a tool/source-scoped failure fingerprint.
4. `CheapRefusalEngine` runs deterministic refusals: store unhealthy, already processed session, below repeat threshold, self-correcting error, wrong-tool/argument-omission shape, duplicate, already evaluated, already covered, or over budget.
5. The already-covered check compares the candidate against active lessons and any readable OpenClaw skills/instructions. It never edits `AGENTS.md`, `SOUL.md`, or user files.
6. If still eligible and budget remains, `ProposalGenerator` makes at most one model call for the session in the milestone design. The model can return `nothing`; `nothing` is a successful outcome, not an error.
7. `GroundingValidator` refuses any proposal without an observed `failure_id` / complete 12-character `pattern_fingerprint`, refuses unbounded text, and refuses restatements.
8. `JournalStore` writes intent before activation; `LessonStore` writes an inactive draft; the lesson is marked active only after the write path succeeds.
9. Future `before_prompt_build` invocations inject a selected lesson block through `prependContext`. OpenClaw concatenates context additions in priority order, with `systemPrompt` and provider/model overrides first-defined-wins and `toolsAllow` intersected [10].
10. Later sessions produce exposure and recurrence rows; the frozen grader is invoked in measurement/audit mode and writes effect verdicts without model calls.

This one-page design is intentionally conservative; the remaining sections spell out exactly where OpenClaw APIs support it and where experiments are still required.

## 2. Hooks: what registers, what each hook does, and what it must never do

| Hook | API status | What this plugin does | What it must never do | Timeout / error policy |
|---|---|---|---|---|
| `before_prompt_build` | Verified result shape includes `prependContext?: string` [3] | Read a small bounded active-lesson set, format the injection block, return `{ prependContext }`; return nothing on unreadable store, config incompatibility, or no active lessons | No model calls, no history scan, no Python grader, no migrations over large stores, no proposal generation, no long I/O, no writes to user files | Register with a short `timeoutMs` below the 15s default if supported by `api.on(..., { timeoutMs })`; catch internally and return no context [1] |
| `session_end` | Verified hook payload shape: `sessionId` and `messageCount` required; lifecycle details optional [2] | Write or update a small session-index / processing-marker row; schedule post-session worker if safe | No unsolicited chat messages, no model calls in the hook body, no cross-session scan, no blocking next turn | Hook runner logs/drops failures; plugin still catches. Exact dispatch timing is **UNPROVEN** and must be probed |
| `agent_end` or nearest agent-completion hook | Hook name appears in the verified hook-type surface, but exact payload and best trigger ordering are **UNPROVEN** | Preferred trigger for bounded post-session work if payload includes enough IDs; otherwise only schedules worker | No chat side effects; no unbounded analysis inside the hook | One-day lifecycle probe chooses between `agent_end`, `session_end`, or a worker polling marker |
| Install / activation / migration hook | `before_install` is not available in the citation list as a verified type here; treat it as **UNPROVEN** for this design | If verified later, show consent and compatibility warnings only; otherwise migrations run lazily at first store open | Never block install through plugin-thrown errors; never patch host files | If no verified install hook, use manifest compatibility fields and lazy idempotent migrations |

OpenClaw's hook runner behavior supports a fail-open turn path: failed handler results are dropped and other successful results retained, and timed-out hooks are skipped while their underlying work is not cancelled [1]. The consequence is operational: every post-session job must have an idempotent key, must re-check budget immediately before writing, and must tolerate completion after the user has moved on.

Must never do in hooks:

- **Model call in prompt hook**: the 15s default timeout and non-cancellation semantics make prompt-time proposals unsafe. Proposal calls happen only post-session.
- **Long cross-session scan in prompt hook**: prompt-time reads are bounded to active lessons; scans happen in the worker.
- **User-file writes**: the plugin does not modify `AGENTS.md`, `SOUL.md`, repository files, or host configuration.
- **Exclusive memory/context registration**: the plugin uses `prependContext` only; it does not take host memory or context-engine slots.
- **Chat side effects**: no unsolicited messages are sent; user controls are command/status surfaces if verified, or configuration fallback if not.

## 3. Data model: lessons, failures, journal, effect ledger, migrations

The storage default is `api.runtime.state.openKeyedStore` only when the plugin is bundled or trusted official, because OpenClaw gates `openKeyedStore` to `origin === "bundled" || trustedOfficialInstall === true`; otherwise `assertTrustedPluginRuntime` throws `PluginTrustRefusalError` [8]. If a non-trusted install cannot use `openKeyedStore`, the runtime plugin fails closed for learning and injection unless a verified plugin-private file store is available. The first milestone should not silently fall back to arbitrary user-workspace files.

| Store / key family | Key | Value fields | Writes | Failure behavior |
|---|---|---|---|---|
| `refine.meta` | `singleton` | `$v`, schema version, migration state, plugin version, pinned host version/commit, last migration error | On startup / lazy migration | If unreadable, inject nothing and do no learning |
| `refine.config` | `singleton` | `$v`, user settings, budget defaults, measurement mode, disabled lesson IDs | User controls / defaults | If unreadable, use read-only safe defaults for injection only when schema-compatible; no writes/model calls |
| `refine.budget.day.<YYYY-MM-DD>` | `singleton` or event rows | `$v`, proposals_attempted, model_calls, lessons_created, estimated_tokens, actual tokens/cost if API exposes them | Immediately before model call and before activation | If unavailable, no model calls and no new lessons |
| `refine.failures` | `failure_id` | `$v`, normalized signature, tool/source, first_seen_session, last_seen_session, count, sessions_seen, representative rows, session IDs, message/tool-call IDs, classification, refusal reason | Extraction and aggregation | Duplicate writes collapse by deterministic key |
| `refine.candidates` | `session_id:fingerprint` or content hash | `$v`, observed failure identity, deterministic filter outcomes, already-covered location, model input hash, model output, validation result, final decision | Every proposal attempt and refusal | Candidate rows are append-like; retries are safe |
| `refine.lessons` | `lesson_id = hash(failure_id + normalized_text)` | `$v`, lesson_id, text, status, failure_id, created_at, disabled_at, disabled_reason, source session, version, injection priority, size estimate, covered_by if refused as restatement | Draft, activation, disable/delete/tombstone | Only `status=active` can inject |
| `refine.journal` | append sequence or timestamp+id | `$v`, intent before change, pre-change content/status, apply result, mark result, recovery state, error | Before every lesson activation/disable/delete | Recovery reconciles incomplete records |
| `refine.effects` | `lesson_id:session_id` | `$v`, lesson_id, arm, prompt block hash, session id, task id if available, observed recurrence, grader input path/hash, grader result, timestamp | Exposure and grading | Pending rows can retry |
| `refine.measure` | run/probe IDs | `$v`, arm assignment, replay metadata, exported trajectory hashes, grader version/hash, Python version | Measurement harness only | Runtime plugin does not depend on it |
| `refine.locks` | Optional lease key | `$v`, owner, expires_at | Only if experiment proves multiple writers and no atomic update | Avoid initially; prefer idempotent keys |

Failure identity deliberately borrows the Hermes pattern because it is operationally concrete: the fingerprint input is `f"{tool_name or ''}|{normalize_error(content)}"`, then hashed to a 12-character identifier [4]. OpenClaw adaptation adds host session ID, message ID, and tool-call ID to the stored evidence rows so that every repeated failure can be audited back to observed rows. The exact OpenClaw tool-result fields used by `normalize_error` are **UNPROVEN** until the history probe records real tool-result payloads.

Migration is monotonic and forward-only. Every stored value has `$v`; readers handle `$v` values from all supported versions; heavy migrations operate on one store/key family at a time and record a cursor in `refine.meta`. On migration failure, the plugin fails closed for new proposals and lesson activation. Injection may continue only if the active lesson row version is explicitly readable by the current code; otherwise the prompt hook injects nothing.

## 4. The loop end to end: session ended → lesson injected → lesson judged

| Stage | Inputs | Cheap refusals | Writes | Model calls |
|---|---|---|---|---:|
| 1. Ingest session | Completed session ID and full message/tool-result history | Refuse if history API unavailable, store unavailable, session already processed, or lifecycle payload lacks stable ID | Processing marker, session index, journal note if needed | 0 |
| 2. Extract failures | Whole session rows, including tool failures and assistant recovery attempts | Refuse self-correcting errors and rows without repeatable signature; do not use newest rows only | `refine.failures` representative rows and normalized signatures | 0 |
| 3. Aggregate across history | Failure rows across bounded prior sessions | Refuse below threshold, already has active lesson, already evaluated, or stale with no recurrence | Updated counts, sessions_seen, candidate row | 0 |
| 4. Classify lesson shape | Failure cluster and representative rows | Deterministic heuristics reject wrong tool choice, missing argument already supplied, transient service issue, permissions error, and user-specific one-offs | Candidate refusal reason or eligible classification | 0 |
| 5. Already-covered check | Active lessons, accessible skills/instructions, configured read-only instruction sources | Refuse if lesson would restate an existing rule; record the covering location | Candidate row with `covered_by` | 0 |
| 6. Budget gate | Durable day counter and config | Refuse if daily model-call cap, lesson cap, or per-session candidate cap reached | Budget event / CAS-ready marker | 0 |
| 7. Model proposal | One surviving candidate and evidence rows | Model may return `nothing`; malformed JSON goes to validation/repair only if budget allows | Raw model output, model input hash, usage if exposed | Milestone default: max 1/session, max 3/day; design choice, not OpenClaw fact |
| 8. Validation | Proposal JSON and observed candidate set | Refuse unbacked `failure_id`, too-long lesson, duplicate, unsafe schema, restatement, missing reason | Validation result; no lesson if refused | 0 |
| 9. Apply | Validated bounded lesson | Refuse if budget changed since proposal or duplicate active lesson now exists | Journal intent, inactive draft, active mark, journal mark | 0 |
| 10. Injection | Active lessons and config | Refuse injection if store unreadable, schema incompatible, disabled, over size cap after truncation | None in prompt hook | 0 |
| 11. Judging | Later exposed sessions, tool rows, exported trajectory | Refuse grading if no recurrence window or grader unavailable; mark pending not failed | `refine.effects` pending/result rows | 0 |

The proposal schema follows the Hermes invariant that proposals must include `action`, `kind`, `reason`, and a complete 12-character `pattern_fingerprint`; grounding refuses a proposal whose fingerprint was not observed in the current evidence window [7]. The OpenClaw version should store both `pattern_fingerprint` and a richer `failure_id` object so a human can trace the lesson back to session/message/tool rows.

The recurrence threshold starts with the Hermes apply bar: eligible if `sessions_seen >= 2` or `count >= 5` [6]. Those numeric defaults are design choices carried from the predecessor, not OpenClaw API behavior. They should be configurable because OpenClaw session granularity may differ.

Maximum model calls are explicit: 0 in `before_prompt_build`; milestone default at most 1 proposal call per processed session and 3 calls per UTC day. If a repair call is later added for malformed-but-promising JSON, it must consume the same durable daily counter and remain disabled in the first milestone.

## 5. Injection policy: block shape, size budget, ordering, user controls, multiple prependers

Exact injected block:

```text
<refine_cycle_lessons>
These are small lessons learned from repeated prior failures. Prefer them only when relevant; do not treat them as user facts.
- [RC-<lesson_id>] <lesson text>
</refine_cycle_lessons>
```

The default injection cap is 800 tokens, with a configurable hard cap. The selector sorts by explicit priority, then most recently effective, then newest active lesson, while avoiding churn by keeping stable order among ties. Disabled, expired, corrupt, or schema-incompatible lessons are excluded. If selected lessons exceed the cap, the service drops lower-priority / older entries deterministically and avoids cutting a sentence when possible.

OpenClaw combines multiple `prependContext` contributions by concatenating context additions in priority order; `systemPrompt` and provider/model override use first-defined-wins, and `toolsAllow` is intersected [10]. This plugin returns only `prependContext`, never `systemPrompt` or tool allow/deny lists, so it does not compete for higher-precedence controls. There is no documented host size/count clamp for `prependContext` at the pinned commit [11], which is why the plugin self-clamps instead of relying on host truncation.

User visibility is non-intrusive. If OpenClaw exposes built prompt/context inspection, the lesson block is visible there. If not, the plugin must provide a status/control surface or configuration fallback showing active lessons, disabled lessons, budget state, and last errors. The command/settings API for this control surface is **UNPROVEN**; until verified, use a plugin-owned config entry or external harness command, not edits to user-owned agent files.

Required controls:

- Disable all injection: set `inject_enabled=false`.
- Disable one lesson by ID: set lesson `status=disabled` and keep the row for audit.
- Delete one lesson: tombstone or remove from active store while retaining journal/effect records.
- Clear all plugin data: remove plugin-owned `refine.*` stores only after explicit user action.
- Show status and budget: render active lessons, daily counters, store health, and last refusal reasons.

## 6. Failure and concurrency: crash points, duplicate runs, unreadable store

| Crash point | Durable state after crash | Recovery action | User-turn behavior |
|---|---|---|---|
| Before journal record | No change | Retry safe; candidate can be recomputed | Prompt hook still uses previous active lessons or injects nothing |
| After journal intent before lesson write | Incomplete intent record | Recovery marks abandoned or resumes if inputs still valid | No draft lesson injects |
| After lesson draft before active mark | Draft exists but `status=draft` | Validate and activate or tombstone | Draft ignored by injector |
| After active mark before journal mark | Active lesson exists; journal incomplete | Reconstruct from lesson status and mark journal applied | Injector may use active lesson if schema-compatible |
| During budget counter update | Counter may be missing or partial if atomicity is unverified | Prefer append-only budget events and recompute; if CAS verified, retry conflict | No model call unless counter write succeeds |
| During effect grading | Pending effect row | Retry grader later; record grader error if deterministic failure | Runtime injection unaffected |

Do not assume single instance. Multiple plugin instances should collapse duplicates through deterministic keys: session processing key, candidate key, and lesson ID derived from `failure_id + normalized_lesson_text`. If atomic compare-and-set is unverified, do not claim exactly-once processing; use at-least-once processing with duplicate collapse and budget checks at the final write point.

Cross-process locking is deliberately avoided in v1. A lock protocol is added only if the concurrency experiment proves multiple independent OpenClaw processes write the same plugin store and the store lacks atomic conditional update. Until then, the safer primitive is idempotency: redundant scans are acceptable; duplicate active lessons are not.

Unreadable store policy is fail closed for learning and fail open for the user turn:

- Prompt hook: return no context.
- Post-session loop: do nothing except transient logging.
- Budget unavailable: no model calls and no new lessons.
- Config unavailable: use safe read-only defaults only if no write/model call follows; otherwise stop.
- Store trust refusal: mark the plugin inert if a status surface exists; do not fall back to user-workspace files without explicit verified API and consent.

## 7. Budgets and cost

Configuration defaults are design choices, not OpenClaw facts:

| Setting | Default | Enforcement point |
|---|---:|---|
| `enabled` | `true` | Checked before all hook and worker actions |
| `inject_enabled` | `true` | Prompt hook before reading active lessons |
| `learn_enabled` | `true` | Worker before extraction/proposal |
| `measure_enabled` | `false` | Harness/audit only |
| `max_model_calls_per_day` | 3 | Durable counter immediately before proposal call |
| `max_lessons_created_per_day` | 2 | Durable counter immediately before activation |
| `max_candidates_per_session` | 1 | Candidate selection before proposal |
| `max_injected_tokens` | 800 | Injection formatting before returning `prependContext` |
| `max_history_sessions_scanned_per_run` | 10 | HistoryReader input window; each chosen session scanned whole |
| `max_post_session_runtime_ms` | 30,000 | Worker scheduling budget, not prompt hook |
| `min_repeat_count` | 2 sessions or 5 occurrences | Failure aggregation, matching predecessor apply bar [6] |
| `retention_days` | No automatic deletion by default | User-controlled cleanup only |

Counters live in durable plugin-owned state, not memory. The design enforces caps twice: before the model call and before lesson activation. The second check matters because another worker may have consumed the budget after the candidate passed earlier filters.

Prompt-time cost worst case is the injected lesson block token budget only; there is no prompt-time model-call cost. Post-session cost is bounded by the configured daily model-call cap on the user's route/budget if the model-call API supports that route; exact route/budget behavior is **UNPROVEN** until the model-call probe verifies it. If the model API exposes token and cost accounting, store actual usage in budget/effect rows; otherwise store a character/token estimate clearly marked as estimated.

## 8. Measurement designed in: replaying the published experiment on OpenClaw

Runtime collection is not the full experiment. The runtime plugin records enough audit data to support measurement, but treatment/control/placebo arms are produced by a separate opt-in harness so a user's live profile is not silently altered.

Per lesson, store: lesson text, failure ID, source failure rows, prompt block hash, activation time, sessions exposed to it, session inputs/outputs/tool results, model/proposal hash, validation result, and effect rows. Per exposure, store: lesson ID, arm label, session ID, task/probe ID if available, prompt block hash, observed recurrence, grader input hash/path, grader result, and timestamp.

The lesson-free arm should be created by harness-driven replay with plugin disabled or lesson withheld for that replay profile. Placebo arms should use the same injection budget with irrelevant/placebo lessons only if reproducing a protocol that requires them. Do not create a control by deleting historical records inside a real user profile; that breaks reversibility and corrupts live audit data.

The Hermes checkout confirms some predecessor facts and does not confirm others. The repository record is pinned at commit `93103f1ad733c22264dd4b5c10ad522eced322d2` on main, committed 2026-09-20T21:30:47+02:00 [12]. The README reports 66 times with the lesson and 28 times without, with two placebo notes scoring 28 and 30 [13], and the detailed arm table reports lesson 66/133, nothing 28/133, scramble 30/133, topic 28/133 [14]. The reported 46/37/6 category split, 0 useful lessons out of 33 candidate sessions, and 65/130 vs 29/130 are carried here only as reported claims awaiting re-derivation in the OpenClaw re-run; the available fully crossed run instead reports `n_pairs=130`, `n10=38`, `n01=0`, and RD +29.23pp, implying lesson 65/130 and nothing 27/130 rather than 29/130 [15].

The frozen grader remains a Python artifact. Package `grader/lesson_effect_checker.py` under `grader/`, verify its hash in CI, and invoke it from TypeScript via a subprocess only in measurement/audit mode, or run it externally from the harness. The available evidence verifies the test copy hash as `d2834b94bf95a15a9dde118387ab348a64deeeabd4e1e2683d0b3f73d33ac7bc` against its `.sha256` file [16], and the verification docs state the rationale for pinning: changing it would change how finished results are scored [17]. Record Python version, grader hash, input trajectory hash, and output verdict.

The harness should drive OpenClaw with deterministic tasks/sessions if CLI/API support is sufficient. Host-driving API coverage is **UNPROVEN**: the one-day experiment installs the plugin in a clean profile, runs a fixed task that produces known tool results, exports the session rows, and verifies the grader can score the exported trajectory without model calls.

## 9. Configuration and permissions

| Setting | Default | Rationale |
|---|---:|---|
| `enabled` | `true` | Master switch; disabled plugin registers no active behavior beyond status if supported |
| `inject_enabled` | `true` | Allows learning/audit without prompt injection |
| `learn_enabled` | `true` | Allows injection of existing lessons without creating new ones |
| `measure_enabled` | `false` | Measurement harness is opt-in |
| `max_injected_tokens` | 800 | Keeps per-turn overhead bounded |
| `max_model_calls_per_day` | 3 | Prevents background cost spikes |
| `max_lessons_per_day` | 2 | Prevents lesson churn |
| `max_candidates_per_session` | 1 | Keeps first milestone simple and measurable |
| `min_repeat_count` | 2 sessions or 5 occurrences | Starts from predecessor apply bar [6] |
| `max_history_sessions_scanned_per_run` | 10 | Bounded whole-session scan |
| `retention_days` | No automatic deletion | Avoid accidental loss of measurement/audit data |
| `include_urls_in_lessons` | No filter | URLs are allowed if the model already saw them; no URL ban |
| `credential_scrubbing` | No special scrubber | Do not filter content beyond what the host already exposes to the model |
| `python_grader_path` | unset | Optional measurement-mode override |

Manifest/compatibility: package metadata should include `openclaw.compat.pluginApi` and `openclaw.build.openclawVersion` where required by ClawHub packaging evidence; OpenClaw docs also describe `openclaw.install.minHostVersion` and `openclaw.compat.pluginApi` as manifest fields whose incompatibility causes rejection rather than loading [18]. Treat `openclaw.install.minHostVersion` as the nested `openclaw.install.minHostVersion` field; if `openclaw.compat.minGatewayVersion` is available/preferred in the current manifest schema, use it as the host-version gate and test both fields in the manifest experiment.

Permissions needed: contribute prompt context through `before_prompt_build`; read session history/messages/tool results; use durable plugin store; call the model on the user's route if verified; read packaged grader or run a subprocess only in measurement mode; expose status/controls if command/settings APIs are verified.

Must never touch:

- Host memory capability slot.
- Host context engine slot.
- `AGENTS.md`, `SOUL.md`, repository files, or user-owned instructions except read-only already-covered checks if explicitly configured.
- Host install/update machinery.
- External network except through the host model route or official package publishing/install path.

## 10. Testing: host-independent, real OpenClaw, and fake-host drift checks

Pure unit tests cover host-independent behavior:

- Fingerprint normalization, including `tool_name or ''` and `normalize_error` behavior.
- Whole-session scan behavior, including failures hidden early in long sessions.
- Refusal ordering: store health, budget, repeat threshold, self-correction, lesson-shape, already-covered, duplicate.
- Schema validation and grounded `failure_id` / `pattern_fingerprint`.
- Journal recovery state machine for every crash row in section 6.
- Injection formatting, deterministic truncation, and no partial malformed block.
- Budget recomputation from append-only events if CAS is unavailable.
- Effect ledger serialization and grader input hashing.

Fake-host contract tests cover adapter assumptions:

- Hook registration names and timeout options.
- Prompt hook return shape for `prependContext`.
- Store wrapper behavior: read/write, unavailable store, trust refusal, restart persistence if simulated.
- Model-call adapter: one call, malformed response, budget recording.
- HistoryReader payload mapping for sessions/messages/tool results.

Real OpenClaw integration tests are mandatory before release:

- Minimal plugin returns `prependContext` and the text appears in the built prompt.
- Throwing prompt hook does not break the user turn.
- Timed-out hook is skipped while later idempotent cleanup remains safe.
- Store persists across sessions/restarts for trusted/bundled installation.
- Session history/tool results are readable across sessions.
- Plugin model calls use the intended user route/budget, or the feature is disabled.
- Compatibility rejection occurs for deliberately incompatible manifest metadata.

Fake-host drift is treated as a release blocker because a drifted fake host previously allowed a broken rollback to ship. The new process generates contract fixtures from a real OpenClaw probe plugin: hook payload shapes, store error shapes, prompt merge behavior, and lifecycle ordering. CI runs the fake host against those fixtures and runs a separate probe against pinned OpenClaw main; any mismatch forces adapter update or marks the seam **UNPROVEN**.

## 11. Packaging and release

Repository layout:

```text
src/plugin.ts
src/openclaw-adapter/
src/core/
src/storage/
src/measurement/
grader/lesson_effect_checker.py
tests/unit/
tests/integration-openclaw/
package.json
openclaw manifest/config file if required by current SDK
```

Build with TypeScript compile and bundle only if compatible with OpenClaw plugin loading. Do not patch the host, ship an installer, add a self-updater, or require host restart as a plugin action. OpenClaw plugins are installed, updated, and uninstalled through the host CLI, so a separate installer is unnecessary [19]. OpenClaw also supports plugin updates through the host CLI, removing the need for a plugin-side self-update path [19].

Publishing should use ClawHub only after its package flow is verified in the current docs/tooling. Do not use an invented `openclaw plugins publish` command; if publishing is needed, validate the actual ClawHub CLI flow with a dry run in the release experiment. Compatibility metadata should be tested by publishing/installing a package with deliberately incompatible `pluginApi` / host-version fields and verifying refusal instead of load/crash.

Host upgrade behavior: if compatible, the plugin continues after OpenClaw update. If incompatible, install/update should refuse or disable according to manifest compatibility behavior rather than crashing. Budget 1–2 person-days per year to review OpenClaw plugin API changes, rerun probe fixtures, and update manifest compatibility.

What not to build:

| Hermes-only item | OpenClaw decision | Reason |
|---|---|---|
| Installer | Do not build | Host CLI manages install/update/uninstall [19] |
| Host patch | Do not build | Design uses documented hooks/stores; if model API is insufficient, disable proposals or use external harness, not patch |
| Self-update path | Do not build | Host update flow covers plugin updates [19] |
| “Fix me” command | Do not build | No host patch to repair; status/control is enough |
| Host restart command | Do not build | Plugin should not manage host lifecycle |
| Desktop status bar | Do not build for v1 | Status command/config is enough; UI can come later if API verified |
| Unsolicited chat messages | Do not build | No need for push messages; avoid chat side effects |
| Cross-process lock protocol | Do not build initially | Add only if concurrency experiment proves multiple writers and no atomic update |
| Credential scrubber / URL ban | Do not build | User explicitly requires no filtering beyond what the model already sees; predecessor removed both because they cost valid lessons [20] |

Anything still needed from the Hermes list: only measurement harness packaging and user-facing status/disable controls remain, but those are not Hermes-specific installer/UI machinery.

## 12. The first milestone: smallest measurable end-to-end version

Estimate: 10–15 person-days if the hook, storage, history, and model-call probes pass without adapter redesign. If model-call or history access is narrower than expected, keep the runtime milestone to injection + extraction + journaling and move proposal generation into the external harness until the API seam is verified.

Milestone includes:

- Hook registration for `before_prompt_build` and the verified lifecycle trigger.
- Durable store schema v1 with `$v` fields.
- Prompt injection of manually seeded active lessons.
- Session-end processing for one bounded session/history window.
- Deterministic failure fingerprint/extraction.
- Cheap refusals before model calls.
- One model call/session max and 3/day cap, only if route/budget probe passes.
- Grounded lesson validation.
- Journaled lesson activation.
- Effect ledger rows and frozen grader invocation in the harness.
- Basic status/disable/delete controls if command/settings API is verified; otherwise config-file or store-backed control via harness.

Deliberately omitted:

- Sophisticated semantic search for restatement beyond deterministic/cheap checks.
- Desktop/status UI.
- Self-update and installer.
- Cross-process locking unless proven needed.
- Multi-host abstraction beyond a clean adapter interface.
- Aggressive performance optimization.
- Any host patch.

## 13. Risks: what may be discovered too late and what absorbs it

| Rank | Risk | Consequence | Design absorber |
|---:|---|---|---|
| 1 | Lifecycle hook names/payloads differ from assumptions | Worker lacks stable session IDs or fires at wrong time | Adapter isolates host-bound code; one-day probe chooses exact hook and payload mapping |
| 2 | History/tool-result access incomplete | Cannot prove repeated observed failures | Fail closed for learning; milestone blocks until history probe passes |
| 3 | Plugin model-call API is narrower than expected | Proposal generation cannot run inside plugin | Disable runtime proposals; run external/harness proposal mode; no host patch |
| 4 | Durable store lacks atomic CAS/transactions or is unavailable to non-trusted installs | Duplicate writes or unsafe budget counters | Append-only journal/events, deterministic keys, trust-gated inert mode |
| 5 | `prependContext` merge order or size behavior changes | Lesson block placement/truncation differs | Self-contained block, self-clamp, no reliance on exclusivity or system prompt |
| 6 | Hook timeout/non-cancellation causes late work to finish | Background job writes after context moved on | Idempotent work units; budget checked at write time |
| 7 | Frozen Python grader packaging is awkward in plugin sandbox | Measurement cannot run in runtime plugin | External harness still runs grader; runtime plugin does not depend on grader |
| 8 | Restatement trap yields few/no lessons | Plugin appears inactive | Treat “already covered” and “nothing” as successful safe outcomes; report refusal reasons |
| 9 | Multiple plugin instances race | Duplicate candidates or budget conflicts | Deterministic IDs and duplicate collapse; add locks only if experiment proves need |
| 10 | User trust/privacy concern | Install rejection or disabled learning | Local plugin-owned store, no extra keys, no user-file edits, explicit consent/status |

## 14. UNPROVEN: ranked seams and one-day experiments

Do not hide these items. The design is credible only because the unverified seams are explicit and testable.

| Rank | UNPROVEN seam | Why it matters | One-day experiment | Fallback if it fails |
|---:|---|---|---|---|
| 1 | Exact lifecycle hook for “session ended” / “agent ended” and payload shape | Determines when learning starts and which IDs are durable | Install a probe plugin that logs all candidate lifecycle hook payloads during a session with a tool failure; inspect event order, IDs, optional fields, and retry behavior | Use the hook with stable IDs only for markers; poll/process through worker |
| 2 | History API exact client symbols and cross-session readability of sessions/messages/tool results | Required to prove repeated observed failures | Create two sessions with known tool results; from a third session/plugin run, read and hash both transcripts and tool outputs | Disable learning; allow manual seeded lessons/injection only |
| 3 | Durable keyed store API shape, persistence, atomicity/CAS/transaction semantics | Required for budgets, journal recovery, duplicate collapse | Concurrent writes, restart persistence test, and crash simulation around journal/budget update | Append-only events with recomputation; if store unavailable, plugin inert |
| 4 | Plugin model-call API exact symbol, route, budget behavior, and token accounting | Required for autonomous proposal generation without a plugin key | Plugin makes one constrained model call; verify provider/model route, billing/budget attribution, failure behavior, and usage fields | External/harness-only proposal generation; no host patch |
| 5 | `prependContext` merge order and size behavior with multiple plugins | Determines prompt placement and truncation risk | Install two probe plugins returning marked context at different priorities; inspect final prompt and large-context behavior | Keep block self-contained and smaller; do not rely on precedence |
| 6 | Command/settings API for user controls | Needed for disable/delete/status UX | Minimal plugin exposes status/disable command or config; verify persistence and no chat side effects | Store/config controlled by harness or documented plugin settings file if allowed |
| 7 | Manifest permission names and install compatibility fields in current SDK/ClawHub | Release blocker; wrong metadata may fail publish/install | Publish/install local package with incompatible `openclaw.compat.pluginApi`, `openclaw.compat.minGatewayVersion` / `openclaw.install.minHostVersion`, and required build metadata; confirm rejection mode | Adjust manifest; do not ship until validated |
| 8 | Ability to package/invoke Python grader from TypeScript plugin sandbox | Needed for in-plugin audit mode | Run pinned Python file from plugin or harness, record hash/result/Python version | Keep grader in external measurement harness |
| 9 | Whether OpenClaw can run multiple plugin instances against one store | Determines whether locks are necessary | Start parallel hosts or sessions using same state directory; attempt same deterministic lesson write; inspect duplicates/races | Add lease/lock only if idempotent keys plus store CAS are insufficient |
| 10 | Access to existing skills/instructions for already-covered check | Required to avoid restatement trap beyond active lessons | Create known skill/instruction text; verify plugin can read enough metadata/content without editing files | Limit already-covered check to active lessons and configured read-only sources; report lower coverage |

## References

[1] The before_prompt_build hook has a 15 s default timeout defined by DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK in hooks.ts:147 at openclaw/openclaw#cc2531654d (2026-09-21).. https://github.com/openclaw/openclaw/blob/cc2531654d/src/plugins/hooks.ts
[2] The PluginHookName union has 42 members (not 43) per hook-types.ts:106–147, with an assertion at :194–196.. https://github.com/openclaw/openclaw/blob/cc2531654d/src/plugins/hook-types.ts
[3] https://github.com/openclaw/openclaw/blob/cc2531654d/src/plugins/hook-before-agent-start.types.ts
[4] The failure fingerprint formula is f"{tool_name or ''}|{normalize_error(content)}" per patterns.py:540–541.. https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/93103f1/patterns.py
[5] https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/93103f1ad733c22264dd4b5c10ad522eced322d2/patterns.py
[6] The Hermes apply bar is `sessions_seen >= apply_min_sessions (2) OR count >= apply_min_occurrences (5)`.. https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/93103f1ad733c22264dd4b5c10ad522eced322d2/core.py
[7] The Hermes `REFINE_PROPOSAL_SCHEMA` requires top-level `action`, `kind`, `reason` and includes `pattern_fingerprint` (mandatory, exact 12-char).. https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/93103f1ad733c22264dd4b5c10ad522eced322d2/llm.py
[8] OpenClaw `openKeyedStore` is gated to `origin === "bundled" || trustedOfficialInstall === true`; otherwise `assertTrustedPluginRuntime` throws `PluginTrustRefusalError`.. https://github.com/openclaw/openclaw/blob/cc2531654d/src/plugins/registry-runtime.ts
[9] The Hermes grader marks external modification of the target as verdict `unreliable` (grader lines 855-883).. https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/93103f1ad733c22264dd4b5c10ad522eced322d2/lesson_effect_checker.py
[10] OpenClaw context additions concatenate in priority order (highest first), `systemPrompt` is first-defined-wins, provider/model override is first-defined-wins, and `toolsAllow` intersects.. https://github.com/openclaw/openclaw/blob/cc2531654d/docs/plugins/hooks/prompt-and-session.md
[11] There is no documented host size/count clamp for `prependContext` in `mergeBeforePromptBuild`, the docs, or the manifest at commit cc2531654d.. https://github.com/openclaw/openclaw/blob/cc2531654d/src/plugins/mergeBeforePromptBuild.ts
[12] The Hermes Refine Cycle repo is at commit 93103f1ad733c22264dd4b5c10ad522eced322d2 on main, committed 2026-09-20T21:30:47+02:00.. https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent
[13] README.md states "66 times with the lesson and 28 times without; two placebo notes scored 28 and 30".. https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/main/README.md
[14] The underlying arm table is lesson 66/133 (49.6%), nothing 28/133 (21.1%), scramble 30/133 (22.6%), topic 28/133 (21.1%).. https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/main/docs/RESEARCH-REPORT-2026-09-12.md
[15] The 130 fully-crossed run (decider_130.txt) reports n_pairs=130, n10=38, n01=0, RD +29.23pp, implying lesson 65/130 but nothing 27/130, not 29/130.. https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/main/docs/evidence/decider_130.txt
[16] lesson_effect_checker.py has sha256 d2834b94bf95a15a9dde118387ab348a64deeeabd4e1e2683d0b3f73d33ac7bc, verified against the .sha256 file and sha256sum of the file.. https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/main/tests/lesson_effect_checker.py
[17] The pin rationale for the frozen grader is "Changing it would change how finished results are scored.". https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/main/docs/VERIFICATION.md
[18] OpenClaw plugin manifests declare openclaw.install.minHostVersion and openclaw.compat.pluginApi, which are enforced at install and cause an incompatible plugin to be rejected rather than loaded.. https://docs.openclaw.ai/plugins/manifest/package-json
[19] OpenClaw plugins are installed, updated, and uninstalled via the host CLI, so a separate installer is unnecessary.. https://docs.openclaw.ai/tools/plugin
[20] The credential scrubber and URL ban were removed after measurement because they cost valid lessons and protected nothing.. https://github.com/Bergschloss/Refine-Cycle-for-Hermes-Agent/blob/main/refine/sanitization.py