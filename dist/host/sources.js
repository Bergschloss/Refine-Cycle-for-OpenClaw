/**
 * The text of the agent's own instructions and skills, for the already-covered
 * check. Read-only: the plugin never writes AGENTS.md, SOUL.md or any other file
 * the user owns.
 */
import fs from "node:fs";
import path from "node:path";
const MAX_FILES = 300;
const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 4;
function readText(file) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_BYTES)
            return null;
        return fs.readFileSync(file, "utf8");
    }
    catch {
        return null;
    }
}
function findSkillFiles(dir, depth, out) {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES)
        return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (out.length >= MAX_FILES)
            return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name.startsWith("."))
                continue;
            findSkillFiles(full, depth + 1, out);
        }
        else if (entry.isFile() && entry.name === "SKILL.md") {
            out.push(full);
        }
    }
}
export function readSources(workspaceDir, instructionFiles, skillDirs) {
    const sources = [];
    if (workspaceDir) {
        for (const name of instructionFiles) {
            const file = path.join(workspaceDir, name);
            const text = readText(file);
            if (text)
                sources.push({ name: file, text });
        }
    }
    const skillFiles = [];
    for (const dir of [...(workspaceDir ? [path.join(workspaceDir, "skills")] : []), ...skillDirs]) {
        findSkillFiles(dir, 0, skillFiles);
    }
    for (const file of skillFiles) {
        const text = readText(file);
        if (text)
            sources.push({ name: file, text });
    }
    return sources;
}
