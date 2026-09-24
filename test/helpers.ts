/**
 * Transcript rows in the shape OpenClaw 2026.9.5 writes to `transcript_events`
 * (recorded from a real install in the spike; see test/fixtures/openclaw-2026.9.5.json).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptRow } from "../src/core/failures.ts";
import type { History } from "../src/pipeline.ts";

export class Transcript {
  rows: TranscriptRow[] = [];
  private seq = 0;
  private callCounter = 0;

  private push(message: Record<string, unknown>): string {
    const id = `ev-${this.seq}`;
    this.rows.push({ seq: this.seq++, event: { type: "message", id, parentId: null, message } });
    return id;
  }

  user(text: string): this {
    this.push({ role: "user", content: [{ type: "text", text }] });
    return this;
  }

  say(text: string): this {
    this.push({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
    return this;
  }

  /** A call through OpenClaw's `tool_call` wrapper and its result. */
  call(tool: string, args: Record<string, unknown>, outcome: { error: string } | { ok: string }): this {
    const callId = `call_${this.callCounter++}`;
    this.push({
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "tool_call", arguments: { id: tool, args } }],
      stopReason: "toolUse",
    });
    if ("error" in outcome) {
      const details = { status: "error", tool: "tool_call", error: outcome.error };
      this.push({
        role: "toolResult",
        toolCallId: callId,
        toolName: "tool_call",
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
        isError: true,
      });
    } else {
      this.push({
        role: "toolResult",
        toolCallId: callId,
        toolName: "tool_call",
        content: [{ type: "text", text: outcome.ok }],
        details: { ok: true },
        isError: false,
      });
    }
    return this;
  }
}

export class FakeHistory implements History {
  sessions = new Map<string, TranscriptRow[]>();

  add(sessionId: string, transcript: Transcript): this {
    this.sessions.set(sessionId, transcript.rows);
    return this;
  }

  readSession(sessionId: string): TranscriptRow[] {
    return this.sessions.get(sessionId) ?? [];
  }

  recentSessions(limit: number) {
    return [...this.sessions.entries()]
      .reverse()
      .slice(0, limit)
      .map(([sessionId, rows]) => ({ sessionId, lastSeq: rows.length - 1 }));
  }
}

export function tempDir(prefix = "refine-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
