import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// OpenClaw installs a plugin from git or npm only as compiled JavaScript: the package
// points at dist/plugin.js, so dist/ is what users run. It must be exactly what
// `npm run build` makes from src/ today; every other test exercises src/.
const repo = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string, prefix = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

test("dist/ is exactly the build of src/ (run npm run build if this fails)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.openclaw.extensions, ["./dist/plugin.js"]);
  let ts: typeof import("typescript");
  try {
    ts = createRequire(import.meta.url)("typescript");
  } catch {
    assert.fail("typescript is not installed: run npm install");
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "refine-dist-"));
  after(() => fs.rmSync(out, { recursive: true, force: true }));
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(repo, "tsconfig.build.json"), { outDir: out }, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => assert.fail(String(d.messageText)),
  })!;
  const emitted = ts.createProgram(parsed.fileNames, parsed.options).emit();
  assert.equal(emitted.emitSkipped, false);
  const built = files(out).sort();
  const shipped = files(path.join(repo, "dist")).sort();
  assert.deepEqual(shipped, built, "dist/ has different files than the build");
  const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  for (const file of built) {
    assert.equal(read(path.join(repo, "dist", file)), read(path.join(out, file)), `dist/${file} is out of date`);
  }
});
