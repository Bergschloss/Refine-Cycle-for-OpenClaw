/**
 * Error fingerprinting: "the same failure happened again" is a question about
 * shapes, not strings. Two errors that differ only by a request id, a row count
 * or a temp path are the same failure; normalizing those away and hashing what
 * remains turns error text into countable patterns.
 *
 * A line-for-line port of `patterns.py` (normalize_error, fingerprint) from the
 * Hermes plugin, Refine Cycle v1.3.17. It must give the same answer on the same
 * text — the golden corpus in test/golden/fingerprint.json is recorded from the
 * Python original and pins that. The reasons behind each rule are documented in
 * the original; they are summarised here only where the port itself depends on
 * them. Pure functions: no host, no I/O.
 */

import { createHash } from "node:crypto";
import {
  fullMatch, isIdentifier, isSpace, lstrip, matchStart, py, splitLines, strip, sub,
  type Match,
} from "./pyre.ts";

// -- Paths ------------------------------------------------------------------------

const SEGMENT = String.raw`[\w.()\-]+`;
const SPACED_SEGMENT = `${SEGMENT}(?: ${SEGMENT})*`;
const ROOTED_WINDOWS_PATH = String.raw`(?:[A-Za-z]:[\\/]|\\\\)(?:${SPACED_SEGMENT}[\\/])*${SEGMENT}`;
const BACKSLASH_PATH = String.raw`\\(?:${SEGMENT}[\\/])+${SEGMENT}`;
const POSIX_PATH = String.raw`(?<!\w)/(?:${SEGMENT}/)*${SEGMENT}`;
const RELATIVE_PATH = String.raw`(?<!\w)${SEGMENT}(?:[\\/]${SEGMENT}){1,8}\.[A-Za-z0-9]{1,8}`;
const PATH = py(`(?:${ROOTED_WINDOWS_PATH}|${BACKSLASH_PATH}|${POSIX_PATH}|${RELATIVE_PATH})`);

const CLI_FLAG = py(String.raw`(?i)\b(option|flag|switch)\s+/(${SEGMENT})`);

// -- HTTP status ------------------------------------------------------------------

const HTTP_STATUS_PRESENT = py(String.raw`(?i)\bhttps?\b`);
const HTTP_STATUS_ANCHORED = py(
  String.raw`(?i)\bhttps?/\d(?:\.\d+)?\s+([1-5]\d{2})\b` +
    String.raw`|\bhttps?\b[^\d]{0,20}\b([1-5]\d{2})\b` +
    String.raw`|\b([1-5]\d{2})\s+(?:client|server)\s+error\b`,
);
const HTTP_STATUS_CONTEXTUAL = py(
  String.raw`(?i)\b(?:returned|status|responded\s+with|response)\b\s*(?:code\s*)?[:=]?\s*([1-5]\d{2})\b`,
);

function firstGroup(m: Match): string {
  for (let g = 1; g < m.groups.length; g++) {
    const v = m.groups[g];
    if (v) return v;
  }
  throw new Error("no captured group");
}

function markHttpStatus(m: Match): string {
  const code = firstGroup(m);
  // Python str.replace with no count: every occurrence.
  return m.groups[0]!.split(code).join(`httpstatus${code}`);
}

function preserveHttpStatus(text: string): string {
  let out = sub(HTTP_STATUS_ANCHORED, text, markHttpStatus);
  if (HTTP_STATUS_PRESENT.test(out)) out = sub(HTTP_STATUS_CONTEXTUAL, out, markHttpStatus);
  return out;
}

// -- Exit codes, signals, ports ---------------------------------------------------

const EXIT_CODE_NUM = py(
  String.raw`(?i)\b(?:exit(?:\s*(?:code|status)|code|status)|exited\s+with\s+(?:exit\s+)?code|returned\s+a\s+non-zero\s+code)\b\s*[:=]?\s*(\d+)`,
);
const SIGNAL_NUM = py(String.raw`(?i)\bsignal\b\s*[:=]?\s*(\d+)`);
const PORT_WORD_NUM = py(String.raw`(?i)\bport\b\s*[:=]?\s*(\d+)`);
const PORT_TCP_NUM = py(String.raw`(?i)\b(?:tcp|udp)\b\s*:\s*(\d{1,5})\b(?![:.]\d)`);
const PORT_LOCALHOST_NUM = py(String.raw`(?i)\blocalhost:(\d{1,5})\b(?![:.]\d)`);
const PORT_IPV4_NUM = py(String.raw`(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}:(\d{1,5})\b(?![:.]\d)`);
const PORT_DNS_NUM = py(
  String.raw`(?i)\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24}):(\d{1,5})\b(?![:.]\d)`,
);
const PORT_CONTEXT_NUM = py(
  String.raw`(?i)\b(?:connect(?:ing|ed)?\s+to|connection\s+to|dial(?:ing)?(?:\s+to)?` +
    String.raw`|upstream|proxy|hostname|host|server|address)\b\s*[:=]?\s*` +
    String.raw`([a-z][\w-]*(?:\.[\w-]+)*):(\d{1,5})\b(?![:.]\d)`,
);
const PORT_IPV6_LOOPBACK_NUM = py(String.raw`(?i)(?:\[::1\]|::1):(\d{1,5})\b(?![:.]\d)`);

/** `name.py:12` is a source location, not a host:port. */
const SOURCE_FILE_SUFFIXES = new Set([
  "py", "pyi", "js", "jsx", "mjs", "cjs", "ts", "tsx", "go", "rs", "rb", "php",
  "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "sh", "bash",
  "ps1", "psm1", "sql", "yml", "yaml", "json", "toml", "ini", "cfg", "conf",
  "md", "rst", "txt", "log", "csv", "html", "htm", "css", "scss", "vue", "svelte",
  "tf", "lua", "pl", "r", "scala", "ex", "exs", "dart", "m", "mm", "asm", "s",
]);

/** Prefix the digits of `group` inside the whole match, by span, not by search. */
function glueGroup(m: Match, prefix: string, group = 1): string {
  const [start, end] = m.span(group)!;
  const text = m.groups[0]!;
  const offset = m.start;
  return `${text.slice(0, start - offset)}${prefix}${m.groups[group]}${text.slice(end - offset)}`;
}

/** Replace the first occurrence of the captured number with `<prefix><number>`. */
function glueNumber(m: Match, prefix: string): string {
  const number = firstGroup(m);
  const text = m.groups[0]!;
  const at = text.indexOf(number);
  return `${text.slice(0, at)}${prefix}${number}${text.slice(at + number.length)}`;
}

function glueDnsPort(m: Match): string {
  if (SOURCE_FILE_SUFFIXES.has(m.groups[1]!.toLowerCase())) return m.groups[0]!;
  return glueGroup(m, "netport", 2);
}

function glueContextPort(m: Match): string {
  const labels = m.groups[1]!.split(".");
  if (SOURCE_FILE_SUFFIXES.has(labels[labels.length - 1].toLowerCase())) return m.groups[0]!;
  return glueGroup(m, "netport", 2);
}

function preserveSemanticNumbers(text: string): string {
  let t = sub(EXIT_CODE_NUM, text, (m) => glueNumber(m, "exitcode"));
  t = sub(SIGNAL_NUM, t, (m) => glueNumber(m, "signal"));
  t = sub(PORT_WORD_NUM, t, (m) => glueNumber(m, "netport"));
  t = sub(PORT_TCP_NUM, t, (m) => glueNumber(m, "netport"));
  t = sub(PORT_LOCALHOST_NUM, t, (m) => glueGroup(m, "netport"));
  t = sub(PORT_IPV4_NUM, t, (m) => glueGroup(m, "netport"));
  t = sub(PORT_DNS_NUM, t, glueDnsPort);
  t = sub(PORT_CONTEXT_NUM, t, glueContextPort);
  t = sub(PORT_IPV6_LOOPBACK_NUM, t, (m) => glueGroup(m, "netport"));
  return t;
}

// -- The normalizers, in order ----------------------------------------------------

type Replacement = string | ((m: Match) => string);

const NORMALIZERS: Array<[RegExp, Replacement]> = [
  [py(String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?`), "T"],
  [py(String.raw`\b\d{2}:\d{2}:\d{2}\b`), "T"],
  [
    py(String.raw`(?<![a-zA-Z])'([^']*)'(?![a-zA-Z])` + String.raw`|(?<![a-zA-Z])'([^']*)$`),
    (m) => (m.groups[1] ?? "") + (m.groups[2] ?? ""),
  ],
  [
    CLI_FLAG,
    (m) => {
      const flag = m.groups[2]!;
      const trimmed = flag.replace(/\.+$/u, "");
      return `${m.groups[1]} cliflag_${trimmed || flag}`;
    },
  ],
  [py(String.raw`https?://\S+`), "URL"],
  [PATH, "PATH"],
  [py(String.raw`\b[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\b`), "X"],
  [py(String.raw`\b(?:0x)?[0-9a-fA-F]{7,}\b`), "X"],
  [py(String.raw`(?i)\b\d+(?:\.\d+)?\s*(?:ms|s|m|h|kb|mb|gb)\b`), "N"],
  [py(String.raw`\b\d+\b`), "N"],
];

// -- Tracebacks -------------------------------------------------------------------

const TOOL_LOOP_WARNING = py(
  String.raw`\s*\[Tool loop warning:\s*repeated_exact_failure_warning;[^\]]*\]\s*$`,
  "i",
);
const TRACEBACK_HEADER = py(
  String.raw`(?:(?:\+\s+)?Exception Group )?Traceback \(most recent call last\):\s*`,
);
const EXCEPTION_GROUP_HEADER = py(
  String.raw`(?:\+\s+)?Exception Group Traceback \(most recent call last\):\s*`,
);
const TRACEBACK_WRAPPER_LINE = py(String.raw`(?i)^(?:g?make|ninja):`);
const TRACEBACK_CHAIN_LINE = py(
  String.raw`(?i)^(?:during handling of the above exception|the above exception was the direct cause)`,
);
const TRACEBACK_RUNNER_FOOTER_LINE = py(
  String.raw`(?i)^(?:process|command) exited with code \d+|^exit(?:ed)? code:? \d+`,
);

function isPythonExceptionLine(line: string): boolean {
  const stripped = strip(line);
  if (!stripped || matchStart(TRACEBACK_WRAPPER_LINE, stripped)) return false;
  const colon = stripped.indexOf(":");
  const typeName = colon === -1 ? stripped : stripped.slice(0, colon);
  return typeName.length > 0 && typeName.split(".").every(isIdentifier);
}

function isBoundaryLine(stripped: string): boolean {
  return (
    matchStart(TRACEBACK_WRAPPER_LINE, stripped) ||
    matchStart(TRACEBACK_CHAIN_LINE, stripped) ||
    matchStart(TRACEBACK_RUNNER_FOOTER_LINE, stripped)
  );
}

const DOUBLE_QUOTED = py(String.raw`"(?:[^"\\]|\\.)*"|"(?:[^"\\]|\\.)*$`);

function stripQuotes(text: string): string {
  return sub(DOUBLE_QUOTED, text, (m) => {
    const s = m.groups[0]!;
    return s.endsWith('"') && s.length > 1 ? s.slice(1, -1) : s.slice(1);
  });
}

/** The terminal exception of the last traceback in `lines`, or null. */
function tracebackException(lines: string[]): string | null {
  const headers: number[] = [];
  lines.forEach((line, index) => {
    if (fullMatch(TRACEBACK_HEADER, line)) headers.push(index);
  });
  if (headers.length === 0) return null;

  let exceptionLine: string | null = null;
  for (let position = headers.length - 1; position >= 0; position--) {
    const start = headers[position] + 1;
    const end = position + 1 < headers.length ? headers[position + 1] : lines.length;
    const block = lines.slice(start, end);

    if (fullMatch(EXCEPTION_GROUP_HEADER, lines[headers[position]])) {
      for (let i = block.length - 1; i >= 0; i--) {
        const cleaned = lstrip(block[i], " |");
        if (!strip(cleaned)) continue;
        if (isPythonExceptionLine(strip(cleaned))) {
          exceptionLine = strip(cleaned);
          break;
        }
      }
      if (exceptionLine) continue;
    }

    let terminal = "";
    let terminalIndex: number | null = null;
    for (let i = block.length - 1; i >= 0; i--) {
      const line = block[i];
      if (!strip(line)) continue;
      if (isBoundaryLine(strip(line))) continue;
      terminal = line;
      terminalIndex = i;
      break;
    }

    if (terminal && isPythonExceptionLine(terminal)) {
      exceptionLine = strip(terminal);
    } else if (terminalIndex !== null) {
      let exceptionStart: number | null = null;
      for (let offset = terminalIndex - 1; offset >= 0; offset--) {
        const line = block[offset];
        const stripped = strip(line);
        if (!stripped) continue;
        if (stripped.startsWith('File "') || isBoundaryLine(stripped)) break;
        if (isSpace(line.slice(0, 1))) continue;
        if (isPythonExceptionLine(line)) exceptionStart = offset;
      }
      if (exceptionStart !== null) {
        const messageLines: string[] = [];
        for (const line of block.slice(exceptionStart, terminalIndex + 1)) {
          const stripped = strip(line);
          if (!stripped) continue;
          if (stripped.startsWith('File "') || isBoundaryLine(stripped)) break;
          messageLines.push(stripped);
        }
        exceptionLine = messageLines.join(" ");
      }
    }
    if (exceptionLine) break;
  }
  return exceptionLine || null;
}

// -- Public -----------------------------------------------------------------------

/**
 * Reduce an error message to its invariant shape: `HTTP 429 for /users/8821` and
 * `HTTP 429 for /users/9134` both become `http N for PATH`.
 */
export function normalizeError(content: string): string {
  if (!content) return "";
  let text = strip(content);
  text = strip(sub(TOOL_LOOP_WARNING, text, () => ""));

  const exception = tracebackException(splitLines(text));
  if (exception) text = exception;

  text = stripQuotes(text);
  text = preserveHttpStatus(text);
  text = preserveSemanticNumbers(text);
  for (const [pattern, replacement] of NORMALIZERS) {
    text = typeof replacement === "string"
      ? sub(pattern, text, () => replacement)
      : sub(pattern, text, replacement);
  }
  return strip(sub(py(String.raw`\s+`), text, () => " ")).toLowerCase();
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A stable 12-character id for an error shape, scoped by the tool that produced it.
 * Hashes the full normalized text, so errors sharing a long prefix stay distinct.
 */
export function fingerprint(toolName: string, content: string): string {
  // Python encodes with errors="replace": a lone surrogate becomes "?".
  const key = `${toolName || ""}|${normalizeError(content)}`.replace(LONE_SURROGATE, "?");
  return createHash("sha1").update(key, "utf8").digest("hex").slice(0, 12);
}
