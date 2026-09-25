/**
 * Python `re` semantics on JavaScript regular expressions.
 *
 * The failure fingerprint is ported from the Hermes plugin (patterns.py) and must
 * give the same answer on the same text: a fingerprint is the identity of a
 * failure, and the two implementations are checked against one golden corpus.
 * Python's `\w`, `\d`, `\s`, `\b` and `.` are Unicode-aware; JavaScript's are
 * ASCII even with the `u` flag. Written naively, a Cyrillic or accented error
 * message would normalize differently here than there, and the same failure
 * would get two identities. This rewrites those escapes into explicit classes.
 */
/** Python `str.isalnum()` or `_`: letters and numbers of any script. */
const WORD = "\\p{L}\\p{N}_";
/** Python `str.isspace()`: note it includes U+001C..U+001F, which JS `\s` does not. */
const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
const NON_BOUNDARY = `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`;
/**
 * Compile a regex written with Python semantics. A leading `(?i)` becomes the
 * `i` flag, as Python applies it to the whole pattern.
 */
export function py(source, flags = "") {
    let src = source;
    let extra = "";
    if (src.startsWith("(?i)")) {
        src = src.slice(4);
        extra += "i";
    }
    let out = "";
    let inClass = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === "\\") {
            const n = src[i + 1];
            i++;
            switch (n) {
                case "w":
                    out += inClass ? WORD : `[${WORD}]`;
                    break;
                case "W":
                    if (inClass)
                        throw new Error("\\W inside a class is not supported");
                    out += `[^${WORD}]`;
                    break;
                case "d":
                    out += "\\p{Nd}";
                    break;
                case "D":
                    if (inClass)
                        throw new Error("\\D inside a class is not supported");
                    out += "\\P{Nd}";
                    break;
                case "s":
                    out += inClass ? SPACE : `[${SPACE}]`;
                    break;
                case "S":
                    if (inClass)
                        throw new Error("\\S inside a class is not supported");
                    out += `[^${SPACE}]`;
                    break;
                case "b":
                    out += inClass ? "\\x08" : BOUNDARY;
                    break;
                case "B":
                    out += NON_BOUNDARY;
                    break;
                default: out += "\\" + n;
            }
            continue;
        }
        if (inClass) {
            if (c === "]")
                inClass = false;
            out += c;
            continue;
        }
        if (c === "[") {
            inClass = true;
            out += c;
            // A `]` right after `[` or `[^` is a literal in Python.
            if (src[i + 1] === "^") {
                out += "^";
                i++;
            }
            if (src[i + 1] === "]") {
                out += "\\]";
                i++;
            }
            continue;
        }
        // Python's `.` excludes only "\n"; JavaScript's also excludes "\r", U+2028, U+2029.
        if (c === ".") {
            out += "[^\\n]";
            continue;
        }
        out += c;
    }
    return new RegExp(out, [...new Set(flags + extra + "u")].join(""));
}
/**
 * Python `re.sub` with a callable: non-overlapping matches, left to right.
 * `pattern` must not carry the `g` flag; this adds `g` and `d` itself.
 */
export function sub(pattern, text, replace) {
    const flags = [...new Set(pattern.flags + "gd")].join("");
    const re = new RegExp(pattern.source, flags);
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        const exec = m;
        const indices = exec.indices;
        out += text.slice(last, exec.index);
        out += replace({
            groups: Array.from(exec),
            start: exec.index,
            span: (g) => (indices && indices[g] ? [indices[g][0], indices[g][1]] : undefined),
        });
        last = exec.index + exec[0].length;
        if (exec[0].length === 0) {
            // An empty match: copy one character and move past it, as Python does.
            if (last < text.length) {
                const cp = text.codePointAt(last);
                const width = cp > 0xffff ? 2 : 1;
                out += text.slice(last, last + width);
                last += width;
            }
            re.lastIndex = last;
        }
    }
    return out + text.slice(last);
}
/** Python `re.sub` with a fixed string, where `\1`-style references are not used. */
export function subText(pattern, text, replacement) {
    return sub(pattern, text, () => replacement);
}
/** True when `pattern` matches at the very start of `text` (Python `re.match`). */
export function matchStart(pattern, text) {
    const re = new RegExp(pattern.source, [...new Set(pattern.flags + "y")].join(""));
    re.lastIndex = 0;
    return re.test(text);
}
/** True when `pattern` matches the whole of `text` (Python `re.fullmatch`). */
export function fullMatch(pattern, text) {
    const re = new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace(/[gy]/g, ""));
    return re.test(text);
}
const SPACE_CLASS = new RegExp(`[${SPACE}]`, "u");
const EDGE_SPACE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");
/** Python `str.isspace()` for one character. */
export function isSpace(ch) {
    return ch.length > 0 && SPACE_CLASS.test(ch);
}
/** Python `str.strip()` with no argument. */
export function strip(text) {
    return text.replace(EDGE_SPACE, "");
}
/** Python `str.lstrip(chars)`. */
export function lstrip(text, chars) {
    let i = 0;
    while (i < text.length && chars.includes(text[i]))
        i++;
    return text.slice(i);
}
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u;
/** Python `str.splitlines()`: no trailing empty line for a final terminator. */
export function splitLines(text) {
    if (text === "")
        return [];
    const parts = text.split(LINE_BREAK);
    if (parts.length > 1 && parts[parts.length - 1] === "")
        parts.pop();
    return parts;
}
const IDENTIFIER = /^[\p{XID_Start}_][\p{XID_Continue}]*$/u;
/** Python `str.isidentifier()`. */
export function isIdentifier(text) {
    return IDENTIFIER.test(text);
}
