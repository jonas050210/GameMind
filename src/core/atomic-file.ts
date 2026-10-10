import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Atomic file replacement that is safe when several callers write the same file at once.
 *
 * "Write a temp file, then rename it over the target" survives a crash, but with a fixed temp name (`state.json.<pid>.tmp`)
 * two writers in one process share the temp file: the first rename moves it away and the second fails with ENOENT, or worse,
 * one writer renames the other's half-written bytes. Two things fix that here: every write gets its own temp name, and
 * writes to the same target are applied one after another in the order they were requested, so an older snapshot can never
 * land after a newer one.
 */
let sequence = 0;
const queues = new Map<string, Promise<void>>();

/** A temp path beside `target` that no other write in this process or another one will use. */
export function temporaryPathFor(target: string): string {
  sequence += 1;
  return `${target}.${process.pid}.${sequence}.tmp`;
}

export interface AtomicWriteOptions {
  /** File mode for the new file (for example 0o600 for data that should not be world-readable). */
  readonly mode?: number;
}

/** Replaces `target` with `contents`. Resolves once this write (and every earlier one for the same file) is on disk. */
export function writeFileAtomic(target: string, contents: string, options: AtomicWriteOptions = {}): Promise<void> {
  const key = path.resolve(target);
  const previous = queues.get(key) ?? Promise.resolve();
  const operation = previous.then(async () => {
    await mkdir(path.dirname(key), { recursive: true });
    const temporary = temporaryPathFor(key);
    try {
      await writeFile(temporary, contents, { encoding: "utf8", ...(options.mode === undefined ? {} : { mode: options.mode }) });
      await rename(temporary, key);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  // The queue keeps going after a failed write; the caller still sees the failure through `operation`.
  const settled = operation.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return operation;
}
