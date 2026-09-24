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
