#!/usr/bin/env python3
"""Build blinded grading packets from Refine Cycle raw JSONL files (PROTOCOL.md §5).

Standard library only. Reads raw/*.jsonl files (taking the last `session` line per
`(agentId, sessionId)` as specified in docs/proof/RAW-FORMAT.md) plus optional
placebo/calibration items, strips all identifying metadata (arm labels, session IDs,
scenario names, model/route names, memory/lesson blocks, and raw tool argument values),
and writes:
  - <out-dir>/packets/<item_id>.json   (one blind packet per item)
  - <out-dir>/packets.jsonl            (all blind packets in deterministic shuffled order)
  - <out-dir>/key_map.json             (operator-only mapping from item_id to source metadata)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PACKET_KEYS = (
    "item_id",
    "tool",
    "failure_shape",
    "session_context",
    "existing_rules",
    "lesson_text",
)

MAX_FAILURE_SHAPE_CHARS = 300
MAX_SESSION_CONTEXT_CHARS = 500

FORBIDDEN_PATTERNS = [
    re.compile(r"<learned_lessons>.*?</learned_lessons>", re.IGNORECASE | re.DOTALL),
    re.compile(r"<learned_lesson_notice>.*?</learned_lesson_notice>", re.IGNORECASE | re.DOTALL),
    re.compile(r"\bopenai/gpt-6-luna\b", re.IGNORECASE),
    re.compile(r"\bgpt-6[- ]luna\b", re.IGNORECASE),
    re.compile(r"\b(?:with-args|without-args|arm[_ -]?[abc]|placebo[_ -]?arm|real[_ -]?lesson[_ -]?arm)\b", re.IGNORECASE),
    re.compile(r"\b(?:fixable|unfixable|not_fixable|noise)_[a-z0-9_]+\b", re.IGNORECASE),
    re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE),
    re.compile(r"\blesson_[0-9a-f]{8,}\b", re.IGNORECASE),
]

JSON_VALUE_RE = re.compile(r'("[^"]+"\s*:\s*)("[^"]*"|-?\d+(?:\.\d+)?|true|false|null|\[.*?\]|\{.*?\})', re.DOTALL)


def redact_parameter_values(text: str) -> str:
    """Replace raw JSON parameter values and quoted literals with <redacted>."""
    if not text:
        return ""
    out = JSON_VALUE_RE.sub(r'\1"<redacted>"', text)
    out = re.sub(r"'(?:[^'\\]|\\.)*'", "'<redacted>'", out)
    return out


def scrub_blinding_leaks(text: str, extra_tokens: Optional[List[str]] = None) -> str:
    """Strip any arm label, route/model name, scenario identifier, UUID, or lesson block."""
    if not text:
        return ""
    out = text
    for pat in FORBIDDEN_PATTERNS:
        out = pat.sub("<redacted>", out)
    if extra_tokens:
        for tok in extra_tokens:
            if tok and len(tok) >= 4:
                out = re.sub(re.escape(tok), "<redacted>", out, flags=re.IGNORECASE)
    out = re.sub(r"\s+", " ", out).strip()
    return out


def load_deduped_sessions(raw_files: List[Path]) -> List[Tuple[str, Dict[str, Any]]]:
    """Read raw/*.jsonl and keep the LAST `session` line per (agentId, sessionId)."""
    by_key: Dict[Tuple[str, str], Tuple[str, Dict[str, Any]]] = {}
    order: List[Tuple[str, str]] = []
    for raw_path in raw_files:
        source_tag = raw_path.name
        with raw_path.open("r", encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                if obj.get("kind") != "session":
                    continue
                agent_id = str(obj.get("agentId") or "main")
                session_id = str(obj.get("sessionId") or "")
                if not session_id:
                    continue
                key = (agent_id, session_id)
                if key not in by_key:
                    order.append(key)
                by_key[key] = (source_tag, obj)
    return [by_key[k] for k in order]


def load_existing_rules_for_tool(tool: str, sources_dir: Optional[Path]) -> str:
    """Find sections or paragraphs in instruction/skill markdown files that mention `tool`."""
    if not sources_dir or not sources_dir.exists() or not tool:
        return ""
    md_files: List[Path] = []
    for p in sorted(sources_dir.iterdir()):
        if p.is_file() and p.suffix.lower() == ".md":
            md_files.append(p)
    skills_dir = sources_dir / "skills"
    if skills_dir.exists():
        for p in sorted(skills_dir.rglob("SKILL.md")):
            if p.is_file():
                md_files.append(p)
    matched_blocks: List[str] = []
    tool_re = re.compile(r"\b" + re.escape(tool) + r"\b", re.IGNORECASE)
    for md in md_files:
        try:
            content = md.read_text(encoding="utf-8")
        except OSError:
            continue
        for para in re.split(r"\n\s*\n", content):
            clean = para.strip()
            if clean and tool_re.search(clean):
                matched_blocks.append(scrub_blinding_leaks(clean))
    return "\n\n".join(matched_blocks)[:2000]


def build_session_context(session_obj: Dict[str, Any], tool: str, shape: str) -> str:
    """Construct a redacted <=500-char session context excerpt with parameter values stripped."""
    cand = session_obj.get("candidate") or {}
    count = cand.get("count", 0)
    sessions_cnt = cand.get("sessions", 0)
    dropped = bool(cand.get("droppedArgument", False))
    has_corr = bool(cand.get("hasCorrectionArgs", False))
    cmd_timeout = bool(cand.get("commandTimesOut", False))
    error_count = session_obj.get("errorCount", 0)

    parts = [
        f"tool={tool}",
        "status=error",
        f"session_errors={error_count}",
        f"pattern_occurrences={count}",
        f"pattern_sessions={sessions_cnt}",
        f"dropped_argument={str(dropped).lower()}",
        f"has_correction_args={str(has_corr).lower()}",
        f"command_times_out={str(cmd_timeout).lower()}",
        f'failure_shape="{shape}"',
        'tool_args="<redacted>"',
    ]
    ctx = " ".join(parts)
    ctx = scrub_blinding_leaks(
        ctx,
        extra_tokens=[
            str(session_obj.get("sessionId") or ""),
            str(session_obj.get("agentId") or ""),
        ],
    )
    return ctx[:MAX_SESSION_CONTEXT_CHARS]


def make_opaque_id(seed: str, unique_key: str) -> str:
    digest = hashlib.sha256(f"{seed}::{unique_key}".encode("utf-8")).hexdigest()
    return f"pkt_{digest[:16]}"


def generate_packets(
    raw_files: List[Path],
    out_dir: Path,
    sources_dir: Optional[Path] = None,
    extra_items_file: Optional[Path] = None,
    seed: str = "openclaw-proof-20260929",
) -> Dict[str, Any]:
    sessions = load_deduped_sessions(raw_files)
    raw_entries: List[Dict[str, Any]] = []

    for source_tag, sess in sessions:
        if sess.get("outcome") != "learned":
            continue
        lesson = sess.get("lesson")
        if not isinstance(lesson, dict):
            continue
        cand = sess.get("candidate") or {}
        lesson_id = str(lesson.get("id") or "")
        lesson_text = str(lesson.get("text") or "")
        tool = str(lesson.get("tool") or cand.get("tool") or "")
        fingerprint = str(lesson.get("fingerprint") or cand.get("fingerprint") or "")
        shape_raw = str(cand.get("shape") or "")
        if not shape_raw:
            for p in sess.get("patterns") or []:
                if isinstance(p, dict) and (p.get("fingerprint") == fingerprint or p.get("tool") == tool):
                    shape_raw = str(p.get("shape") or "")
                    break

        extra_tokens = [
            str(sess.get("sessionId") or ""),
            lesson_id,
            source_tag,
            source_tag.replace(".jsonl", ""),
        ]
        failure_shape = scrub_blinding_leaks(redact_parameter_values(shape_raw), extra_tokens=extra_tokens)[
            :MAX_FAILURE_SHAPE_CHARS
        ]
        session_context = build_session_context(sess, tool, failure_shape)
        existing_rules = scrub_blinding_leaks(
            load_existing_rules_for_tool(tool, sources_dir), extra_tokens=extra_tokens
        )
        clean_lesson_text = scrub_blinding_leaks(
            lesson_text,
            extra_tokens=[str(sess.get("sessionId") or ""), lesson_id],
        )

        unique_key = f"raw::{source_tag}::{sess.get('sessionId')}::{lesson_id}::{fingerprint}"
        raw_entries.append(
            {
                "unique_key": unique_key,
                "tool": tool,
                "failure_shape": failure_shape,
                "session_context": session_context,
                "existing_rules": existing_rules,
                "lesson_text": clean_lesson_text,
                "meta": {
                    "origin": "raw_learned",
                    "source_file": source_tag,
                    "session_id": sess.get("sessionId"),
                    "agent_id": sess.get("agentId"),
                    "lesson_id": lesson_id,
                    "fingerprint": fingerprint,
                    "raw_lesson_length": len(lesson_text),
                    "arm": "lesson",
                },
            }
        )

    if extra_items_file and extra_items_file.exists():
        text = extra_items_file.read_text(encoding="utf-8").strip()
        if text.startswith("["):
            extra_list = json.loads(text)
        else:
            extra_list = [json.loads(line) for line in text.splitlines() if line.strip()]
        for idx, item in enumerate(extra_list):
            tool = str(item.get("tool") or "")
            shape_raw = str(item.get("failure_shape") or "")
            failure_shape = scrub_blinding_leaks(redact_parameter_values(shape_raw))[:MAX_FAILURE_SHAPE_CHARS]
            ctx_raw = str(item.get("session_context") or "")
            if not ctx_raw:
                ctx_raw = f'tool={tool} status=error failure_shape="{failure_shape}" tool_args="<redacted>"'
            session_context = scrub_blinding_leaks(redact_parameter_values(ctx_raw))[:MAX_SESSION_CONTEXT_CHARS]
            existing_rules = scrub_blinding_leaks(
                str(item.get("existing_rules") or load_existing_rules_for_tool(tool, sources_dir))
            )
            lesson_text = str(item.get("lesson_text") or "")
            clean_lesson_text = scrub_blinding_leaks(lesson_text)
            unique_key = f"extra::{idx}::{item.get('source_id', idx)}"
            raw_entries.append(
                {
                    "unique_key": unique_key,
                    "tool": tool,
                    "failure_shape": failure_shape,
                    "session_context": session_context,
                    "existing_rules": existing_rules,
                    "lesson_text": clean_lesson_text,
                    "meta": {
                        "origin": item.get("origin", "extra"),
                        "source_id": item.get("source_id", f"extra_{idx}"),
                        "arm": item.get("arm", "unknown"),
                        "raw_lesson_length": len(lesson_text),
                    },
                }
            )

    rng = random.Random(seed)
    rng.shuffle(raw_entries)

    packets_dir = out_dir / "packets"
    packets_dir.mkdir(parents=True, exist_ok=True)
    packets_jsonl_path = out_dir / "packets.jsonl"
    key_map_path = out_dir / "key_map.json"

    key_map: Dict[str, Any] = {}
    used_ids: set[str] = set()

    with packets_jsonl_path.open("w", encoding="utf-8", newline="\n") as jsonl_out:
        for idx, entry in enumerate(raw_entries):
            item_id = make_opaque_id(seed, f"{idx}::{entry['unique_key']}")
            while item_id in used_ids:
                item_id = make_opaque_id(seed, f"{idx}::{entry['unique_key']}::retry")
            used_ids.add(item_id)

            packet = {
                "item_id": item_id,
                "tool": entry["tool"],
                "failure_shape": entry["failure_shape"],
                "session_context": entry["session_context"],
                "existing_rules": entry["existing_rules"],
                "lesson_text": entry["lesson_text"],
            }
            validate_packet(packet)
            pkt_file = packets_dir / f"{item_id}.json"
            pkt_file.write_text(json.dumps(packet, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
            jsonl_out.write(json.dumps(packet, ensure_ascii=False) + "\n")
            key_map[item_id] = entry["meta"]

    key_map_doc = {
        "seed": seed,
        "packet_count": len(key_map),
        "items": key_map,
    }
    key_map_path.write_text(json.dumps(key_map_doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return {"packet_count": len(key_map), "packets_jsonl": str(packets_jsonl_path), "key_map": str(key_map_path)}


def validate_packet(packet: Dict[str, Any]) -> None:
    """Verify §5 blinding and schema invariants on a single packet."""
    if tuple(packet.keys()) != PACKET_KEYS:
        raise ValueError(f"Invalid packet keys: {list(packet.keys())} != {list(PACKET_KEYS)}")
    if not isinstance(packet["item_id"], str) or not re.fullmatch(r"pkt_[0-9a-f]{16}", packet["item_id"]):
        raise ValueError(f"Invalid opaque item_id: {packet['item_id']!r}")
    if len(packet["failure_shape"]) > MAX_FAILURE_SHAPE_CHARS:
        raise ValueError(f"failure_shape exceeds {MAX_FAILURE_SHAPE_CHARS} chars: {len(packet['failure_shape'])}")
    if len(packet["session_context"]) > MAX_SESSION_CONTEXT_CHARS:
        raise ValueError(f"session_context exceeds {MAX_SESSION_CONTEXT_CHARS} chars: {len(packet['session_context'])}")
    for field in ("tool", "failure_shape", "session_context", "existing_rules", "lesson_text"):
        val = packet[field]
        if not isinstance(val, str):
            raise ValueError(f"Field {field} must be str, got {type(val).__name__}")
        for pat in FORBIDDEN_PATTERNS:
            if pat.search(val):
                raise ValueError(f"Blinding leak in {field} matching {pat.pattern}: {val!r}")


class MakePacketsSelfTest(unittest.TestCase):
    def test_multiline_session_dedup_and_blinding(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            raw_file = tmp_path / "r2-scenarios.jsonl"
            lines = [
                {"kind": "run", "format": 1, "at": "2026-09-29T00:00:00Z", "source": "live", "version": "0.1.0"},
                {
                    "kind": "session",
                    "format": 1,
                    "at": "2026-09-29T00:01:00Z",
                    "source": "agent_end",
                    "agentId": "main",
                    "sessionId": "11111111-2222-3333-4444-555555555555",
                    "errorCount": 2,
                    "selfCorrectingSuppressed": 0,
                    "patterns": [{"fingerprint": "fp1", "tool": "schedule_backup", "shape": "cron expression '0 0 * *' has 4 fields, expected 5", "count": 2}],
                    "outcome": "learned",
                    "refusal": null if False else None,
                    "modelCalled": True,
                    "candidate": {
                        "fingerprint": "fp1",
                        "tool": "schedule_backup",
                        "shape": "cron expression '0 0 * *' has 4 fields, expected 5",
                        "count": 2,
                        "sessions": 1,
                        "droppedArgument": False,
                        "hasCorrectionArgs": True,
                        "commandTimesOut": False,
                    },
                    "lesson": {
                        "id": "lesson_abcdef123456",
                        "tool": "schedule_backup",
                        "fingerprint": "fp1",
                        "text": "Should be overwritten by later session line.",
                    },
                },
                {
                    "kind": "session",
                    "format": 1,
                    "at": "2026-09-29T00:02:00Z",
                    "source": "agent_end",
                    "agentId": "main",
                    "sessionId": "11111111-2222-3333-4444-555555555555",
                    "errorCount": 3,
                    "selfCorrectingSuppressed": 0,
                    "patterns": [{"fingerprint": "fp1", "tool": "schedule_backup", "shape": "cron expression '0 0 * *' has 4 fields, expected 5", "count": 3}],
                    "outcome": "learned",
                    "refusal": None,
                    "modelCalled": True,
                    "candidate": {
                        "fingerprint": "fp1",
                        "tool": "schedule_backup",
                        "shape": "cron expression '0 0 * *' has 4 fields, expected 5 " + ("x" * 350),
                        "count": 3,
                        "sessions": 1,
                        "droppedArgument": False,
                        "hasCorrectionArgs": True,
                        "commandTimesOut": False,
                    },
                    "lesson": {
                        "id": "lesson_abcdef123456",
                        "tool": "schedule_backup",
                        "fingerprint": "fp1",
                        "text": "When calling schedule_backup, always pass a 5-field cron expression.",
                    },
                },
            ]
            raw_file.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")

            extra_file = tmp_path / "extra.json"
            extra_file.write_text(
                json.dumps(
                    [
                        {
                            "source_id": "placebo_1",
                            "origin": "r3_placebo",
                            "arm": "placebo",
                            "tool": "schedule_backup",
                            "failure_shape": "cron expression has <num> fields in fixable_cron_5 on openai/gpt-6-luna",
                            "session_context": "<learned_lessons>secret</learned_lessons> {\"cron\": \"0 0 * *\"}",
                            "existing_rules": "",
                            "lesson_text": "Cron expressions in schedule_backup relate to five whitespace-separated time fields.",
                        }
                    ]
                ),
                encoding="utf-8",
            )

            out_dir = tmp_path / "grading"
            res = generate_packets([raw_file], out_dir, extra_items_file=extra_file, seed="test-seed")
            self.assertEqual(res["packet_count"], 2)

            packets = [json.loads(line) for line in (out_dir / "packets.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(packets), 2)
            for pkt in packets:
                validate_packet(pkt)
                self.assertLessEqual(len(pkt["failure_shape"]), MAX_FAILURE_SHAPE_CHARS)
                self.assertLessEqual(len(pkt["session_context"]), MAX_SESSION_CONTEXT_CHARS)
                self.assertNotIn("11111111-2222-3333-4444-555555555555", json.dumps(pkt))
                self.assertNotIn("gpt-6-luna", json.dumps(pkt).lower())
                self.assertNotIn("fixable_cron_5", json.dumps(pkt).lower())
                self.assertNotIn("<learned_lessons>", json.dumps(pkt).lower())
                self.assertNotIn("Should be overwritten", pkt["lesson_text"])


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Build blind grading packets from raw JSONL files.")
    parser.add_argument("--raw", nargs="*", default=[], help="Paths to raw/*.jsonl files.")
    parser.add_argument("--out-dir", default="", help="Output directory for packets/, packets.jsonl, and key_map.json.")
    parser.add_argument("--sources-dir", default="", help="Optional workspace/sources directory for existing_rules.")
    parser.add_argument("--extra-items", default="", help="Optional JSON/JSONL file with placebo/calibration items.")
    parser.add_argument("--seed", default="openclaw-proof-20260929", help="Deterministic shuffle/ID seed.")
    parser.add_argument("--selftest", action="store_true", help="Run unit tests and exit.")
    args = parser.parse_args(argv)

    if args.selftest:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(MakePacketsSelfTest)
        runner = unittest.TextTestRunner(verbosity=2)
        result = runner.run(suite)
        return 0 if result.wasSuccessful() else 1

    if not args.raw or not args.out_dir:
        parser.error("--raw and --out-dir are required unless --selftest is passed.")

    raw_paths = [Path(p) for p in args.raw]
    out_dir = Path(args.out_dir)
    sources_dir = Path(args.sources_dir) if args.sources_dir else None
    extra_file = Path(args.extra_items) if args.extra_items else None
    summary = generate_packets(raw_paths, out_dir, sources_dir=sources_dir, extra_items_file=extra_file, seed=args.seed)
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
