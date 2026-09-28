/**
 * The plugin's own durable state: JSON files under its data directory, each
 * written atomically (temp file, fsync, rename) and each carrying `$v`.
 *
 * OpenClaw's keyed store is only open to bundled or trusted-official plugins, so
 * a ClawHub plugin keeps its own files. A record that cannot be read is skipped,
 * never fatal: a torn file from a crash must not stop the plugin for good.
 *
 *   meta.json                 schema version
 *   sessions/<id>.json        a session's failure summary (the `failures` family)
 *   folded/<agent>.json       the summaries pruned by age or count, folded: each session's failure counts and the sum per failure
 *   raw/<YYYY-MM-DD>.jsonl    with `rawLog` on: one line per pass and per lesson withdrawal (docs/proof/RAW-FORMAT.md)
 *   candidates/<id>.json      what was decided for a session, and why
 *   lessons/<id>.json         draft / active / disabled / deleted
 *   journal/<id>.json         intent before every lesson change, marked after
 *   budget/<YYYY-MM-DD>.json  model calls spent that day
 *   effects/<id>.json         which lessons a session was shown, and whether the failure came back
 *   deferred/<id>.json        a validated lesson the lock kept from being applied, retried next run
 *   proposed/<agent>--<fp>.json  a failure sent to the model: written with the budget reservation, completed with the answer
 *   ledger/<lesson>.json      per lesson, per session it was shown in: did its failure come back after (the audit)
 *   ledger-pending/<id>.json  a session whose effect waits for the ledger lock
 *   verdicts/<lesson>.json    the audit's last verdict for a lesson, and when
 *   ledger-built.json         the ledger was built once from the effect records an older version left
 *   backfill/<agent>.json     when that agent's recent sessions were last re-read
 *   replay-result.json        the output of `openclaw refine-cycle replay`, in a replay's own store
 *   <name>.lock               a cross-process lock; <name>.lock.takeover while a stale one is removed
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
export const SCHEMA_VERSION = 1;
export class StoreError extends Error {
}
/** A lock older than this is from a process that died holding it. */
const STALE_LOCK_MS = 30_000;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
export class FileStore {
    root;
    beforeWrite;
    /** Set by `open()` when it found meta.json torn, set it aside under this name and wrote a new one. */
    repairedMeta;
    constructor(root, options = {}) {
        this.root = root;
        this.beforeWrite = options.beforeWrite;
    }
    /** Create the directory and meta record, or confirm an existing one is ours. Throws StoreError if not usable. */
    open() {
        try {
            fs.mkdirSync(this.root, { recursive: true });
        }
        catch (error) {
            throw new StoreError(`cannot create ${this.root}: ${String(error)}`);
        }
        const file = path.join(this.root, "meta.json");
        let raw;
        try {
            raw = fs.readFileSync(file, "utf8");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw new StoreError(`cannot read meta.json: ${String(error)}`);
        }
        let meta = null;
        if (raw !== undefined) {
            try {
                const parsed = JSON.parse(raw);
                if (typeof parsed === "object" && parsed !== null)
                    meta = parsed;
            }
            catch {
                // torn: handled below
            }
        }
        if (meta && (typeof meta.schema === "number" || typeof meta.$v === "number")) {
            // A store another version wrote is not this version's to read or to rewrite.
            if (meta.schema !== SCHEMA_VERSION || meta.$v !== SCHEMA_VERSION) {
                throw new StoreError(`store schema ${String(meta.schema ?? meta.$v)} is not ${SCHEMA_VERSION}`);
            }
            return;
        }
        if (raw !== undefined) {
            // Torn or emptied by a crash or a full disk: it records nothing but the schema, so it
            // is set aside (kept for inspection) and written again instead of disabling the plugin.
            const aside = `meta.json.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
            try {
                fs.renameSync(file, path.join(this.root, aside));
            }
            catch (error) {
                throw new StoreError(`meta.json is unreadable and cannot be set aside: ${String(error)}`);
            }
            this.repairedMeta = aside;
        }
        this.write("meta.json", { schema: SCHEMA_VERSION, createdAt: new Date().toISOString() });
    }
    /** The record, or undefined when it is missing, torn, or of another version. */
    read(relative) {
        let raw;
        try {
            raw = fs.readFileSync(path.join(this.root, relative), "utf8");
        }
        catch {
            return undefined;
        }
        try {
            const value = JSON.parse(raw);
            if (typeof value !== "object" || value === null || value.$v !== SCHEMA_VERSION)
                return undefined;
            return value;
        }
        catch {
            return undefined;
        }
    }
    write(relative, value) {
        this.beforeWrite?.(relative);
        const target = path.join(this.root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        const body = JSON.stringify({ ...value, $v: SCHEMA_VERSION }, null, 1);
        const fd = fs.openSync(temp, "w");
        try {
            try {
                fs.writeSync(fd, body);
                fs.fsyncSync(fd);
            }
            finally {
                fs.closeSync(fd);
            }
            fs.renameSync(temp, target);
        }
        catch (error) {
            // A write that failed (a full disk, a locked target) leaves no temp file behind.
            fs.rmSync(temp, { force: true });
            throw error;
        }
    }
    /**
     * An exclusive lock across processes (the gateway, a CLI run, a replay into the
     * same store) for a read-modify-write. Returns the release function; throws
     * StoreError when another holder keeps it past `timeoutMs`. With `timeoutMs` 0 it
     * makes one attempt and never waits: that is what code on the gateway thread uses.
     */
    lock(name, timeoutMs = 5_000) {
        fs.mkdirSync(this.root, { recursive: true });
        const file = path.join(this.root, `${name}.lock`);
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            try {
                const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
                const fd = fs.openSync(file, "wx");
                try {
                    fs.writeSync(fd, token);
                }
                catch (error) {
                    // A lock we could not sign (a full disk) is not left behind for 30 s.
                    fs.closeSync(fd);
                    fs.rmSync(file, { force: true });
                    throw error;
                }
                fs.closeSync(fd);
                return () => {
                    // Only the holder removes it: a holder that outlived the stale limit must not
                    // delete the lock a later process took over.
                    try {
                        if (fs.readFileSync(file, "utf8") === token)
                            fs.unlinkSync(file);
                    }
                    catch {
                        // already gone
                    }
                };
            }
            catch (error) {
                const code = error.code;
                if (code !== "EEXIST")
                    throw new StoreError(`cannot take lock ${name}: ${code ?? String(error)}`);
            }
            let stale = false;
            try {
                stale = Date.now() - fs.statSync(file).mtimeMs > STALE_LOCK_MS;
            }
            catch (error) {
                if (error.code === "ENOENT")
                    continue; // released between our two calls
            }
            if (stale && this.takeOver(file))
                continue;
            if (timeoutMs <= 0 || Date.now() > deadline)
                throw new StoreError(`store is locked: ${name}`);
            Atomics.wait(SLEEP, 0, 0, 25);
        }
    }
    /**
     * Remove a stale lock, one waiter at a time: only the waiter that creates the
     * takeover guard may remove it, and only if it is still stale under the guard, so a
     * fresh lock another waiter took meanwhile is not removed. (A holder that went silent
     * past the stale limit and then released at this very instant is the one exception;
     * holds last milliseconds.) False when the lock
     * stays (another waiter is taking over, or it cannot be removed: permissions, a
     * file held open); the caller then waits or gives up, never loops without a pause.
     */
    takeOver(file) {
        const guard = `${file}.takeover`;
        try {
            fs.closeSync(fs.openSync(guard, "wx"));
        }
        catch {
            // A guard left by a waiter that died mid-takeover is cleared like a stale lock.
            // Two waiters clearing the same dead guard at the same instant is the one race
            // left; it needs a crash inside the takeover itself.
            try {
                if (Date.now() - fs.statSync(guard).mtimeMs > STALE_LOCK_MS) {
                    fs.unlinkSync(guard);
                    return true;
                }
            }
            catch {
                // gone already, or cannot be removed
            }
            return false;
        }
        try {
            if (Date.now() - fs.statSync(file).mtimeMs <= STALE_LOCK_MS)
                return false;
            fs.unlinkSync(file);
            return true;
        }
        catch (error) {
            return error.code === "ENOENT";
        }
        finally {
            try {
                fs.unlinkSync(guard);
            }
            catch {
                // cannot happen short of a permissions change; the guard goes stale and is cleared
            }
        }
    }
    /**
     * Append one line to a log file (the raw record). One `write` in append mode, so lines
     * from two processes do not interleave on a local file system; not a JSON record.
     */
    appendLine(relative, line) {
        this.beforeWrite?.(relative);
        const target = path.join(this.root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.appendFileSync(target, `${line}\n`);
    }
    remove(relative) {
        this.beforeWrite?.(relative);
        try {
            fs.unlinkSync(path.join(this.root, relative));
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    exists(relative) {
        return fs.existsSync(path.join(this.root, relative));
    }
    /** Names (without `.json`) of the records in a family. */
    list(family) {
        try {
            return fs
                .readdirSync(path.join(this.root, family))
                .filter((name) => name.endsWith(".json"))
                .map((name) => name.slice(0, -5))
                .sort();
        }
        catch {
            return [];
        }
    }
}
/** A session id or lesson id becomes a file name; anything else in it is replaced. */
export function safeName(id) {
    return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "_";
}
