# Pre-Registration Freeze Manifest (`docs/proof/FREEZE.md`)

This manifest locks all pre-registered protocol documents, evaluation scripts, grading rubrics, and experimental scenario/assignment manifests **before trial #1** of any measured run (`R1`, `R2`, `R3`, `R4`, `R5`) under `docs/proof/PROTOCOL.md` §0 and §12.

---

## 1. Pinned Repository & Runtime Environment

| Item | Value |
|---|---|
| Repository | `Bergschloss/Refine-Cycle-for-OpenClaw` (`main`) |
| Pre-freeze `HEAD` commit (`PROTOCOL.md` added) | `3178ab3bb474a632be734604943ee8520ec8c4b9` |
| Plugin code commit (`src/` & `dist/` last modified) | `5f5dd44a50cb3361fd1bf6cf3e19ca1988e0670d` |
| Host runtime | `OpenClaw 2026.9.6 (eb377ac)` |
| Agent model route (locked across all runs) | `openai/gpt-6-luna` (`GPT-6 Luna`) |
| Fixed system prompt SHA-256 | `6349ff543247ce2ca84ed03d6ace828d75e303e1aeaf98dccad6f78826f84975` |
| Fixed workspace `AGENTS.md` SHA-256 | `07dff714f81e14bba2f391a1961a350b56b2e2891130c98a08ba84590cd4f7f6` |
| Fixed prompt scaffold SHA-256 (`{{task_text}}`) | `6c98a4081878bf6ea3144a16b7d99a65b7bb10b05affa02d9dd366a6bfdedfb9` |
| Blind LLM grader families (Amendment A1, §5) | Family 1: Anthropic Claude (`claude-*`) · Family 2: Google Gemini (`gemini-*`) · Family 3: Open-weight (`qwen-*` / `llama-*`) |
| Freeze timestamp (UTC) | `2026-09-29T22:20:00Z` |

---

## 2. Frozen Artifacts & SHA-256 Digests (LF-normalized bytes)

Every file below is stored with LF (`\n`) line endings. Before starting `R1`, `R2`, `R3`, `R4`, or `R5`, the self-driving runner (`~/proof/runner.sh`) and `analysis_decider.py` verify that every file is present on `main` under `docs/proof/` and that its SHA-256 matches the table below.

| Artifact Path (`docs/proof/...`) | SHA-256 Digest | Size (bytes) | Role |
|---|---|---:|---|
| `docs/proof/PROTOCOL.md` | `0e69fe099dde3b362324fcfcc2abaa6f98c85369aa55b67d85ef0b0ff04a11db` | `81532` | Pre-registered experimental protocol (§0–§13, Appendices A–D) |
| `docs/proof/RAW-FORMAT.md` | `26080e2e8ef914d2c315a52241ed64eb20ac72f9f2530e017bc015665d71ed33` | `11127` | Raw JSONL format 1 specification |
| `docs/proof/analysis_decider.py` | `18690d2411467712937bbdc9d67db9bbeaad758cd4e015dd7551d8ebab1e1a2c` | `38215` | Locked stdlib-only statistical analysis & 5-branch verdict decider (§7, Appendix D) |
| `docs/proof/grader-rubric.md` | `5e9565c7c11bc4f0d294dffe27dcd13cb1052275de78dc8c49ce4f625688d0fd` | `11680` | Verbatim §5 rubric, §5.1 blind judge prompt, packet & answer schemas (Appendix C) |
| `docs/proof/make_packets.py` | `42ae8ee542ca71d1b2b843d4cf42340c49c1578a55154360e8848ab4b81e3a6e` | `20865` | Blind packet builder & redaction validator (§5) |
| `docs/proof/scenarios-manifest-20260929.json` | `2d8354b30cf6c0b997649493ff10d113072b563266bdaf496c1c3f5c9e3660a0` | `44417` | Frozen R2 scenario manifest: 20 primary (10 fixable, 5 not-fixable, 5 noise) + 4 reserve (§4, Appendix B) |
| `docs/proof/r3-assignment-manifest.json` | `179323b5bc53e32ebd0b2a6ca4a7b986135ffa47c69deecb460716ebe74db269` | `176130` | Frozen R3 paired within-item assignment manifest: 120 primary crossed items (360 runs) + 24 reserve items (§6) |

---

## 3. Machine-Readable Digest Map (`freeze_digests`)

```json
{
  "docs/proof/PROTOCOL.md": "0e69fe099dde3b362324fcfcc2abaa6f98c85369aa55b67d85ef0b0ff04a11db",
  "docs/proof/RAW-FORMAT.md": "26080e2e8ef914d2c315a52241ed64eb20ac72f9f2530e017bc015665d71ed33",
  "docs/proof/analysis_decider.py": "18690d2411467712937bbdc9d67db9bbeaad758cd4e015dd7551d8ebab1e1a2c",
  "docs/proof/grader-rubric.md": "5e9565c7c11bc4f0d294dffe27dcd13cb1052275de78dc8c49ce4f625688d0fd",
  "docs/proof/make_packets.py": "42ae8ee542ca71d1b2b843d4cf42340c49c1578a55154360e8848ab4b81e3a6e",
  "docs/proof/scenarios-manifest-20260929.json": "2d8354b30cf6c0b997649493ff10d113072b563266bdaf496c1c3f5c9e3660a0",
  "docs/proof/r3-assignment-manifest.json": "179323b5bc53e32ebd0b2a6ca4a7b986135ffa47c69deecb460716ebe74db269"
}
```

---

## 4. How to Recompute Each Hash

### POSIX / Linux (`sha256sum`)

```bash
sha256sum \
  docs/proof/PROTOCOL.md \
  docs/proof/RAW-FORMAT.md \
  docs/proof/analysis_decider.py \
  docs/proof/grader-rubric.md \
  docs/proof/make_packets.py \
  docs/proof/scenarios-manifest-20260929.json \
  docs/proof/r3-assignment-manifest.json
```

### Cross-Platform Python 3 (immune to `core.autocrlf` checkout settings)

```bash
python3 -c '
import hashlib, pathlib
for name in [
    "PROTOCOL.md",
    "RAW-FORMAT.md",
    "analysis_decider.py",
    "grader-rubric.md",
    "make_packets.py",
    "scenarios-manifest-20260929.json",
    "r3-assignment-manifest.json",
]:
    p = pathlib.Path("docs/proof") / name
    b = p.read_bytes().replace(b"\r\n", b"\n")
    print(f"{hashlib.sha256(b).hexdigest()}  docs/proof/{name}")
'
```
