#!/usr/bin/env python3
"""Pre-registered analysis & verdict decider for Refine Cycle for OpenClaw (PROTOCOL.md §7).

Standard library only. Implements:
  1. SHA-256 verification of all frozen artifacts before reading trial data.
  2. Raw JSONL recomputation (docs/proof/RAW-FORMAT.md format 1: last `session` line per
     `(agentId, sessionId)` wins), including independent H5 `/refine audit` verdict
     recomputation and S4 deterministic lesson length verification (`<= 200` chars).
  3. Three-LLM blind grader adjudication (2-of-3 majority with conservative tie-break
     `harmful > wrong > restates > useful`) and Fleiss' kappa.
  4. Paired within-item R3 analysis across the three arms (`lesson`, `nothing`, `placebo`):
     Wilson 95% CIs, Clopper-Pearson exact one-sided 95% bounds, exact two-sided McNemar test,
     Agresti-Wald paired risk-difference 95% CIs (both pre-registered formula and post-verdict
     sign-corrected sensitivity block per PROTOCOL.md §7), and Holm step-down adjustment across
     the two planned contrasts (`C1_primary`: lesson vs nothing; `C2_mechanism`: lesson vs placebo).
  5. Strict 5-verdict decision order (PROTOCOL.md §2.1 & §7):
     `UNDERPOWERED` -> `FALSIFIED` -> `NOT SUPPORTED` -> `PARTIAL` -> `SUPPORTED`.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import hashlib
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

ARMS = ("lesson", "nothing", "placebo")
PLANNED_CONTRASTS = ("C1_primary", "C2_mechanism")
GRADER_CATEGORIES = ("useful", "restates", "wrong", "harmful")
SEVERITY_ORDER = {"harmful": 4, "wrong": 3, "restates": 2, "useful": 1}

GATE0_MIN_TRIALS_PER_ARM = 80
GATE0_MIN_CROSSED_ITEMS = 100
GATE0_MAX_MISFIRE_RATE = 0.10
GATE0_MAX_PROVIDER_FAILURE_RATE = 0.05

ALPHA_FAMILY = 0.05
PRIMARY_RD_FLOOR = 0.05
RECALL_BAR = 0.80
USEFUL_BAR = 0.80
MAX_LESSON_CHARS = 200


# -- Statistical functions --------------------------------------------------------


def wilson_ci(k: int, n: int, z: float = 1.959963984540054) -> Tuple[float, float]:
    """Two-sided 95% Wilson score interval for a binomial proportion."""
    if n <= 0:
        return (0.0, 1.0)
    p = k / n
    denom = 1.0 + (z * z) / n
    center = (p + (z * z) / (2.0 * n)) / denom
    half = (z * math.sqrt((p * (1.0 - p) + (z * z) / (4.0 * n)) / n)) / denom
    return (max(0.0, center - half), min(1.0, center + half))


def _binom_cdf(k: int, n: int, p: float) -> float:
    if p <= 0.0:
        return 1.0 if k >= 0 else 0.0
    if p >= 1.0:
        return 1.0 if k >= n else 0.0
    total = 0.0
    for i in range(0, k + 1):
        total += math.comb(n, i) * (p ** i) * ((1.0 - p) ** (n - i))
    return min(1.0, max(0.0, total))


def clopper_pearson_one_sided_95_upper(k: int, n: int) -> float:
    """Exact one-sided 95% upper Clopper-Pearson bound (and rule-of-three 3/n report)."""
    if n <= 0:
        return 1.0
    if k >= n:
        return 1.0
    if k == 0:
        return 1.0 - (0.05 ** (1.0 / n))
    lo, hi = 0.0, 1.0
    for _ in range(64):
        mid = 0.5 * (lo + hi)
        if _binom_cdf(k, n, mid) > 0.05:
            lo = mid
        else:
            hi = mid
    return hi


def clopper_pearson_one_sided_95_lower(k: int, n: int) -> float:
    """Exact one-sided 95% lower Clopper-Pearson bound."""
    if n <= 0 or k <= 0:
        return 0.0
    if k >= n:
        return 0.05 ** (1.0 / n)
    lo, hi = 0.0, 1.0
    for _ in range(64):
        mid = 0.5 * (lo + hi)
        tail = 1.0 - _binom_cdf(k - 1, n, mid)
        if tail < 0.05:
            lo = mid
        else:
            hi = mid
    return lo


def rule_of_three_upper(n: int) -> float:
    """Rule-of-three 95% upper bound 3/N when 0 events are observed."""
    return 1.0 if n <= 0 else min(1.0, 3.0 / n)


def mcnemar_exact(n01: int, n10: int) -> float:
    """Exact two-sided binomial McNemar p-value on discordant pairs."""
    b = n01 + n10
    if b == 0:
        return 1.0
    k = min(n01, n10)
    tail = sum(math.comb(b, i) for i in range(0, k + 1)) * (0.5 ** b)
    return min(1.0, 2.0 * tail)


def agresti_wald_paired_rd_ci(
    n11: int, n10: int, n01: int, n00: int, z: float = 1.959963984540054
) -> Dict[str, float]:
    """Paired risk difference (arm1 - arm2) and 95% CI (pre-registered + sign-corrected)."""
    n = n11 + n10 + n01 + n00
    if n == 0:
        return {
            "rd": 0.0,
            "ci95_low": -1.0,
            "ci95_high": 1.0,
            "sensitivity_sign_corrected_ci95_low": -1.0,
            "sensitivity_sign_corrected_ci95_high": 1.0,
        }
    rd = (n10 - n01) / n
    var_prereg = (
        (n11 + n10) * (n01 + n00)
        + (n11 + n01) * (n10 + n00)
        - 2.0 * (n01 * n10 - n11 * n00)
    ) / (n ** 3)
    se_prereg = math.sqrt(max(0.0, var_prereg))

    var_corr = (
        (n11 + n10) * (n01 + n00)
        + (n11 + n01) * (n10 + n00)
        + 2.0 * (n01 * n10 - n11 * n00)
    ) / (n ** 3)
    se_corr = math.sqrt(max(0.0, var_corr))

    return {
        "rd": rd,
        "ci95_low": rd - z * se_prereg,
        "ci95_high": rd + z * se_prereg,
        "sensitivity_sign_corrected_ci95_low": rd - z * se_corr,
        "sensitivity_sign_corrected_ci95_high": rd + z * se_corr,
    }


def holm_step_down(p_map: Dict[str, float]) -> Dict[str, float]:
    """Holm step-down adjusted p-values across the pre-registered planned contrast family."""
    ordered = sorted(p_map.items(), key=lambda kv: kv[1])
    m = len(ordered)
    adj: Dict[str, float] = {}
    running_max = 0.0
    for idx, (name, p_val) in enumerate(ordered):
        raw_adj = min(1.0, (m - idx) * p_val)
        running_max = max(running_max, raw_adj)
        adj[name] = running_max
    return adj


def fleiss_kappa(
    item_labels: List[List[str]], categories: Iterable[str] = GRADER_CATEGORIES
) -> float:
    """Fleiss' kappa across M raters for N items."""
    cats = list(categories)
    valid_items = [row for row in item_labels if len(row) >= 2 and all(c in cats for c in row)]
    if not valid_items:
        return 0.0
    n_items = len(valid_items)
    n_raters = len(valid_items[0])
    if n_raters <= 1:
        return 1.0

    cat_totals = {c: 0 for c in cats}
    p_i_sum = 0.0
    for row in valid_items:
        if len(row) != n_raters:
            raise ValueError("All items in Fleiss' kappa must have the same number of raters.")
        counts = {c: 0 for c in cats}
        for label in row:
            counts[label] += 1
            cat_totals[label] += 1
        num = sum(v * (v - 1) for v in counts.values())
        p_i_sum += num / (n_raters * (n_raters - 1))

    p_bar = p_i_sum / n_items
    total_ratings = float(n_items * n_raters)
    p_e = sum((cat_totals[c] / total_ratings) ** 2 for c in cats)
    if abs(1.0 - p_e) < 1e-12:
        return 1.0
    return (p_bar - p_e) / (1.0 - p_e)


def adjudicate_three_graders(labels: List[str]) -> str:
    """2-of-3 majority label; conservative tie-break harmful > wrong > restates > useful."""
    filtered = [lbl for lbl in labels if lbl != "skipped"]
    if not filtered:
        return "skipped"
    counts: Dict[str, int] = {}
    for lbl in filtered:
        counts[lbl] = counts.get(lbl, 0) + 1
    for lbl, cnt in counts.items():
        if cnt >= 2:
            return lbl
    return max(filtered, key=lambda lbl: SEVERITY_ORDER.get(lbl, 0))


# -- H5 Independent Audit Verdict Recomputation ----------------------------------


def recompute_audit_verdict(
    status: str,
    created_at_ms: int,
    now_ms: int,
    sessions_ended_since_learned: int,
    shown: int,
    unplaced: int,
    quiet: int,
    recurrence: int,
) -> str:
    """Exact decision order from PROTOCOL.md §7 & src/core/audit.ts."""
    age_days = max(0, (now_ms - created_at_ms) // 86_400_000)
    if status == "deleted":
        return "rolled back"
    if status == "disabled":
        return "disabled"
    if sessions_ended_since_learned <= 0:
        return "no recurrence window"
    if recurrence > 0:
        return "did not help"
    if unplaced > 0:
        return "unreliable"
    if shown <= 0:
        return "unused" if age_days >= 14 else "too early"
    if quiet < 3:
        return "too early"
    if quiet >= 3 and age_days >= 3:
        return "working"
    return "too early"


# -- Raw JSONL parsing & Digest check --------------------------------------------


def verify_freeze_digests(manifest: Dict[str, str], base_dir: Path) -> None:
    """Verify SHA-256 of every frozen artifact listed in manifest `{rel_path: sha256}`."""
    for rel_path, expected_hex in sorted(manifest.items()):
        p = (base_dir / rel_path) if not Path(rel_path).is_absolute() else Path(rel_path)
        if not p.exists():
            raise RuntimeError(f"Missing frozen file required by manifest: {p}")
        actual_hex = hashlib.sha256(p.read_bytes()).hexdigest().lower()
        if actual_hex != expected_hex.lower():
            raise RuntimeError(
                f"SHA-256 mismatch for {rel_path}: expected {expected_hex.lower()}, got {actual_hex}"
            )


def load_raw_sessions_deduped(raw_path: Path) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Return `(deduped_session_lines, non_session_lines)` per RAW-FORMAT.md format 1."""
    by_key: Dict[Tuple[str, str], Dict[str, Any]] = {}
    order: List[Tuple[str, str]] = []
    other_lines: List[Dict[str, Any]] = []
    with raw_path.open("r", encoding="utf-8") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if obj.get("kind") == "session":
                key = (str(obj.get("agentId") or "main"), str(obj.get("sessionId") or ""))
                if key not in by_key:
                    order.append(key)
                by_key[key] = obj
            else:
                other_lines.append(obj)
    return ([by_key[k] for k in order], other_lines)


def analyze_raw_replay(raw_path: Path, qualifying_fingerprints: Optional[List[str]] = None) -> Dict[str, Any]:
    """Compute H1 repeat recall and S4 lesson lengths from a raw replay JSONL file."""
    sessions, _ = load_raw_sessions_deduped(raw_path)
    learned_lessons: List[Dict[str, Any]] = []
    learned_fps: set[str] = set()
    discovered_qualifying: set[str] = set()

    for sess in sessions:
        outcome = sess.get("outcome")
        refusal = str(sess.get("refusal") or "")
        cand = sess.get("candidate")
        if isinstance(cand, dict):
            fp = str(cand.get("fingerprint") or "")
            cnt = int(cand.get("count") or 0)
            if fp and cnt >= 2:
                if refusal not in ("self_correcting", "already_covered") and not refusal.startswith(
                    "not_lesson_shaped:"
                ):
                    discovered_qualifying.add(fp)
        if outcome == "learned" and isinstance(sess.get("lesson"), dict):
            lesson = sess["lesson"]
            learned_lessons.append(lesson)
            fp = str(lesson.get("fingerprint") or "")
            if fp:
                learned_fps.add(fp)
                discovered_qualifying.add(fp)

    qual_set = set(qualifying_fingerprints) if qualifying_fingerprints is not None else discovered_qualifying
    hit_count = len(learned_fps & qual_set)
    qual_count = len(qual_set)
    recall = 1.0 if qual_count == 0 else (hit_count / qual_count)
    over_cap = sum(1 for l in learned_lessons if len(str(l.get("text") or "")) > MAX_LESSON_CHARS)

    return {
        "sessions_count": len(sessions),
        "qualifying_count": qual_count,
        "learned_qualifying_count": hit_count,
        "repeat_recall": recall,
        "repeat_recall_wilson_ci95": wilson_ci(hit_count, qual_count) if qual_count > 0 else (1.0, 1.0),
        "lessons_count": len(learned_lessons),
        "over_200_chars": over_cap,
        "lessons": learned_lessons,
    }


# -- Complete Evaluation Engine --------------------------------------------------


def evaluate_bundle(
    bundle: Dict[str, Any],
    base_dir: Optional[Path] = None,
    skip_digest_check: bool = False,
    min_trials_per_arm: int = GATE0_MIN_TRIALS_PER_ARM,
    min_crossed_items: int = GATE0_MIN_CROSSED_ITEMS,
) -> Dict[str, Any]:
    """Compute all pre-registered statistics, bar checks, and the final verdict."""
    if not skip_digest_check and bundle.get("freeze_digests"):
        verify_freeze_digests(bundle["freeze_digests"], base_dir or Path("."))

    # 1. R3 Paired Within-Item Analysis
    r3_rows: List[Dict[str, Any]] = bundle.get("r3_rows", [])
    total_r3_rows = len(r3_rows)
    misfire_rows = sum(1 for r in r3_rows if r.get("misfire") is True)
    provider_fail_rows = sum(1 for r in r3_rows if r.get("provider_failure") is True)
    misfire_rate = (misfire_rows / total_r3_rows) if total_r3_rows > 0 else 0.0
    provider_failure_rate = (provider_fail_rows / total_r3_rows) if total_r3_rows > 0 else 0.0

    by_arm_valid: Dict[str, List[Dict[str, Any]]] = {a: [] for a in ARMS}
    by_item: Dict[str, Dict[str, int]] = {}

    for r in r3_rows:
        if r.get("misfire") or r.get("provider_failure"):
            continue
        arm = str(r.get("arm") or "")
        if arm not in ARMS:
            continue
        item_id = str(r.get("item_id") or "")
        passed = 1 if int(r.get("first_call_pass", 0)) == 1 else 0
        by_arm_valid[arm].append(r)
        if item_id:
            by_item.setdefault(item_id, {})[arm] = passed

    crossed_ids = sorted(iid for iid, m in by_item.items() if all(a in m for a in ARMS))
    n_crossed = len(crossed_ids)
    min_arm_completed = min(len(by_arm_valid[a]) for a in ARMS)

    arm_summary: Dict[str, Any] = {}
    for a in ARMS:
        s = sum(by_item[iid][a] for iid in crossed_ids)
        lo, hi = wilson_ci(s, n_crossed)
        arm_summary[a] = {
            "completed_trials": len(by_arm_valid[a]),
            "crossed_n": n_crossed,
            "successes": s,
            "rate": (s / n_crossed) if n_crossed > 0 else 0.0,
            "wilson_ci95": [lo, hi],
        }

    def pair_counts(arm_x: str, arm_y: str) -> Tuple[int, int, int, int]:
        n11 = n10 = n01 = n00 = 0
        for iid in crossed_ids:
            vx = by_item[iid][arm_x]
            vy = by_item[iid][arm_y]
            if vx == 1 and vy == 1:
                n11 += 1
            elif vx == 1 and vy == 0:
                n10 += 1
            elif vx == 0 and vy == 1:
                n01 += 1
            else:
                n00 += 1
        return n11, n10, n01, n00

    contrasts_raw: Dict[str, Dict[str, Any]] = {}
    for cname, ax, ay in (
        ("C1_primary", "lesson", "nothing"),
        ("C2_mechanism", "lesson", "placebo"),
        ("C3_placebo_exploratory", "nothing", "placebo"),
    ):
        n11, n10, n01, n00 = pair_counts(ax, ay)
        p_raw = mcnemar_exact(n01, n10)
        ci_info = agresti_wald_paired_rd_ci(n11, n10, n01, n00)
        contrasts_raw[cname] = {
            "arm_x": ax,
            "arm_y": ay,
            "n": n_crossed,
            "n11": n11,
            "n10": n10,
            "n01": n01,
            "n00": n00,
            "rd": ci_info["rd"],
            "ci95": [ci_info["ci95_low"], ci_info["ci95_high"]],
            "sensitivity_sign_corrected_ci95": [
                ci_info["sensitivity_sign_corrected_ci95_low"],
                ci_info["sensitivity_sign_corrected_ci95_high"],
            ],
            "p_mcnemar_raw": p_raw,
        }

    holm_adj = holm_step_down({c: contrasts_raw[c]["p_mcnemar_raw"] for c in PLANNED_CONTRASTS})
    for c in PLANNED_CONTRASTS:
        contrasts_raw[c]["p_holm"] = holm_adj[c]
    contrasts_raw["C3_placebo_exploratory"]["p_holm"] = None

    # 2. Lesson Grading Panel (H3 / S3)
    grading_items: List[Dict[str, Any]] = bundle.get("grading_items", [])
    rater_triplets: List[List[str]] = []
    adjudicated_counts = {"useful": 0, "restates": 0, "wrong": 0, "harmful": 0, "skipped": 0}
    per_grader_counts = [
        {"useful": 0, "restates": 0, "wrong": 0, "harmful": 0, "skipped": 0} for _ in range(3)
    ]

    for item in grading_items:
        if item.get("arm", "lesson") != "lesson":
            continue
        labels = list(item.get("grader_labels") or [])
        for g_idx in range(min(3, len(labels))):
            lbl = labels[g_idx]
            if lbl in per_grader_counts[g_idx]:
                per_grader_counts[g_idx][lbl] += 1
        if len(labels) == 3 and all(l in GRADER_CATEGORIES for l in labels):
            rater_triplets.append(labels)
        maj = adjudicate_three_graders(labels)
        adjudicated_counts[maj] = adjudicated_counts.get(maj, 0) + 1

    graded_non_skipped = sum(adjudicated_counts[c] for c in GRADER_CATEGORIES)
    useful_rate = (
        (adjudicated_counts["useful"] / graded_non_skipped) if graded_non_skipped > 0 else 1.0
    )
    useful_ci95 = wilson_ci(adjudicated_counts["useful"], graded_non_skipped)
    wrong_or_harmful = adjudicated_counts["wrong"] + adjudicated_counts["harmful"]
    wrong_harmful_cp95_upper = clopper_pearson_one_sided_95_upper(wrong_or_harmful, graded_non_skipped)
    kappa = fleiss_kappa(rater_triplets) if rater_triplets else float(bundle.get("fleiss_kappa", 1.0))

    # 3. R1, R2, S4, R4, R5 metrics
    r1_info = bundle.get("r1", {})
    r1_with_args_available = bool(r1_info.get("with_args_available", True))
    r1_repeat_recall = float(r1_info.get("repeat_recall", 1.0))
    r1_qualifying = int(r1_info.get("qualifying_count", 1))
    r1_learned_qual = int(r1_info.get("learned_qualifying_count", r1_qualifying))

    r2_info = bundle.get("r2", {})
    r2_fixable_total = int(r2_info.get("fixable_total", 10))
    r2_fixable_learned = int(r2_info.get("fixable_learned_within_3", 10))
    r2_fixable_recall = (r2_fixable_learned / r2_fixable_total) if r2_fixable_total > 0 else 0.0
    r2_not_fixable_total = int(r2_info.get("not_fixable_total", 5))
    r2_not_fixable_false_lessons = int(r2_info.get("not_fixable_false_lessons", 0))
    r2_noise_total = int(r2_info.get("noise_total", 5))
    r2_noise_false_lessons = int(r2_info.get("noise_false_lessons", 0))

    s4_info = bundle.get("s4", {})
    total_lessons_checked = int(s4_info.get("total_lessons", graded_non_skipped))
    over_200_chars = int(s4_info.get("over_200_chars", 0))

    r4_info = bundle.get("r4", {})
    audit_disagreements = int(r4_info.get("audit_disagreements", 0))
    working_before_3d = int(r4_info.get("working_before_3d", 0))
    withdrawn_relearned = int(r4_info.get("withdrawn_relearned", 0))
    faulted_host_crash = int(r4_info.get("faulted_host_crash", 0))
    faulted_lessons_learned = int(r4_info.get("faulted_lessons_learned", 0))
    budget_cap_exceeded = int(r4_info.get("budget_cap_exceeded", 0))
    notice_mismatches = int(r4_info.get("notice_mismatches", 0))
    r4_all_passed = (
        audit_disagreements == 0
        and working_before_3d == 0
        and withdrawn_relearned == 0
        and faulted_host_crash == 0
        and faulted_lessons_learned == 0
        and budget_cap_exceeded == 0
        and bool(r4_info.get("disable_enable_delete_ok", True))
    )

    r5_info = bundle.get("r5", {})
    install_steps_total = int(r5_info.get("install_steps_total", 4))
    install_steps_passed = int(r5_info.get("install_steps_passed", 4))
    gateway_crashes = int(r5_info.get("gateway_crashes", 0))
    r5_all_passed = (install_steps_passed == install_steps_total) and (gateway_crashes == 0)

    # 4. Gate-0 Check
    single_route_ok = bool(bundle.get("single_route_ok", True))
    blinding_pass = bool(bundle.get("blinding_pass", True))
    gate0_reasons: List[str] = []
    if min_arm_completed < min_trials_per_arm:
        gate0_reasons.append(f"min_arm_completed={min_arm_completed} < {min_trials_per_arm}")
    if n_crossed < min_crossed_items:
        gate0_reasons.append(f"crossed_items={n_crossed} < {min_crossed_items}")
    if not single_route_ok:
        gate0_reasons.append("single_route_ok=False")
    if not blinding_pass:
        gate0_reasons.append("blinding_pass=False")
    if misfire_rate > GATE0_MAX_MISFIRE_RATE + 1e-12:
        gate0_reasons.append(f"misfire_rate={misfire_rate:.4f} > {GATE0_MAX_MISFIRE_RATE}")
    if provider_failure_rate > GATE0_MAX_PROVIDER_FAILURE_RATE + 1e-12:
        gate0_reasons.append(
            f"provider_failure_rate={provider_failure_rate:.4f} > {GATE0_MAX_PROVIDER_FAILURE_RATE}"
        )
    gate0_pass = len(gate0_reasons) == 0

    # 5. Falsification Check (harm checked first after Gate-0)
    c1 = contrasts_raw["C1_primary"]
    c2 = contrasts_raw["C2_mechanism"]
    falsified_reasons: List[str] = []
    if adjudicated_counts["harmful"] >= 1:
        falsified_reasons.append(f"harmful_lessons={adjudicated_counts['harmful']} >= 1")
    if (c1["p_holm"] < ALPHA_FAMILY and c1["rd"] < 0.0) or c1["ci95"][1] <= 0.0:
        falsified_reasons.append(
            f"R3 lesson worse than nothing (rd={c1['rd']:.4f}, ci95={c1['ci95']}, p_holm={c1['p_holm']:.4g})"
        )
    if withdrawn_relearned >= 1:
        falsified_reasons.append(f"withdrawn_relearned={withdrawn_relearned} >= 1")
    if audit_disagreements >= 1 or working_before_3d >= 1:
        falsified_reasons.append(
            f"audit mismatch (disagreements={audit_disagreements}, working_before_3d={working_before_3d})"
        )
    if faulted_host_crash >= 1 or faulted_lessons_learned >= 1:
        falsified_reasons.append(
            f"faulted pass violation (host_crash={faulted_host_crash}, lessons_learned={faulted_lessons_learned})"
        )
    if budget_cap_exceeded >= 1:
        falsified_reasons.append(f"budget_cap_exceeded={budget_cap_exceeded} >= 1")
    if gateway_crashes >= 1:
        falsified_reasons.append(f"gateway_crashes={gateway_crashes} >= 1")

    # 6. Bars S1-S9 evaluation
    bars = {
        "S1_r1_repeat_recall": (not r1_with_args_available) or (r1_repeat_recall + 1e-12 >= RECALL_BAR),
        "S2_noise_zero_false_lessons": (r2_noise_false_lessons == 0) and (r2_not_fixable_false_lessons == 0),
        "S3_lesson_quality": (useful_rate + 1e-12 >= USEFUL_BAR) and (wrong_or_harmful == 0),
        "S4_lesson_length_cap": over_200_chars == 0,
        "S5_r2_fixable_recall": r2_fixable_recall + 1e-12 >= RECALL_BAR,
        "S6_r3_lesson_vs_nothing": (c1["p_holm"] < ALPHA_FAMILY) and (c1["ci95"][0] + 1e-12 >= PRIMARY_RD_FLOOR),
        "S7_r3_lesson_vs_placebo": (c2["p_holm"] < ALPHA_FAMILY) and (c2["rd"] > 0.0),
        "S8_r4_control_and_robustness": r4_all_passed and (notice_mismatches == 0),
        "S9_r5_install_verification": r5_all_passed,
    }

    # 7. Strict 5-Branch Decision Order (PROTOCOL.md §2.1 & §7)
    if not gate0_pass:
        verdict = "UNDERPOWERED"
        verdict_reasons = gate0_reasons
    elif falsified_reasons:
        verdict = "FALSIFIED"
        verdict_reasons = falsified_reasons
    elif not (
        bars["S1_r1_repeat_recall"]
        and bars["S2_noise_zero_false_lessons"]
        and bars["S3_lesson_quality"]
        and bars["S4_lesson_length_cap"]
        and bars["S5_r2_fixable_recall"]
        and bars["S6_r3_lesson_vs_nothing"]
        and bars["S8_r4_control_and_robustness"]
        and bars["S9_r5_install_verification"]
    ):
        verdict = "NOT SUPPORTED"
        verdict_reasons = [k for k, v in bars.items() if k != "S7_r3_lesson_vs_placebo" and not v]
    elif not bars["S7_r3_lesson_vs_placebo"]:
        verdict = "PARTIAL"
        verdict_reasons = ["S7_r3_lesson_vs_placebo not met while S1-S6, S8, S9 met"]
    else:
        verdict = "SUPPORTED"
        verdict_reasons = ["All pre-registered bars S1-S9 and Gate-0 met"]

    return {
        "verdict": verdict,
        "verdict_reasons": verdict_reasons,
        "gate0": {
            "pass": gate0_pass,
            "reasons": gate0_reasons,
            "min_arm_completed": min_arm_completed,
            "crossed_items": n_crossed,
            "misfire_rate": misfire_rate,
            "provider_failure_rate": provider_failure_rate,
            "single_route_ok": single_route_ok,
            "blinding_pass": blinding_pass,
        },
        "bars": bars,
        "r1": {
            "with_args_available": r1_with_args_available,
            "qualifying_count": r1_qualifying,
            "learned_qualifying_count": r1_learned_qual,
            "repeat_recall": r1_repeat_recall,
            "wilson_ci95": list(wilson_ci(r1_learned_qual, r1_qualifying)),
        },
        "r2": {
            "fixable_total": r2_fixable_total,
            "fixable_learned_within_3": r2_fixable_learned,
            "fixable_recall": r2_fixable_recall,
            "fixable_wilson_ci95": list(wilson_ci(r2_fixable_learned, r2_fixable_total)),
            "not_fixable_total": r2_not_fixable_total,
            "not_fixable_false_lessons": r2_not_fixable_false_lessons,
            "noise_total": r2_noise_total,
            "noise_false_lessons": r2_noise_false_lessons,
            "noise_cp95_upper": clopper_pearson_one_sided_95_upper(r2_noise_false_lessons, r2_noise_total),
            "noise_rule_of_three_upper": rule_of_three_upper(r2_noise_total),
        },
        "s3_grading": {
            "adjudicated_counts": adjudicated_counts,
            "per_grader_counts": per_grader_counts,
            "graded_non_skipped": graded_non_skipped,
            "useful_rate": useful_rate,
            "useful_wilson_ci95": list(useful_ci95),
            "wrong_or_harmful": wrong_or_harmful,
            "wrong_or_harmful_cp95_upper": wrong_harmful_cp95_upper,
            "fleiss_kappa": kappa,
        },
        "s4_length": {
            "total_lessons": total_lessons_checked,
            "over_200_chars": over_200_chars,
        },
        "r3_arms": arm_summary,
        "r3_contrasts": contrasts_raw,
        "r4": {
            "all_passed": r4_all_passed,
            "audit_disagreements": audit_disagreements,
            "working_before_3d": working_before_3d,
            "withdrawn_relearned": withdrawn_relearned,
            "faulted_host_crash": faulted_host_crash,
            "faulted_lessons_learned": faulted_lessons_learned,
            "budget_cap_exceeded": budget_cap_exceeded,
            "notice_mismatches": notice_mismatches,
        },
        "r5": {
            "all_passed": r5_all_passed,
            "install_steps_total": install_steps_total,
            "install_steps_passed": install_steps_passed,
            "gateway_crashes": gateway_crashes,
        },
    }


# -- Unit Test Suite -------------------------------------------------------------


def _make_base_passing_bundle(n_items: int = 100) -> Dict[str, Any]:
    r3_rows: List[Dict[str, Any]] = []
    for i in range(n_items):
        iid = f"item_{i:03d}"
        lesson_pass = 1 if i < int(0.85 * n_items) else 0
        nothing_pass = 1 if i < int(0.25 * n_items) else 0
        placebo_pass = 1 if i < int(0.25 * n_items) else 0
        r3_rows.append({"item_id": iid, "arm": "lesson", "first_call_pass": lesson_pass})
        r3_rows.append({"item_id": iid, "arm": "nothing", "first_call_pass": nothing_pass})
        r3_rows.append({"item_id": iid, "arm": "placebo", "first_call_pass": placebo_pass})

    grading_items = [
        {"item_id": f"pkt_{i:02d}", "arm": "lesson", "grader_labels": ["useful", "useful", "useful"]}
        for i in range(9)
    ] + [{"item_id": "pkt_09", "arm": "lesson", "grader_labels": ["restates", "restates", "useful"]}]

    return {
        "single_route_ok": True,
        "blinding_pass": True,
        "r3_rows": r3_rows,
        "grading_items": grading_items,
        "r1": {
            "with_args_available": True,
            "qualifying_count": 5,
            "learned_qualifying_count": 5,
            "repeat_recall": 1.0,
        },
        "r2": {
            "fixable_total": 10,
            "fixable_learned_within_3": 9,
            "not_fixable_total": 5,
            "not_fixable_false_lessons": 0,
            "noise_total": 5,
            "noise_false_lessons": 0,
        },
        "s4": {"total_lessons": 10, "over_200_chars": 0},
        "r4": {
            "audit_disagreements": 0,
            "working_before_3d": 0,
            "withdrawn_relearned": 0,
            "faulted_host_crash": 0,
            "faulted_lessons_learned": 0,
            "budget_cap_exceeded": 0,
            "notice_mismatches": 0,
            "disable_enable_delete_ok": True,
        },
        "r5": {
            "install_steps_total": 4,
            "install_steps_passed": 4,
            "gateway_crashes": 0,
        },
    }


class AnalysisDeciderSelfTest(unittest.TestCase):
    def test_verdict_supported(self) -> None:
        bundle = _make_base_passing_bundle(100)
        res = evaluate_bundle(bundle)
        self.assertEqual(res["verdict"], "SUPPORTED")
        self.assertTrue(all(res["bars"].values()))

    def test_verdict_underpowered(self) -> None:
        bundle = _make_base_passing_bundle(79)
        res = evaluate_bundle(bundle)
        self.assertEqual(res["verdict"], "UNDERPOWERED")

        bundle_misfire = _make_base_passing_bundle(100)
        for i in range(40):
            bundle_misfire["r3_rows"].append({"item_id": f"m_{i}", "arm": "lesson", "misfire": True})
        self.assertEqual(evaluate_bundle(bundle_misfire)["verdict"], "UNDERPOWERED")

    def test_verdict_falsified_all_triggers(self) -> None:
        # 1. Harmful lesson
        b1 = _make_base_passing_bundle(100)
        b1["grading_items"][0]["grader_labels"] = ["harmful", "harmful", "wrong"]
        self.assertEqual(evaluate_bundle(b1)["verdict"], "FALSIFIED")

        # 2. Lesson worse than nothing
        b2 = _make_base_passing_bundle(100)
        for r in b2["r3_rows"]:
            if r["arm"] == "lesson":
                r["first_call_pass"] = 0
            elif r["arm"] == "nothing":
                r["first_call_pass"] = 1
        self.assertEqual(evaluate_bundle(b2)["verdict"], "FALSIFIED")

        # 3. Withdrawn lesson relearned
        b3 = _make_base_passing_bundle(100)
        b3["r4"]["withdrawn_relearned"] = 1
        self.assertEqual(evaluate_bundle(b3)["verdict"], "FALSIFIED")

        # 4. Audit disagreement
        b4 = _make_base_passing_bundle(100)
        b4["r4"]["audit_disagreements"] = 1
        self.assertEqual(evaluate_bundle(b4)["verdict"], "FALSIFIED")

        # 5. Faulted pass crash / lesson
        b5 = _make_base_passing_bundle(100)
        b5["r4"]["faulted_lessons_learned"] = 1
        self.assertEqual(evaluate_bundle(b5)["verdict"], "FALSIFIED")

        # 6. Budget cap exceeded
        b6 = _make_base_passing_bundle(100)
        b6["r4"]["budget_cap_exceeded"] = 1
        self.assertEqual(evaluate_bundle(b6)["verdict"], "FALSIFIED")

        # 7. Gateway crash during install
        b7 = _make_base_passing_bundle(100)
        b7["r5"]["gateway_crashes"] = 1
        self.assertEqual(evaluate_bundle(b7)["verdict"], "FALSIFIED")

    def test_verdict_partial(self) -> None:
        bundle = _make_base_passing_bundle(100)
        # Make placebo perform identically to lesson so C1 passes and C2 fails
        for r in bundle["r3_rows"]:
            if r["arm"] == "placebo":
                idx = int(r["item_id"].split("_")[1])
                r["first_call_pass"] = 1 if idx < 85 else 0
        res = evaluate_bundle(bundle)
        self.assertEqual(res["verdict"], "PARTIAL")
        self.assertTrue(res["bars"]["S6_r3_lesson_vs_nothing"])
        self.assertFalse(res["bars"]["S7_r3_lesson_vs_placebo"])

    def test_verdict_not_supported_and_boundary_bars(self) -> None:
        # S1 boundary: 0.80 passes, 0.79 fails
        b = _make_base_passing_bundle(100)
        b["r1"]["repeat_recall"] = 0.80
        self.assertEqual(evaluate_bundle(b)["verdict"], "SUPPORTED")
        b["r1"]["repeat_recall"] = 0.79
        self.assertEqual(evaluate_bundle(b)["verdict"], "NOT SUPPORTED")

        # S2 boundary: 0 noise passes, 1 noise fails
        b = _make_base_passing_bundle(100)
        b["r2"]["noise_false_lessons"] = 1
        self.assertEqual(evaluate_bundle(b)["verdict"], "NOT SUPPORTED")

        # S3 boundary: 8/10 useful (80%) passes, 7/10 useful (70%) fails, 1 wrong fails
        b = _make_base_passing_bundle(100)
        b["grading_items"][8]["grader_labels"] = ["restates", "restates", "restates"]
        self.assertEqual(evaluate_bundle(b)["verdict"], "SUPPORTED")
        b["grading_items"][7]["grader_labels"] = ["restates", "restates", "restates"]
        self.assertEqual(evaluate_bundle(b)["verdict"], "NOT SUPPORTED")

        b_wrong = _make_base_passing_bundle(100)
        b_wrong["grading_items"][9]["grader_labels"] = ["wrong", "wrong", "useful"]
        self.assertEqual(evaluate_bundle(b_wrong)["verdict"], "NOT SUPPORTED")

        # S4 boundary: 0 over_200 passes, 1 over_200 fails
        b = _make_base_passing_bundle(100)
        b["s4"]["over_200_chars"] = 1
        self.assertEqual(evaluate_bundle(b)["verdict"], "NOT SUPPORTED")

        # S5 boundary: 8/10 (0.80) passes, 7/10 (0.70) fails
        b = _make_base_passing_bundle(100)
        b["r2"]["fixable_learned_within_3"] = 8
        self.assertEqual(evaluate_bundle(b)["verdict"], "SUPPORTED")
        b["r2"]["fixable_learned_within_3"] = 7
        self.assertEqual(evaluate_bundle(b)["verdict"], "NOT SUPPORTED")

        # S9 boundary: 4/4 passes, 3/4 fails
        b = _make_base_passing_bundle(100)
        b["r5"]["install_steps_passed"] = 3
        self.assertEqual(evaluate_bundle(b)["verdict"], "NOT SUPPORTED")

    def test_no_majority_tie_break_and_fleiss_kappa(self) -> None:
        self.assertEqual(adjudicate_three_graders(["useful", "restates", "wrong"]), "wrong")
        self.assertEqual(adjudicate_three_graders(["useful", "restates", "harmful"]), "harmful")
        self.assertEqual(adjudicate_three_graders(["useful", "useful", "wrong"]), "useful")
        k_perfect = fleiss_kappa([["useful", "useful", "useful"], ["wrong", "wrong", "wrong"]])
        self.assertAlmostEqual(k_perfect, 1.0, places=6)

    def test_digest_mismatch_halts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "artifact.txt"
            p.write_bytes(b"hello")
            bundle = _make_base_passing_bundle(100)
            bundle["freeze_digests"] = {"artifact.txt": "0" * 64}
            with self.assertRaises(RuntimeError):
                evaluate_bundle(bundle, base_dir=Path(tmp), skip_digest_check=False)

    def test_multiline_raw_dedup_and_audit_recomputation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw_p = Path(tmp) / "raw.jsonl"
            lines = [
                {
                    "kind": "session",
                    "agentId": "main",
                    "sessionId": "s1",
                    "outcome": "learned",
                    "lesson": {"id": "l1", "fingerprint": "fp1", "text": "x" * 205},
                },
                {
                    "kind": "session",
                    "agentId": "main",
                    "sessionId": "s1",
                    "outcome": "learned",
                    "lesson": {"id": "l1", "fingerprint": "fp1", "text": "short valid lesson"},
                },
            ]
            raw_p.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
            rep = analyze_raw_replay(raw_p, qualifying_fingerprints=["fp1"])
            self.assertEqual(rep["sessions_count"], 1)
            self.assertEqual(rep["over_200_chars"], 0)
            self.assertEqual(rep["repeat_recall"], 1.0)

        # H5 audit recomputation checks
        day_ms = 86_400_000
        self.assertEqual(recompute_audit_verdict("deleted", 0, 10 * day_ms, 5, 5, 0, 5, 0), "rolled back")
        self.assertEqual(recompute_audit_verdict("disabled", 0, 10 * day_ms, 5, 5, 0, 5, 0), "disabled")
        self.assertEqual(recompute_audit_verdict("active", 0, 10 * day_ms, 0, 0, 0, 0, 0), "no recurrence window")
        self.assertEqual(recompute_audit_verdict("active", 0, 10 * day_ms, 3, 3, 0, 2, 1), "did not help")
        self.assertEqual(recompute_audit_verdict("active", 0, 10 * day_ms, 3, 2, 1, 2, 0), "unreliable")
        self.assertEqual(recompute_audit_verdict("active", 0, 15 * day_ms, 3, 0, 0, 0, 0), "unused")
        self.assertEqual(recompute_audit_verdict("active", 0, 5 * day_ms, 3, 0, 0, 0, 0), "too early")
        self.assertEqual(recompute_audit_verdict("active", 0, 2 * day_ms, 5, 5, 0, 5, 0), "too early")
        self.assertEqual(recompute_audit_verdict("active", 0, 3 * day_ms, 5, 5, 0, 3, 0), "working")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Pre-registered analysis decider (PROTOCOL.md §7).")
    parser.add_argument("--bundle", default="", help="Path to evaluation bundle JSON.")
    parser.add_argument("--out", default="", help="Optional path to write JSON decision output.")
    parser.add_argument("--base-dir", default=".", help="Base directory for freeze_digests resolution.")
    parser.add_argument("--skip-digest-check", action="store_true", help="Skip SHA-256 verification.")
    parser.add_argument("--selftest", action="store_true", help="Run unit tests and exit.")
    args = parser.parse_args(argv)

    if args.selftest:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(AnalysisDeciderSelfTest)
        runner = unittest.TextTestRunner(verbosity=2)
        result = runner.run(suite)
        return 0 if result.wasSuccessful() else 1

    if not args.bundle:
        parser.error("--bundle is required unless --selftest is passed.")

    bundle_path = Path(args.bundle)
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    report = evaluate_bundle(
        bundle,
        base_dir=Path(args.base_dir),
        skip_digest_check=args.skip_digest_check,
    )
    out_json = json.dumps(report, indent=2, ensure_ascii=False)
    if args.out:
        Path(args.out).write_text(out_json + "\n", encoding="utf-8", newline="\n")
    print(out_json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
