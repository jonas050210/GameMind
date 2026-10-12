import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Lock files held by apps in this process, so a second app in the same process is refused too. */
const HELD_LOCKS = new Set<string>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AppAlreadyRunningError extends Error {
  readonly code = "APP_ALREADY_RUNNING";

  constructor(
    readonly url: string | null,
    readonly pid: number,
  ) {
    super(
      `GameMind is already running in this project (process ${pid}${url ? `, Control Center at ${url}` : ""}). ` +
        `${url ? `Open ${url} or ` : ""}stop that process first.`,
    );
    this.name = "AppAlreadyRunningError";
  }
}

/**
 * The lock exists but cannot be understood. Starting anyway could put two bots on one account, so fail closed and
 * ask the operator to inspect it instead of treating it as evidence that the project is free.
 */
export class InstanceLockUnreadableError extends Error {
  readonly code = "INSTANCE_LOCK_UNREADABLE";

  constructor(
    readonly lockFile: string,
    readonly problem: string,
  ) {
    super(
      `Cannot tell whether GameMind is already running in this project: '${lockFile}' exists but could not be read (${problem}). ` +
        "Stop any running GameMind and delete that file, then start again.",
    );
    this.name = "InstanceLockUnreadableError";
  }
}

/**
 * Shared project-instance lock for both the Control Center app and terminal-only sessions. A lock is written before
 * connecting, so choosing not to run the dashboard never weakens the one-bot-per-project guarantee.
 */
export class ProjectInstanceLock {
  private readonly lockFile: string | null;

  constructor(dataDirectory: string, private readonly startedAt: string, enabled = true) {
    this.lockFile = enabled ? path.join(path.resolve(dataDirectory), "run", "gamemind.lock.json") : null;
  }

  acquire(): void {
    const lockFile = this.lockFile;
    if (!lockFile) return;

    let raw: string | null = null;
    try {
      raw = readFileSync(lockFile, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw new InstanceLockUnreadableError(lockFile, errorMessage(error));
    }

    if (raw !== null) {
      let existing: { pid?: unknown; url?: unknown; platform?: unknown } | null = null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && typeof (parsed as { pid?: unknown }).pid === "number") {
          existing = parsed as { pid: number; url?: unknown; platform?: unknown };
        }
      } catch {
        existing = null;
      }
      if (!existing) throw new InstanceLockUnreadableError(lockFile, "it is not the expected JSON object");
      const pid = existing.pid as number;
      const foreign = typeof existing.platform === "string" && existing.platform !== "" && existing.platform !== process.platform;
      if (foreign && pid !== process.pid) {
        throw new InstanceLockUnreadableError(lockFile, `it was written on '${String(existing.platform)}'`);
      }
      const alive = pid === process.pid ? HELD_LOCKS.has(lockFile) : isProcessAlive(pid);
      if (alive) throw new AppAlreadyRunningError(typeof existing.url === "string" ? existing.url : null, pid);
    }

    HELD_LOCKS.add(lockFile);
    try {
      mkdirSync(path.dirname(lockFile), { recursive: true });
      this.writeLock({ pid: process.pid, url: null, startedAt: this.startedAt });
    } catch (error) {
      HELD_LOCKS.delete(lockFile);
      throw error;
    }
  }

  /** Adds the dashboard address after it is listening. Headless locks intentionally keep `url` null. */
  update(url: string, port: number): void {
    if (!this.lockFile) return;
    this.writeLock({ pid: process.pid, url, port, startedAt: this.startedAt });
  }

  release(): void {
    const lockFile = this.lockFile;
    if (!lockFile) return;
    HELD_LOCKS.delete(lockFile);
    try {
      const current = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: number };
      if (current.pid === process.pid) rmSync(lockFile, { force: true });
    } catch {
      // Already gone or unreadable; never delete a lock that no longer belongs to this process.
    }
  }

  private writeLock(body: Record<string, unknown>): void {
    const lockFile = this.lockFile;
    if (!lockFile) return;
    const temporary = `${lockFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...body, platform: process.platform })}\n`, "utf8");
    renameSync(temporary, lockFile);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
