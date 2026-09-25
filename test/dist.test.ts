import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// OpenClaw installs a plugin from git or npm only as compiled JavaScript: the
// package points at dist/plugin.js. The shipped dist must exist for every source
// file and give the same fingerprints as the source (and the Python original).
test("dist is built for every source file and matches the golden corpus", async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.openclaw.extensions, ["./dist/plugin.js"]);
  const walk = (dir: URL, prefix = ""): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    );
  for (const file of walk(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".ts"))) {
    assert.ok(fs.existsSync(new URL(`../dist/${file.replace(/\.ts$/, ".js")}`, import.meta.url)), `dist/${file} is missing: run npm run build`);
  }
  const { fingerprint, normalizeError } = await import(new URL("../dist/core/fingerprint.js", import.meta.url).href);
  const golden = JSON.parse(fs.readFileSync(new URL("./golden/fingerprint.json", import.meta.url), "utf8"));
  const wrong = golden.filter(
    (row: { tool: string; input: string; normalized: string; fingerprint: string }) =>
      normalizeError(row.input) !== row.normalized || fingerprint(row.tool, row.input) !== row.fingerprint,
  );
  assert.equal(wrong.length, 0, `${wrong.length} rows differ in dist: rebuild it`);
});
