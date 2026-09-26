# AGENTS.md — Refine Cycle for OpenClaw

Repo-scoped rules. General operating standards live in the user's global agent rules;
this file covers only what is specific to this project. Design and host contract:
[docs/DESIGN.md](docs/DESIGN.md).

---

## What this is

An **OpenClaw plugin** that stops an agent repeating the same tool mistake. After each turn it
reads the agent's history from OpenClaw's SQLite, fingerprints failed tool calls, refuses what
cannot be a lesson without a model call, asks the agent's own model for one short lesson, and
journals it into the plugin's own store. Before each prompt it prepends the agent's active
lessons in a short, marked block.

The mental model that matters: **this code writes into the agent's future prompts.** A bad
lesson is not a bug that throws; it is a silent behaviour change in every later turn. That is
why the invariants below are not negotiable and why "it didn't crash" is never evidence.

The idea and its measurement come from the Hermes plugin (`G:/Kiro/Refine-Cycle`,
`Bergschloss/Refine-Cycle-for-Hermes-Agent`). Consult it for intent and for what it cost to
learn; do not port its host workarounds (installer, host patches, self-update, desktop half).
OpenClaw needs none of them.

---

## Invariants — never weaken these

1. **Never edit a file the user owns.** No writes to `AGENTS.md`, `SOUL.md`, `TOOLS.md`, skills,
   memory or OpenClaw config. Lessons live only in the plugin's data directory.
2. **The host's SQLite is opened read-only.** Always. Tests build throwaway SQLite files.
3. **A withdrawn lesson never comes back.** Disable and delete keep a tombstone; learning,
   recovery and the deferred sweep all check for it.
4. **Journal before change.** Intent, then the change, then the mark. A record a crash cut
   short must be finished or abandoned by `recover()`, never stop the plugin.
5. **The model budget stands:** at most one call per session and `maxModelCallsPerDay`
   (3) a day, reserved under the lock *before* the call.
6. **The gateway thread never waits.** Every lock taken from a hook or a chat command uses a
   0 ms timeout; only the CLI may wait. Background work starts outside the host's async work
   scope (`runOutsideHostWorkScope`).
7. **Fail open.** A broken store or hook leaves the agent's turn exactly as if the plugin were
   not installed, and the log says why.
8. **No content filter on lessons** (owner decision, carried over from the Hermes plugin).
   Refusals are structural only: markup that could close the block, a lesson that does not
   name the failing tool, an unobserved fingerprint, a restatement.
9. **No runtime dependencies.** Node standard library only; TypeScript and `@types/node` are
   dev dependencies.

---

## Layout

| Path | Owns |
|---|---|
| `src/plugin.ts` | the only file that knows OpenClaw: hooks, the queue, `/refine`, `openclaw refine-cycle` |
| `src/pipeline.ts` | the learning loop for one ended turn, the budget, deferred lessons, the report |
| `src/core/` | pure functions: fingerprint (port of the Hermes `patterns.py`), failure extraction, refusal shapes, already-covered check, the injected block, proposal and validation |
| `src/store.ts`, `src/lessons.ts` | atomic JSON files, the cross-process lock, the journal |
| `src/host/` | reading the agent's SQLite history and its instruction and skill files |
| `src/replay.ts` | the measurement harness |
| `dist/` | the compiled plugin OpenClaw loads; generated, never edited by hand |

Anything provable without OpenClaw belongs in `src/core/`, where it is tested directly.

---

## Build and verification

Running a command is not evidence. **Reading its output is evidence.**

```bash
npm install
npm test
npm run typecheck
npm run build
```

- OpenClaw installs only compiled JavaScript, so **`dist/` is committed and must equal a fresh
  build of `src/`.** Run `npm run build` after every change to `src/`; `test/dist.test.ts` fails
  otherwise.
- For a new test, break the code it guards and watch it fail before trusting it.
- Green tests are a secondary signal. Anything touching extraction, thresholds or heuristics is
  measured against real history (the replay) before it is called working. Every serious defect
  so far was invisible on synthetic input: event rows compressed in a new host version, tool
  results in a shape the fixtures lacked, a host work scope that closed under the model call.
- Host behaviour is proven on a real OpenClaw install, not assumed from types. When a claim in
  `docs/DESIGN.md` "Host contract" changes, record how and on which version it was checked.
  `scripts/drift-check.ts` compares the test fixtures with a live install.
- State plainly what was verified and what was not.

---

## Platform

Developed on Windows, run on Linux servers and desktops.

- Resolve host paths from OpenClaw's state directory and the hook context, never from
  `os.homedir()` guesses.
- Cross-process safety through the store's lock, not `flock` or other POSIX-only calls.
- Working copies may carry CRLF; anything that edits files by exact match normalizes line
  endings first.

---

## Privacy

The history is the user's private conversations.

- Never commit real session content, replay corpora, stores or reports built from them. Test
  fixtures are synthetic.
- Real sessions go only to the model the user's agent already uses, the way the agent would
  send them.
- Reports about real data carry numbers and lesson texts, not conversation content.
- The repository is public: no hostnames, IP addresses, key paths, tokens or account details.

---

## Git

- **Work directly on `main`.** No feature branches, no pull requests.
- **Push after every commit, without being asked:**

  ```
  git -C G:/Kiro/Refine-Cycle-OpenClaw push origin main
  ```

  A commit that is not pushed is not done.
- **Commit author must be `263254659+Bergschloss@users.noreply.github.com`**; the remote rejects
  a private email (`GH007`).
- One commit per logical item; the message names the item and says *why*.
- Rebuild `dist/` in the same commit as the `src/` change it comes from.

---

## Known-fragile areas

- **Host contract drift.** Each OpenClaw release has moved something: `event_zstd` rows in
  2026.9.6, the `cli-metadata` registration pass, `allowConversationAccess` for non-bundled
  plugins, `agentId` absent from command contexts without a session. Check a new host version
  before claiming support.
- **The host work scope.** `agent_end` runs in a scope the host closes when the hook returns.
  Anything awaited later (the model call) must start outside it, or it fails with "Async work
  scope is closed".
- **"The same command".** Deciding whether a later success corrected a failure is a heuristic
  that must lean to "not the same": a false match refuses a real repeated failure as
  self-corrected and the lesson is lost. Every change needs pairs for both directions in
  `test/failures.test.ts`.
- **Fingerprint parity.** `src/core/fingerprint.ts` must give the same identity as the Hermes
  original; the golden corpus in `test/golden/` pins it. Do not "improve" normalization here
  alone.
- **Locks.** Stale-lock takeover goes through the `.takeover` guard; a lock that cannot be
  removed means "busy", never a spin.
- **Silent no-op.** A model error, an invalid reply, a busy store and "nothing to learn" must
  stay distinguishable in `candidates/`. If two failures look alike afterwards, one is invisible.

---

## Scope discipline

- No abstractions, folders or helpers that do not remove existing complexity.
- No CI, release automation or publishing without the owner asking.
- Do not reformat code the task does not name.
- When OpenClaw does not expose a capability, **say so and stop.** A fake implementation that
  looks right makes the README lie.
