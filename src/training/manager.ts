import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { setPriority } from "node:os";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ControlCenterTraining, ControlCenterTrainingDeltas, ControlCenterTrainingStart, ControlCommandResult } from "../control-center/types.js";
import { DEFAULT_TRAINING_EXPLORATION_RATE, TRAINING_STAGES } from "./curriculum.js";
import { readTrainingLock, type TrainingLockHolder } from "./lock.js";
import { describeTrainingArtifacts } from "./trainer.js";
import type { TrainingEvaluationReport } from "./evaluate.js";
import {
  readTrainingState,
  trainingPaths,
  writeControlCommand,
  type TrainingPaths,
  type TrainingState,
} from "./state.js";

/**
 * Runs training and evaluation as separate processes and reports their state to the Control Center.
 *
 * The agent's observation loop never waits on training: the trainer is a child process with its own event
 * loop, and the only channels between them are the state and control files. The manager reports what those
 * files say and whether the recorded pid is alive; it never invents progress it cannot see.
 */

export interface TrainingManagerOptions {
  readonly root: string;
  /** Overrides the entry point (tests). Defaults to the `cli` module next to this file. */
  readonly entry?: string;
  readonly now?: () => Date;
  /**
   * How the directory is shown to the operator (a project-relative path). The absolute `root` is used only to read
   * and write files and never leaves the process; without this the root is shown as given.
   */
  readonly displayRoot?: string;
}

export type TrainingStartOptions = ControlCenterTrainingStart;

export { DEFAULT_TRAINING_EXPLORATION_RATE };

export interface TrainingPreflight {
  /** Project-relative directory the run would use. */
  readonly directory: string;
  /** What is in the directory right now. */
  readonly existing: {
    readonly hasRun: boolean;
    readonly status: string | null;
    readonly episodes: number;
    readonly stageId: string | null;
    readonly checkpoints: number;
    readonly experienceFiles: number;
    readonly evaluations: number;
    readonly stageIds: readonly string[] | null;
    readonly updatedAt: string | null;
  };
  readonly lock: TrainingLockHolder | null;
  /** True when something in this process or on disk is already running in the directory. */
  readonly busy: boolean;
  readonly resume: { readonly possible: boolean; readonly summary: string };
  readonly fresh: {
    readonly needsConfirmation: boolean;
    /** Exactly what a fresh start moves aside. Nothing is deleted. */
    readonly wouldArchive: readonly string[];
    readonly summary: string;
    readonly consequences: readonly string[];
  };
  readonly warnings: readonly string[];
}

/** Nice value applied to the trainer child process (higher means less CPU priority). */
const TRAINING_NICE = 10;

function isAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tsxLoaderUrl(): string {
  // Resolve the loader from this package, not the working directory: the Control Center can be started from
  // another folder, and a bare "tsx" would then fail to load in the child process.
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  } catch {
    return "tsx";
  }
}

function childPreloadPath(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), `child-preload${extname(here)}`);
}

function childArguments(entry: string): string[] {
  // The preload is TypeScript during development and JavaScript in a compiled build. Load tsx whenever
  // either the preload or the requested entry needs it, then let Node load the actual entry normally.
  const preload = childPreloadPath();
  const needsTsx = extname(preload) === ".ts" || extname(entry) === ".ts";
  return [
    ...(needsTsx ? ["--import", tsxLoaderUrl()] : []),
    "--import",
    pathToFileURL(preload).href,
    entry,
  ];
}

interface ChildRunMetadata {
  readonly logOffset: number;
  readonly terminationMarker: string;
}

/**
 * The training operations the Control Center and the Library use. `TrainingManager` is the implementation for one
 * directory; the app's hub implements the same surface over several directories while allowing one run at a time.
 */
export interface TrainingControl {
  start(options?: TrainingStartOptions): Promise<ControlCommandResult>;
  pause(): Promise<ControlCommandResult>;
  resume(): Promise<ControlCommandResult>;
  stop(): Promise<ControlCommandResult>;
  evaluate(checkpointId?: string): Promise<ControlCommandResult>;
  snapshot(): Promise<ControlCenterTraining>;
  preflight(): Promise<TrainingPreflight>;
  /** Asks any active run to stop and waits (bounded) for its process to exit, killing it if it does not. */
  dispose(): Promise<void>;
}

export class TrainingManager implements TrainingControl {
  private trainer: ChildProcess | null = null;
  private evaluator: ChildProcess | null = null;
  /** Why the most recent trainer failed to start or exited non-zero, when its state file has no error. */
  private launchError: string | null = null;
  private runSequence = 0;
  private readonly runMetadata = new WeakMap<ChildProcess, ChildRunMetadata>();
  private readonly launchFailures = new WeakSet<ChildProcess>();
  private readonly paths: TrainingPaths;

  constructor(private readonly options: TrainingManagerOptions) {
    this.paths = trainingPaths(options.root);
  }

  private get entry(): string {
    if (this.options.entry) return this.options.entry;
    const here = fileURLToPath(import.meta.url);
    return join(dirname(here), `cli${extname(here)}`);
  }

  private spawnCli(args: string[], logFile: string): ChildProcess {
    mkdirSync(dirname(logFile), { recursive: true });
    // The log is shared by every run, so the child's own output starts at this offset. The marker is unique
    // to this child and lets the Windows preload preserve a self-termination signal that Node otherwise
    // reports as the indistinguishable exit code 1.
    const offset = statSync(logFile, { throwIfNoEntry: false })?.size ?? 0;
    const terminationMarker = `${logFile}.${process.pid}.${Date.now()}-${this.runSequence++}.termination`;
    rmSync(terminationMarker, { force: true });
    const fd = openSync(logFile, "a");
    try {
      const child = spawn(process.execPath, [...childArguments(this.entry), ...args], {
        stdio: ["ignore", fd, fd],
        env: { ...process.env, GAMEMIND_TERMINATION_MARKER: terminationMarker },
        cwd: process.cwd(),
      });
      this.runMetadata.set(child, { logOffset: offset, terminationMarker });
      // Training is background work. A lower scheduling priority keeps the live observation and safety loops
      // ahead of it when the machine is busy. Best effort: some platforms refuse the change, and that is fine.
      if (child.pid !== undefined) {
        try {
          setPriority(child.pid, TRAINING_NICE);
        } catch {
          /* the child keeps its default priority */
        }
      }
      return child;
    } catch (error) {
      rmSync(terminationMarker, { force: true });
      throw error;
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Reports what starting here would do, so the Control Center can explain a fresh start *before* it happens. It reads
   * the directory and the lock; it starts nothing and writes nothing.
   */
  async preflight(): Promise<TrainingPreflight> {
    const state = await this.readState();
    const artifacts = await describeTrainingArtifacts(this.paths);
    const lock = readTrainingLock(this.options.root);
    const liveLock = lock && lock.alive ? lock : null;
    const hasRun = state !== null;
    const hasData = hasRun || artifacts.checkpoints > 0 || artifacts.experienceFiles > 0 || artifacts.evaluations > 0;
    const busy = this.isTrainingActive(state) || liveLock !== null || (this.evaluator !== null && this.evaluator.exitCode === null);
    const stage = state ? TRAINING_STAGES[state.stageIndex] ?? null : null;
    const wouldArchive: string[] = [];
    if (hasRun) wouldArchive.push("state.json (progress, stage, budgets)", "control.json");
    if (artifacts.experienceFiles > 0) wouldArchive.push(`experience/ (${artifacts.experienceFiles} file(s) of recorded episodes and policy history)`);
    if (artifacts.checkpoints > 0) wouldArchive.push(`checkpoints/ (${artifacts.checkpoints} checkpoint(s))`);
    if (artifacts.evaluations > 0) wouldArchive.push(`evaluations/ (${artifacts.evaluations} report(s))`);
    const warnings: string[] = [];
    if (liveLock) warnings.push(`Process ${liveLock.pid} holds this directory (${liveLock.kind === "train" ? "training" : "evaluation"}, since ${liveLock.startedAt}); a new run cannot start until it ends.`);
    if (!hasRun && hasData) warnings.push("The directory holds training data but no state file, so it cannot be resumed; a fresh start (which archives the data) or another directory is needed.");
    if (state?.status === "completed") warnings.push("The saved curriculum has completed; resuming has nothing left to do. Start fresh to train again.");
    return {
      directory: this.displayRoot,
      existing: {
        hasRun,
        status: state?.status ?? null,
        episodes: state?.totalEpisodes ?? 0,
        stageId: stage?.id ?? null,
        checkpoints: artifacts.checkpoints,
        experienceFiles: artifacts.experienceFiles,
        evaluations: artifacts.evaluations,
        stageIds: state?.stageIds ?? null,
        updatedAt: state?.updatedAt ?? null,
      },
      lock: lock && lock.alive ? lock : null,
      busy,
      resume: {
        possible: hasRun && state?.status !== "completed" && !busy,
        summary: !hasRun
          ? "There is no saved run here, so starting begins a new one at episode 0."
          : state?.status === "completed"
            ? "The saved run already finished its curriculum."
            : `Resume continues the saved run from episode ${state?.totalEpisodes ?? 0}${stage ? ` in stage '${stage.id}'` : ""}, keeping all experience and checkpoints, and adds to them.`,
      },
      fresh: {
        needsConfirmation: hasData,
        wouldArchive,
        summary: hasData
          ? `A fresh start moves everything listed here into ${this.displayRoot}/archive/<timestamp>-before-fresh, then begins at episode 0 with an empty policy.`
          : "Nothing exists here yet, so a fresh start and a resume are the same.",
        consequences: hasData
          ? [
              "The current run's progress, experience and checkpoints are archived, not deleted; they can be restored by moving the archive folder back.",
              "Training restarts at episode 0 and the learned policy starts empty, so its first checkpoints will hold no learned weights until enough verified attempts accumulate.",
              "Evaluations of the old checkpoints stay in the archive and are no longer listed here.",
              "The live policy store used by real Minecraft sessions is not touched, and nothing is promoted automatically.",
              "This is offline simulator training; it is not learning in a real Minecraft world.",
            ]
          : ["This is offline simulator training; it is not learning in a real Minecraft world."],
      },
      warnings,
    };
  }

  private get displayRoot(): string {
    return this.options.displayRoot ?? this.options.root;
  }

  /** Starts (or resumes) training in a child process. Refused while a run is already active. */
  async start(options: TrainingStartOptions = {}): Promise<ControlCommandResult> {
    // The values come from the browser, so they are checked here with the same limits as the CLI.
    const limits: [string, number | undefined, number, number][] = [
      ["Episodes per stage", options.episodesPerStage, 1, 200],
      ["Episode budget", options.maxEpisodes, 1, 5000],
      ["Time budget (minutes)", options.maxMinutes, 1, 24 * 60],
    ];
    for (const [label, value, min, max] of limits) {
      if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
        return { ok: false, message: `${label} must be a whole number from ${min} to ${max}.` };
      }
    }
    if (options.explorationRate !== undefined && (!Number.isFinite(options.explorationRate) || options.explorationRate < 0 || options.explorationRate > 1)) {
      return { ok: false, message: "Exploration rate must be a number from 0 to 1." };
    }
    if (options.stageIds !== undefined) {
      const known = new Set(TRAINING_STAGES.map((stage) => stage.id));
      const unknown = options.stageIds.filter((id) => !known.has(id));
      if (options.stageIds.length === 0 || unknown.length > 0) {
        return { ok: false, message: options.stageIds.length === 0 ? "Choose at least one curriculum stage." : `Unknown curriculum stage(s): ${unknown.join(", ")}. Known: ${[...known].join(", ")}.` };
      }
    }
    const current = await readTrainingState(this.paths).catch(() => null);
    if (this.isTrainingActive(current)) {
      return { ok: false, message: "Training is already running; pause or stop it first." };
    }
    const lock = readTrainingLock(this.options.root);
    if (lock && lock.alive) {
      return { ok: false, message: `Another process (${lock.pid}) is using this training directory (${lock.kind === "train" ? "a training run" : "an evaluation"} since ${lock.startedAt}). Wait for it to finish; two runs cannot share a directory.` };
    }
    if (current?.status === "completed" && !options.fresh) {
      return { ok: false, message: "The curriculum has already completed. Start fresh to train again." };
    }
    if (this.evaluator && this.evaluator.exitCode === null) {
      return { ok: false, message: "An evaluation is running; wait for it to finish." };
    }
    if (current && !options.fresh && options.stageIds !== undefined && current.stageIds && current.stageIds.join(",") !== options.stageIds.join(",")) {
      return { ok: false, message: `The saved run uses the stages [${current.stageIds.join(", ")}]. A run can only be resumed with its own stages; start fresh to change them.` };
    }
    if (options.fresh) {
      // A fresh start moves the current run aside. That is recoverable (nothing is deleted) but it is never silent:
      // the caller must have shown the consequences and say so explicitly.
      const artifacts = await describeTrainingArtifacts(this.paths);
      const hasData = current !== null || artifacts.checkpoints > 0 || artifacts.experienceFiles > 0 || artifacts.evaluations > 0;
      if (hasData && options.confirmFresh !== true) {
        return { ok: false, message: `A fresh start archives the existing run in ${this.displayRoot} (${current?.totalEpisodes ?? 0} episode(s), ${artifacts.checkpoints} checkpoint(s)). Review the consequences and confirm it explicitly; nothing was changed.` };
      }
    }
    const args = ["train", "--dir", this.options.root];
    if (options.episodesPerStage !== undefined) args.push("--episodes-per-stage", String(options.episodesPerStage));
    if (options.maxEpisodes !== undefined) args.push("--max-episodes", String(options.maxEpisodes));
    if (options.maxMinutes !== undefined) args.push("--max-minutes", String(options.maxMinutes));
    if (options.fresh) args.push("--fresh");
    // A resumed run keeps the rate it was collecting experience with; a fresh one starts from the default.
    args.push("--explore", String(options.explorationRate ?? (options.fresh ? undefined : current?.explorationRate) ?? DEFAULT_TRAINING_EXPLORATION_RATE));
    if (options.stageIds !== undefined) args.push("--stages", options.stageIds.join(","));
    await writeControlCommand(this.paths, "run");
    this.launchError = null;
    const child = this.spawnCli(args, this.paths.log);
    this.trainer = child;
    child.on("exit", () => {
      if (this.trainer === child) this.trainer = null;
    });
    // `close` follows `exit` after the child's stdio handles are closed. Reading the shared log here avoids
    // racing a final Windows file write while still scoping the excerpt to this child's starting offset.
    child.on("close", (code, signal) => {
      if (!this.launchFailures.has(child)) void this.noteUnexpectedExit(child, code, signal);
      else this.discardRunMetadata(child);
    });
    child.on("error", (error) => {
      if (this.trainer === child) this.trainer = null;
      this.launchFailures.add(child);
      this.discardRunMetadata(child);
      this.launchError = `The training process could not start: ${error.message}`;
    });
    return {
      ok: true,
      message: options.fresh
        ? "Training started from scratch in a separate process."
        : current
          ? "Training resumed from the saved state in a separate process."
          : "Training started in a separate process.",
    };
  }

  async pause(): Promise<ControlCommandResult> {
    if (!this.isTrainingActive(await this.readState())) return { ok: false, message: "No training run is active." };
    await writeControlCommand(this.paths, "pause");
    return { ok: true, message: "Training will pause after the current episode." };
  }

  async resume(): Promise<ControlCommandResult> {
    const state = await this.readState();
    if (state?.status === "paused" && this.isTrainingActive(state)) {
      await writeControlCommand(this.paths, "run");
      return { ok: true, message: "Training resumed." };
    }
    // A paused run whose process has ended is resumed by starting it again from the saved state.
    if (state?.status === "paused") return this.start();
    return { ok: false, message: "Training is not paused." };
  }

  async stop(): Promise<ControlCommandResult> {
    const state = await this.readState();
    if (!this.isTrainingActive(state)) return { ok: false, message: "No training run is active." };
    await writeControlCommand(this.paths, "stop");
    return { ok: true, message: "Training will stop after the current episode and keep a checkpoint." };
  }

  /** Scores the latest (or a named) checkpoint against the baseline on held-out seeds. */
  async evaluate(checkpointId?: string): Promise<ControlCommandResult> {
    const state = await this.readState();
    if (this.isTrainingActive(state)) return { ok: false, message: "Pause or stop training before evaluating." };
    if (this.evaluator && this.evaluator.exitCode === null) return { ok: false, message: "An evaluation is already running." };
    if (!state || state.checkpoints.length === 0) return { ok: false, message: "No checkpoint to evaluate yet; train first." };
    const lock = readTrainingLock(this.options.root);
    if (lock && lock.alive) return { ok: false, message: `Process ${lock.pid} is using this training directory; wait for it to finish before evaluating.` };
    const args = ["evaluate", "--dir", this.options.root];
    if (checkpointId) args.push("--checkpoint", checkpointId);
    const child = this.spawnCli(args, this.paths.log);
    this.evaluator = child;
    child.on("close", () => {
      if (this.evaluator === child) this.evaluator = null;
      this.discardRunMetadata(child);
    });
    return { ok: true, message: "Evaluation started; the verdict appears here when it finishes." };
  }

  /**
   * Asks an active trainer to stop after its current episode, then waits for its process to exit. A trainer that has not
   * exited within the grace period is terminated, so closing the app never leaves a training or evaluation child behind.
   */
  async dispose(graceMs = 8_000): Promise<void> {
    const state = await this.readState();
    if (this.isTrainingActive(state)) await writeControlCommand(this.paths, "stop");
    await Promise.all([this.reap(this.trainer, graceMs), this.reap(this.evaluator, graceMs)]);
  }

  private async reap(child: ChildProcess | null, graceMs: number): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(grace);
        clearTimeout(hard);
        resolve();
      };
      child.once("exit", done);
      const grace = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }, graceMs);
      const hard = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, graceMs + 4_000);
      grace.unref();
      hard.unref();
    });
  }

  private async readState(): Promise<TrainingState | null> {
    try {
      return await readTrainingState(this.paths);
    } catch {
      return null;
    }
  }

  private isTrainingActive(state: TrainingState | null): boolean {
    if (!state) return false;
    if (state.status !== "running" && state.status !== "paused") return false;
    return isAlive(state.pid) || (this.trainer !== null && this.trainer.exitCode === null);
  }

  /**
   * A trainer that exits non-zero is reported with the last lines of its own log, so a crash at start-up
   * is never shown as "idle". A stop or pause the operator asked for is not an error and is not recorded.
   */
  private discardRunMetadata(child: ChildProcess): void {
    const metadata = this.runMetadata.get(child);
    this.runMetadata.delete(child);
    if (metadata) rmSync(metadata.terminationMarker, { force: true });
  }

  private async noteUnexpectedExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const metadata = this.runMetadata.get(child);
    this.runMetadata.delete(child);
    try {
      // Stop and pause are cooperative (a control file), so an operator stop exits 0 and is not recorded here.
      if (code === 0) return;

      // Only lines written by this child. A killed process writes no final line, so an unscoped tail would show an earlier run.
      const [tail, recordedSignal] = await Promise.all([
        metadata
          ? readFile(this.paths.log)
              .then((bytes) => bytes.subarray(metadata.logOffset).toString("utf8").split("\n").filter((line) => line.trim() !== "").slice(-3).join(" | "))
              .catch(() => "")
          : Promise.resolve(""),
        metadata
          ? readFile(metadata.terminationMarker, "utf8")
              .then((value) => value.trim().split("\n")[0] === "SIGKILL" ? "SIGKILL" as const : null)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      // On Windows Node maps a JavaScript self-SIGKILL to exit code 1 and signal null. The preload's marker
      // recovers the signal without treating every genuine exit code 1 as a kill. Keep the raw code in the
      // message too, since Windows has no general way to distinguish an external TerminateProcess call.
      const effectiveSignal = signal ?? recordedSignal;
      const windowsCode = recordedSignal && signal === null && code !== null ? ` (Windows reported exit code ${code})` : "";
      const reason = effectiveSignal ? `signal ${effectiveSignal}${windowsCode}` : `exit code ${code}`;
      this.launchError = `The training process stopped with ${reason}.${tail ? ` Last log lines: ${tail.slice(0, 600)}` : ""}`;
    } finally {
      if (metadata) rmSync(metadata.terminationMarker, { force: true });
    }
  }

  async snapshot(): Promise<ControlCenterTraining> {
    const state = await this.readState();
    const processAlive = state ? this.isTrainingActive(state) : false;
    const evaluating = this.evaluator !== null && this.evaluator.exitCode === null;
    let status: ControlCenterTraining["status"] = "idle";
    if (state) {
      if (evaluating) status = "evaluating";
      else if ((state.status === "running" || state.status === "paused") && !processAlive) status = "interrupted";
      else status = state.status;
    }
    const stage = state ? TRAINING_STAGES[state.stageIndex] ?? null : null;
    const recent = state?.recent ?? [];
    const rewards = recent.map((entry) => entry.reward).filter((value): value is number => value !== null);
    const lastEvaluation = state?.lastEvaluation ?? null;
    const deltas = lastEvaluation ? await this.readDeltas(lastEvaluation.reportPath) : null;
    return {
      status,
      processAlive,
      pid: state && processAlive ? state.pid : null,
      root: this.displayRoot,
      episodesTotal: state?.totalEpisodes ?? 0,
      episodeBudget: state?.maxEpisodes ?? 0,
      episodesPerStage: state?.episodesPerStage ?? null,
      stage: state && stage
        ? {
            index: state.stageIndex,
            total: TRAINING_STAGES.length,
            id: stage.id,
            label: stage.label,
            episodes: state.stageEpisodes,
            successRate: state.stageEpisodes === 0 ? null : state.stageSuccesses / state.stageEpisodes,
            passRate: stage.passRate,
          }
        : null,
      recentSuccessRate: recent.length === 0 ? null : recent.filter((entry) => entry.success).length / recent.length,
      recentMeanReward: rewards.length === 0 ? null : rewards.reduce((sum, value) => sum + value, 0) / rewards.length,
      recentEpisodes: recent.slice(0, 12).map((entry) => ({
        index: entry.index,
        stageId: entry.stageId,
        scenarioId: entry.scenarioId,
        seed: entry.seed,
        success: entry.success,
        status: entry.status,
        failureCode: entry.failureCode,
        actions: entry.actions,
        wastedActions: entry.wastedActions,
        simulatedSeconds: entry.simulatedSeconds,
        reward: entry.reward,
        at: entry.at,
      })),
      checkpoints: (state?.checkpoints ?? []).slice(-6).reverse().map((entry) => ({
        id: entry.id,
        stageId: entry.stageId,
        createdAt: entry.createdAt,
        episodes: entry.episodes,
        weightedContexts: entry.weightedContexts,
        evaluable: entry.weightedContexts > 0,
      })),
      lastEvaluation: lastEvaluation
        ? {
            checkpointId: lastEvaluation.checkpointId,
            generatedAt: lastEvaluation.generatedAt,
            verdict: lastEvaluation.verdict,
            successRate: lastEvaluation.successRate,
            deltas,
            reasons: lastEvaluation.reasons,
            conclusion: lastEvaluation.conclusion ?? null,
            learnedContexts: lastEvaluation.learnedContexts ?? null,
            behaviourChangedRuns: lastEvaluation.behaviourChangedRuns ?? null,
            pairedRuns: lastEvaluation.pairedRuns ?? null,
          }
        : null,
      availableStages: TRAINING_STAGES.map((entry) => ({ id: entry.id, label: entry.label, scenarioCount: entry.scenarioIds.length, minEpisodes: entry.minEpisodes })),
      stageIds: state?.stageIds ?? null,
      explorationRate: state?.explorationRate ?? null,
      defaultExplorationRate: DEFAULT_TRAINING_EXPLORATION_RATE,
      lock: (() => {
        const holder = readTrainingLock(this.options.root);
        return holder && holder.alive ? { pid: holder.pid, kind: holder.kind, startedAt: holder.startedAt, alive: holder.alive } : null;
      })(),
      lastError: state?.lastError ?? this.launchError,
      updatedAt: state?.updatedAt ?? null,
      note: "Offline simulator training only: it is not learning in a real Minecraft world. Checkpoints are measured on held-out seeds and are never promoted automatically.",
      execution: "offline-simulator",
      render: "none",
      maxMinutes: state?.maxMinutes ?? null,
      activeSeconds: Math.round((state?.activeMs ?? 0) / 100) / 10,
      episodesPerMinute:
        state && state.activeMs > 0 ? Math.round((state.totalEpisodes / (state.activeMs / 60_000)) * 10) / 10 : null,
      rewardTrend: [...(state?.recent ?? [])].reverse().map((entry) => entry.reward),
      stopReason: state?.stopReason ?? null,
    };
  }

  /**
   * The newest checkpoint evaluation reports in this directory, newest first. Reports are the files the evaluator wrote;
   * unreadable or foreign files are skipped, and nothing is recomputed here.
   */
  async evaluationReports(limit = 8): Promise<TrainingEvaluationReport[]> {
    let names: string[] = [];
    try {
      const { readdir } = await import("node:fs/promises");
      names = (await readdir(this.paths.evaluations)).filter((name) => name.startsWith("ckpt-") && name.endsWith(".json"));
    } catch {
      return [];
    }
    names.sort().reverse();
    const reports: TrainingEvaluationReport[] = [];
    for (const name of names.slice(0, Math.max(1, limit))) {
      try {
        const parsed = JSON.parse(await readFile(join(this.paths.evaluations, name), "utf8")) as TrainingEvaluationReport;
        if (parsed && parsed.schemaVersion === 1 && typeof parsed.checkpointId === "string") reports.push(parsed);
      } catch {
        // a torn or foreign file is not a report
      }
    }
    return reports;
  }

  private async readDeltas(reportPath: string): Promise<ControlCenterTrainingDeltas | null> {
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8")) as { deltas?: ControlCenterTrainingDeltas };
      return report.deltas ?? null;
    } catch {
      return null;
    }
  }
}
