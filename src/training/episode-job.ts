/**
 * One training episode, runnable in another process. Parallel training keeps a single learner (the one brain) in the
 * trainer process. A worker gets a job, rebuilds the learner from the same episode log the trainer has (the log is the
 * source of truth), plays the episode, and sends back the calls the episode made on the learner. The trainer then
 * replays those calls on its own learner, in job order, so the persisted state is produced by the same code path as a
 * sequential run.
 *
 * The worker never writes to the training directory: its learner has a throwaway state file that is deleted afterwards.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperienceLearner, type EpisodeDraft, type LearningRunContext } from "../core/learning/learner.js";
import type { Episode } from "../core/learning/episode.js";
import { ExperienceStore, InMemoryExperienceStore } from "../core/learning/experience-store.js";
import type { EvaluationRun, EvaluationRunOptions } from "../testing/eval/harness.js";
import type { EvaluationScenario } from "../testing/eval/scenarios.js";
import { curriculumScenarios, type CurriculumStage } from "./curriculum.js";

export interface EpisodeJob {
  /** Position in the run's episode sequence; results are replayed in this order. */
  readonly index: number;
  readonly stageId: string;
  readonly scenarioId: string;
  readonly seed: number;
  readonly worldKey: string;
  readonly runId: string;
  readonly explorationRate: number;
}

/** What the episode did to the learner: enough to replay it exactly on the trainer's learner. */
export interface EpisodeCapture {
  readonly runContext: LearningRunContext | null;
  readonly drafts: readonly EpisodeDraft[];
  readonly finished: boolean;
  readonly finishReport: { readonly promoted?: boolean; readonly note?: string } | null;
}

export interface WorkerTelemetry {
  readonly pid: number;
  /** Resident memory of the worker process when the job finished. */
  readonly rssMb: number;
  /** CPU time the job used (user + system). */
  readonly cpuMs: number;
  readonly wallMs: number;
}

export interface EpisodeJobResult {
  readonly index: number;
  readonly run: EvaluationRun;
  readonly reward: number | null;
  readonly capture: EpisodeCapture;
  readonly telemetry: WorkerTelemetry;
}

export type EpisodeJobRunner = (scenario: EvaluationScenario, seed: number, options: EvaluationRunOptions) => Promise<EvaluationRun>;

export interface EpisodeJobContext {
  readonly stages: readonly CurriculumStage[];
  readonly experienceDirectory: string;
  readonly runner: EpisodeJobRunner;
  /** Throwaway folder for the worker's learner state. Owned by the caller when given; otherwise the executor makes one. */
  readonly scratchDir?: string;
}

/** A learner that remembers the calls an episode makes on it, and otherwise behaves exactly like the real one. */
export class CapturingLearner extends ExperienceLearner {
  private captured: { runContext: LearningRunContext | null; drafts: EpisodeDraft[]; finished: boolean; finishReport: { promoted?: boolean; note?: string } | null } = {
    runContext: null,
    drafts: [],
    finished: false,
    finishReport: null,
  };

  override beginRun(context: LearningRunContext): void {
    this.captured.runContext = context;
    super.beginRun(context);
  }

  override recordEpisode(draft: EpisodeDraft): Episode | null {
    // Copy through JSON so the captured draft is exactly what would cross the process boundary.
    this.captured.drafts.push(JSON.parse(JSON.stringify(draft)) as EpisodeDraft);
    return super.recordEpisode(draft);
  }

  override async finishRun(report: { readonly promoted?: boolean; readonly note?: string } = {}) {
    this.captured.finished = true;
    this.captured.finishReport = { ...report };
    return super.finishRun(report);
  }

  /** Returns what was recorded since the last call and clears the buffer. */
  takeCapture(): EpisodeCapture {
    const taken: EpisodeCapture = {
      runContext: this.captured.runContext,
      drafts: this.captured.drafts,
      finished: this.captured.finished,
      finishReport: this.captured.finishReport,
    };
    this.captured.runContext = null;
    this.captured.drafts = [];
    this.captured.finished = false;
    this.captured.finishReport = null;
    return taken;
  }
}

/** Replays a worker's captured learner calls on the trainer's learner, in the same order the episode made them. */
export async function replayCapture(learner: ExperienceLearner, capture: EpisodeCapture): Promise<void> {
  if (capture.runContext) learner.beginRun(capture.runContext);
  for (const draft of capture.drafts) learner.recordEpisode(draft);
  if (capture.finished) await learner.finishRun(capture.finishReport ?? {});
}

/** What a worker must apply before it can run a job: its own learner's catch-up, or a rebuild from the episode log. */
export interface JobSync {
  /** Rebuild the learner from the episode log on disk (first job of a worker, or after a restart). */
  readonly bootstrap: boolean;
  /** Captured calls from other workers' episodes that this worker has not seen yet, in order. */
  readonly pending: readonly EpisodeCapture[];
}

/**
 * Runs jobs for one worker. The worker keeps its learner between jobs, so each job costs the episode itself plus the
 * episodes it has not seen yet, not a re-read of the whole log. The worker's view therefore contains the shared log
 * up to the last batch plus its own episodes; the trainer's learner is still the only one that is persisted.
 */
export class EpisodeExecutor {
  private learner: CapturingLearner | null = null;
  private scratch: string | null = null;
  private ownsScratch = false;
  private readonly scenarios;

  constructor(private readonly context: EpisodeJobContext) {
    this.scenarios = curriculumScenarios(context.stages);
  }

  async run(job: EpisodeJob, sync: JobSync): Promise<EpisodeJobResult> {
    const scenario = this.scenarios.get(job.scenarioId);
    if (!scenario) throw new Error(`Scenario '${job.scenarioId}' is not part of the curriculum in this worker.`);

    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    if (sync.bootstrap || this.learner === null) {
      await this.bootstrap();
    } else {
      for (const capture of sync.pending) await replayCapture(this.learner!, capture);
    }
    const learner = this.learner!;
    // Whatever the catch-up recorded is not this job's output.
    learner.takeCapture();

    const before = learner.rewardTotals;
    const run = await this.context.runner(scenario, job.seed, {
      learner,
      worldKey: job.worldKey,
      runId: job.runId,
      provenance: "training",
      explore: job.explorationRate > 0 ? { epsilon: job.explorationRate, seed: job.seed } : null,
    });
    const after = learner.rewardTotals;
    const reward = after.episodes > before.episodes ? after.sum - before.sum : null;

    const cpu = process.cpuUsage(cpuBefore);
    return {
      index: job.index,
      run,
      reward,
      capture: learner.takeCapture(),
      telemetry: {
        pid: process.pid,
        rssMb: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10,
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        wallMs: Math.round((performance.now() - started) * 10) / 10,
      },
    };
  }

  private async bootstrap(): Promise<void> {
    if (this.scratch === null) {
      this.scratch = this.context.scratchDir ?? (await mkdtemp(join(tmpdir(), "gamemind-episode-")));
      this.ownsScratch = this.context.scratchDir === undefined;
    }
    // Same evidence as the trainer's learner: the episode log as it is when the job is sent.
    const { episodes } = await new ExperienceStore({ directory: this.context.experienceDirectory }).load();
    const memory = new InMemoryExperienceStore();
    await memory.appendMany(episodes);
    // The throwaway state file keeps this learner from writing into the training directory.
    const learner = new CapturingLearner({ store: memory, stateFile: join(this.scratch, "state.json") });
    await learner.load();
    this.learner = learner;
  }

  async close(): Promise<void> {
    this.learner = null;
    if (this.scratch !== null && this.ownsScratch) await rm(this.scratch, { recursive: true, force: true });
    this.scratch = null;
  }
}
