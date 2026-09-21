# OpenClaw: how a plugin puts a durable lesson in front of the agent

**Scope.** Only the "writable prompt-injected memory" blocker from the Refine Cycle rebuild analysis: *what are all the ways a plugin can put a short, durable lesson (a sentence or two, a handful to a few dozen) in front of the agent in future sessions, surviving restarts, reaching the model without user action, with add/change/remove by the plugin?* Everything else about the rebuild is settled.

**Evidence base.**
- OpenClaw source, main branch, commit `8c56f7239e98dbee1369e036d6b594fd560b9d9d` (repo state 2026-09-21; current release line `2026.9.x`, latest mirrored release note `2026.9.5`). Cited as `src/<path>` at `8c56f72`.
- Live docs at `docs.openclaw.ai` (mirror markers show release versions, e.g. `2026.9.5`).
- CHANGELOG entries under `CHANGELOG/` (per-release, e.g. `CHANGELOG/2026.9.3.md`).
- Community plugins inspected directly (`CortexReach/memory-lancedb-pro` cloned and read; ClawHub pages fetched).

---

## 1. Recommendation (three lines)

**Use the `before_prompt_build` Modify hook**: on every prompt build, read your own lesson store and return `{ prependContext: "<your lessons block>" }`. It reaches the model on every turn of every session (embedded/CLI runners for sure; Copilot documented; Codex coverage unverified), survives restarts because the plugin re-runs and re-reads its own store, takes **no slot**, conflicts with no other plugin's memory, and requires **no host patch**. Store lessons yourself — `api.runtime.state.openKeyedStore(...)` if your plugin is trusted, otherwise your own SQLite/file under the workspace or state dir.

**Second choice:** a **ContextEngine** (`plugins.slots.contextEngine`) only if you also need to rewrite the whole context pipeline (compaction, summarization, message selection). It can inject lessons via `systemPromptAddition`, but it is an exclusive slot and replaces the host's entire context engine — overkill and fragile for a handful of one-line lessons.

**Avoid:** taking the memory slot (`registerMemoryCapability`) just to get prompt space, and editing `AGENTS.md`/skills from the plugin. Both either seize a user capability or rely on formats the user/session controls.

---

## 2. Summary table

| Way | Works? | Exclusive? (takes something from user/other plugins) | Limits | Fragility (API stability + break risks) | Effort (lesson-injection part only) |
|---|---|---|---|---|---|
| **1. `before_prompt_build` (+ `agent_turn_prepare` / `heartbeat_prompt_contribution`) Modify hook** | **Yes** — runs every prompt build; lessons returned as `prependContext`/`appendContext` are concatenated into the model input. Confirmed in source. | **No.** Any number of plugins may register; results merge. No slot. | No explicit host cap found on hook context (see 3.1). Effective limit = model context window + compaction. Per-plugin next-turn queue (a related seam) caps text at 32 KiB and 32 entries/session. | **Low–medium.** Typed hooks are documented as the "safest no-breakage path", but every plugin API is experimental and the SDK churned hard in 2026.9.x (>=3 breaking SDK surface renames in `2026.9.3` alone). Hook contract itself (return shape, priority, first-defined systemPrompt) is source-stable. Codex harness dispatch of this hook is UNPROVEN. | **~1–2 person-days** (store + render + one handler). |
| **2. `registerMemoryCapability` (memory slot)** | Yes, but you must implement the **whole** memory for the user. | **YES** — `plugins.slots.memory` is one implementation at a time. A second memory plugin is disabled with warning ("memory slot already filled"). | Must satisfy `MemoryPluginCapability` (indexer + runtime + recall tools + prompt builder). Taking it away from the user means owning their memory. | **Medium–high.** Host memory design has been rewritten repeatedly (memory moved to plugin slots; LanceDB/Mem0 ecosystem around it). You inherit all of it. | **~10–20+ person-days** for a usable memory. Not justified. |
| **2b. `registerMemoryPromptSupplement` / `Preparation` / `CorpusSupplement` (additive memory adjuncts)** | **Partially — under conditions.** Additive, non-exclusive, registered without slot ownership. Renders into the system-prompt memory section. | **No.** | Output appears only when the session's memory section is included (`includeMemorySection` gate — likely tied to memory search being enabled). Consumes via host system-prompt assembly (`src/agents/system-prompt.ts`). | **High / UNPROVEN.** Consumption gating not fully mapped; undocumented as a general injection seam; may be inert when the user has no memory backend. | **~2–4 days**, but risky. Spike needed before betting on it. |
| **3. Skills shipped via manifest `"skills"` field** | **Only under conditions.** Plugin skills load when the plugin is enabled (priority 7, lowest), but a session selects <=64 skills itself and retains that selection. New sessions auto-select from the library; existing sessions keep what they had. | **No** slot, but lowest precedence (workspace/project/personal/managed/bundled skills override same-named plugin skills). | <=64 selected per new session; no guaranteed per-turn injection; skill format (`SKILL.md` + frontmatter) evolves. | **Medium.** Skill bundle format stable-ish, but injection is not automatic — fails the "without the user doing anything" requirement for existing sessions. Official `self-learning` skill writes learnings to `.learnings/` markdown (skill, not auto-injected). | **~3–5 days**; does not meet the requirement, so not worth it as the mechanism. |
| **4. AGENTS.md / SOUL.md / USER.md instruction files** | Technically yes if the plugin rewrites workspace files (exec or fs), but there is **no sanctioned API** for it. | **No**, but you are mutating user-owned files. | Loaded at the start of every session (`docs/concepts/agent-workspace`); user edits and bootstrap resets overwrite you; Control UI owns these files. | **High.** Hostile to the user's own instructions; bootstrap may recreate them; audits may flag workspace mutation. Bad practice. | Trivial code, unacceptable risk. |
| **5. `registerContextEngine` (context-engine slot)** | **Yes** — full control of ingest/assemble/compact; inject via `systemPromptAddition` in `assemble()`. | **YES** — `plugins.slots.contextEngine`, one implementation at a time; replacing the host's default engine costs you the whole context pipeline. | Must implement `ingest()`, `assemble({messages,sessionKey,availableTools,citationsMode})`, `compact()` (delegate via `delegateCompactionToRuntime` unless you own compaction). | **High.** The context engine is exactly where the host has churned (ContextEngine introduced in `2026.3.7`, assembly boundaries change). Replacing core orchestration = you break when they refactor. | **~15–30 person-days**. Overkill. |
| **6. Durable storage: `openKeyedStore`, `registerSessionExtension`, `enqueueNextTurnInjection`** | Storage **survives restarts** (session store / state dir), but **none of it auto-injects** — you still need a hook (candidate 1) to surface it to the model. | **No**, except trust gating on `openKeyedStore` (trusted plugins only; `assertTrustedPluginRuntime("openKeyedStore")`). | Next-turn injection: 32 KiB text max, 32 entries/plugin/session, idempotency-key dedup, TTL, expired/inactive/prompt-injection-disabled records dropped, **consumed once then deleted**. Session extension: JSON only, projected to Control UI as `pluginExtensions`. | **Medium.** Persistence contracts are typed; the single-consume semantics of injections trip people up (docs warn: "consuming an entry is not a receipt that the model saw it"). | **~1–2 days** as plumbing *paired with* candidate 1. Useless alone. |
| **7. A tool the agent calls (e.g. `memory_recall`)** | **Only if the agent decides to call it.** | **No.** | Depends on agent initiative + tool policy. | **High** as an injection mechanism — unreliable for guaranteed delivery. Worth having as the explicit "look up lessons" surface alongside candidate 1. | ~1 day, near-zero value standalone. |

---

## 3. Each candidate, in detail

### 3.1 `before_prompt_build` and the other Modify hooks — WORKS, NOT EXCLUSIVE

**What it can change.** On the embedded and CLI runners the return shape is:

```ts
{ prependContext?, appendContext?, systemPrompt?, prependSystemContext?, appendSystemContext?, toolsAllow? }
```

(`docs.openclaw.ai/plugins/hooks/prompt-and-session`; same at main @ `8c56f72` in `docs/plugins/hooks/prompt-and-session.md`). `toolsAllow` narrows the turn's submitted tool surface (intersected across plugins) and is rejected by the Codex harness. The sibling hooks are `agent_turn_prepare` (same prepend/append, runs earlier, after queued-injection drain) and `heartbeat_prompt_contribution` (heartbeat turns only).

**Merge semantics — source-confirmed.** `src/plugins/hooks.ts`, `mergeBeforePromptBuild`:
- `systemPrompt: firstDefined(acc?.systemPrompt, next.systemPrompt)` -> **the first defined (highest-priority) systemPrompt wins**; later handlers cannot override it.
- `prependContext` / `appendContext` / `prependSystemContext` / `appendSystemContext` -> **concatenate in priority order** (`concatOptionalTextSegments`).
- `toolsAllow` -> **intersected**.

**Priority and ordering.** Handlers default to priority `0`; higher runs first, registration order breaks ties (`docs/plugins/hooks/reference`). On embedded/CLI: *drain queued injections -> `agent_turn_prepare` -> heartbeat contribution (if applicable) -> ordinary `before_prompt_build` -> finalized tool policy -> authorized prompt enrichment* (`docs/plugins/hooks/prompt-and-session`; ordered dispatch confirmed in `src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts`, `resolvePromptBuildHookResult`, @ `8c56f72`).

**Does the change reach the model?** Yes. The merged `prependContext`/`appendContext` flows into prompt assembly (`attempt-prompt-build.ts` applies `hookResult?.prependContext`/`appendContext` at lines 215-220) and, on the CLI runner, `composeCliPromptContext` renders them into the native prompt (`src/agents/cli-runner/prompt-context.ts`). Failed or timed-out handlers are logged and skipped while other handlers' results survive (15 s default budget for this hook; `docs/plugins/hooks/reference` table).

**Persistence across sessions.** The hook registration lives as long as the plugin is loaded and enabled — so `before_prompt_build` fires at every prompt build of every future session automatically. Durability of the *lessons themselves* is your responsibility: read them from your own store inside the handler (next-turn injection queue, keyed store, or your own files). The host does not store lessons for you here.

**Size limits.** No explicit host cap on `prependContext`/`appendContext` was found in the merge or prompt-build path at `8c56f72` (the only truncation in that fileset targets oversized tool results and structured metadata refs: `truncateOversizedToolResultsInMessages`, `MAX_STRUCTURED_MEDIA_REF_CHARS`, `truncateUtf16Safe` in `attempt-prompt-helpers.ts`). The practical ceiling is the model's context budget plus whatever the context engine/compaction does with overflow. Contrast with the adjacent next-turn-injection queue, which the host *does* cap: `MAX_PLUGIN_NEXT_TURN_INJECTION_TEXT_LENGTH = 32*1024` bytes and `MAX_PLUGIN_NEXT_TURN_INJECTIONS_PER_SESSION = 32` per plugin (`src/plugins/host-hook-state.ts`, @ `8c56f72`). The precedent community plugin (`memory-lancedb-pro`) self-imposes `recallMaxChars` (default 1000, configurable 100-10000) rather than hitting a host wall — consistent with "budget-driven, not hard-capped". Marked **UNPROVEN** whether a downstream LLM adapter silently truncates arbitrary prepended context; the spike (section 6) should print effective token counts to settle it.

**Several plugins wanting the same thing.** They coexist: contexts concatenate in priority order, so a lesson block from plugin A sits next to plugin B's block; a higher-priority plugin that returns a `systemPrompt` silently drops everyone else's (firstDefined wins) — that is the one real collision risk. Nested dispatch of ordinary `before_prompt_build` is skipped while an outer dispatch of the same hook is active on the same runner (reentrancy guard; `docs/plugins/hooks/prompt-and-session` + `hooks.prompt-build-reentrancy.test.ts`).

**Permissions / `requiresToolAuthority`.** Non-bundled plugins need `plugins.entries.<id>.hooks.allowConversationAccess: true` to register `before_prompt_build`; `allowPromptInjection: false` blocks it (and `agent_turn_prepare`, `heartbeat_prompt_contribution`, and durable next-turn injections) — defaults allowed (`docs/plugins/hooks`, "Permissions and scope"). `requiresToolAuthority: true` moves the handler into a **post-policy phase** that receives ephemeral `ctx.toolAuthority` tied to the finalized per-turn tool surface; supported on embedded, CLI, Copilot and Codex runtimes; returns only `prependContext`/`appendContext` there (`docs/plugins/hooks/prompt-and-session`, "Authorized prompt enrichment"; type flag listed in `docs/plugins/hooks/reference`). Use it if lesson retrieval calls a tool on the same turn.

**API stability.** Every plugin API is stated experimental (`docs.openclaw.ai/plugins/architecture`: capability-specific helpers are "evolving unless docs mark them stable"; typed hooks called the "safest no-breakage path"). Typed hooks have an explicit deprecation/removal regime (removeAfter dates and removal gates, section 5). The `before_prompt_build` return contract and priority model are concrete, tested (contract + phase tests in `src/plugins/`), and already depended on by external plugins — the most stable injection seam available.

**Effort.** Store wiring + a renderer that joins N lessons into one block + one `api.on("before_prompt_build", ...)` handler. ~1-2 person-days for the injection part.

### 3.2 `registerMemoryCapability` itself — YES, BUT EXCLUSIVE AND OVERKILL

**What taking the slot means.** `plugins.slots.memory` selects exactly one plugin (`docs/tools/plugin`, config reference). Selecting it force-enables that plugin for the slot, but any *other* memory-capable plugin that is not selected is disabled: `src/plugins/config-activation-shared.ts`, `resolveMemorySlotDecisionShared` returns `{ enabled: false, reason: 'memory slot already filled by "<id>"' }` for non-selected single-kind memory plugins (multi-kind plugins stay enabled for their other role) (@ `8c56f72`). If the selected id does not resolve to a memory plugin, startup fails hard: `"memory slot plugin not found or not marked as memory: <id>"` (`src/plugins/loader-runtime-core.ts:460`). Docs confirm behavior end-to-end: installing `@openclaw/memory-lancedb` "switches `plugins.slots.memory`... If another plugin currently owns the memory slot, that plugin is disabled with a warning" (`docs/plugins/memory-lancedb`).

So yes — a lesson plugin that grabs the slot **must implement the whole memory capability** (`MemoryPluginCapability`: indexer/runtime/recall/prompt builder) or at minimum carry the user's prior memory. That is a large contract (`src/plugins/plugin-api.types.ts:469`: "Register the active memory capability for this memory plugin (**exclusive slot**)").

**Wrap/delegate?** The registry keeps a flat `memoryCapabilities` list but only the slot-selected one's runtime/recall/indexing surfaces are used; non-selected plugins get their indexing runtime dropped (`src/plugins/registry-registrars-memory.ts`, lines ~40-55, where `_droppedRuntime` etc. are discarded for non-selected plugins). There is no documented delegation/wrapping primitive. **Two memory capabilities cannot coexist as active implementations in any released version** — the slot admits one, and the runner resolves exactly one via `resolveMemoryCapabilityRegistration(...)`. Nothing in the roadmap sources suggests multi-implementation support.

**Non-exclusive adjuncts exist (section 2, row 2b).** `registerMemoryPromptSupplement`, `registerMemoryPromptPreparation`, `registerMemoryCorpusSupplement` (`src/plugins/plugin-api.types.ts:471-477`) register into `registry.memoryPromptSupplements/Preparations/CorpusSupplements` **without slot gating** (`src/plugins/memory-state.ts`) and are rendered by host system-prompt assembly (`src/agents/system-prompt.ts:202-212` -> `buildMemoryPromptSection` -> synchronously via `buildSynchronousMemoryPromptSection` which includes `registry.memoryPromptSupplements.map(({builder}) => builder(params))`, then async preparations; `src/plugins/memory-state.ts:240-300`). **But** the memory section is gated by `includeMemorySection` / `isMinimal` parameters (`system-prompt.ts:212`), which come from the caller chain — i.e. the output likely only ships when the agent's memory search path is active. This is the interesting middle path: additive, no slot. **UNPROVEN:** exact gate conditions and whether a supplement renders when the user has *no* memory plugin installed. Needs the spike to settle; do not bet a rebuild on it yet.

**What the user sees / can break by hand.** They see `plugins.slots.memory` pointing at you in `openclaw.json`; they can flip it back anytime, and doctor/reload reconciles it. If they run two memory plugins, one is quarantined/disabled at startup.

**Effort.** A credible memory implementation is a 10-20+ person-day surface (embedding, vector/full-text store, recall tools, auto-capture, dedupe, ownership, CLI, forgetting) — or a thin wrapper that still must satisfy the capability shape and own recall latency budgets. Not justified to win a prompt-text slot.

### 3.3 Skills — CONDITIONAL, NOT ALWAYS-ON

**Can a plugin write one?** Yes — ship skills with the manifest: `openclaw.plugin.json` supports `"skills": ["dir"]` relative to the plugin root (`docs/plugins/manifest.md`, schema row "`skills` — Skill directories to load, relative to the plugin root"; `src/skills/loading/plugin-skills.ts` discovers them via `iteratePluginRootContributions({ contribution: "skills" })` at @ `8c56f72`). Example given in docs: the browser plugin ships `browser-automation`.

**Injected always or chosen?** Chosen. Skill precedence table puts plugin skills at **priority 7, lowest**, merged with `skills.load.extraDirs` (`docs/tools/skills.md`); a same-named bundled/managed/agent/workspace skill overrides. Selection is per session: *"A new session selects up to 64 enabled library skills... A session retains its selected skill IDs and revisions... explicitly attach or refresh a skill to use it on the next turn of an existing session"* (`docs/tools/skills.md`). So:
- A brand-new session *may* auto-select a plugin skill (library default selection, subject to the 64 limit and "personal first" ordering).
- An existing session keeps its old selection — your newly-added lesson skill is **not** re-selected.
- There is no documented "always-on skill" concept; eligibility is gated by frontmatter `metadata.openclaw.requires` and by session selection.

This fails the requirement "must reach the model in later sessions without the user doing anything." A skill could be *written* by the plugin (the agent writes learnings to disk, e.g. the official `self-learning` flow), but getting it back into the prompt requires the skill to be attached — circular.

**Stability / effort.** Skill bundle format is relatively settled; packaging is hours. But since it cannot guarantee injection, effort is moot for this requirement.

**Note on skill-hosted hooks.** Some ClawHub skills (e.g. `pskoett/self-improving-agent`) ship a `hooks/openclaw/` pack. Whether skill-borne hooks execute only when the skill is session-attached (almost certainly) makes them subject to the same selection problem; mechanism UNPROVEN in source and not relied upon.

### 3.4 Instruction / context files (AGENTS.md etc.) — USER-OWNED, NOT AN API PATH

**Who reads / when.** `AGENTS.md` ("operating instructions for the agent..."), `SOUL.md` (persona), `USER.md` (preferences, separate 4,000-char budget), `IDENTITY.md` are **"Loaded at the start of every session"** or "Loaded every session" (`docs/concepts/agent-workspace`, workspace file map; `docs/concepts/agent.md`; "standing orders" in workspace files at `docs/automation/standing-orders`). The default template lives at `docs/reference/AGENTS.default`.

**May a plugin write them?** There is **no plugin API** to mutate workspace instruction files. A plugin with filesystem access (e.g. via `exec`, or node fs from within a trusted runtime) technically can rewrite `AGENTS.md`, but:
- The user owns and edits these files via Settings -> Agents -> Files / Control UI.
- Bootstrap/onboarding recreates or seeds them (`skipBootstrap` exists precisely because bootstrap writes them; `docs/concepts/agent-workspace`).
- Audits/backups treat the workspace as private memory the user controls.

**Verdict.** Works technically, fails the "user sees and can break by hand" test catastrophically (by design, it's theirs), and competes with the user's own operating instructions. Not recommended. Effort trivial; risk unacceptable.

### 3.5 `registerContextEngine` — YES, EXCLUSIVE, MOST INVASIVE

**What it gives.** `api.registerContextEngine(id, factory)` where the factory returns `{ info: { id, name, ownsCompaction, acceptedHostParams }, ingest(), assemble(), compact() }` (`docs/plugins/architecture-internals/context-engines`; type `ContextEngineFactory` at `src/plugins/plugin-api.types.ts:338`). `assemble({ messages, sessionKey, availableTools, citationsMode })` may return `messages`, `estimatedTokens`, `systemPromptAddition`, and `contextProjection`; `buildMemorySystemPromptAddition` is provided to fold memory/wiki guidance in. If you don't own compaction you must delegate: `compact() { return await delegateCompactionToRuntime(params); }` (same page). You control **which messages are included, how history is summarized, and compaction** — i.e. full authority over what reaches the model.

**Exclusivity.** Selected via `plugins.slots.contextEngine` (`docs/plugins/architecture`; `docs/tools/plugin` lists `contextEngine` alongside `memory` as an exclusive category; config-state/effective-plugin-id plumbing mirrors the memory-slot decision, `src/plugins/config-activation-shared.ts:122,207` and `effective-plugin-ids.ts:155` at @ `8c56f72`). One engine per host; selecting yours replaces the default pipeline for the user. The doc line says it plainly: *"Use this when your plugin needs to replace or extend the default context pipeline rather than just add memory search or hooks."*

**Cost.** You own the context lifecycle for every agent: ingestion, assembly, projection, compaction, cache boundaries, epoching. Any host refactor of context internals lands on you. Introduced as a plugin slot in `2026.3.7` (`CHANGELOG/2026.3.7.md`; blog `openclaws.io/blog/openclaw-contextengine-deep-dive`) — still comparatively young and churn-prone. **~15-30 person-days**, and you break whatever the default engine gave the user unless you proxy it carefully. Justifiable only if Refine Cycle later needs compaction-aware lesson culling; not for injection alone.

### 3.6 Session extensions / host hooks / `ctx.storage` — DURABLE STORAGE, NOT INJECTION

**What survives restarts.**
- **Next-turn injections.** `api.session.workflow.enqueueNextTurnInjection(...)` (top-level `api.enqueueNextTurnInjection` deprecated alias, `src/plugins/api-facades.ts`; deprecation-marked in `src/plugins/compat/deprecation-marking.ts:336`). Persisted per plugin per session in the session entry's `pluginNextTurnInjections` map, drained once per prompt build (`drainPluginNextTurnInjections`, `src/plugins/host-hook-state.ts` @ `8c56f72`): drops expired entries, discards inactive plugins and plugins with prompt injection disabled, dedupes by `idempotencyKey`, enforces `MAX_PLUGIN_NEXT_TURN_INJECTION_TEXT_LENGTH = 32 KiB` and `MAX_PLUGIN_NEXT_TURN_INJECTIONS_PER_SESSION = 32` per plugin, sorts by `createdAt`, **then deletes the whole map on drain** (consume-once semantics). Drained entries are reused across retries *within the active run*, but "consuming an entry is not a receipt that the model saw it" (`docs/plugins/hooks`).
- **Session extensions.** `api.session.state.registerSessionExtension(...)` stores small JSON per plugin/session, patched through Gateway `sessions.pluginPatch`, projected read-only to Control UI as `pluginExtensions` (`docs/plugins/hooks/prompt-and-session`, "Session extensions and next-turn injections"; `getPluginSessionExtensionStateSync`/`patchPluginSessionExtension` in `host-hook-state.ts`). Survives restarts; JSON-only; **not injected into prompts**.
- **Keyed/blob stores.** `api.runtime.state.openKeyedStore<T>(...)` and `openSyncKeyedStore` — persistent per-plugin stores in the state dir — but gated: `assertTrustedPluginRuntime("openKeyedStore")`, and `retention: "retained"` requires `assertRuntimeCurrent()` (`src/plugins/registry-runtime.ts:258-266`). Trust is granted by the registry/install provenance machinery; a random npm plugin will not get it without operator allowlisting.

**The remaining gap.** All three are *storage*; none puts text in front of the model by itself. For lessons you would pair them with candidate 1: store in `openKeyedStore` (or your own file if untrusted), read and render in `before_prompt_build`. The next-turn queue is a poorer fit for *persistent* lessons because it is consume-once — you would re-enqueue every turn (e.g. from `agent_end`), which works but adds moving parts versus simply rendering in `before_prompt_build`.

**Effort.** ~1-2 days as plumbing alongside the hook; zero value standalone.

### 3.7 A tool the agent calls — UNRELIABLE ALONE

The lesson arrives only if the agent chooses to call `memory_recall`-style tools. Nothing forces that call; nothing in the hook/tool policy surface can *make* the agent invoke a specific tool on a future turn (tool policies can narrow/block surfaces, not conjure calls). As the sole mechanism it is worth nothing for guaranteed delivery. Its legitimate role: an explicit retrieval surface ("look up my lessons") that *complements* always-present hook injection, and a place for the user/agent to inspect or delete individual lessons. ~1 day, companion only.

---

## 4. Plugins that already do something like it

Searches covered: ClawHub (`hub.openclaw.ai`), GitHub, npm, community write-ups, Reddit roundups. Memory is the single most crowded category; "learning"/self-improvement exists mostly as skills.

### 4.1 Direct precedents for injecting durable text

| Name / link | What it does | Which of the 7 ways | Size | Maintained? | User complaints / notes |
|---|---|---|---|---|---|
| **CortexReach/memory-lancedb-pro** — github.com/CortexReach/memory-lancedb-pro | Full long-term memory: vector store (LanceDB), auto-recall, auto-capture, reflection distiller, preference slots, per-agent ownership, 5 tools + `ltm` CLI. | **#1 `before_prompt_build`** — `api.on("before_prompt_build", ...)` prepends recalled context each turn (index.ts lines ~3547-3955+); also command/new/reset, `before_reset`, `session_end`; reflection reminders injected via the same hook (line 5360 `SELF_IMPROVEMENT_RESET_REMINDER_CONTEXT`). | ~7,322 LOC `index.ts` + ~15 src modules (~5 kLOC); npm-style package, TypeScript built to `dist/`. | **Yes** — last commit recent (`fix(reflection): restore reflection on current hosts ... (#995)`); extensive test suite (`npm run test:*` groups). | Embedding dimension pitfalls, darwin-x64 unsupported, `input length exceeds context length` tuning (plugin-self-imposed `recallMaxChars`). It is a heavyweight memory system, not a lesson-writer. |
| **mem0ai/mem0** `@mem0/openclaw-mem0` — mem0.ai/blog/mem0-memory-for-openclaw | Persistent cross-session memory with Auto-Recall (every turn) + Auto-Capture (after each exchange), cloud or self-hosted. | Takes **#2 memory slot** (install switches `plugins.slots.memory`); auto-recall each turn — exact injection seam UNPROVEN from the blog (claims "two processes on every conversation turn"; likely memory-runtime recall, not a Modify hook). | External package; docs claim 30 s setup. | Yes (vendor-backed). | Blog frames complaints against stock memory: compaction destroys in-context memory, embedding 401s. |
| **Knol Memory** — hub.openclaw.ai/r2st/plugins/knol-memory | Rust-native context engineering + long-term memory via Knol API. | **#2 memory slot** ("OpenClaw plugin for Knol — Rust-native context engineering and long-term memory"). | Plugin (native). | Listed on ClawHub. | Cloud-dependent. |
| **SwarmRecall Memory**, **Soul Memory**, **mar-elite-longterm-memory**, **neural-memory**, **Memory Garden** (ClawHub) | Vector/semantic/graph memory variants, some skill-based. | Mix of **#2 slot** and **#3 skills**; Memory Garden advertises "validated knowledge to every conversation" (details behind listing). | Vary. | Mixed; ClawHub metadata present. | Typical memory-plugin ops (embeddings, dedupe, recall length). |

### 4.2 Self-improvement / learning plugins (closest to Refine Cycle's *purpose*)

| Name / link | What it does | Which way | Size | Maintained? | Complaints / gaps vs Refine Cycle |
|---|---|---|---|---|---|
| **akdira/self-smarter-everyday** — hub.openclaw.ai/akdira/self-smarter-everyday | Nightly cron routine (2 a.m.) with 6 phases: reflection, audit, memory compaction, **prompt evolution**, skill-gap analysis, improvement plan. Writes logs + `plans/daily/*.json`, versioned prompts, metrics/KPIs. | **#4 file-writing** (workspace/state dirs) + cron; prompt evolution edits stored prompt artifacts. Does **not** clearly inject lessons per-turn. | Substantial scripted system (Python orchestrator). | Listed; changelog-driven. | Heavy, self-modifying, file-based; learns at night, not from repeated cross-session failures; no effectiveness verification loop documented. |
| **initail/self-improving-agent-skill** — hub.openclaw.ai/initail/self-improving-agent-skill | Task-event -> experience extraction -> pattern abstraction -> skill update, with semantic/episodic/working memory, confidence tracking, **user confirmation gate** before applying changes, periodic self-validation. | **#3 skill** (patterns stored to `memory/self-improving/semantic/patterns.json`, loaded when skill attached). | Skill package. | Listed; self-validating design. | Requires explicit user approval gates; skill attachment not guaranteed per session. |
| **pskoett/self-improving-agent** — github.com/pskoett/self-improving-agent (ClawHub `@pskoett/self-improving-agent`) | Captures learnings, errors, feature requests across sessions; also ships `hooks/openclaw/`. | **#3 skill** + possibly a skill-borne hook pack (hook mechanism UNPROVEN). | Small skill package (~dozens of files; README-focused repo). | Open source, multi-agent original ported to OpenClaw. | Stores to `.learnings/`; relies on the agent/skill consulting that store; no automated effectiveness check. |

### 4.3 Verdict: does one already do what Refine Cycle does?

**No.** None cleanly implements the Refine Cycle loop — *detect failures that repeat across the agent's sessions -> write one small lesson -> later check whether that specific lesson helped.*
- `memory-lancedb-pro` injects durable text every turn via `before_prompt_build` (**proves the seam works**) and has reflection/self-improvement reminders, but its units are vectorized memories, not small verified lessons, and there is no measured "did this lesson reduce failures" step.
- `self-smarter-everyday` audits and evolves prompts but is nightly, file-based, and heavy; not per-failure, not injected-by-construction.
- The self-improvement skills persist learnings to disk and depend on attachment/consultation; they gate changes behind user approval.

**What is still worth building:** (1) the cross-session failure clustering/aggregation layer; (2) the minimal lesson store + per-turn rendering on `before_prompt_build` (proven seam); (3) above all the **effectiveness-measurement hook** — after a lesson is injected, track whether the same failure signature recurs and retire/amplify lessons accordingly. That measurement loop is the part nobody ships.

---

## 5. What an upgrade costs, and maintenance per year

### 5.1 Versioning and compatibility policy

- **Declarations.** Plugins declare compatibility in `package.json` as `openclaw.compat.pluginApi` (a range) and optionally `install.minHostVersion` (`docs/tools/plugin`, "Configuration -> Choose an install source" + compat paragraph). Manifest-level declarations are `kind`, `skills`, etc.; the API-floor declaration lives in the package, not the manifest.
- **Enforcement is real and fails closed.**
  - ClawHub install: `src/plugins/clawhub.ts:1134-1138` — if `!satisfiesPluginApiRange(runtimeVersion, compatibility.pluginApiRange)` the install is refused with `INCOMPATIBLE_PLUGIN_API: Plugin "<pkg>" requires plugin API <range>, but this OpenClaw runtime exposes <version>`; `minGatewayVersion` similarly yields `INCOMPATIBLE_GATEWAY` (`clawhub.ts:1144-1163`).
  - npm/local install validation: `src/plugins/install-shared.ts`, `validateOpenClawPackageCompatibility` — invalid range -> `INVALID_PLUGIN_API`; mismatched range -> `INCOMPATIBLE_PLUGIN_API: "...Upgrade OpenClaw or install a compatible plugin version and retry."`
  - Discovery: invalid `openclaw.compat.pluginApi` -> warn + **skip discovery** (`src/plugins/discovery.ts:630-635`); valid-but-unsatisfied range -> warn `"plugin requires plugin API <range>, but this host is <version>; skipping discovery (check 'openclaw --version', OPENCLAW_COMPATIBILITY_HOST_VERSION...)"` and skip load (`discovery.ts:646-653`).
  - Bundles: `"this plugin bundles an incompatible OpenClaw SDK; update it or contact its author"` (`src/plugins/loader-records.ts:196`, diagnostic code `sdk-incompatible`).
- **Runtime host version** comes from `OPENCLAW_VERSION` env / binary version (`src/version.ts`, `resolveCompatibilityHostVersion` at line 173; `checkMinHostVersion`).
- **Deprecation/removal regime.** Surfaces carry `removeAfter` dates or removal gates (e.g. `"next-plugin-sdk-major"`), tracked per-surface in a compatibility registry — **not** at major-version boundaries (`docs/plugins/hooks`, "Upcoming deprecations"). Removal follows an announced migration window, usually culminating in a major release (compatibility-policy summary). Concrete examples: top-level `api.registerSessionExtension` / `api.enqueueNextTurnInjection` deprecated in favor of `api.session.state.*` / `api.session.workflow.*` namespaces (same page); runtime-entry `kind` in `OpenClawPluginDefinition` deprecated **2026-07-25**, removal gate **2026-10-01** (`docs/plugins/manifest.md`, "JSON Schema requirements"); plaintext channel envelopes in `inbound_claim`/`message_received`, `onResolution` string -> typed union, `command-auth`->`command-status` rename (hooks page deprecation list).
- **Experimental stance in practice.** The architecture doc states helper subpaths are "evolving unless docs mark them stable" and calls legacy hooks the safest path for external plugins. So the typed hook surface (`api.on("before_prompt_build", ...)`) is the conservative choice; newer SDK helpers are the risk surface.

### 5.2 Breaking changes in recent releases

Spot-checked the last minor releases (all 2026; dates from changelog/release-note mirrors):
- **2026.9.3** — `CHANGELOG/2026.9.3.md` lists **three explicit `**Breaking**` SDK changes in one minor**: execution-policy helpers relocated (`resolveExecModePolicy`), approval account-resolution helpers moved, `channel-inbound.buildChannelTurnMediaPayload` renamed to `buildChannelInboundMediaPayload` with a named type removed. Any plugin using those helpers broke on upgrade.
- **2026.9.4** — ~170 changelog entries mention plugins/tooling churn (not exhaustively parsed).
- **2026.9.5** — ~355 mentions; feature-scale release ("plugins you can install without restarting your Gateway", atomic updates).
- Earlier, **2026.3.7** introduced ContextEngine as a plugin slot — a structural change that would have invalidated any prior context-internals integration.

Exact per-release break counts beyond the checked files: **UNPROVEN** (would require parsing every `CHANGELOG/2026.*.*.md` and matching against a fixed plugin corpus). Direction is clear: high churn, breaking changes land even in minors, advertised via `**Breaking**` headers + SDK migration guides.

### 5.3 Who updates, and does anything need a host patch?

- **Who updates the plugin:** the **author** publishes compatible versions; the installer/resolver picks the newest package advertising compatibility with the running build for unpinned specs (`docs/tools/plugin`). At runtime an incompatible plugin is **refused or skipped** — the host does *not* auto-load a wrong-API plugin and does not auto-repair it (doctor can quarantine/disable; `openclaw plugins update <id>` is the user's repair path). No registry-side rewrite of plugin code.
- **Does the chosen injection way need a host patch?** **No.** This is the decisive point. `before_prompt_build` is a first-class typed hook wired in the standard loader (`src/plugins/loader-module-runtime.ts` runs `api.on` registrations; hook dispatch via the global hook runner consumed by `attempt-prompt-helpers.ts`). You install, enable, and the handler runs. **Unlike the Hermes plugin, nothing in this path touches host source** — so the specific trap that killed the Hermes version (a host update rewrites your patch, plugin stops until you re-patch) does not recur. Upgrade cost is limited to adapting your own code if a surface you touch is renamed/removed, which the `openclaw.compat.pluginApi` floor plus the refusal logic makes visible at install rather than silent at runtime.

### 5.4 Maintenance estimate (person-days/year)

Estimates, reasoned from the evidence above (not measured telemetry):
- **Typed Modify hooks only (`before_prompt_build`, `agent_end`, plain storage):** **~2-4 days/year.** Rationale: the hook name/contract is concrete and precedent-bearing; watch the changelog, apply the occasional rename (2026.9.3-style SDK renames hit you only if you import the moved helpers — staying on raw hook registration sidesteps most of them). One incident like 2026.9.3 might cost a day if you do use an affected helper.
- **Leaning on newer SDK helpers / capability registration / `openKeyedStore`-adjacent surfaces:** **~5-10+ days/year.** Three breaking SDK changes in one minor is a plausible annual cadence of similar magnitude; each requires reading a migration guide and touching code, plus testing.
- **Taking the memory slot or becoming a ContextEngine:** **~10-20+ days/year** because you inherit the host's most-refactored subsystems.

Downside protection: declaring a tight `openclaw.compat.pluginApi` floor means an incompatible OpenClaw upgrade refuses your plugin at install/update instead of crashing, giving you (or the user running update) a hard signal rather than a silent broken agent.

---

## 6. Answers to the follow-up questions

### 6.1 The recommendation
**One way:** `before_prompt_build` returning `{ prependContext }`, lessons read from your own store (`openKeyedStore` if trusted, else your own persisted file/SQLite). Reason: guaranteed per-prompt delivery, no slot taken, no host patch, merge-safe coexistence with other plugins, and live precedent (`memory-lancedb-pro` does exactly this pattern at ~7.3 kLOC scale).  
**Second choice:** `registerContextEngine` — preferred only if you genuinely need to own compaction/summarization too (e.g. lessons must survive and steer context-window eviction), accepting the exclusive-slot cost and the rewrite burden.

### 6.2 Is the blocker real?
**No.** If a Modify hook can inject lessons into every prompt — and it can (`before_prompt_build`/`agent_turn_prepare` with `prependContext`, documented and source-confirmed, already used in the wild for exactly this) — then the memory-slot problem **is not a blocker**. What it costs instead is roughly **1.5 person-days** for the injection plumbing (handler + store read + render), plus the ordinary maintenance described in section 5.4, plus one design decision (trusted `openKeyedStore` vs. your own file/SQLite). The slot argument collapses: you do not need writable *host memory* because you have writable *prompt* access every turn and durable storage via typed state APIs.

### 6.3 The spike (<= 1 day)
1. Scaffold a minimal native plugin: `definePluginEntry({ id, name, description, register(api) { ... } })` with `openclaw.plugin.json` (empty `configSchema`, `activation.onCapabilities: ["hook"]`), enable it, and run `openclaw plugins inspect <id> --runtime --json` to confirm the handler registers.
2. Wire the store: try `api.runtime.state.openKeyedStore<{lessons: string[]}>("refine.lessons")` and log whether it throws with `openKeyedStore is only available for trusted plugins`; if trusted-gated, fall back to a JSON file at `<stateDir>/refine-lessons/<agentId>.json` written with node `fs`.
3. Seed one lesson (a scratch CLI command or a one-off config write).
4. Register `api.on("before_prompt_build", async (event, ctx) => { const lessons = read(); logger.info('bpp ran, ' + lessons.length + ' lessons'); return { prependContext: '## Lessons\n\n' + lessons.map(l => '- ' + l).join('\n') }; })`. Also register `agent_end` as an observation hook that appends a marker lesson so you can test add/remove.
5. Send any user message in a **new** session; run the Gateway with `--raw-stream --raw-stream-path <dir>` (docs prompt-and-session debugging) or observe `llm_input` to capture the exact model input. **Pass criterion A:** the lessons block appears verbatim in the model input.
6. Stop the Gateway completely, restart it, start a fresh session, send a message. **Pass criterion B:** lessons still appear — proving survival across restart without user action.
7. Add a second lesson and remove the first (through your store), restart Gateway, new session. **Pass criterion C:** only lesson 2 appears — proving add/change/remove.
8. Install/enable a stock memory plugin (`@openclaw/memory-lancedb` or mem0) alongside yours. **Pass criterion D:** `openclaw plugins inspect` shows your plugin fully loaded with the hook registered, the memory plugin still owns its slot, and both runs produce output — proving no exclusivity collision.
9. Print the effective prompt/context length per turn (from `llm_input` usage or hook-side token counting) with 1, 10, and 30 lessons. **Pass criterion E (sanity):** identify where your block sits and how much budget it consumes; set your own cap below the model's context wall.
10. If you care about Codex/Copilot routes, repeat steps 5-9 on those runners; if `before_prompt_build` does not fire there, decide whether to restrict the product to embedded/CLI or add runner detection (log `ctx.trigger`/runner identity — UNPROVEN exposure).

Exit decision: if A-D pass, the blocker is disproven and the injection approach is production-viable; E sets your operating cap.

### 6.4 The trap
**Not the slot — the coexistence and churn.** Most likely failures with the chosen way, in order:
1. **A co-tenant plugin at higher priority returns a `systemPrompt`** — because `firstDefined` wins, your lessons keep arriving (context still concatenates) but any `systemPrompt`-based framing you add silently disappears, and if *you* return a `systemPrompt` you silently erase another plugin's. Mitigation: only ever return `prependContext`/`appendContext` from a third-party plugin; never `systemPrompt`.
2. **Budget creep.** Concatenated contexts from all plugins grow; compaction/summarization may elide or compress your block, and unlike Mem0's externally-stored memory, your lessons live *in* the context window and share its fate. Mitigation: your own `recallMaxChars`-style cap (section 6.3, criterion E) and dedupe.
3. **API drift.** High-churn 2026.9.x releases prove SDK helpers move even between minors. Sticking to raw `api.on("before_prompt_build", ...)` registration minimizes exposure, but the `OpenClawPluginApi` surface remains experimental — budget section 5.4 maintenance.
4. **Trust gating.** If you assumed `openKeyedStore` and your plugin isn't registry-trusted, writes fail closed; ship the filesystem fallback from day one.
5. **Codex hook coverage.** Embedded/CLI/Copilot are documented for `before_prompt_build`; Codex dispatch is not verified. If your users run Codex routes, the spike (step 10) determines whether you need a Codex-specific path or accept the gap.
6. **Ordering semantics surprise.** Lower-priority plugins render after higher-priority ones; your lessons could end up far down a long prompt. Set an explicit `priority` and document it.

The one thing that does **not** trap you: a host patch. There is none in this path.

---

## 7. What could not be established

1. **Exact host release tag of the inspected source.** Repo HEAD is `8c56f72...` (2026-09-21 tree state); the appcast/`package.json` version mapping would pin it — probably post-`2026.9.5`. All path/function claims hold at that commit; version numbers on the docs pages come from their release-note mirror markers.
2. **Codex harness dispatch of `before_prompt_build`.** Docs say the catalog is "not a promise that every runtime emits every hook" and point to `codex-harness-runtime#hook-boundaries` (not read here). Embedded and CLI are confirmed; Copilot documented; Codex UNPROVEN.
3. **Any hard downstream truncation of `prependContext`/`appendContext`.** No cap in the merge/build path at `8c56f72`; whether a later LLM-boundary or adapter silently truncates appended context is UNPROVEN (the spike's criterion E settles it operationally).
4. **Exact gating of `registerMemoryPromptSupplement`/`Preparation` output.** Rendering happens in `src/agents/system-prompt.ts`'s memory section, gated by `includeMemorySection`/`isMinimal`; whether supplements render when the user has **no** memory capability installed is UNPROVEN without running it. Promising enough to warrant a parallel one-day spike.
5. **Precise count of plugin-breaking changes per release** across the full last-N-release window — 2026.9.3's three `**Breaking**` SDK items were read verbatim; 2026.9.4/.5 were counted by "plugin" mention frequency (~170 / ~355), not exhaustively classified.
6. **Who performs plugin updates by default in a managed deployment.** Docs describe hybrid hot-reload plus `openclaw plugins update <id>`; the registry refuses incompatible installs but does not auto-rewrite plugin code. Whether installations auto-update plugins absent operator action is UNPROVEN.
7. **Skill-borne hook execution semantics** (`hooks/openclaw/` packs shipped inside skills like `pskoett/self-improving-agent`): whether such hooks run only while the skill is session-attached was not traced in source.
8. **User complaint volume/severity for each community plugin** beyond what READMEs/listings/advertised pitfalls state — no issue-tracker mining was done; treat the "complaints" column as anecdotal.

---

### Sources cited

- OpenClaw repo, main @ `8c56f7239e98dbee1369e036d6b594fd560b9d9d` (2026-09-21): `src/plugins/hooks.ts`, `src/plugins/host-hook-state.ts`, `src/plugins/plugin-api.types.ts`, `src/plugins/memory-state.ts`, `src/plugins/registry-registrars-memory.ts`, `src/plugins/config-activation-shared.ts`, `src/plugins/loader-module-runtime.ts`, `src/plugins/loader-runtime-core.ts`, `src/plugins/loader-records.ts`, `src/plugins/discovery.ts`, `src/plugins/install-shared.ts`, `src/plugins/clawhub.ts`, `src/plugins/registry-runtime.ts`, `src/plugins/api-facades.ts`, `src/plugins/version.ts`, `src/plugins/compat/deprecation-marking.ts`, `src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts`, `src/agents/embedded-agent-runner/run/attempt-prompt-build.ts`, `src/agents/cli-runner/prompt-context.ts`, `src/agents/system-prompt.ts`, `src/context-engine/delegate.ts`, `src/plugins/plugin-invocation-scope.ts`, `src/skills/loading/plugin-skills.ts`, `src/plugins/plugin-root-contributions.ts`, `src/plugins/effective-plugin-ids.ts`, `docs/plugins/hooks/prompt-and-session.md`, `docs/plugins/hooks/reference.md`, `docs/plugins/manifest.md`, `docs/tools/plugin`, `docs/plugins/memory-lancedb`, `docs/plugins/architecture`, `docs/plugins/architecture-internals/context-engines.md`, `docs/concepts/agent-workspace`, `docs/tools/skills.md`, `CHANGELOG/2026.9.3.md`, `CHANGELOG/2026.9.4.md`, `CHANGELOG/2026.9.5.md`, `CHANGELOG/2026.3.7.md`.
- Live docs: `docs.openclaw.ai` (pages above; release mirrors e.g. `2026.9.5`).
- Community: CortexReach/memory-lancedb-pro (v1.1.0-beta.11, cloned & read); mem0.ai blog "Mem0 memory for OpenClaw"; ClawHub listings; pskoett/self-improving-agent (GitHub + ClawHub `@pskoett/self-improving-agent`).
