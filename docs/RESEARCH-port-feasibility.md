# Can Refine Cycle be rebuilt for OpenClaw?

**Deep-research feasibility assessment — Refine Cycle (Hermes Agent) → OpenClaw**

Sources observed: **OpenClaw `openclaw/openclaw`, package version `2026.9.5`, source HEAD `8a9bc25` committed 2026-09-21 18:18 UTC; documentation at `docs.openclaw.ai` observed 2026-09-22.** Refine Cycle at `Bergschloss/Refine-Cycle-for-Hermes-Agent` tag `v1.3.16`, observed 2026-09-22.

---

## 0. Verdict (three lines)

**REBUILD, not port.** OpenClaw's plugin model is TypeScript/ESM in-process only — there is no Python host, so the ~22.8k-line Python corpus cannot be carried over as a plugin; and the plugin's central action (land a small lesson in durable, prompt-injected memory) has no first-class surface because OpenClaw's memory capability is an exclusive single-implementation slot. Two of the three hard blockers resolve favourably (cross-session history is well-exposed; model calls on the user's own route need no patch and are arguably better than Hermes), but the memory gap plus the language barrier mean a "port" would be a rewrite in disguise anyway — write it natively instead.

The answer flips to **port** if OpenClaw ever exposes a non-exclusive, plugin-writable global-memory surface injected into every session prompt *and* a polyglot/Python-sidecar plugin path: then the existing Python implementation becomes directly reusable and the economics invert.

---

## 1. What OpenClaw actually has

### Identity of the host

OpenClaw is the open-source multi-channel self-hosted agent gateway described in the brief (`openclaw.ai`, docs at `docs.openclaw.ai`, source `github.com/openclaw/openclaw`). The description in the brief **matches**: it ships a plugin SDK under `openclaw/plugin-sdk/*` (e.g. `src/plugin-sdk/`, ~650 TypeScript files), manifest-gated trusted capability surfaces (`contracts.*` declared in `openclaw.plugin.json`), channel plugins for Telegram/Slack/WhatsApp (`extensions/telegram/`, `slack/`, `whatsapp/`), skills as `SKILL.md` bundles, agent harnesses (`docs/plugins/sdk-agent-harness.md`, `docs/plugins/sdk-subpaths.md`), and many model providers (`extensions/openai/`, `anthropic/`, `ollama/`, …).

### Plugin model, language, and guarantees

- **Language: TypeScript ESM only.** "Requirements: … TypeScript ESM modules. Node 24.16+ or Node 26.1+" (`docs/plugins/building-plugins.md:31`; confirmed by the SDK being entirely `.ts` under `src/plugin-sdk/`). There is no Python plugin runtime. A Refine Cycle port cannot reuse a single line of its Python directly — this is the single most decisive fact.
- **Shape:** native plugins register capabilities in-process; OpenClaw classifies each loaded plugin as `plain-capability`, `hybrid-capability`, `hook-only`, or `non-capability` (`docs/plugins/architecture.md`). Trusted surfaces are manifest-gated: e.g. `api.registerAgentToolResultMiddleware` and `api.registerTrustedToolPolicy` require explicit `contracts.*` declarations (`docs/plugins/building-plugins.md:126`).
- **Trust boundary:** "Native OpenClaw plugins run **in-process** with the Gateway. They are not sandboxed." A bug can crash the Gateway; a malicious plugin is arbitrary code execution in the Gateway process (`docs/plugins/architecture.md`).
- **Stability: everything experimental.** "All OpenClaw plugin APIs are **experimental**. This includes every `openclaw/plugin-sdk/*` subpath, registration and runtime APIs, channel and provider contracts, hooks… These contracts can change between OpenClaw releases. Pin the OpenClaw version… do not assume a working build supports future releases" (`docs/plugins/sdk-overview.md`). There is **no stable API guarantee**; compatibility is managed per-version with documented migration windows (e.g. session-store beta.5 window through 2026-10-12, `docs/plugins/sdk-runtime/agent.md`).

### Registration surface

A plugin exports a default `definePluginEntry({ id, name, description, register(api) { … } })`. `register(api)` receives `OpenClawPluginApi` with `api.on("hook_name", handler)` for typed hooks, `api.registerTool/registerProvider/registerCommand/...`, `api.runtime.*` helpers, and scoped state/session/workflow namespaces (`docs/plugins/sdk-overview.md`; `docs/plugins/building-plugins.md`). Distribution: publish to **ClawHub** (`clawhub.ai`) and users run `openclaw plugins install clawhub:<package>`; bare specs install from npm, plus `npm:`, `git:`, `npm-pack:` and local `--link` sources (`docs/plugins/manage-plugins.md`).

### The typed hook catalog (what a plugin may see of a turn)

From `docs/plugins/hooks/reference.md` (catalog, lines ~127–206):

| Lifecycle stage | Hooks (kind) |
|---|---|
| Pre-model | `before_model_resolve` (Modify), `agent_turn_prepare` (Modify), `before_prompt_build` (Modify; also authorized post-policy phase), `before_agent_run` (Gate), `before_agent_reply` (Claim), `before_agent_finalize` (Modify — inspect final answer, request one more pass), `agent_end` (Observe), `heartbeat_prompt_contribution` (Modify) |
| Model IO | `model_call_started`/`model_call_ended` (Observe, sanitized metadata only), `llm_input` (Observe), `llm_output` (Observe) |
| Tools | `before_tool_call` (Modify/Gate + approval resolution), `after_tool_call` (Observe), `resolve_exec_env` (Modify), `tool_result_persist` (Sync modify), `before_message_write` (Sync modify/Gate) |
| Messages | `inbound_claim`, `channel_pairing_requested`, `message_received`, `message_sending`, `reply_payload_sending`, `message_sent`, `before_dispatch`, `reply_dispatch` |
| Sessions | `session_start`/`session_end` (Observe), `before_compaction`/`after_compaction` (Observe), `before_reset` (Observe) |
| Subagents | `subagent_spawned`/`subagent_ended`/`subagent_progress` (Observe), `subagent_delivery_target` |
| Gateway/lifecycle | `gateway_start`/`gateway_stop`, `cron_reconciled`/`cron_changed`, `before_install` |
| Skills | `skill_proposal_evaluate` (Evaluate), `skill_proposal_changed`, `skill_changed` (Observe) |

Handlers have priorities, per-handler timeout budgets, and matchers; conversation hooks require `plugins.entries.<id>.hooks.allowConversationAccess: true` (`docs/plugins/hooks.md`).

### Runtime helpers relevant here (`api.runtime.*`)

- `api.runtime.llm` — host-owned completions (`docs/plugins/sdk-runtime/models.md`): `complete({...})`, `prepareSimpleCompletionModelForAgent({ cfg, agentId })`, isolated mode.
- `api.runtime.agent.session` — `listSessionEntries({agentId})`, `getSessionEntry`, `patchSessionEntry`, `upsertSessionEntry`, `readSessionTranscriptRawDelta`, `readSessionTranscriptVisibleMessageDelta` (cursor-paginated), `createSessionEntry` (`docs/plugins/sdk-runtime/agent.md`).
- `api.runtime.state` — durable namespaced SQLite keyed store and blob store (`openKeyedStore`, `openBlobStore`) (`docs/plugins/sdk-runtime/state-and-system.md`).
- `api.runtime.subagent` — `run(...)`, `complete(...)` background runs (`docs/plugins/sdk-runtime/background-work.md`).
- `api.runtime.sandbox` — workspace authority resolution; `api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId)` (`docs/plugins/sdk-runtime/agent.md`).
- `api.session.state.registerSessionExtension(...)` (durable per-session JSON, deprecated top-level alias `api.registerSessionExtension`) and `api.session.workflow.enqueueNextTurnInjection(...)` for next-turn prompt context (`docs/plugins/hooks/prompt-and-session.md`).

---

## 2. The map: Refine Cycle's 11 needs → OpenClaw

Need numbering follows the brief. Ratings: **exact** (drop-in equivalent), **partial** (needs workarounds), **nothing** (no counterpart).

| # | Refine Cycle need (Hermes API) | Our source | OpenClaw offer | Rating | What's missing / workaround cost |
|---|---|---|---|---|---|
| 1 | Turn-loop hooks (8): `pre_llm_call`, `pre_tool_call`, `post_llm_call`, `transform_llm_output`, `on_session_end`, `on_session_reset`, `subagent_start`, `subagent_stop` | `__init__.py:1895-1900` (+8 registrations); handlers at `_on_pre_llm_call:845`, `_on_transform_llm_output:833`, `_on_session_reset:963`, `_on_session_end:1658`, `_on_subagent_start:1798`, `_on_subagent_stop:1810` | Typed catalog above: `before_prompt_build`, `before_agent_run`, `before_agent_finalize`, `agent_end`, `session_start`/`session_end`, `before_reset`, `subagent_spawned`/`ended`/`progress`, `before_tool_call`, `after_tool_call`, `llm_input`/`llm_output` | **Partial** | No direct `transform_llm_output` — closest is `before_agent_finalize` (request one more pass, indirect); session/subagent/end/reset hooks are **Observe-only**, not Modify. 8 registrations become ~10–12 typed ones; output-shaping logic must move to queued next-turn injection. **3–5 days.** |
| 2 | Session history across sessions as data (SQLite `state.db`, queryable) | `core.py` SQL against `messages`/`sessions`; fingerprinting in `patterns.py` | Canonical SQLite session store: `listSessionEntries({agentId})` cross-session; transcript reads via `readSessionTranscriptRawDelta` / `readSessionTranscriptVisibleMessageDelta` with opaque cursors; default page 1,000 events / 1M bytes, caps 10,000 events / 64 MiB; bounded `openModelContext` reads | **Exact** | No single lifetime-dump call: long histories need cursor loops; reads are per-session-authorised and byte-capped. Core idea fully achievable. **2–3 days.** |
| 3 | Durable agent memory, injected into every future system prompt, budgeted, threat-scanned (`tools.memory_tool.MemoryStore`, `MEMORY.md`) | `core.py` calls to `MemoryStore`; `docs/SPEC-memory-budget-and-honest-refusal.md` | `MEMORY.md` *is* loaded at every session start with bootstrap-budget truncation (`docs/concepts/memory.md`) — **but** the memory capability is an **exclusive slot**: `api.registerMemoryCapability(capability)` allows exactly one active implementation (`docs/plugins/sdk-overview/memory-and-context.md`). A plugin cannot also be the memory plugin. No plugin API writes injected global memory. | **Nothing (first-class) / Partial (workaround)** | Workaround: durable plugin-scoped store (`api.runtime.state.openKeyedStore`) + re-inject lessons into each new session's prompt via `session_start` + `before_prompt_build`/`enqueueNextTurnInjection`. Loses automatic indexing/provenance/budget isolation; adds reinjection ordering risk and a redesign of where lessons live. **8–12 days, high ongoing fragility. This is the soft blocker.** |
| 4 | Skills: list/view (`tools.skills_tool`) + create/patch (`tools.skill_manager_tool.skill_manage`), load-on-demand Markdown skills | `core.py` skill-manager calls; `tools.skill_manager_tool` | Skills are **static `SKILL.md` manifests** bundled with packages/extensions (`extensions/*/skills/*/SKILL.md`); no `registerSkill` or runtime skill-management API exists in the plugin SDK docs (searched `docs/plugins/sdk-overview/*.md`). | **Nothing** | No faithful counterpart to dynamic create/patch skills. Only extreme fallback is owning the exclusive context-engine slot (`api.registerContextEngine`), which replaces the whole context engine — unacceptable. Feature effectively unavailable as designed. |
| 5 | Call the user's own model/route without a plugin key (`agent.plugin_llm.PluginLlm`, invocation-bound) — needed an 8-file host patch | `llm.py:13` `PluginLlm`; `docs/HOST-PATCH.md` (+977/−14 across 8 files, `bind_invocation()`) | Native, patch-free: `api.runtime.llm.complete({...})` and `prepareSimpleCompletionModelForAgent({ cfg, agentId })` resolve the agent's own model selection, auth profile, provider and base URL from user config (`docs/plugins/sdk-runtime/models.md`; impl `src/agents/simple-completion-runtime.ts:529-541`). Usage reconciled against the auth profile's quota blocks (`reconcileAuthProfileQuotaBlocks`, lines 264/279). Isolated zero-tool mode available. | **Exact (better than Hermes)** | Completion is a separate host-owned invocation, not bound to the current turn's exact client object — fine for offline lesson proposal/scoring. Zero patch needed (Hermes needed +977/−14). **1–2 days.** |
| 6 | Slash commands (`/refine status`, `/refine_update`, `/refine_fix`) | `__init__.py` command handlers | `api.registerCommand` / root CLI commands via manifest `cliCommands`; `openclaw plugins inspect <id>`; hot reload via `openclaw plugins reload <id>` (`docs/plugins/sdk-overview/tools-and-commands.md`; `docs/plugins/manage-plugins.md`) | **Exact** | Direct mapping. **1–2 days.** |
| 7 | Push a message the user didn't ask for (release notice, "stopped working") via `hermes_cli.send_cmd` | `notify.py`; `notices.py` | No push-notification primitive exposed to plugins. Delivery surfaces (`message_sending`, `reply_dispatch`, `toolContext.delivery.send`) require an **active conversation binding/route**. A plugin cannot proactively ping an idle user. | **Nothing / Partial** | Status lives in a Control UI widget (lab-flag-gated, see #8) or is surfaced by injecting into the next user turn. Announcement use-case degraded. **2–4 days + UX redesign.** |
| 8 | Desktop surface: status-bar item + chat card, JS plugin for the Electron app | `desktop/plugin.js` (343 lines) | OpenClaw = server + **web Control UI**, not an Electron desktop. Custom plugin UI is a **default-OFF lab flag** (**Settings → Labs → Custom plugin UI**), exposing React widgets/pages to opted-in operators only (`docs/plugins/feature-plugins.md:35-37`, `registerWidget`, dashboard widgets, `registerControlUi`). | **Nothing** | Reach is capped at operators who enable the lab flag; no status bar. Rebuild as widget **4–6 days**, adoption-limited. |
| 9 | Restart the host after a self-update (`gateway.run.GatewayRunner`, `gateway.status`) | `install.py` / update flow | In-process native plugin: `openclaw plugins reload <id>` refreshes runtime without restart (`docs/plugins/manage-plugins.md`). Full Gateway restart remains an **operator action**; no documented programmatic restart surface for plugins. Bundled plugins can be disabled/reloaded but not removed. | **Partial** | Installer becomes "reload + instruct operator to restart". `gateway_start`/`gateway_stop` hooks exist for service lifecycle. **1–2 days.** |
| 10 | Plugin-owned home dir for journal/backups/locks; cross-process locking (gateway+CLI+cron converge) | `config.py` (`get_hermes_home`); locking in `journal.py`/`core.py` | Workspace paths via `api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId)` + authority via `api.runtime.sandbox.resolveWorkspaceAuthority({workspaceDir})`; durable namespaced SQLite via `openKeyedStore`/`openBlobStore` (per-plugin caps: 512 MiB BLOBs, 50k rows) (`docs/plugins/sdk-runtime/agent.md`, `state-and-system.md`). **No documented cross-process lock primitive.** Concurrency model differs (in-process Gateway). | **Partial** | Workaround: filesystem `flock` on workspace lock files + advisory discipline; concurrent-invocation correctness needs e2e validation since CLI/cron/Gateway share the process differently than Hermes. **2–3 days + correctness risk.** |
| 11 | Installer disables the write-approval queue (`tools.write_approval`), else no lesson lands | `install.py` | Tool/exec approvals exist (`before_tool_call` gate) but a plugin-owned **host completion is not a user tool call**, so no approval queue stands between the plugin and its writes. Direct workspace file writes follow route-specific sandbox-authority rules. | **Partial (favourable)** | Failure mode differs and is milder than Hermes; verify per-deployment approval config if using file writes. **~1 day validation.** |

---

## 3. The three blockers, judged individually

### Blocker 1 — Is the history of past sessions readable, across sessions, as data? **YES. Not a blocker.**

OpenClaw exposes exactly what Refine needs: `api.runtime.agent.session.listSessionEntries({ agentId })` iterates all of an agent's session rows (`docs/plugins/sdk-runtime/agent.md`); `getSessionEntry`/`patchSessionEntry` address one row; transcripts are read through bounded cursor APIs `readSessionTranscriptRawDelta` and `readSessionTranscriptVisibleMessageDelta` (defaults 1,000 events / 1,000,000 bytes, caps 10,000 events / 64 MiB; a cursor identifies position only and never grants another session). The canonical store is SQLite-backed. Cross-session failure fingerprinting — the plugin's whole premise — is fully achievable. Caveat (workaround cost noted above): very long trajectories need multi-page loops; raw event field shapes are UNPROVEN without reading the TypeScript types.

### Blocker 2 — Is there durable memory injected into future sessions, and can a plugin write to it? **NO FIRST-CLASS ANSWER. The soft blocker.**

Two separate facts:
1. `MEMORY.md` **is** loaded at the start of every session and **is** truncated when it exceeds the bootstrap file budget (`docs/concepts/memory.md`) — so the injection-with-budget mechanism exists in the host.
2. But the **write side is not open to plugins.** The unified memory capability is an **exclusive slot**: `api.registerMemoryCapability` admits one active implementation at a time (`docs/plugins/sdk-overview/memory-and-context.md`), so Refine could not coexist with the user's existing memory plugin, and there is no sanctioned "plugin writes to global injected memory" API. Memory is written by the agent/tools (`memory_search`/`memory_get`/`intent`, `docs/concepts/memory.md`), not by plugins.

Workaround that keeps the central idea alive: persist lessons in durable plugin-scoped SQLite (`api.runtime.state.openKeyedStore` — survives restarts, namespace-isolated) and inject them into each new session's prompt via `session_start` + `before_prompt_build` (or `enqueueNextTurnInjection` per turn) (`docs/plugins/hooks/prompt-and-session.md`). This loses MEMORY.md's automatic indexing, provenance tracking, and isolated budget, and it makes lesson injection order-dependent and reinjection-managed — a real architectural tax on the feature that defines the product. If you judge the memory behaviour as essential *as implemented*, the plugin's central idea does not transfer cleanly; what survives is a lesson-journal that re-presents itself at session start rather than truly living in memory.

### Blocker 3 — Can a plugin call the model on the user's own route and budget, without its own key? **YES — natively, no patch. Better than Hermes.**

`api.runtime.llm.complete({...messages, purpose, maxTokens, temperature})` and `prepareSimpleCompletionModelForAgent({ cfg, agentId })` resolve the agent's own configured model selection, auth profile, provider, and base URL from the user's config (`docs/plugins/sdk-runtime/models.md`; `src/agents/simple-completion-runtime.ts:85-160, 529-541`). Token spend is reconciled against the auth profile's quota blocks (`reconcileAuthProfileQuotaBlocks`, lines 264/279), and an `isolated-agent-runtime` mode gives a zero-tool fresh context. So: same route, same key, same budget line, **zero host patch** — versus Hermes, which required a +977/−14 patch across eight files to expose an invocation-bound facade (`docs/HOST-PATCH.md`). Caveat: the completion is a separate host-owned invocation, not bound to the exact client object of the current turn — acceptable for Refine's offline lesson-proposal use case, but a plugin could not cheaply resume the current turn's client-side cache.

**Net on the three:** 2 of 3 resolve favourably (history yes, model yes-and-better). Only memory lacks a first-class answer — and even there, a workable emulation exists. None of the three, alone, kills the idea. The kill factors are elsewhere: the language barrier and the absence of dynamic skills / push notifications / a desktop surface.

---

## 4. What would survive a port — in numbers

Measured at tag `v1.3.16` (2026-09-22). **Note:** the brief states "~16k lines of Python … 1,278 tests"; the repository as tagged contains **~22.8k lines of application Python + 343 lines of JS + ~30.9k lines of tests + ~7k lines of Markdown docs**. The stated figure appears to reflect an earlier snapshot; the split below uses measured numbers, which is the conservative basis for any estimate.

### Application code (15 modules + 1 JS file = 23,157 lines)

| Category | Files | Lines | % of app code | Contents |
|---|---|---|---|---|
| **Host-independent (portable)** | `journal.py`, `ledger.py`, `lesson_effect_checker.py`, `patterns.py`, `sanitization.py`, `refine_trace.py` | **~5,850** | **~25%** | Journaling + rollback + backups; effect ledger; the frozen grader (555 lines, 100% independent); error fingerprinting (954, 100%); sanitisation; tracing. Pure algorithms, prompts-as-data, schema definitions — no host imports. |
| **Mixed** | `config.py`, parts of `journal.py`/`llm.py` | ~1,400 | ~6% | Path resolution + feature flags (Hermes home), LLM facade fallback client; extraction-friendly behind adapters. |
| **Host-bound** | `__init__.py` (2,002), `core.py` (7,905), `llm.py` (~1,950 bound), `notices.py` (~665), `notify.py` (~255), `update_check.py` (~335), `install.py` (1,896), `desktop/plugin.js` (343) | **~15,900** | **~69%** | Hook registration + 6 slash-command handlers + desktop bridge; the full cycle orchestrator; PluginLlm invocation-binding; release notices + CLI sends; update checking + delivery; installer + patch application; Electron surface. |

### With tests (~30,922 lines)

Assuming ~90% of test lines exercise host-independent logic/harness rules (`test_lesson_effect_checker.py`, `test_usefulness.py`, `test_proposer_status.py`, `test_block_rule_fallback.py`, and the `run_tests.py` harness), the tests add ~27,800 portable lines. **Including tests: ~33,650 portable / ~16,300 host-bound out of ~54,100 total lines (~62% / ~30% / ~8%).**

### Library-with-adapters verdict

The genuinely portable half is already structured like one: `patterns.py` (fingerprints), `journal.py` (entries + rollback), `ledger.py` (effect records), `lesson_effect_checker.py` (the frozen grader), `sanitization.py` all take inputs and emit outputs with no host coupling. These five could ship as a language-neutral **adapter library** (conceptually: `RefineCore { fingerprint(traj), propose(lessons), score(probe, outcome) }`) with per-host adapters implementing `read_history`, `write_memory_injection`, `call_llm(route)`, `send_notice`, `register_hooks`. In practice, for OpenClaw the adapter target is TypeScript and the Python half would need either a TypeScript port or a subprocess sidecar — see Section 5.

---

## 5. Port vs rebuild

**Assumption for all figures:** one senior full-stack TypeScript engineer familiarising themselves with the OpenClaw SDK, 8-hour days, **including SDK ramp but excluding a formal security review and excluding building a large probe bank from scratch**. Effort is given as a range reflecting how quickly the experimental-API shapes are learned.

### Option A — Port (keep the core, write an OpenClaw adapter)

A literal port is impossible: OpenClaw plugins are TypeScript/ESM in-process, so Python cannot host the existing 22.8k lines. The only "port" shape is a **TypeScript plugin shell + Python sidecar** (the plugin shells out to the Python modules over IPC/stdio), or a full rewrite of the host-bound half while reusing the portable Python half via the same sidecar.

- **Work:** 45–70 days. TypeScript plugin shell + hook wiring (8–12); sidecar protocol, packaging, lifecycle and error handling (8–12); adapter implementations for history/state/injection/commands (12–18); keeping Python modules importable and dependency-pinned across two runtimes (6–10); testing both halves (8–12); desktop surface dropped, notices redesigned (3–5).
- **What is lost anyway:** desktop status-bar item; push notices to idle users; dynamic skills; the clean single-process deployment (now two binaries + IPC + its own locking story layered on top of OpenClaw's in-process model).
- **What breaks first when OpenClaw changes:** the experimental hook event shapes (`before_prompt_build`, `session_start`) and the session-store API (beta.5 compatibility window ends 2026-10-12 per `docs/plugins/sdk-runtime/agent.md`) — and now also the sidecar boundary, which has *two* version skews (plugin↔Python and Python↔OpenClaw docs).
- **Can the measured effect be reproduced?** Only by building a new harness. OpenClaw documents agent harnesses (`docs/plugins/sdk-agent-harness.md`) and programmatic subagent runs (`api.runtime.subagent.run`), plus tool plugins, so a probe can launch a task-with-tools and score the outcome — but there is no frozen-grader-equivalent shipped. Feasible, ~10–15 days extra, and the new harness itself must be validated before its numbers are trustworthy.

### Option B — Rebuild (native TypeScript plugin, reuse ideas + grader logic only)

Write the plugin the way OpenClaw wants: `definePluginEntry`, typed hooks, `openKeyedStore` for the journal, `listSessionEntries` + transcript deltas for scanning, `api.runtime.llm.complete` (isolated) for proposal/scoring, `session_start` + `before_prompt_build` for lesson injection, `registerCommand` for `/refine *`, optional Control UI widget behind the lab flag.

- **Work:** 25–40 days MVP, +10–15 days measurement. History scanner + fingerprint port (3–5); lesson proposer over isolated completions (2–3); journal in `openKeyedStore` w/ schema + migrations (2–3); prompt-injection hooks with dedupe/ordering (3–4); slash commands + update self-check (2–3); lock-file discipline (1–2); tests (4–6); integration/e2e against a real agent (4–6); optional widget (4–6, gateable to a later release).
- **What is lost:** the proven Python codebase (rewritten — prompts and grader *logic* survive, the code does not); exact Modify semantics for `transform_llm_output` (becomes "request another pass" + next-turn injection); dynamic skills; the desktop card (unless the lab-flag widget is built).
- **What breaks first when OpenClaw changes:** hook event payloads (mitigated by pinning the SDK version and the documented migration windows); the session-store helpers during their beta window; the memory-slot exclusivity policy if it changes. All tracked by the SDK's published compat registry.
- **Can the measured effect be reproduced?** Yes, same answer as Option A on harness — the host can run tasks with tools via harnesses/subagents, so probes + a JS port of `lesson_effect_checker.py` (555 lines of pure logic) can reproduce the 66-vs-28 style comparison. The grader's vocabulary-matched scramble/placebo design is portable concept-for-concept.

**Recommendation:** Option B. Option A pays ~2× the days for a sidecar architecture that is *more* fragile than a clean rewrite and still loses the same host surfaces. A native rebuild fits the host's capability model, inherits its distribution/review/update mechanics, and fails in documented, migratable ways rather than in IPC between two runtimes.

---

## 6. The ecosystem

- **Distribution & install** (`docs/plugins/manage-plugins.md`): publish to the **ClawHub** registry (`clawhub.ai`); users install with `openclaw plugins install clawhub:<package>` (versioned `@x.y.z` and `@beta` supported). The Control UI browses/installs but "does not install from arbitrary npm, git, or local-path sources" — those go through the CLI: `npm:`, `git:`, `npm-pack:`, and `--link <path>`. Deterministic source selection via the `clawhub:`/`npm:`/`git:`/`npm-pack:` prefixes.
- **Registry & review:** install/enable triggers a **capability-consent screen** reviewing the declared capability surface (channels, providers, tools, hooks, MCP servers, CLI commands, skills, dangerous flags) plus version/source and artifact integrity — not human moderation, but automated surface review with operator acceptance recorded. Verified first-party plugins from OpenClaw's official catalog skip review; verification checks package identity against the catalog and the verified npm source record at clawhub.ai, and "a matching plugin id or package name alone is insufficient" (local copies/archives/git/custom registries still require review). Acceptance carries forward across updates when the declared surface and recorded integrity are unchanged; sources without integrity (local paths) require consent every time.
- **May a plugin patch the host?** **No sanctioned mechanism.** Plugins register capabilities and run in-process; modifying OpenClaw core is an out-of-band user patch — unsupported, lost on every update, and it breaks the artifact-integrity model that consent carry-forward relies on. The trust gate is capability consent, not patch review. Note the consequence for Refine's history: Hermes needed a shipped host patch just to call the model; OpenClaw needs **none** for that particular need — the patch-shaped problem simply does not recur for LLM access, but any other host modification would be unsupportable.
- **Licences:** OpenClaw is **MIT** (`package.json`; `THIRD_PARTY_NOTICES.md` for dependencies). Refine Cycle is MIT (c. Taras Boiko). Compatible; a published OpenClaw plugin must declare `peerDependencies: { openclaw: ">=<version>" }` and pin tested versions given the experimental SDK.
- **Does anything like Refine Cycle already exist there?** Nothing comparable found in the bundled extensions or documented plugins: searches across `extensions/` and `docs/plugins/` for self-improvement / lesson / retrospective / failure-loop / learning-from-failure returned no match (only an unrelated mention in `docs/plugins/workboard.md`). **UNPROVEN for the wider ClawHub registry**, which cannot be queried offline.

---

## 7. What could not be established, and what would settle it

| Unresolved point | Why it matters | What settles it |
|---|---|---|
| Exact TypeScript return/error shapes of `api.runtime.llm.complete` and the plugin-state APIs | Determines how much wrapper code the adapter needs and whether usage/tokens are observable for logging | Read `src/plugin-sdk/llm.ts`, `src/agents/simple-completion.types.ts`, `src/plugin-state/plugin-state-store.types.ts` |
| Whether workspace file writes by a plugin trigger exec/approval gates under the default configuration | Affects whether the memory-workaround write path is approval-free in practice | Live install probe writing to `resolveAgentWorkspaceDir` with default approvals |
| The field-level shape of transcript delta events (do tool name/content/timestamps arrive usable for fingerprinting?) | Refine's fingerprinting consumes role/tool/content/time | Read `src/sessions/user-turn-transcript.types.ts` / event contract types; a one-off probe |
| Whether concurrent CLI + cron + Gateway invocations of the same plugin collide (Hermes' locking problem) in OpenClaw's in-process model | Locking strategy (#10) depends on it | Source trace of plugin dispatch paths + a concurrency e2e test |
| Whether ClawHub hosts any third-party self-improvement/lesson plugin today | Competitive overlap / prior art | Browse/search `clawhub.ai` directly |
| Full semantics of Hermes' 8 hooks beyond their names (Modify vs Observe, what each receives) | Tightens the #1 map row | Hermes hook docs + Refine's own handler signatures (`__init__.py`)

---

## Appendix — source index

**Refine Cycle (tag v1.3.16):** `__init__.py` (hook registrations 1895–1900; handlers: 833, 845, 963, 1658, 1798, 1810); `core.py` (7,905 lines); `llm.py` (`PluginLlm` import, line 13); `journal.py`, `ledger.py`, `lesson_effect_checker.py` (555), `patterns.py` (954), `sanitization.py`, `refine_trace.py`, `notify.py`, `notices.py`, `update_check.py`, `install.py` (patch application); `desktop/plugin.js` (343); `docs/HOST-PATCH.md` (+977/−14, 8 files); `docs/RESEARCH-REPORT-2026-09-12.md`; line counts measured 2026-09-22.

**OpenClaw (v2026.9.5; HEAD 8a9bc25, 2026-09-21; docs observed 2026-09-22):** `package.json` (version, MIT); `docs/plugins/building-plugins.md` (TypeScript ESM requirement, line 31; host-trusted manifest gates, 126); `docs/plugins/sdk-overview.md` (experimental stability); `docs/plugins/architecture.md` (shapes, in-process trust); `docs/plugins/hooks/reference.md` (hook catalog); `docs/plugins/hooks.md` (typed `api.on`, budgets, conversation access); `docs/plugins/hooks/prompt-and-session.md` (session extensions, next-turn injections); `docs/plugins/sdk-runtime/agent.md` (session store + transcript deltas, beta.5 window to 2026-10-12); `docs/plugins/sdk-runtime/models.md` (host-owned completions); `docs/plugins/sdk-runtime/state-and-system.md` (durable stores); `docs/plugins/sdk-runtime/background-work.md` (subagent runs); `docs/plugins/sdk-overview/memory-and-context.md` (exclusive memory slot); `docs/concepts/memory.md` (MEMORY.md injection + truncation); `docs/plugins/manage-plugins.md` (ClawHub, consent review, reload); `docs/plugins/feature-plugins.md` (Custom plugin UI lab flag); `src/agents/simple-completion-runtime.ts` (auth-profile resolution + quota reconciliation).
