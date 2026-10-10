import * as os from "node:os";
import { performance } from "node:perf_hooks";
import type { ControlCenterRuntimePerformance } from "../../control-center/types.js";

/**
 * Samples process and host load since the previous call. Each sampler keeps its own baseline, so two consumers (a
 * session's snapshot and the app's detached snapshot) never disturb each other's CPU and event-loop deltas.
 */
export function createRuntimePerformanceSampler(): () => ControlCenterRuntimePerformance {
  const logicalCpus = Math.max(1, typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length);
  let priorSampleAt = performance.now();
  let priorCpu = process.cpuUsage();
  let priorEventLoop = performance.eventLoopUtilization();

  return function sampleRuntimePerformance(): ControlCenterRuntimePerformance {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const eventLoop = performance.eventLoopUtilization();
    const eventLoopDelta = performance.eventLoopUtilization(priorEventLoop, eventLoop);
    const sampleWindowMs = Math.max(0, now - priorSampleAt);
    const cpuTimeMs = ((cpu.user - priorCpu.user) + (cpu.system - priorCpu.system)) / 1_000;
    const cpuCapacityPercent = sampleWindowMs > 0
      ? Math.max(0, Math.min(100, cpuTimeMs / (sampleWindowMs * logicalCpus) * 100))
      : 0;
    const processMemory = process.memoryUsage();
    const load = os.loadavg()[0] ?? null;
    priorSampleAt = now;
    priorCpu = cpu;
    priorEventLoop = eventLoop;
    return {
      sampledAt: new Date().toISOString(),
      sampleWindowMs,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      logicalCpus,
      process: {
        cpuCapacityPercent,
        eventLoopUtilizationPercent: Math.max(0, Math.min(100, eventLoopDelta.utilization * 100)),
        rssBytes: processMemory.rss,
        heapUsedBytes: processMemory.heapUsed,
        heapTotalBytes: processMemory.heapTotal,
        externalBytes: processMemory.external,
        uptimeSeconds: process.uptime(),
      },
      host: {
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
        loadAverage1m: process.platform === "win32" || !Number.isFinite(load) ? null : load,
      },
    };
  };
}
