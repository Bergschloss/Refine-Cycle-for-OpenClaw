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
 *   candidates/<id>.json      what was decided for a session, and why
 *   lessons/<id>.json         draft / active / disabled / deleted
 *   journal/<id>.json         intent before every lesson change, marked after
 *   budget/<YYYY-MM-DD>.json  model calls spent that day
 *   effects/<id>.json         which lessons a session was shown, and whether the failure came back
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const SCHEMA_VERSION = 1;

export class StoreError extends Error {}

/** A lock older than this is from a process that died holding it. */
const STALE_LOCK_MS = 30_000;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

export interface StoreOptions {
  /** Test seam: called before every write with the record's relative path; throwing simulates a crash there. */
  beforeWrite?: (relative: string) => void;
}

export class FileStore {
  readonly root: string;
  private readonly beforeWrite?: (relative: string) => void;

  constructor(root: string, options: StoreOptions = {}) {
    this.root = root;
    this.beforeWrite = options.beforeWrite;
  }

  /** Create the directory and meta record, or confirm an existing one is ours. Throws StoreError if not usable. */
  open(): void {
    try {
      fs.mkdirSync(this.root, { recursive: true });
    } catch (error) {
      throw new StoreError(`cannot create ${this.root}: ${String(error)}`);
    }
    const meta = this.read<{ schema: number }>("meta.json");
    if (meta === undefined) {
      if (fs.existsSync(path.join(this.root, "meta.json"))) throw new StoreError("meta.json is unreadable");
      this.write("meta.json", { schema: SCHEMA_VERSION, createdAt: new Date().toISOString() });
      return;
    }
    if (meta.schema !== SCHEMA_VERSION) throw new StoreError(`store schema ${meta.schema} is not ${SCHEMA_VERSION}`);
  }

  /** The record, or undefined when it is missing, torn, or of another version. */
  read<T>(relative: string): (T & { $v: number }) | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.root, relative), "utf8");
    } catch {
      return undefined;
    }
    try {
      const value = JSON.parse(raw);
      if (typeof value !== "object" || value === null || value.$v !== SCHEMA_VERSION) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  write(relative: string, value: object): void {
    this.beforeWrite?.(relative);
    const target = path.join(this.root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const body = JSON.stringify({ ...value, $v: SCHEMA_VERSION }, null, 1);
    const fd = fs.openSync(temp, "w");
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
  }

  /**
   * An exclusive lock across processes (the gateway, a CLI run, a replay into the
   * same store) for a read-modify-write. Returns the release function; throws
   * StoreError when another holder keeps it past `timeoutMs`. With `timeoutMs` 0 it
   * makes one attempt and never waits: that is what code on the gateway thread uses.
   */
  lock(name: string, timeoutMs = 5_000): () => void {
    fs.mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, `${name}.lock`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
        const fd = fs.openSync(file, "wx");
        fs.writeSync(fd, token);
        fs.closeSync(fd);
        return () => {
          // Only the holder removes it: a holder that outlived the stale limit must not
          // delete the lock a later process took over.
          try {
            if (fs.readFileSync(file, "utf8") === token) fs.unlinkSync(file);
          } catch {
            // already gone
          }
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw new StoreError(`cannot take lock ${name}: ${code ?? String(error)}`);
      }
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(file).mtimeMs > STALE_LOCK_MS;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // released between our two calls
      }
      if (stale && this.takeOver(file)) continue;
      if (timeoutMs <= 0 || Date.now() > deadline) throw new StoreError(`store is locked: ${name}`);
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
  private takeOver(file: string): boolean {
    const guard = `${file}.takeover`;
    try {
      fs.closeSync(fs.openSync(guard, "wx"));
    } catch {
      // A guard left by a waiter that died mid-takeover is cleared like a stale lock.
      // Two waiters clearing the same dead guard at the same instant is the one race
      // left; it needs a crash inside the takeover itself.
      try {
        if (Date.now() - fs.statSync(guard).mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(guard);
          return true;
        }
      } catch {
        // gone already, or cannot be removed
      }
      return false;
    }
    try {
      if (Date.now() - fs.statSync(file).mtimeMs <= STALE_LOCK_MS) return false;
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    } finally {
      try {
        fs.unlinkSync(guard);
      } catch {
        // cannot happen short of a permissions change; the guard goes stale and is cleared
      }
    }
  }

  remove(relative: string): void {
    this.beforeWrite?.(relative);
    try {
      fs.unlinkSync(path.join(this.root, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  exists(relative: string): boolean {
    return fs.existsSync(path.join(this.root, relative));
  }

  /** Names (without `.json`) of the records in a family. */
  list(family: string): string[] {
    try {
      return fs
        .readdirSync(path.join(this.root, family))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5))
        .sort();
    } catch {
      return [];
    }
  }
}

/** A session id or lesson id becomes a file name; anything else in it is replaced. */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "_";
}
