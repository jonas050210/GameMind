import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../core/atomic-file.js";
import type { AppEventLog } from "./event-log.js";
import { redactText, type RedactionContext } from "./redact.js";

/**
 * Long-running offline work started from the Control Center (unit tests, offline evaluation, live verification)
 * runs as a child process owned by this runner. The rules it enforces are the ones the UI relies on:
 *  - one job at a time: these are CPU-heavy, and two evaluations would write the same report;
 *  - every job can be cancelled, has a hard time limit, and is killed as a process tree so no grandchild survives;
 *  - disposing the runner (app shutdown) kills whatever is still running and waits for it;
 *  - a job's result says where it came from (`offline` or `live`) and that never changes after the fact;
 *  - output is bounded and redacted before it is ever shown.
 */

export type JobKind = "unit-tests" | "offline-eval" | "live-verification";
export type JobSource = "offline" | "live";
export type JobState = "running" | "succeeded" | "failed" | "cancelled" | "timed-out";

export interface TestSummary {
  readonly kind: "tests";
  readonly total: number | null;
  readonly passed: number | null;
  readonly failed: number | null;
  readonly skipped: number | null;
  readonly cancelled: number | null;
  readonly durationMs: number | null;
  readonly failedTests: readonly string[];
  readonly skippedTests: readonly { readonly name: string; readonly reason: string | null }[];
}

export interface EvalJobSummary {
  readonly kind: "eval";
  readonly reportPath: string | null;
}

export interface LiveJobSummary {
  readonly kind: "live";
  readonly reachedServer: boolean | null;
  readonly passed: number | null;
  readonly failed: number | null;
  readonly total: number | null;
  readonly phases: readonly { readonly phase: string; readonly outcome: "passed" | "failed" | "skipped" | "not-run"; readonly reason: string | null }[];
  readonly server: string | null;
}

export type JobSummary = TestSummary | EvalJobSummary | LiveJobSummary;

export interface JobSpec {
  readonly kind: JobKind;
  readonly label: string;
  readonly source: JobSource;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** What the operator sees as the command; already free of secrets and absolute paths. */
  readonly display: string;
  /** Free-form facts shown with the result (seeds, host, phases ...). */
  readonly meta?: Readonly<Record<string, string | number | boolean | null>>;
  /** Builds the structured summary once the process has exited. May read files the job wrote. */
  readonly summarise?: (output: string, exitCode: number | null) => Promise<JobSummary | null> | JobSummary | null;
}

export interface JobView {
  readonly id: string;
  readonly kind: JobKind;
  readonly label: string;
  readonly source: JobSource;
  readonly state: JobState;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly display: string;
  readonly meta: Readonly<Record<string, string | number | boolean | null>>;
  readonly summary: JobSummary | null;
  /** The last lines of combined output, redacted. */
  readonly outputTail: readonly string[];
  readonly error: string | null;
  /** True for a result reloaded from an earlier run of the app. */
  readonly historical: boolean;
}

export type JobStartResult =
  | { readonly ok: true; readonly job: JobView }
  | { readonly ok: false; readonly code: "JOB_ALREADY_RUNNING" | "JOB_SPAWN_FAILED" | "JOB_RUNNER_CLOSED"; readonly message: string };

export interface JobRunnerOptions {
  readonly redaction: RedactionContext;
  readonly events: AppEventLog;
  /** Where the last result of each kind is kept so it survives a restart. */
  readonly historyDirectory?: string | null;
  readonly now?: () => number;
  readonly maxOutputLines?: number;
  readonly killGraceMs?: number;
  /** Test seam: replaces process creation. */
  readonly spawnProcess?: (spec: JobSpec) => ChildProcess;
}

interface RunningJob {
  readonly spec: JobSpec;
  readonly id: string;
  readonly startedMs: number;
  readonly child: ChildProcess;
  readonly lines: string[];
  readonly done: Promise<void>;
  cancelled: boolean;
  timedOut: boolean;
  timer: NodeJS.Timeout | null;
}

const OUTPUT_LINE_LIMIT = 400;

export class JobRunner {
  private readonly now: () => number;
  private readonly maxLines: number;
  private readonly graceMs: number;
  private running: RunningJob | null = null;
  private readonly finished: JobView[] = [];
  private sequence = 0;
  private closed = false;

  constructor(private readonly options: JobRunnerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxLines = Math.max(20, options.maxOutputLines ?? 300);
    this.graceMs = Math.max(50, options.killGraceMs ?? 4_000);
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** Newest first: the running job (if any) then the finished ones. */
  list(): readonly JobView[] {
    return [...(this.running ? [this.viewOf(this.running)] : []), ...this.finished];
  }

  latest(kind: JobKind): JobView | null {
    return this.list().find((job) => job.kind === kind) ?? null;
  }

  /** Reloads the last result of each kind from disk as historical entries. Never throws. */
  async loadHistory(): Promise<number> {
    const directory = this.options.historyDirectory;
    if (!directory) return 0;
    let names: string[] = [];
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    } catch {
      return 0;
    }
    let loaded = 0;
    for (const name of names) {
      try {
        const parsed = JSON.parse(await readFile(path.join(directory, name), "utf8")) as Partial<JobView>;
        if (typeof parsed.id === "string" && typeof parsed.kind === "string" && typeof parsed.state === "string" && typeof parsed.startedAt === "string") {
          this.finished.push({ ...(parsed as JobView), historical: true, outputTail: parsed.outputTail ?? [] });
          loaded += 1;
        }
      } catch {
        // A corrupt history file is ignored; it is only a convenience.
      }
    }
    this.finished.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return loaded;
  }

  start(spec: JobSpec): JobStartResult {
    if (this.closed) return { ok: false, code: "JOB_RUNNER_CLOSED", message: "The app is shutting down and starts no new jobs." };
    if (this.running) {
      return { ok: false, code: "JOB_ALREADY_RUNNING", message: `'${this.running.spec.label}' is still running; wait for it to finish or cancel it first.` };
    }
    let child: ChildProcess;
    try {
      child = this.options.spawnProcess ? this.options.spawnProcess(spec) : defaultSpawn(spec);
    } catch (error) {
      return { ok: false, code: "JOB_SPAWN_FAILED", message: `Could not start '${spec.label}': ${error instanceof Error ? error.message : String(error)}` };
    }
    this.sequence += 1;
    const id = `job-${this.sequence}-${this.now().toString(36)}`;
    const lines: string[] = [];
    const job: RunningJob = {
      spec,
      id,
      startedMs: this.now(),
      child,
      lines,
      cancelled: false,
      timedOut: false,
      timer: null,
      done: Promise.resolve(),
    };
    const collect = (chunk: Buffer | string): void => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.length === 0) continue;
        lines.push(line.length > OUTPUT_LINE_LIMIT ? `${line.slice(0, OUTPUT_LINE_LIMIT)}…` : line);
      }
      if (lines.length > this.maxLines * 4) lines.splice(0, lines.length - this.maxLines * 4);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let spawnError: Error | null = null;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", (error) => {
        spawnError = error;
        resolve({ code: null, signal: null });
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    job.timer = setTimeout(() => {
      job.timedOut = true;
      void killProcessTree(child, this.graceMs);
    }, Math.max(1_000, spec.timeoutMs));
    job.timer.unref();
    (job as { done: Promise<void> }).done = exited.then(async ({ code, signal }) => {
      if (job.timer) clearTimeout(job.timer);
      await this.finish(job, code, signal, spawnError);
    });
    this.running = job;
    this.options.events.record({
      category: "evaluation",
      code: "JOB_STARTED",
      message: `${spec.label} started`,
      source: spec.source === "live" ? "live" : "offline",
      data: { jobId: id, kind: spec.kind, command: spec.display },
    });
    return { ok: true, job: this.viewOf(job) };
  }

  /** Asks the running job to stop. Resolves once it has actually exited. */
  async cancel(id?: string): Promise<boolean> {
    const job = this.running;
    if (!job || (id !== undefined && job.id !== id)) return false;
    job.cancelled = true;
    await killProcessTree(job.child, this.graceMs);
    await job.done;
    return true;
  }

  /** Kills anything still running and waits for it; the runner accepts no further jobs afterwards. */
  async dispose(): Promise<void> {
    this.closed = true;
    const job = this.running;
    if (job) {
      job.cancelled = true;
      await killProcessTree(job.child, this.graceMs);
      await job.done;
    }
  }

  private async finish(job: RunningJob, code: number | null, signal: NodeJS.Signals | null, spawnError: Error | null): Promise<void> {
    const output = job.lines.join("\n");
    const state: JobState = job.cancelled ? "cancelled" : job.timedOut ? "timed-out" : spawnError ? "failed" : code === 0 ? "succeeded" : "failed";
    let summary: JobSummary | null = null;
    try {
      summary = (await job.spec.summarise?.(output, code)) ?? null;
    } catch {
      summary = null;
    }
    const finishedMs = this.now();
    const view: JobView = {
      id: job.id,
      kind: job.spec.kind,
      label: job.spec.label,
      source: job.spec.source,
      state,
      startedAt: new Date(job.startedMs).toISOString(),
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - job.startedMs,
      exitCode: code,
      signal,
      display: job.spec.display,
      meta: job.spec.meta ?? {},
      summary,
      outputTail: this.tail(job.lines),
      error: spawnError ? redactText(spawnError.message, this.options.redaction) : job.timedOut ? `Stopped after the ${Math.round(job.spec.timeoutMs / 1000)} s time limit.` : null,
      historical: false,
    };
    this.running = null;
    this.finished.unshift(view);
    if (this.finished.length > 20) this.finished.length = 20;
    this.options.events.record({
      level: state === "succeeded" ? "info" : state === "cancelled" ? "warn" : "error",
      category: "evaluation",
      code: `JOB_${state.toUpperCase().replace("-", "_")}`,
      message: `${job.spec.label} ${state}${code !== null ? ` (exit ${code})` : ""}`,
      source: job.spec.source === "live" ? "live" : "offline",
      data: { jobId: job.id, kind: job.spec.kind, durationMs: view.durationMs, exitCode: code },
    });
    await this.persist(view);
  }

  private async persist(view: JobView): Promise<void> {
    const directory = this.options.historyDirectory;
    if (!directory) return;
    try {
      const target = path.join(directory, `${view.kind}.json`);
      await writeFileAtomic(target, JSON.stringify({ ...view, outputTail: view.outputTail.slice(-60) }, null, 2));
    } catch {
      // Losing history must never fail a job.
    }
  }

  private tail(lines: readonly string[]): string[] {
    return lines.slice(-this.maxLines).map((line) => redactText(line, this.options.redaction));
  }

  private viewOf(job: RunningJob): JobView {
    return {
      id: job.id,
      kind: job.spec.kind,
      label: job.spec.label,
      source: job.spec.source,
      state: "running",
      startedAt: new Date(job.startedMs).toISOString(),
      finishedAt: null,
      durationMs: this.now() - job.startedMs,
      exitCode: null,
      signal: null,
      display: job.spec.display,
      meta: job.spec.meta ?? {},
      summary: null,
      outputTail: this.tail(job.lines),
      error: null,
      historical: false,
    };
  }
}

function defaultSpawn(spec: JobSpec): ChildProcess {
  return spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env ?? {}), FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    // A new process group on POSIX lets the whole tree be signalled at once; Windows uses taskkill /T instead.
    detached: process.platform !== "win32",
    windowsHide: true,
    shell: false,
  });
}

/** Terminates a child and everything it started. SIGTERM first, SIGKILL after the grace period; resolves when it is gone. */
export function killProcessTree(child: ChildProcess, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(force);
      resolve();
    };
    child.once("close", finish);
    child.once("exit", finish);
    const force = setTimeout(() => {
      signalTree(child, pid, "SIGKILL");
      // Even a SIGKILL that fails to report must not hang a shutdown.
      setTimeout(resolve, 500).unref();
    }, graceMs);
    force.unref();
    signalTree(child, pid, "SIGTERM");
  });
}

function signalTree(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
      return;
    }
    // Negative pid addresses the process group created by `detached: true`.
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Folds Node's TAP output into counts and the names of failing and skipped tests. Counts come from the runner's
 * own trailing summary lines; if the process was killed before printing them they stay null rather than being guessed.
 */
export function parseTapSummary(output: string): TestSummary {
  const counter = (name: string): number | null => {
    const match = new RegExp(`^# ${name} (\\d+(?:\\.\\d+)?)\\s*$`, "m").exec(output);
    return match?.[1] === undefined ? null : Math.round(Number(match[1]));
  };
  const failedTests: string[] = [];
  const skippedTests: { name: string; reason: string | null }[] = [];
  for (const line of output.split("\n")) {
    const failed = /^\s*not ok \d+ - (.+?)\s*$/.exec(line);
    if (failed?.[1] && !/# (?:SKIP|TODO)/.test(failed[1])) {
      const name = failed[1];
      if (!failedTests.includes(name)) failedTests.push(name);
      continue;
    }
    const skipped = /^\s*(?:not )?ok \d+ - (.+?)\s+# SKIP\s*(.*)$/.exec(line);
    if (skipped?.[1]) skippedTests.push({ name: skipped[1], reason: skipped[2] ? skipped[2].trim() : null });
  }
  return {
    kind: "tests",
    total: counter("tests"),
    passed: counter("pass"),
    failed: counter("fail"),
    skipped: counter("skipped"),
    cancelled: counter("cancelled"),
    durationMs: counter("duration_ms"),
    failedTests: failedTests.slice(0, 40),
    skippedTests: skippedTests.slice(0, 40),
  };
}

/** Reads a live-verification report and keeps only what the Control Center shows. */
export async function readLiveReportSummary(reportPath: string): Promise<LiveJobSummary | null> {
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      reachedServer?: boolean;
      passed?: number;
      failed?: number;
      total?: number;
      server?: string;
      phases?: Array<{ phase?: string; passed?: boolean; error?: string | null; notRun?: boolean; skipped?: boolean; notes?: string[] }>;
    };
    return {
      kind: "live",
      reachedServer: typeof report.reachedServer === "boolean" ? report.reachedServer : null,
      passed: typeof report.passed === "number" ? report.passed : null,
      failed: typeof report.failed === "number" ? report.failed : null,
      total: typeof report.total === "number" ? report.total : null,
      server: typeof report.server === "string" ? report.server : null,
      phases: (report.phases ?? []).map((phase) => ({
        phase: String(phase.phase ?? "unknown"),
        outcome: phase.notRun ? "not-run" : phase.skipped ? "skipped" : phase.passed ? "passed" : "failed",
        reason: phase.error ?? (phase.notRun || phase.skipped ? (phase.notes ?? []).join(" ") || null : null),
      })),
    };
  } catch {
    return null;
  }
}
