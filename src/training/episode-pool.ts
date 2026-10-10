/**
 * Runs training episodes on several workers. A batch has at most one job per worker and the trainer replays the
 * results in job order, so the persisted learner does not depend on which worker was fast.
 *
 * Each worker keeps its own learner view: the shared episode log up to the previous batch, plus its own episodes. Before
 * a job, the pool sends the captured learner calls the worker has not seen yet (other workers' episodes). A worker that
 * dies is replaced; its replacement rebuilds from the episode log, and the job is retried once. An episode that fails
 * with an error is not retried, because it would fail the same way.
 */
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { CurriculumStage } from "./curriculum.js";
import { EpisodeExecutor, type EpisodeCapture, type EpisodeJob, type EpisodeJobContext, type EpisodeJobResult, type JobSync } from "./episode-job.js";

export interface PoolStats {
  readonly workers: number;
  readonly episodes: number;
  readonly respawns: number;
  readonly totalCpuMs: number;
  /** Sum of the latest resident memory of every worker. */
  readonly rssMb: number;
  /** Highest value `rssMb` has reached. */
  readonly peakRssMb: number;
}

export interface EpisodePool {
  readonly size: number;
  runBatch(jobs: readonly EpisodeJob[]): Promise<EpisodeJobResult[]>;
  stats(): PoolStats;
  close(): Promise<void>;
}

/** Thrown by a transport when its worker died while it had a job. */
export class WorkerCrashed extends Error {}

/** How a pool reaches its workers. Two transports exist: separate processes, and in-process (tests). */
export interface WorkerTransport {
  readonly size: number;
  run(slot: number, job: EpisodeJob, sync: JobSync): Promise<EpisodeJobResult>;
  /** Drops the worker in this slot; the next job for the slot starts a fresh one. */
  replace(slot: number): void;
  close(): Promise<void>;
}

interface SlotState {
  bootstrapped: boolean;
  /** Index in the shared history up to which this worker's view is current. */
  syncedUpTo: number;
  /** History index of this worker's own last capture, which its view already contains. */
  ownIndex: number | null;
  rssMb: number;
}

export function createEpisodePool(transport: WorkerTransport): EpisodePool {
  const slots: SlotState[] = Array.from({ length: transport.size }, () => ({ bootstrapped: false, syncedUpTo: 0, ownIndex: null, rssMb: 0 }));
  const history: EpisodeCapture[] = [];
  let respawns = 0;
  let episodes = 0;
  let totalCpuMs = 0;
  let peakRssMb = 0;
  let closed = false;

  function syncFor(slot: number, base: number): JobSync {
    const state = slots[slot]!;
    if (!state.bootstrapped) return { bootstrap: true, pending: [] };
    const pending: EpisodeCapture[] = [];
    for (let index = state.syncedUpTo; index < base; index += 1) {
      if (index !== state.ownIndex) pending.push(history[index]!);
    }
    return { bootstrap: false, pending };
  }

  async function runOn(slot: number, job: EpisodeJob, base: number): Promise<EpisodeJobResult> {
    const state = slots[slot]!;
    try {
      const result = await transport.run(slot, job, syncFor(slot, base));
      state.bootstrapped = true;
      return result;
    } catch (error) {
      if (!(error instanceof WorkerCrashed)) throw error;
      respawns += 1;
      transport.replace(slot);
      state.bootstrapped = false;
      try {
        return await transport.run(slot, job, syncFor(slot, base));
      } catch (second) {
        throw new Error(`${second instanceof Error ? second.message : String(second)} The job was retried once in a fresh worker.`);
      } finally {
        state.bootstrapped = true;
      }
    }
  }

  return {
    size: transport.size,
    async runBatch(jobs: readonly EpisodeJob[]): Promise<EpisodeJobResult[]> {
      if (closed) throw new Error("The episode pool is closed.");
      if (jobs.length > slots.length) throw new Error(`A batch can have at most ${slots.length} jobs, got ${jobs.length}.`);
      const base = history.length;
      const results = await Promise.all(jobs.map((job, slot) => runOn(slot, job, base)));
      // Position N of the batch is appended at history index base + N; each worker's view now contains its own one.
      results.forEach((result, slot) => {
        const state = slots[slot]!;
        state.syncedUpTo = base;
        state.ownIndex = base + slot;
        state.rssMb = result.telemetry.rssMb;
        episodes += 1;
        totalCpuMs += result.telemetry.cpuMs;
        history.push(result.capture);
      });
      peakRssMb = Math.max(peakRssMb, slots.reduce((sum, state) => sum + state.rssMb, 0));
      return results;
    },
    stats(): PoolStats {
      return {
        workers: slots.length,
        episodes,
        respawns,
        totalCpuMs,
        rssMb: Math.round(slots.reduce((sum, state) => sum + state.rssMb, 0) * 10) / 10,
        peakRssMb: Math.round(peakRssMb * 10) / 10,
      };
    },
    async close(): Promise<void> {
      closed = true;
      await transport.close();
    },
  };
}

/** In-process workers: same protocol, no processes. Used by tests and by callers that already run in a worker. */
export function createInProcessEpisodePool(options: { readonly workers: number; readonly context: EpisodeJobContext }): EpisodePool {
  const executors = Array.from({ length: options.workers }, () => new EpisodeExecutor(options.context));
  return createEpisodePool({
    size: options.workers,
    run: (slot, job, sync) => executors[slot]!.run(job, sync),
    replace: (slot) => {
      void executors[slot]!.close();
      executors[slot] = new EpisodeExecutor(options.context);
    },
    close: async () => {
      await Promise.all(executors.map((executor) => executor.close()));
    },
  });
}

export interface ProcessPoolOptions {
  readonly workers: number;
  readonly stages: readonly CurriculumStage[];
  readonly experienceDirectory: string;
  /** Override for tests; the default is the TypeScript or compiled worker next to this file. */
  readonly entry?: string;
}

function workerEntry(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), `episode-worker${extname(here)}`);
}

function tsxLoaderUrl(): string {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  } catch {
    return "tsx";
  }
}

interface ProcessSlot {
  child: ChildProcess | null;
  stderr: string;
  /** Scratch folder of the current worker; the pool removes it when the worker is replaced or the pool closes. */
  scratch: string | null;
}

export function createProcessEpisodePool(options: ProcessPoolOptions): EpisodePool {
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 8) {
    throw new Error("Workers must be a whole number from 1 through 8.");
  }
  const entry = options.entry ?? workerEntry();
  const execArgv = extname(entry) === ".ts" ? ["--import", tsxLoaderUrl()] : [];
  const slots: ProcessSlot[] = Array.from({ length: options.workers }, () => ({ child: null, stderr: "", scratch: null }));
  const scratchRoot = mkdtempSync(join(tmpdir(), "gamemind-workers-"));
  let spawned = 0;

  function removeScratch(slot: ProcessSlot): void {
    if (slot.scratch !== null) rmSync(slot.scratch, { recursive: true, force: true });
    slot.scratch = null;
  }

  function spawn(slot: ProcessSlot): ChildProcess {
    spawned += 1;
    removeScratch(slot);
    slot.scratch = join(scratchRoot, `worker-${spawned}`);
    mkdirSync(slot.scratch, { recursive: true });
    const child = fork(entry, [], {
      execArgv,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, GAMEMIND_EPISODE_SCRATCH: slot.scratch },
    });
    slot.stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      slot.stderr = `${slot.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.on("exit", () => {
      if (slot.child === child) slot.child = null;
    });
    slot.child = child;
    return child;
  }

  function send(slotIndex: number, job: EpisodeJob, sync: JobSync): Promise<EpisodeJobResult> {
    const slot = slots[slotIndex]!;
    return new Promise<EpisodeJobResult>((resolve, reject) => {
      const child = slot.child && slot.child.connected ? slot.child : spawn(slot);
      const cleanup = () => {
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", onExit);
      };
      const onMessage = (message: { type: string; result?: EpisodeJobResult; message?: string }) => {
        if (message.type === "ready") return;
        cleanup();
        if (message.type === "result" && message.result) resolve(message.result);
        else reject(new Error(message.message ?? "Worker returned no result."));
      };
      const onExit = (code: number | null, signal?: NodeJS.Signals | null) => {
        cleanup();
        if (slot.child === child) slot.child = null;
        reject(
          new WorkerCrashed(
            `Worker stopped (code ${code ?? "none"}, signal ${signal ?? "none"}) during episode ${job.scenarioId} seed ${job.seed}. ${slot.stderr.trim().slice(-600)}`.trim(),
          ),
        );
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", onExit);
      child.send({ type: "job", job, sync, stages: options.stages, experienceDirectory: options.experienceDirectory }, (error) => {
        if (error) {
          cleanup();
          reject(new WorkerCrashed(`Could not send an episode to the worker: ${error.message}`));
        }
      });
    });
  }

  return createEpisodePool({
    size: options.workers,
    run: (slot, job, sync) => send(slot, job, sync),
    replace: (slot) => {
      const state = slots[slot]!;
      const child = state.child;
      state.child = null;
      child?.kill();
      removeScratch(state);
    },
    close: async () => {
      await Promise.all(
        slots.map(
          (slot) =>
            new Promise<void>((resolve) => {
              const child = slot.child;
              slot.child = null;
              if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
              child.once("exit", () => resolve());
              try {
                child.send({ type: "exit" });
              } catch {
                // already gone
              }
              setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill();
              }, 2000).unref();
            }),
        ),
      );
      for (const slot of slots) removeScratch(slot);
      rmSync(scratchRoot, { recursive: true, force: true });
    },
  });
}
