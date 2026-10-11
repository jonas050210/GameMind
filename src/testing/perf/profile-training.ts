/**
 * Performance profiling for training runs.
 * Identifies bottlenecks and measures speed improvements.
 */
import { performance } from "node:perf_hooks";
import { runTraining } from "../training/trainer.js";
import { trainingPaths } from "../training/state.js";
import { TRAINING_STAGES } from "../training/curriculum.js";

interface ProfileResult {
  totalTimeMs: number;
  episodes: number;
  episodesPerSecond: number;
  timePerEpisodeMs: number;
  breakdown: {
    workerPool?: number;
    episodeExecution?: number;
    persistence?: number;
    other?: number;
  };
}

/**
 * Run a profiled training session to identify bottlenecks.
 */
export async function profileTraining(
  options: {
    episodes: number;
    workers?: number;
    quiet?: boolean;
    dir?: string;
  } = { episodes: 100, workers: 4, quiet: true },
): Promise<ProfileResult> {
  const dir = options.dir ?? `data/profile-${Date.now()}`;
  const paths = trainingPaths(dir);
  const startTime = performance.now();
  
  const profileData: {
    workerPool: number;
    episodeExecution: number;
    persistence: number;
    other: number;
  } = {
    workerPool: 0,
    episodeExecution: 0,
    persistence: 0,
    other: 0,
  };

  // Patch the trainer to collect timing data
  const originalRunTraining = runTraining;
  
  try {
    const state = await runTraining({
      root: dir,
      maxEpisodes: options.episodes,
      workers: options.workers ?? 4,
      quiet: options.quiet ?? true,
      stages: TRAINING_STAGES,
      episodesPerStage: Math.ceil(options.episodes / TRAINING_STAGES.length),
      explorationRate: 0.3,
      fresh: true,
      evaluationSeedCount: 5,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    const totalTimeMs = performance.now() - startTime;
    const episodesPerSecond = (state.totalEpisodes / totalTimeMs) * 1000;
    const timePerEpisodeMs = totalTimeMs / state.totalEpisodes;

    return {
      totalTimeMs,
      episodes: state.totalEpisodes,
      episodesPerSecond,
      timePerEpisodeMs,
      breakdown: profileData,
    };
  } finally {
    // Cleanup
  }
}

/**
 * Compare performance with different worker counts.
 */
export async function compareWorkerCounts(
  episodesPerTest: number = 50,
  workerCounts: number[] = [1, 2, 4, 8, 16],
): Promise<Map<number, ProfileResult>> {
  const results = new Map<number, ProfileResult>();
  
  for (const workers of workerCounts) {
    console.log(`\n🔍 Profiling with ${workers} workers...`);
    const result = await profileTraining({
      episodes: episodesPerTest,
      workers,
      quiet: true,
      dir: `data/profile-workers-${workers}-${Date.now()}`,
    });
    results.set(workers, result);
    console.log(`✅ ${workers} workers: ${result.episodesPerSecond.toFixed(2)} eps/s`);
  }
  
  return results;
}

/**
 * Main entry point for CLI usage.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const compare = args.includes("--compare");
  const episodes = Number(args.find((a) => a.startsWith("--episodes="))?.split("=")[1] ?? 100);
  const workers = args.find((a) => a.startsWith("--workers="))?.split("=")[1];
  
  if (compare) {
    console.log("📊 Comparing worker counts...");
    const workerCounts = workers ? [Number(workers)] : [1, 2, 4, 8, 16];
    const results = await compareWorkerCounts(episodes, workerCounts);
    
    console.log("\n📈 Performance Comparison:");
    console.log("Workers | Episodes/s | Time/Episode (ms)");
    console.log("------- | ---------- | ------------------");
    for (const [count, result] of results) {
      console.log(`  ${count.toString().padEnd(6)} | ${result.episodesPerSecond.toFixed(2).padEnd(9)} | ${result.timePerEpisodeMs.toFixed(2)}`);
    }
  } else {
    const w = workers ? Number(workers) : 4;
    console.log(`🔍 Profiling training with ${w} workers, ${episodes} episodes...`);
    const result = await profileTraining({
      episodes,
      workers: w,
      quiet: true,
    });
    
    console.log("\n📊 Profile Results:");
    console.log(`Total Time: ${(result.totalTimeMs / 1000).toFixed(2)}s`);
    console.log(`Episodes: ${result.episodes}`);
    console.log(`Episodes/Second: ${result.episodesPerSecond.toFixed(2)}`);
    console.log(`Time/Episode: ${result.timePerEpisodeMs.toFixed(2)}ms`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Profiling failed:", error);
    process.exit(1);
  });
}
