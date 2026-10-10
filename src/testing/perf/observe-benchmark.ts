/**
 * Measures the per-decision cost of the live Minecraft pipeline on a real Mineflayer block model.
 *
 * What is timed, end to end, through the same code the agent runs:
 *   - `MinecraftAdapter.observe()`      perception: local cube, wide scans, entities, validation;
 *   - `GameMindRuntime.observe()`       the adapter call plus world-model update and the trace write
 *                                       (the JSONL file is real disk I/O, and the logger is pino at `info`,
 *                                       as in production, so logging serialisation is included);
 *   - `MinecraftTaskDecisionModel.decide()`  the planner over the observation.
 *
 * Output is written to `data/perf/<label>.json` (git-ignored) and printed. These are offline measurements of
 * the adapter against a Mineflayer block model; they say nothing about network latency or server tick time.
 * Run with `npm run perf:observe -- --label before`.
 */
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import pino from "pino";
import { MinecraftAdapter, DEFAULT_MINECRAFT_CONFIG, type MinecraftAdapterConfig } from "../../games/minecraft/minecraft-adapter.js";
import { GameMindRuntime } from "../../core/game-mind-runtime.js";
import { JsonlTraceSink, TraceRecorder } from "../../core/trace.js";
import { MinecraftTaskDecisionModel } from "../../games/minecraft/decision-model.js";
import { gatherResourceTaskSchema } from "../../games/minecraft/task.js";
import { createRealisticBot } from "./realistic-bot.js";
import { minecraftSafetyContext } from "../../games/minecraft/safety-context.js";

interface Summary {
  readonly label: string;
  readonly generatedAt: string;
  readonly node: string;
  readonly iterations: number;
  readonly world: { readonly chunkRadius: number; readonly blocksWritten: number; readonly observationRadius: number; readonly resourceScanRadius: number };
  /** Every observation re-runs the wide scans (cache invalidated first): the worst case, and the cost after any action. */
  readonly observeAdapterFreshMs: Quantiles;
  /** Steady state: the wide scans are reused while the agent stays put, as in the live observation loop. */
  readonly observeAdapterMs: Quantiles;
  readonly observeRuntimeMs: Quantiles;
  readonly decideMs: Quantiles;
  readonly perceptionBreakdownMs: { readonly localScan: number; readonly strategicScan: number; readonly entityScan: number; readonly validation: number };
  readonly observationBytes: { readonly payloadJson: number; readonly tracedPerObservation: number };
  readonly traceBytesPerObservation: number;
  readonly traceLinesPerObservation: number;
  readonly note: string;
}

interface Quantiles {
  readonly p50: number;
  readonly p95: number;
  readonly mean: number;
  readonly max: number;
}

function quantiles(values: readonly number[]): Quantiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
  return { p50: round(at(0.5)), p95: round(at(0.95)), mean: round(mean), max: round(sorted.at(-1) ?? 0) };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

export async function runObservationBenchmark(options: { label: string; iterations: number; chunkRadius: number; outDir: string }): Promise<Summary> {
  const realistic = createRealisticBot({ chunkRadius: options.chunkRadius });
  const logger = pino({ level: "info" }, createWriteStream("/dev/null"));
  const config: MinecraftAdapterConfig = { ...DEFAULT_MINECRAFT_CONFIG, connectTimeoutMs: 5_000 };
  const adapter = new MinecraftAdapter(logger, config, {
    botFactory: () => {
      queueMicrotask(() => realistic.bot.emit("spawn"));
      return realistic.bot;
    },
    installPlugins: () => undefined,
    configureSafeMovements: () => undefined,
  });

  const workDir = await mkdtemp(path.join(tmpdir(), "gamemind-perf-"));
  try {
    const traceFile = path.join(workDir, "trace");
    const trace = new TraceRecorder(new JsonlTraceSink(traceFile), logger);
    const runtime = new GameMindRuntime(adapter, trace, logger, { safetyContext: minecraftSafetyContext });
    await runtime.connect();

    // Warm-up: first observations pay one-time costs (JIT, registry caches) that are not steady state.
    for (let index = 0; index < 5; index += 1) await runtime.observe();

    const adapterMs: number[] = [];
    const adapterFreshMs: number[] = [];
    const invalidate = (reason: string) =>
      (adapter as unknown as { invalidateWideScan(reason: string): void }).invalidateWideScan(reason);
    const runtimeMs: number[] = [];
    const decideMs: number[] = [];
    const breakdown = { localScan: 0, strategicScan: 0, entityScan: 0, validation: 0 };
    let payloadBytes = 0;
    const before = await traceTotals(traceFile);
    const decisionModel = new MinecraftTaskDecisionModel();
    const task = gatherResourceTaskSchema.parse({
      id: "bench-gather",
      kind: "gather_resource",
      resourceName: "oak_log",
      targetCount: 8,
      maxActions: 50,
      maxDurationMs: 60_000,
      maxExplorationLegs: 6,
    });

    for (let index = 0; index < options.iterations; index += 1) {
      invalidate("benchmark_fresh");
      const freshStarted = performance.now();
      await adapter.observe();
      adapterFreshMs.push(performance.now() - freshStarted);
      const started = performance.now();
      const observation = await adapter.observe();
      adapterMs.push(performance.now() - started);
      const perception = observation.state.perception;
      if (perception) {
        breakdown.localScan += perception.localScanMs;
        breakdown.strategicScan += perception.strategicScanMs;
        breakdown.entityScan += perception.entityScanMs;
        breakdown.validation += perception.validationMs;
      }
      payloadBytes += Buffer.byteLength(JSON.stringify(observation.state));

      const runtimeStarted = performance.now();
      const world = await runtime.observe();
      runtimeMs.push(performance.now() - runtimeStarted);

      const decisionStarted = performance.now();
      decisionModel.decide(world.state, task, { excludedTargets: new Set<string>(), previousFailureCode: null }, world.sequence);
      decideMs.push(performance.now() - decisionStarted);
    }
    // Let the trace queue drain before measuring what it wrote.
    await trace.close();
    const after = await traceTotals(traceFile);
    const traceBytes = after.bytes - before.bytes;
    const traceLinesWritten = after.lines - before.lines;
    const n = options.iterations;
    const summary: Summary = {
      label: options.label,
      generatedAt: new Date().toISOString(),
      node: process.version,
      iterations: n,
      world: {
        chunkRadius: options.chunkRadius,
        blocksWritten: realistic.blocksWritten,
        observationRadius: config.observationRadius,
        resourceScanRadius: config.resourceScanRadius,
      },
      observeAdapterFreshMs: quantiles(adapterFreshMs),
      observeAdapterMs: quantiles(adapterMs),
      observeRuntimeMs: quantiles(runtimeMs),
      decideMs: quantiles(decideMs),
      perceptionBreakdownMs: {
        localScan: round(breakdown.localScan / n),
        strategicScan: round(breakdown.strategicScan / n),
        entityScan: round(breakdown.entityScan / n),
        validation: round(breakdown.validation / n),
      },
      observationBytes: {
        payloadJson: Math.round(payloadBytes / n),
        tracedPerObservation: Math.round(traceBytes / Math.max(1, n)),
      },
      traceBytesPerObservation: Math.round(traceBytes / Math.max(1, n)),
      traceLinesPerObservation: round(traceLinesWritten / Math.max(1, n)),
      note: "Offline: real Mineflayer block/raycast code over a generated world, no network, no server tick.",
    };
    await mkdir(options.outDir, { recursive: true });
    await writeFile(path.join(options.outDir, `observe-${options.label}.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return summary;
  } finally {
    await rm(workDir, { recursive: true, force: true });
    realistic.bot.end?.("benchmark finished");
  }
}

/** Sums the bytes and lines the JSONL trace sink wrote under `dir` (one file per session). */
async function traceTotals(dir: string): Promise<{ bytes: number; lines: number }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { bytes: 0, lines: 0 };
  }
  let bytes = 0;
  let lines = 0;
  for (const name of names) {
    const content = await readFile(path.join(dir, name), "utf8");
    bytes += Buffer.byteLength(content);
    lines += content.split("\n").filter((line) => line.length > 0).length;
  }
  return { bytes, lines };
}

// Entry point when run as a script.
if (process.argv[1] && process.argv[1].endsWith("observe-benchmark.ts")) {
  const label = argValue("--label", "current");
  const iterations = Number(argValue("--iterations", "60"));
  const chunkRadius = Number(argValue("--chunk-radius", "2"));
  runObservationBenchmark({ label, iterations, chunkRadius, outDir: path.resolve("data/perf") })
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
