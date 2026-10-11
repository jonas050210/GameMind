/**
 * Entry point of one training worker process. The trainer sends one job at a time over IPC and gets the episode result
 * back. Nothing here touches the trainer's directory or its learner; see episode-job.ts for the contract.
 */
import { runEvaluationOnce } from "../testing/eval/harness.js";
import { EpisodeExecutor, type EpisodeCapture, type EpisodeJob } from "./episode-job.js";
import type { CurriculumStage } from "./curriculum.js";

interface JobMessage {
  readonly type: "job";
  readonly job: EpisodeJob;
  readonly sync: { readonly bootstrap: boolean; readonly pending: readonly EpisodeCapture[] };
  readonly stages: readonly CurriculumStage[];
  readonly experienceDirectory: string;
}

type WorkerMessage = JobMessage | { readonly type: "exit" };

if (typeof process.send !== "function") {
  console.error("episode-worker must be started by the training pool.");
  process.exit(2);
}

let executor: EpisodeExecutor | null = null;
let queue: Promise<void> = Promise.resolve();

process.on("message", (raw: WorkerMessage) => {
  if (raw.type === "exit") {
    queue = queue.then(async () => {
      await executor?.close();
      process.exit(0);
    });
    return;
  }
  if (raw.type !== "job") return;
  // Jobs for one worker arrive one at a time; the queue keeps that true even if a message comes early.
  queue = queue.then(async () => {
    executor ??= new EpisodeExecutor({
      stages: raw.stages,
      experienceDirectory: raw.experienceDirectory,
      runner: runEvaluationOnce,
      ...(process.env.GAMEMIND_EPISODE_SCRATCH ? { scratchDir: process.env.GAMEMIND_EPISODE_SCRATCH } : {}),
    });
    try {
      const result = await executor.run(raw.job, raw.sync);
      process.send!({ type: "result", result });
    } catch (error) {
      process.send!({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });
});

// If the trainer goes away, this worker must not keep running on its own.
process.on("disconnect", () => process.exit(0));

process.send({ type: "ready", pid: process.pid });
