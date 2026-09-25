/**
 * Does the agent already have this rule?
 *
 * The Hermes plugin's surviving lessons were mostly restatements of what the
 * agent's own skills already said: 0 useful lessons out of 33 candidate sessions.
 * This is the check it never had. It runs twice: before the model, against the
 * failure (is there a paragraph about this tool and this error?), and after it,
 * against the proposed lesson (does a paragraph already say it?).
 *
 * Deliberately lexical and cheap. It will miss a rule written in other words,
 * which costs a model call; it will not refuse a lesson on a vague resemblance,
 * because it needs the tool and most of the distinctive words together.
 */
const STOPWORDS = new Set(("the and for with that this from are was were not but you your have has had can " +
    "cannot could should would will into onto when then than them they their there here " +
    "what which while who whom why how all any each every some such only also just more " +
    "most other its it's is be been being do does did done a an of to in on at by or as " +
    "if no nor so too very use used using via per out off over under again once because " +
    "before after above below between both same own error errors failed failure fail " +
    "path url n x t true false null none undefined").split(" "));
/** Lowercased content words of any script, without the tokens normalization leaves behind. */
export function terms(text) {
    const out = [];
    for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) {
        const word = match[0];
        if (word.length < 3 || STOPWORDS.has(word) || /^\p{N}+$/u.test(word))
            continue;
        out.push(word);
    }
    return out;
}
function paragraphs(text) {
    const out = [];
    let start = 0;
    let buffer = [];
    const lines = text.split(/\r?\n/);
    const flush = () => {
        const joined = buffer.join("\n").trim();
        if (joined)
            out.push({ line: start + 1, text: joined, terms: new Set(terms(joined)) });
        buffer = [];
    };
    lines.forEach((line, index) => {
        if (!line.trim()) {
            flush();
            start = index + 1;
            return;
        }
        if (buffer.length === 0)
            start = index;
        buffer.push(line);
    });
    flush();
    return out;
}
function excerpt(text) {
    const flat = text.replace(/\s+/g, " ");
    return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}
/**
 * A paragraph that names the tool and shares at least half of the error's
 * distinctive words (never fewer than two).
 */
export function findCoveringRule(tool, shape, sources) {
    const toolTerms = terms(tool.replace(/[_.:-]+/g, " "));
    const toolLower = tool.toLowerCase();
    const shapeTerms = [...new Set(terms(shape))].filter((term) => !toolTerms.includes(term));
    if (shapeTerms.length === 0)
        return null;
    const needed = Math.max(2, Math.ceil(shapeTerms.length / 2));
    for (const source of sources) {
        for (const paragraph of paragraphs(source.text)) {
            const namesTool = paragraph.text.toLowerCase().includes(toolLower) ||
                (toolTerms.length > 0 && toolTerms.every((term) => paragraph.terms.has(term)));
            if (!namesTool)
                continue;
            const shared = shapeTerms.filter((term) => paragraph.terms.has(term)).length;
            if (shared >= needed)
                return { source: source.name, line: paragraph.line, excerpt: excerpt(paragraph.text) };
        }
    }
    return null;
}
/** A paragraph that already contains most of the lesson's content words. */
export function findRestatement(lesson, sources, threshold = 0.7) {
    const lessonTerms = [...new Set(terms(lesson))];
    if (lessonTerms.length < 4)
        return null;
    for (const source of sources) {
        for (const paragraph of paragraphs(source.text)) {
            const shared = lessonTerms.filter((term) => paragraph.terms.has(term)).length;
            if (shared / lessonTerms.length >= threshold) {
                return { source: source.name, line: paragraph.line, excerpt: excerpt(paragraph.text) };
            }
        }
    }
    return null;
}
