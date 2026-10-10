import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * One training process per directory, enforced by the filesystem rather than by anyone's memory of what is running.
 *
 * The state file's pid and the manager's in-memory child handle only describe *this* app. Two apps (or an app and a
 * command-line `npm run train`) pointed at one directory would both look at "no run active" and then both write
 * `state.json`, the experience log and the checkpoints. The lock is created with exclusive-create semantics, so
 * exactly one process can hold it; a lock left by a process that no longer exists is recognised as stale and replaced.
 * Evaluation takes the same lock because it also writes into the directory.
 */

export const TRAINING_LOCK_FILE = "training.lock";

export type TrainingLockKind = "train" | "evaluate";

export interface TrainingLockHolder {
  readonly pid: number;
  readonly kind: TrainingLockKind;
  readonly startedAt: string;
  /** Whether the holding process still exists. A dead holder's lock is stale and gets replaced. */
  readonly alive: boolean;
}

export class TrainingLockError extends Error {
  readonly code = "TRAINING_DIRECTORY_LOCKED";
  constructor(
    readonly holder: TrainingLockHolder,
    readonly lockPath: string,
  ) {
    super(
      `This training directory is already in use by a ${holder.kind === "train" ? "training run" : "checkpoint evaluation"} (process ${holder.pid}, started ${holder.startedAt}). ` +
        `Wait for it to finish or stop it first. If you are certain nothing is running, delete the file '${TRAINING_LOCK_FILE}' in the training directory.`,
    );
    this.name = "TrainingLockError";
  }
}

export interface TrainingLock {
  readonly path: string;
  /** Removes the lock if this process still owns it. Safe to call repeatedly. */
  release(): void;
}

export interface LockEnvironment {
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads the lock file without taking it; null when there is none or it is unreadable. */
export function readTrainingLock(root: string, environment: LockEnvironment = {}): TrainingLockHolder | null {
  const lockPath = join(root, TRAINING_LOCK_FILE);
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; kind?: unknown; startedAt?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
    const isAlive = environment.isAlive ?? processExists;
    return {
      pid: parsed.pid,
      kind: parsed.kind === "evaluate" ? "evaluate" : "train",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "an unknown time",
      alive: isAlive(parsed.pid),
    };
  } catch {
    // A torn or garbled lock cannot be attributed to a live process; treat it as stale so it cannot wedge the directory.
    return { pid: -1, kind: "train", startedAt: "an unknown time", alive: false };
  }
}

/**
 * Takes the lock or throws `TrainingLockError` naming the holder. A stale lock (its process is gone) is removed and the
 * attempt is retried once; if another process wins that retry, it is the holder and the error says so.
 */
export function acquireTrainingLock(root: string, kind: TrainingLockKind, environment: LockEnvironment = {}): TrainingLock {
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, TRAINING_LOCK_FILE);
  const pid = environment.pid ?? process.pid;
  const startedAt = (environment.now?.() ?? new Date()).toISOString();
  const body = `${JSON.stringify({ pid, kind, startedAt })}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx");
      try {
        writeSync(descriptor, body);
      } finally {
        closeSync(descriptor);
      }
      let released = false;
      return {
        path: lockPath,
        release: () => {
          if (released) return;
          released = true;
          const current = readTrainingLock(root, environment);
          // Only remove a lock that is still ours: never one a later process created after ours was judged stale.
          if (current && current.pid === pid) rmSync(lockPath, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readTrainingLock(root, environment);
      if (holder && holder.alive && holder.pid !== pid) throw new TrainingLockError(holder, lockPath);
      if (holder && holder.alive && holder.pid === pid) {
        // The same process asking twice is a programming error, not a stale file.
        throw new TrainingLockError(holder, lockPath);
      }
      rmSync(lockPath, { force: true });
    }
  }
  const holder = readTrainingLock(root, environment) ?? { pid: -1, kind, startedAt: "an unknown time", alive: true };
  throw new TrainingLockError(holder, lockPath);
}
