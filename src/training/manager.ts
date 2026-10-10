import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlCenterTraining, ControlCenterTrainingDeltas, ControlCommandResult } from "../control-center/types.js";
import { TRAINING_STAGES } from "./curriculum.js";
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
}

export interface TrainingStartOptions {
  readonly episodesPerStage?: number;
  readonly maxEpisodes?: number;
  readonly fresh?: boolean;
}

function isAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function childArguments(entry: string): string[] {
  // Under tsx (development) the TypeScript entry needs the loader; the compiled build runs plain JS.
  return extname(entry) === ".ts" ? ["--import", "tsx", entry] : [entry];
}

export class TrainingManager {
  private trainer: ChildProcess | null = null;
  private evaluator: ChildProcess | null = null;
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
    const fd = openSync(logFile, "a");
    try {
      const child = spawn(process.execPath, [...childArguments(this.entry), ...args], {
        stdio: ["ignore", fd, fd],
        env: process.env,
        cwd: process.cwd(),
      });
      return child;
    } finally {
      closeSync(fd);
    }
  }

  /** Starts (or resumes) training in a child process. Refused while a run is already active. */
  async start(options: TrainingStartOptions = {}): Promise<ControlCommandResult> {
    const current = await readTrainingState(this.paths).catch(() => null);
    if (this.isTrainingActive(current)) {
      return { ok: false, message: "Training is already running; pause or stop it first." };
    }
    if (current?.status === "completed" && !options.fresh) {
      return { ok: false, message: "The curriculum has already completed. Start fresh to train again." };
    }
    if (this.evaluator && this.evaluator.exitCode === null) {
      return { ok: false, message: "An evaluation is running; wait for it to finish." };
    }
    const args = ["train", "--dir", this.options.root];
    if (options.episodesPerStage !== undefined) args.push("--episodes-per-stage", String(options.episodesPerStage));
    if (options.maxEpisodes !== undefined) args.push("--max-episodes", String(options.maxEpisodes));
    if (options.fresh) args.push("--fresh");
    await writeControlCommand(this.paths, "run");
    const child = this.spawnCli(args, this.paths.log);
    this.trainer = child;
    child.on("exit", () => {
      if (this.trainer === child) this.trainer = null;
    });
    child.on("error", () => {
      if (this.trainer === child) this.trainer = null;
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
    const args = ["evaluate", "--dir", this.options.root];
    if (checkpointId) args.push("--checkpoint", checkpointId);
    const child = this.spawnCli(args, this.paths.log);
    this.evaluator = child;
    child.on("exit", () => {
      if (this.evaluator === child) this.evaluator = null;
    });
    return { ok: true, message: "Evaluation started; the verdict appears here when it finishes." };
  }

  /** Asks an active trainer to stop after its current episode. The process is not killed mid-episode. */
  async dispose(): Promise<void> {
    const state = await this.readState();
    if (this.isTrainingActive(state)) await writeControlCommand(this.paths, "stop");
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
      root: this.options.root,
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
      })),
      lastEvaluation: lastEvaluation
        ? {
            checkpointId: lastEvaluation.checkpointId,
            generatedAt: lastEvaluation.generatedAt,
            verdict: lastEvaluation.verdict,
            successRate: lastEvaluation.successRate,
            deltas,
            reasons: lastEvaluation.reasons,
          }
        : null,
      lastError: state?.lastError ?? null,
      updatedAt: state?.updatedAt ?? null,
      note: "Training runs on the offline simulator in a separate process. Its checkpoints are measured on held-out seeds and are not promoted automatically.",
    };
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
