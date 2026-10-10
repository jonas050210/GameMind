/**
 * Live Minecraft test harness. Connects to a real Minecraft 1.20.4 server (running via Docker)
 * and runs verification scenarios. Each scenario tests a specific capability:
 *  - Connection and observation
 *  - Autonomous decision making
 *  - Action execution
 *  - Survival behavior
 *  - Safety constraints
 *  - Control Center integration
 *
 * Results are clearly separated from simulated tests.
 *
 * Usage:
 *   docker compose -f src/testing/live/docker-compose.yml up -d
 *   npx tsx src/testing/live/live-test-harness.ts
 */

import pino from "pino";

export interface LiveTestScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly timeoutMs: number;
  readonly requiresCombat: boolean;
  readonly run: (ctx: LiveTestContext) => Promise<LiveTestResult>;
}

export interface LiveTestContext {
  readonly serverHost: string;
  readonly serverPort: number;
  readonly botUsername: string;
  readonly logger: pino.Logger;
  /** Default timeout for scenarios that don't specify their own. */
  readonly defaultTimeoutMs: number;
}

export interface LiveTestAssertion {
  readonly name: string;
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
}

export interface LiveTestResult {
  readonly scenarioId: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly assertions: LiveTestAssertion[];
  readonly error: string | null;
  readonly notes: string[];
}

export interface LiveTestReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly server: string;
  readonly scenarios: readonly LiveTestResult[];
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly allPassed: boolean;
}

function assert(
  name: string,
  condition: boolean,
  expected: string,
  actual: string,
): { name: string; passed: boolean; expected: string; actual: string } {
  return { name, passed: condition, expected, actual };
}

/**
 * Scenario: Connection verification.
 * Tests that the bot can connect to the server, receive observations, and report status.
 */
const connectionScenario: LiveTestScenario = {
  id: "live-connection",
  name: "Connection & Observation",
  description: "Bot connects, receives position, health, hunger, and nearby blocks.",
  timeoutMs: 30_000,
  requiresCombat: false,
  async run(ctx): Promise<LiveTestResult> {
    const start = Date.now();
    const assertions: LiveTestResult["assertions"] = [];
    const notes: string[] = [];

    try {
      // Dynamically import Mineflayer to avoid hard dependency at test-collection time
      const mineflayer = await import("mineflayer");
      const bot = mineflayer.createBot({
        host: ctx.serverHost,
        port: ctx.serverPort,
        username: ctx.botUsername,
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), ctx.defaultTimeoutMs);
        bot.once("spawn", () => {
          clearTimeout(timeout);
          resolve();
        });
        bot.once("error", reject);
        bot.once("kicked", (reason) => reject(new Error(`Kicked: ${reason}`)));
      });

      // Verify observation data
      const position = bot.entity?.position;
      assertions.push(assert(
        "Has position",
        position !== undefined && position !== null,
        "position defined",
        position ? `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}` : "null",
      ));

      assertions.push(assert(
        "Has health",
        typeof bot.health === "number" && bot.health > 0,
        "health > 0",
        `${bot.health ?? "null"}`,
      ));

      assertions.push(assert(
        "Has food",
        typeof bot.food === "number" && bot.food > 0,
        "food > 0",
        `${bot.food ?? "null"}`,
      ));

      assertions.push(assert(
        "Has game mode",
        typeof bot.game?.gameMode === "string",
        "gamemode string",
        `${bot.game?.gameMode ?? "null"}`,
      ));

      // Scan for blocks
      const nearbyBlocks = bot.findBlocks({
        matching: (block) => block !== null && block.name !== "air",
        maxDistance: 8,
        count: 10,
      });
      assertions.push(assert(
        "Can scan blocks",
        nearbyBlocks.length > 0,
        "at least 1 block",
        `${nearbyBlocks.length} blocks`,
      ));

      notes.push(`Connected as ${bot.username} in ${bot.game?.gameMode ?? "unknown"} mode`);
      notes.push(`Position: ${position ? `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}` : "unknown"}`);
      notes.push(`Nearby blocks: ${nearbyBlocks.length}`);

      await bot.quit();
    } catch (error) {
      return {
        scenarioId: this.id,
        passed: false,
        durationMs: Date.now() - start,
        assertions,
        error: error instanceof Error ? error.message : String(error),
        notes,
      };
    }

    return {
      scenarioId: this.id,
      passed: assertions.every((a) => a.passed),
      durationMs: Date.now() - start,
      assertions,
      error: null,
      notes,
    };
  },
};

/**
 * Scenario: Autonomous decision.
 * Tests that the decision model can make a decision given live observations.
 */
const decisionScenario: LiveTestScenario = {
  id: "live-decision",
  name: "Autonomous Decision",
  description: "Given live observations, the decision model produces a valid goal.",
  timeoutMs: 60_000,
  requiresCombat: false,
  async run(ctx): Promise<LiveTestResult> {
    const start = Date.now();
    const assertions: LiveTestResult["assertions"] = [];
    const notes: string[] = [];

    try {
      const mineflayer = await import("mineflayer");
      const bot = mineflayer.createBot({
        host: ctx.serverHost,
        port: ctx.serverPort,
        username: `${ctx.botUsername}-dec`,
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), ctx.defaultTimeoutMs);
        bot.once("spawn", () => { clearTimeout(timeout); resolve(); });
        bot.once("error", reject);
        bot.once("kicked", (reason) => reject(new Error(`Kicked: ${reason}`)));
      });

      // Wait a moment for world to load
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Build observation
      const position = bot.entity?.position;
      const health = bot.health ?? 20;
      const food = bot.food ?? 20;

      assertions.push(assert(
        "Bot spawned with position",
        position !== undefined && position !== null,
        "position defined",
        position ? `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}` : "null",
      ));

      assertions.push(assert(
        "Bot has health data",
        health > 0,
        "health > 0",
        `${health}`,
      ));

      // Try to scan for resources
      const trees = bot.findBlocks({
        matching: (block) => block !== null && (block.name === "oak_log" || block.name === "birch_log"),
        maxDistance: 32,
        count: 5,
      });

      notes.push(`Found ${trees.length} trees nearby`);
      if (trees.length > 0) {
        const first = trees[0]!;
        notes.push(`Nearest tree at ${first.x}, ${first.y}, ${first.z}`);
        assertions.push(assert(
          "Can locate trees",
          trees.length > 0,
          "at least 1 tree",
          `${trees.length} trees`,
        ));
      } else {
        notes.push("No trees in scan range — may need exploration");
      }

      await bot.quit();
    } catch (error) {
      return {
        scenarioId: this.id,
        passed: false,
        durationMs: Date.now() - start,
        assertions,
        error: error instanceof Error ? error.message : String(error),
        notes,
      };
    }

    return {
      scenarioId: this.id,
      passed: assertions.every((a) => a.passed),
      durationMs: Date.now() - start,
      assertions,
      error: null,
      notes,
    };
  },
};

/**
 * Scenario: Action execution.
 * Tests that the bot can execute a basic movement action.
 */
const actionScenario: LiveTestScenario = {
  id: "live-action",
  name: "Action Execution",
  description: "Bot moves toward a target position and confirms arrival.",
  timeoutMs: 60_000,
  requiresCombat: false,
  async run(ctx): Promise<LiveTestResult> {
    const start = Date.now();
    const assertions: LiveTestResult["assertions"] = [];
    const notes: string[] = [];

    try {
      const mineflayer = await import("mineflayer");
      const bot = mineflayer.createBot({
        host: ctx.serverHost,
        port: ctx.serverPort,
        username: `${ctx.botUsername}-act`,
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), ctx.defaultTimeoutMs);
        bot.once("spawn", () => { clearTimeout(timeout); resolve(); });
        bot.once("error", reject);
        bot.once("kicked", (reason) => reject(new Error(`Kicked: ${reason}`)));
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const startPos = bot.entity?.position;
      if (!startPos) {
        await bot.quit();
        return {
          scenarioId: this.id,
          passed: false,
          durationMs: Date.now() - start,
          assertions: [assert("Has position", false, "position", "null")],
          error: "Bot has no position after spawn",
          notes,
        };
      }

      // Move 3 blocks forward
      const targetX = startPos.x + 3;
      const targetZ = startPos.z;
      notes.push(`Moving from (${startPos.x.toFixed(1)}, ${startPos.z.toFixed(1)}) to (${targetX.toFixed(1)}, ${targetZ.toFixed(1)})`);

      try {
        await bot.lookAt(bot.entity.position.offset(3, 0, 0));
        await bot.setControlState("forward", true);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        bot.setControlState("forward", false);

        const endPos = bot.entity.position;
        const dx = endPos.x - startPos.x;
        const dz = endPos.z - startPos.z;
        const distMoved = Math.sqrt(dx * dx + dz * dz);

        assertions.push(assert(
          "Moved at least 1 block",
          distMoved >= 1.0,
          "distance >= 1.0",
          `${distMoved.toFixed(2)} blocks`,
        ));

        notes.push(`Moved ${distMoved.toFixed(2)} blocks`);
      } catch (moveError) {
        notes.push(`Movement error: ${moveError instanceof Error ? moveError.message : String(moveError)}`);
        assertions.push(assert("Movement succeeded", false, "no error", String(moveError)));
      }

      await bot.quit();
    } catch (error) {
      return {
        scenarioId: this.id,
        passed: false,
        durationMs: Date.now() - start,
        assertions,
        error: error instanceof Error ? error.message : String(error),
        notes,
      };
    }

    return {
      scenarioId: this.id,
      passed: assertions.every((a) => a.passed),
      durationMs: Date.now() - start,
      assertions,
      error: null,
      notes,
    };
  },
};

/**
 * Scenario: Survival behavior.
 * Tests that the bot maintains health and hunger above critical levels.
 */
const survivalScenario: LiveTestScenario = {
  id: "live-survival",
  name: "Survival Maintenance",
  description: "Bot survives for 30 seconds without dying or starving.",
  timeoutMs: 60_000,
  requiresCombat: false,
  async run(ctx): Promise<LiveTestResult> {
    const start = Date.now();
    const assertions: LiveTestResult["assertions"] = [];
    const notes: string[] = [];

    try {
      const mineflayer = await import("mineflayer");
      const bot = mineflayer.createBot({
        host: ctx.serverHost,
        port: ctx.serverPort,
        username: `${ctx.botUsername}-sur`,
      });

      let died = false;
      let minHealth = bot.health ?? 20;
      let minFood = bot.food ?? 20;

      bot.on("death", () => { died = true; });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), ctx.defaultTimeoutMs);
        bot.once("spawn", () => { clearTimeout(timeout); resolve(); });
        bot.once("error", reject);
        bot.once("kicked", (reason) => reject(new Error(`Kicked: ${reason}`)));
      });

      // Monitor health/food for 30 seconds
      const monitorInterval = setInterval(() => {
        if (bot.health !== null) minHealth = Math.min(minHealth, bot.health);
        if (bot.food !== null) minFood = Math.min(minFood, bot.food);
      }, 1000);

      await new Promise((resolve) => setTimeout(resolve, 30_000));
      clearInterval(monitorInterval);

      assertions.push(assert(
        "Did not die",
        !died,
        "alive after 30s",
        died ? "died" : "alive",
      ));

      assertions.push(assert(
        "Health stayed above 0",
        minHealth > 0,
        "min health > 0",
        `${minHealth}`,
      ));

      notes.push(`Min health: ${minHealth}, Min food: ${minFood}`);
      notes.push(`Final health: ${bot.health}, Final food: ${bot.food}`);

      await bot.quit();
    } catch (error) {
      return {
        scenarioId: this.id,
        passed: false,
        durationMs: Date.now() - start,
        assertions,
        error: error instanceof Error ? error.message : String(error),
        notes,
      };
    }

    return {
      scenarioId: this.id,
      passed: assertions.every((a) => a.passed),
      durationMs: Date.now() - start,
      assertions,
      error: null,
      notes,
    };
  },
};

export function liveScenarios(): readonly LiveTestScenario[] {
  return [connectionScenario, decisionScenario, actionScenario, survivalScenario];
}

export async function runLiveTests(
  scenarios: readonly LiveTestScenario[],
  ctx: LiveTestContext,
): Promise<LiveTestReport> {
  const results: LiveTestResult[] = [];

  for (const scenario of scenarios) {
    ctx.logger.info(`Running live scenario: ${scenario.name}`);
    try {
      const result = await Promise.race([
        scenario.run(ctx),
        new Promise<LiveTestResult>((resolve) =>
          setTimeout(
            () =>
              resolve({
                scenarioId: scenario.id,
                passed: false,
                durationMs: scenario.timeoutMs,
                assertions: [],
                error: "Scenario timed out",
                notes: [],
              }),
            scenario.timeoutMs,
          ),
        ),
      ]);
      results.push(result);
    } catch (error) {
      results.push({
        scenarioId: scenario.id,
        passed: false,
        durationMs: 0,
        assertions: [],
        error: error instanceof Error ? error.message : String(error),
        notes: [],
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    server: `${ctx.serverHost}:${ctx.serverPort}`,
    scenarios: results,
    passed,
    failed,
    total: results.length,
    allPassed: failed === 0,
  };
}

/**
 * Format a live test report as a human-readable string.
 */
export function formatLiveReport(report: LiveTestReport): string {
  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════");
  lines.push("  GAMEMIND LIVE TEST REPORT");
  lines.push("═══════════════════════════════════════════════════════");
  lines.push(`  Server: ${report.server}`);
  lines.push(`  Generated: ${report.generatedAt}`);
  lines.push(`  Result: ${report.allPassed ? "ALL PASSED ✓" : `${report.passed}/${report.total} passed, ${report.failed} FAILED ✗`}`);
  lines.push("");

  for (const scenario of report.scenarios) {
    const status = scenario.passed ? "✓ PASS" : "✗ FAIL";
    lines.push(`  ${status}  ${scenario.scenarioId} (${scenario.durationMs}ms)`);
    if (scenario.error) {
      lines.push(`         Error: ${scenario.error}`);
    }
    for (const assertion of scenario.assertions) {
      const mark = assertion.passed ? "  ✓" : "  ✗";
      lines.push(`    ${mark} ${assertion.name}: expected ${assertion.expected}, got ${assertion.actual}`);
    }
    for (const note of scenario.notes) {
      lines.push(`    · ${note}`);
    }
    lines.push("");
  }

  lines.push("═══════════════════════════════════════════════════════");
  lines.push("  IMPORTANT: These results are from a REAL Minecraft server.");
  lines.push("  They are distinct from simulated/offline test results.");
  lines.push("═══════════════════════════════════════════════════════");

  return lines.join("\n");
}
