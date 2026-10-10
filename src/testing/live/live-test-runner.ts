#!/usr/bin/env node
/**
 * Live Minecraft verification CLI.
 *
 * Connects to ANY reachable Minecraft 1.20.4 server — no Docker required.
 *
 * Usage:
 *   # Read-only connection + observation checks (safe on any server):
 *   npx tsx src/testing/live/live-test-runner.ts --host <ip> --port 25565
 *
 *   # Full verification including episode recording + learning updates:
 *   npx tsx src/testing/live/live-test-runner.ts --host <ip> --port 25565 --mode learn
 *
 *   # Specific phases only:
 *   npx tsx src/testing/live/live-test-runner.ts --host <ip> --port 25565 --phases connection,observation
 *
 *   # Against a local Docker server (if you have one):
 *   npx tsx src/testing/live/live-test-runner.ts --host 127.0.0.1 --port 25565
 *
 *   # Against a remote server:
 *   npx tsx src/testing/live/live-test-runner.ts --host mc.example.com --port 25565
 */

import pino from "pino";
import {
  runLiveVerification,
  formatLiveVerificationReport,
  DEFAULT_SERVER_CONFIG,
  type LiveServerConfig,
  type LiveTestMode,
  type LivePhase,
} from "./live-verifier.js";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const host = getArg(args, "--host") ?? DEFAULT_SERVER_CONFIG.host;
  const port = parseInt(getArg(args, "--port") ?? String(DEFAULT_SERVER_CONFIG.port), 10);
  const username = getArg(args, "--username") ?? DEFAULT_SERVER_CONFIG.botUsername;
  const mode = (getArg(args, "--mode") ?? "verify") as LiveTestMode;
  const phasesStr = getArg(args, "--phases");
  const outputDir = getArg(args, "--output") ?? "test-results";
  const connectTimeout = parseInt(getArg(args, "--timeout") ?? "30000", 10);

  if (mode !== "verify" && mode !== "learn") {
    console.error(`Unknown mode: ${mode}. Use --mode verify or --mode learn.`);
    process.exit(1);
  }

  const phases = phasesStr
    ? (phasesStr.split(",").map((s) => s.trim()) as LivePhase[])
    : undefined;

  const server: LiveServerConfig = {
    host,
    port,
    version: DEFAULT_SERVER_CONFIG.version,
    botUsername: username,
    connectTimeoutMs: connectTimeout,
  };

  const logger = pino({ level: "info" });
  logger.info("GameMind Live Verification");
  logger.info(`Server: ${host}:${port} (${DEFAULT_SERVER_CONFIG.version})`);
  logger.info(`Mode: ${mode}`);
  logger.info(`Bot: ${username}`);
  if (phases) logger.info(`Phases: ${phases.join(", ")}`);

  const report = await runLiveVerification({
    server,
    mode,
    ...(phases ? { phases } : {}),
    logger,
  });

  console.log(formatLiveVerificationReport(report));

  // Save report
  const reportDir = path.resolve(outputDir);
  try {
    await mkdir(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, "live-verification-report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    logger.info(`Report saved to ${reportPath}`);
  } catch (error) {
    logger.warn({ err: error }, "Could not save report file");
  }

  // Exit code: 0 if reached server and all passed, 1 if connection failed or tests failed
  if (!report.reachedServer) {
    console.log("\n⚠ Server was not reached. Cannot verify GameMind against live Minecraft.");
    console.log("  Ensure a Minecraft 1.20.4 server is running at the specified address.");
    console.log("  For a local test server: docker compose -f src/testing/live/docker-compose.yml up -d");
    process.exit(2);
  }
  if (!report.allPassed) {
    process.exit(1);
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  return undefined;
}

main().catch((error) => {
  console.error("Live verification failed:", error);
  process.exit(1);
});
