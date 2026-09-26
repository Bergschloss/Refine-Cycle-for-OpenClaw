import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { aggregate, isSelfCorrectingError, missingParameters, summarizeSession } from "../src/core/failures.ts";
import { fingerprint } from "../src/core/fingerprint.ts";
import { Transcript } from "./helpers.ts";

test("a failure is identified by the real tool behind the tool_call wrapper", () => {
  const t = new Transcript().user("go").call("fs_read", { path: "/tmp/a.txt" }, { error: "ENOENT: no such file /tmp/a.txt" });
  const summary = summarizeSession("s1", "main", t.rows);
  assert.equal(summary.patterns.length, 1);
  assert.equal(summary.patterns[0].tool, "fs_read");
  assert.equal(summary.patterns[0].fingerprint, fingerprint("fs_read", "ENOENT: no such file /tmp/a.txt"));
  assert.equal(summary.patterns[0].occurrences[0].toolCallId, "call_0");
  assert.equal(summary.patterns[0].occurrences[0].eventId, "ev-2");
});

test("the same error with a different path is one pattern", () => {
  const t = new Transcript()
    .call("fs_read", { path: "/tmp/a.txt" }, { error: "ENOENT: no such file /tmp/a.txt" })
    .call("fs_read", { path: "/var/b.txt" }, { error: "ENOENT: no such file /var/b.txt" });
  const summary = summarizeSession("s1", "main", t.rows);
  assert.equal(summary.patterns.length, 1);
  assert.equal(summary.patterns[0].count, 2);
});

test("the whole session counts, not only the newest rows", () => {
  const t = new Transcript().call("db", {}, { error: "relation users does not exist" });
  for (let i = 0; i < 400; i++) t.user(`turn ${i}`).say("ok");
  t.call("db", {}, { error: "relation users does not exist" });
  assert.equal(summarizeSession("s1", "main", t.rows).patterns[0].count, 2);
});

test("what the agent did next is classified up to the next user message", () => {
  const t = new Transcript()
    .user("a").call("x", { q: 1 }, { error: "bad value 1" }).call("x", { q: 2 }, { ok: "fine" })
    .user("b").call("y", {}, { error: "boom" }).call("y", {}, { error: "boom" })
    .user("c").call("z", {}, { error: "nope" }).call("other", {}, { ok: "done" })
    .user("d").call("w", {}, { error: "stuck" }).user("never mind");
  const summary = summarizeSession("s1", "main", t.rows);
  const resolution = (tool: string) => summary.patterns.find((p) => p.tool === tool)!.occurrences[0].resolution;
  assert.equal(resolution("x"), "corrected");
  assert.equal(resolution("y"), "repeated");
  assert.equal(resolution("z"), "switched");
  assert.equal(resolution("w"), "unknown");
});

test("an error that states its own remedy is seen but never a candidate", () => {
  const t = new Transcript().call("tool_search", {}, { error: "query is required" });
  const summary = summarizeSession("s1", "main", t.rows);
  assert.equal(summary.patterns.length, 0);
  assert.equal(summary.selfCorrectingSuppressed, 1);
  assert.equal(summary.errorCount, 1);
});

test("a missing credential is not self-correcting (ported rule)", () => {
  assert.equal(isSelfCorrectingError("query is required"), true);
  assert.equal(isSelfCorrectingError("GITHUB_TOKEN is required"), false);
  assert.equal(isSelfCorrectingError("Authentication is required"), false);
  assert.equal(isSelfCorrectingError("x".repeat(60) + " query is required"), false);
});

test("dropping an argument the agent already used is recognised", () => {
  assert.deepEqual(missingParameters("Missing required parameter: 'schedule'"), ["schedule"]);
  const t = new Transcript()
    .call("cron_add", { schedule: "0 * * * *", command: "x" }, { ok: "added" })
    .call("cron_add", { command: "y" }, { error: "Missing required parameter: schedule" });
  assert.equal(summarizeSession("s1", "main", t.rows).patterns[0].droppedArgument, true);
  const fresh = new Transcript().call("cron_add", { command: "y" }, { error: "Missing required parameter: schedule" });
  assert.equal(summarizeSession("s1", "main", fresh.rows).patterns[0].droppedArgument, false);
});

test("aggregation counts sessions and occurrences, and a re-read session is not double-counted", () => {
  const one = summarizeSession("s1", "main", new Transcript().call("db", {}, { error: "locked" }).rows);
  const two = summarizeSession("s2", "main", new Transcript().call("db", {}, { error: "locked" }).call("db", {}, { error: "locked" }).rows);
  const merged = aggregate([one, two]).get(one.patterns[0].fingerprint)!;
  assert.equal(merged.count, 3);
  assert.deepEqual(merged.sessionIds, ["s1", "s2"]);
});

test("a Codex-runtime tool result (the ChatGPT-subscription route) is read too", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/openclaw-2026.9.5.json", import.meta.url), "utf8"));
  const rows = [
    { seq: 0, event: fixture.codexToolCallEvent },
    { seq: 1, event: fixture.codexToolResultErrorEvent },
  ];
  const summary = summarizeSession("s1", "main", rows);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.patterns[0].tool, "schedule_backup");
  assert.equal(summary.patterns[0].sample, "cron expression '0 3 *' has 3 fields, expected 5");
  assert.equal(summary.patterns[0].sampleArgs, '{"cron":"0 3 *"}');
  assert.deepEqual(summary.patterns[0].times, [1790214680414], "the host's own ms timestamp");
});

test("rows that are not messages, or malformed, are skipped", () => {
  const rows = [
    { seq: 0, event: { type: "session" } },
    { seq: 1, event: null },
    { seq: 2, event: { type: "message", message: { role: "toolResult", isError: true, content: "plain string error" } } },
  ];
  const summary = summarizeSession("s1", "main", rows);
  assert.equal(summary.patterns.length, 1);
  assert.equal(summary.lastSeq, 2);
});

test("a long error is bounded like the Hermes plugin: head 1000 and tail 3000 characters", () => {
  const error = (middle: string) => "E".repeat(1000) + middle.repeat(5000) + "T".repeat(3000);
  const t = new Transcript().call("x", {}, { error: error("a") }).call("x", {}, { error: error("b") });
  const summary = summarizeSession("s1", "main", t.rows);
  assert.equal(summary.patterns.length, 1, "differences outside head and tail do not split the pattern");
  assert.equal(summary.patterns[0].count, 2);
  assert.deepEqual(summary.patterns[0].seqs, [1, 3]);
});

test("an event with only an ISO timestamp is still placed in time", () => {
  const rows = [
    { seq: 0, event: { type: "message", id: "e", timestamp: "2026-09-22T00:45:48.690Z", message: { role: "toolResult", toolName: "x", isError: true, content: "boom" } } },
  ];
  assert.deepEqual(summarizeSession("s1", "main", rows).patterns[0].times, [Date.parse("2026-09-22T00:45:48.690Z")]);
});

test("a later success of a different shell command does not count as a correction", () => {
  const t = new Transcript()
    .call("Bash", { command: "python3 build.py" }, { error: "exit code 49" })
    .call("Bash", { command: "ls -la" }, { ok: "files" })
    .user("again")
    .call("Bash", { command: "python3 build.py" }, { error: "exit code 49" })
    .call("Bash", { command: "/usr/bin/python3 build.py --fixed" }, { ok: "built" });
  const [pattern] = summarizeSession("s1", "main", t.rows).patterns;
  assert.deepEqual(pattern.occurrences.map((o) => o.resolution), ["unknown", "corrected"]);
});

test("the same command is recognised past cd &&, env prefixes and wrappers", () => {
  const resolution = (failed: string, later: string) => {
    const t = new Transcript().call("Bash", { command: failed }, { error: "exit code 1" }).call("Bash", { command: later }, { ok: "done" });
    return summarizeSession("s1", "main", t.rows).patterns[0].occurrences[0].resolution;
  };
  assert.equal(resolution("cd /app && npm test", "cd /app && ls"), "unknown");
  assert.equal(resolution("cd /app && npm test", "cd /app && npm test -- --ci"), "corrected");
  assert.equal(resolution("python3 a.py", "python3 b.py"), "unknown");
  assert.equal(resolution("FOO=1 make build", "make build"), "corrected");
  assert.equal(resolution("sudo systemctl restart x", "systemctl restart x"), "corrected");
});

test("the same command is compared past flags, inside quotes and in inline code", () => {
  const resolution = (failed: unknown, later: unknown) => {
    const t = new Transcript().call("Bash", { command: failed }, { error: "exit code 1" }).call("Bash", { command: later }, { ok: "done" });
    return summarizeSession("s1", "main", t.rows).patterns[0].occurrences[0].resolution;
  };
  assert.equal(resolution("bash -c 'npm test'", "bash -c 'ls -la'"), "unknown");
  assert.equal(resolution("bash -c 'npm test'", "bash -c 'npm test -- --ci'"), "corrected");
  assert.equal(resolution("python3 -m pytest", "python3 -m pip install x"), "unknown");
  assert.equal(resolution("node -e 'boom()'", "node -e 'console.log(1)'"), "unknown");
  // Changed inline code is a different command: the comparison leans to "not the same".
  assert.equal(resolution('python3 -c "import a; a.go()"', 'python3 -c "import a; a.go(1)"'), "unknown");
  assert.equal(resolution('python3 -c "import a;  a.go()"', 'python3 -c "import a; a.go()"'), "corrected");
  assert.equal(resolution("npm test", "npm --silent test"), "corrected");
  assert.equal(resolution(["python3", "a.py"], ["python3", "b.py"]), "unknown");
  assert.equal(resolution(["python3", "a.py"], ["python3", "a.py", "--fix"]), "corrected");
});

test("the same command: odd argv, git -C, multi-line scripts and pipelines", () => {
  const resolution = (failed: unknown, later: unknown) => {
    const t = new Transcript().call("Bash", { command: failed }, { error: "exit code 1" }).call("Bash", { command: later }, { ok: "done" });
    return summarizeSession("s1", "main", t.rows).patterns[0].occurrences[0].resolution;
  };
  // An empty or odd argv is compared by tool, never a crash.
  assert.equal(resolution([], ["ls"]), "corrected");
  assert.equal(resolution([1, 2], ["ls"]), "corrected");
  assert.equal(resolution("", "ls"), "corrected");
  assert.equal(resolution("git -C /repo push", "git -C /repo log"), "unknown");
  assert.equal(resolution("git -C /repo push", "git -C /repo push --force-with-lease"), "corrected");
  assert.equal(resolution("make -C build install", "make -C build clean"), "unknown");
  assert.equal(resolution("cd /repo\nnpm test", "cd /repo\nls"), "unknown");
  assert.equal(resolution("cd /repo\nnpm test", "cd /repo\nnpm test -- --ci"), "corrected");
  assert.equal(resolution("ls | grep foo", "ls -la | wc -l"), "unknown");
  assert.equal(resolution("npm test 2>&1 | tail -5", "npm test 2>&1 | tail -5 -q"), "corrected");
  assert.equal(resolution("npm test 2>&1 | tail -5", "npm test 2>&1 | tail -20"), "unknown");
  assert.equal(resolution("npm run dev & npm test", "npm test"), "unknown");
  assert.equal(resolution("npm run dev & npm test", "npm run dev & npm test --ci"), "corrected");
});

test("the same command: heredocs, line continuations, shell scripts and whole multi-line scripts", () => {
  const resolution = (failed: unknown, later: unknown) => {
    const t = new Transcript().call("Bash", { command: failed }, { error: "exit code 1" }).call("Bash", { command: later }, { ok: "done" });
    return summarizeSession("s1", "main", t.rows).patterns[0].occurrences[0].resolution;
  };
  assert.equal(resolution("python3 - <<'EOF'\nimport foo\nEOF", "cat > notes.md <<'EOF'\nhi\nEOF"), "unknown");
  assert.equal(resolution("node <<EOF\nboom()\nEOF", "python3 <<EOF\nprint(1)\nEOF"), "unknown");
  assert.equal(resolution("cat <<EOF > a.txt\nx\nEOF", "cat <<EOF > a.txt\nx\nEOF\n"), "corrected");
  assert.equal(resolution("cat <<EOF > a.txt\nx\nEOF", "cat <<EOF > a.txt\ny\nEOF"), "unknown");
  assert.equal(resolution("python3 train.py \\\n  --out model.bin", "ls \\\n  --out model.bin"), "unknown");
  assert.equal(resolution("bash -c 'cd /repo && pytest'", "bash -c 'cd /repo && ls'"), "unknown");
  assert.equal(resolution("bash -lc 'cd /repo && pytest'", "bash -lc 'cd /repo && git status'"), "unknown");
  assert.equal(resolution(["bash", "-lc", "cd /repo && pytest"], ["bash", "-lc", "cd /repo && git status"]), "unknown");
  assert.equal(resolution("bash -lc 'cd /repo && pytest -x'", "bash -lc 'cd /repo && pytest -q'"), "corrected");
  assert.equal(resolution("npm test\necho done", "ls\necho done"), "unknown");
  assert.equal(resolution("# build it\nnpm run build", "# lint it\nnpm run lint"), "unknown");
  assert.equal(resolution("npm run build", "npm run build -- --verbose"), "corrected");
  assert.equal(resolution("uv run pytest", "uv run ruff check"), "unknown");
});

test("the same command: code on standard input, << inside quotes, runners and containers", () => {
  const resolution = (failed: unknown, later: unknown) => {
    const t = new Transcript().call("Bash", { command: failed }, { error: "exit code 1" }).call("Bash", { command: later }, { ok: "done" });
    return summarizeSession("s1", "main", t.rows).patterns[0].occurrences[0].resolution;
  };
  // A heredoc into an interpreter is the code that runs; into anything else it is data.
  assert.equal(resolution("python3 - <<'EOF'\nimport pandas\nEOF", "python3 - <<'EOF'\nprint(1)\nEOF"), "unknown");
  assert.equal(resolution("node <<'EOF'\nboom()\nEOF", "node <<'EOF'\nok()\nEOF"), "unknown");
  assert.equal(resolution("psql -d app <<'SQL'\nselect 1;\nSQL", "psql -d app <<'SQL'\nselect 2;\nSQL"), "unknown");
  assert.equal(resolution("python3 - <<'EOF'\nimport pandas\nEOF", "python3 - <<'EOF'\nimport  pandas\nEOF"), "corrected");
  assert.equal(resolution("cat > f.md <<'EOF'\none\nEOF", "cat > f.md <<'EOF'\ntwo\nEOF"), "unknown");
  assert.equal(resolution("cat > f.md <<'EOF'\none\nEOF", "cat > f.md <<'EOF'\n  one\nEOF"), "corrected");
  assert.equal(resolution("cat <<EOF > a\nx\nEOF\nnpm test", "cat <<EOF > a\nx\nEOF\nls"), "unknown");
  assert.equal(resolution("bash <<'EOF'\nnpm test\nEOF", "bash <<'EOF'\nls\nEOF"), "unknown");
  // A << inside quotes starts nothing.
  assert.equal(resolution("echo 'a << b'\nnpm test", "echo 'a << b'\nls"), "unknown");
  assert.equal(resolution('python3 -c "print(1 << 2)"\nnpm test', 'python3 -c "print(1 << 2)"\nls'), "unknown");
  // Runners and containers compare the command they run.
  assert.equal(resolution("uv run python train.py", "uv run python -c 'print(1)'"), "unknown");
  assert.equal(resolution("uv run python -c 'import torch'", "uv run python -c 'print(1)'"), "unknown");
  assert.equal(resolution("uv run --with pandas pytest -x", "uv run pytest -q"), "corrected");
  assert.equal(resolution("poetry run python manage.py migrate", "poetry run python manage.py check"), "unknown");
  assert.equal(resolution("conda run -n ml python train.py", "conda run -n ml pip list"), "unknown");
  assert.equal(resolution("docker exec -it web python manage.py migrate", "docker exec -it web ls"), "unknown");
  assert.equal(resolution("docker compose exec web pytest", "docker compose exec web ls"), "unknown");
  assert.equal(resolution("docker run --rm -v $PWD:/app img pytest", "docker run --rm -v $PWD:/app img ls"), "unknown");
  assert.equal(resolution("kubectl exec pod -- pytest", "kubectl exec pod -- ls"), "unknown");
  assert.equal(resolution("timeout 60 npm test", "timeout 60 npm run build"), "unknown");
  assert.equal(resolution("timeout 60 npm test", "timeout 120 npm test"), "corrected");
});

test("comparing commands stays fast on long sessions of long commands", () => {
  const long = `python3 -c '${"x = 1\n".repeat(10_000)}'`;
  const t = new Transcript();
  for (let i = 0; i < 100; i++) t.call("Bash", { command: `${long}\n# run ${i}` }, { error: "exit code 1" });
  for (let i = 0; i < 24; i++) t.call("Bash", { command: `${long}\n# ok ${i}` }, { ok: "done" });
  const started = performance.now();
  summarizeSession("s1", "main", t.rows);
  assert.ok(performance.now() - started < 2_000, `took ${Math.round(performance.now() - started)} ms`);
});

test("the same command: every argument counts, flags do not", () => {
  const resolution = (failed: unknown, later: unknown) => {
    const t = new Transcript().call("Bash", { command: failed }, { error: "exit code 1" }).call("Bash", { command: later }, { ok: "done" });
    return summarizeSession("s1", "main", t.rows).patterns[0].occurrences[0].resolution;
  };
  assert.equal(resolution("python -m pytest tests/test_a.py", "python -m pytest tests/test_b.py"), "unknown");
  assert.equal(resolution("python3 -m pytest -k test_login", "python3 -m pytest -k test_logout"), "unknown");
  assert.equal(resolution("python -m pytest tests/test_a.py", "python -m pytest tests/test_a.py -x -q"), "corrected");
  assert.equal(resolution("sed -i -e 's/a/b/' a.txt", "sed -i -e 's/a/b/' b.txt"), "unknown");
  assert.equal(resolution("grep -e TODO src/a.ts", "grep -e TODO src/b.ts"), "unknown");
  assert.equal(resolution("gcc -c -o out.o a.c", "gcc -c -o out.o b.c"), "unknown");
  assert.equal(resolution("git -c core.editor=true rebase --continue", "git -c core.editor=true status"), "unknown");
  assert.equal(resolution("git push origin main", "git push origin feature-x"), "unknown");
  assert.equal(resolution("pytest tests/unit/test_api.py", "pytest tests/integration/test_api.py"), "unknown");
  assert.equal(resolution("curl -sf http://localhost:3000/health", "curl -sf http://localhost:8080/health"), "unknown");
  assert.equal(resolution("curl -s http://localhost:3000/health", "curl -s -f http://localhost:3000/health"), "corrected");
});

test("the same command: a value written into a flag counts", () => {
  const resolution = (failed: unknown, later: unknown) => {
    const t = new Transcript().call("Bash", { command: failed }, { error: "exit code 1" }).call("Bash", { command: later }, { ok: "done" });
    return summarizeSession("s1", "main", t.rows).patterns[0].occurrences[0].resolution;
  };
  assert.equal(resolution("go test -run=TestLogin ./...", "go test -run=TestLogout ./..."), "unknown");
  assert.equal(resolution("npm run build --workspace=packages/api", "npm run build --workspace=packages/web"), "unknown");
  assert.equal(resolution("python train.py --config=a.yaml", "python train.py --config=b.yaml"), "unknown");
  assert.equal(resolution("terraform plan -var-file=prod.tfvars", "terraform plan -var-file=dev.tfvars"), "unknown");
  assert.equal(resolution("go test -run=TestLogin ./...", "go test -v -run=TestLogin ./..."), "corrected");
});

test("the same command: input redirections count, 2>&1 does not, quoted words are arguments", () => {
  const resolution = (failed: unknown, later: unknown) => {
    const t = new Transcript().call("Bash", { command: failed }, { error: "exit code 1" }).call("Bash", { command: later }, { ok: "done" });
    return summarizeSession("s1", "main", t.rows).patterns[0].occurrences[0].resolution;
  };
  assert.equal(resolution("psql -d app < migrations/001.sql", "psql -d app < migrations/002.sql"), "unknown");
  assert.equal(resolution("sqlite3 app.db <a.sql", "sqlite3 app.db <b.sql"), "unknown");
  assert.equal(resolution("python3 script.py < in1.txt", "python3 script.py < in2.txt"), "unknown");
  assert.equal(resolution("psql -d app < a.sql", "psql -d app < a.sql 2>&1"), "corrected");
  assert.equal(resolution("npm test > out.log", "npm test > other.log"), "unknown");
  assert.equal(resolution("npm test 2>&1", "npm test"), "corrected");
  assert.equal(resolution("npm test 2>/dev/null", "npm test > /dev/null"), "corrected");
  assert.equal(resolution('rg -n "<Button" src', 'rg -n "<Modal" src'), "unknown");
  assert.equal(resolution('grep ">" a.txt', 'grep ">" b.txt'), "unknown");
  assert.equal(resolution("echo 'a | b'", "echo 'a | c'"), "unknown");
  assert.equal(resolution(["rg", "<Button", "src"], ["rg", "<Modal", "src"]), "unknown");
  assert.equal(resolution('bash -c "npm test"', "bash -c 'npm test'"), "corrected");
});

test("the same command: where it writes, what a heredoc feeds and glued values count", () => {
  const resolution = (failed: unknown, later: unknown) => {
    const t = new Transcript().call("Bash", { command: failed }, { error: "exit code 1" }).call("Bash", { command: later }, { ok: "done" });
    return summarizeSession("s1", "main", t.rows).patterns[0].occurrences[0].resolution;
  };
  assert.equal(resolution("cat > /etc/app/conf.yaml <<'EOF'\na: 1\nEOF", "cat > /tmp/notes.md <<'EOF'\na: 1\nEOF"), "unknown");
  assert.equal(resolution("echo hello > /root/a.txt", "echo hello > /tmp/b.txt"), "unknown");
  assert.equal(resolution("echo hello >/root/a.txt", "echo hello >/tmp/b.txt"), "unknown");
  assert.equal(resolution("kubectl apply -f - <<EOF\nkind: Deployment\nEOF", "kubectl apply -f - <<EOF\nkind: Service\nEOF"), "unknown");
  assert.equal(resolution("git apply <<'EOF'\n--- a/x\nEOF", "git apply <<'EOF'\n--- a/y\nEOF"), "unknown");
  assert.equal(resolution("curl -XDELETE http://x/api/1", "curl -XGET http://x/api/1"), "unknown");
  assert.equal(resolution("curl -XDELETE http://x/api/1", "curl -v -XDELETE http://x/api/1"), "corrected");
});
