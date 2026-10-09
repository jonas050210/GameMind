import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { RingBufferTraceSink, TraceRecorder } from "../src/core/trace.js";
import { ExperienceLearner } from "../src/core/learning/learner.js";
import { createMinecraftAgent } from "../src/games/minecraft/create-agent.js";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import { MinecraftTaskRunner } from "../src/games/minecraft/task-runner.js";
import { attachMinecraftRunHost, taskFromControlCenterRequest } from "../src/games/minecraft/attach-control-center.js";
import { readEvaluationSummary } from "../src/games/minecraft/run-control.js";
import { evaluationScenarios } from "../src/testing/eval/scenarios.js";
import { SimulatedMinecraftAdapter } from "../src/testing/simulated-minecraft/adapter.js";
import type { MinecraftTaskResult } from "../src/games/minecraft/task-runner.js";
import type { MinecraftTask } from "../src/games/minecraft/task.js";
import type { ControlCenterSnapshot } from "../src/control-center/types.js";

/**
 * These tests drive the Control Center through its HTTP surface against a real agent (simulated world,
 * real Safety Broker, real learner, real trace ring) — the point is to prove the dashboard is wired to the
 * runtime rather than to a fixture of its own.
 */
interface Fixture {
  readonly directory: string;
  readonly host: Awaited<ReturnType<typeof attachMinecraftRunHost>>;
  readonly runtime: ReturnType<typeof createMinecraftAgent>["runtime"];
  readonly skills: ReturnType<typeof createMinecraftAgent>["skills"];
  readonly adapter: SimulatedMinecraftAdapter;
  readonly snapshots: () => Promise<ControlCenterSnapshot>;
  readonly command: (type: string, payload?: unknown) => Promise<{ status: number; body: { ok?: boolean; message?: string } }>;
  readonly results: MinecraftTaskResult[];
  readonly runTask: (task: MinecraftTask) => Promise<MinecraftTaskResult>;
  readonly close: () => Promise<void>;
}

interface FixtureOptions {
  readonly scenarioId?: string;
  readonly learning?: boolean;
  readonly allowCombat?: boolean;
  /** Requests the operator stop after this many recorded actions, at the runner's inter-action check. */
  readonly stopAfterActions?: number;
}

async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-control-center-"));
  const logger = createLogger("silent");
  const ring = new RingBufferTraceSink(300);
  const trace = new TraceRecorder(ring, logger);
  const scenario =
    evaluationScenarios().find((candidate) => candidate.id === (options.scenarioId ?? "explore-remote-log"))
    ?? evaluationScenarios()[0];
  assert.ok(scenario, "the evaluation suite must provide at least one scenario");
  const adapter = new SimulatedMinecraftAdapter({
    definition: scenario.world(101),
    allowCombat: options.allowCombat ?? false,
  });
  const { runtime, skills, safety } = createMinecraftAgent(adapter, trace, logger);
  const learner = options.learning === false ? null : ExperienceLearner.forDirectory(directory, { logger });
  const decisionModel = new MinecraftTaskDecisionModel();
  const results: MinecraftTaskResult[] = [];
  const worldKey = `${scenario.id}#101`;
  // Connect and observe once, so the dashboard's idle state is a real connected session rather than an
  // untested "never started" path.
  await runtime.connect();
  await runtime.observe();
  const host = await attachMinecraftRunHost({
    runtime,
    safety,
    traceSink: ring,
    logger,
    ...(learner ? { learner } : {}),
    worldKey,
    offlineNote: "test fixture: simulated world",
    port: 0,
    bindHost: "127.0.0.1",
    evaluationReportPath: path.join(directory, "no-report.json"),
    createRunner: (extra) => {
      const stopAfter = options.stopAfterActions ?? null;
      let actions = 0;
      return new MinecraftTaskRunner(runtime, skills, decisionModel, logger, {
        clock: () => adapter.simulatedNowMs,
        ...(learner ? { learner } : {}),
        worldKey,
        ...extra,
        onAction: (action) => {
          actions += 1;
          extra.onAction?.(action);
        },
        // Deterministic mid-run stop: the fixture decides when to ask, the runner decides where to honour it.
        ...(stopAfter !== null
          ? {
              shouldStop: () =>
                actions >= stopAfter ? "operator is taking over" : (extra.shouldStop?.() ?? null),
            }
          : {}),
      });
    },
    onTaskFinished: (result) => {
      results.push(result);
    },
  });
  const base = new URL(host.handle?.url ?? "", "http://127.0.0.1").toString();
  const token = host.handle?.token ?? "";
  assert.ok(base.length > 0 && token.length > 0, "the handle must expose its URL and control token");
  return {
    directory,
    host,
    runtime,
    skills,
    adapter,
    results,
    runTask: (task) => host.runTask(task),
    async snapshots() {
      const response = await fetch(`${base}/api/snapshot?fresh=1`);
      assert.equal(response.status, 200);
      return (await response.json()) as ControlCenterSnapshot;
    },
    async command(type, payload) {
      const response = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gamemind-token": token },
        body: JSON.stringify(payload === undefined ? { type } : { type, payload }),
      });
      return { status: response.status, body: (await response.json()) as { ok?: boolean; message?: string } };
    },
    async close() {
      await host.close();
      await runtime.shutdown("test complete");
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("snapshot reflects the live runtime, before and after a real task", async () => {
  const fixture = await startFixture();
  try {
    const before = await fixture.snapshots();
    assert.equal(before.connection.adapterStatus, "connected");
    assert.equal(before.connection.gameId, "minecraft-java");
    assert.equal(before.connection.gameVersion, "1.20.4");
    assert.equal(before.connection.server, "explore-remote-log#101");
    assert.equal(before.agent.taskId, null);
    assert.equal(before.agent.state, "idle");
    assert.equal(before.offlineNote, "test fixture: simulated world");
    assert.equal(before.goal, null);
    assert.equal(before.safety?.policyId, "gamemind-minecraft-v1");
    assert.equal(before.safety?.paused, false);
    assert.equal(before.learning?.episodes, 0);
    assert.equal(before.learning?.evaluation?.generatedAt, null, "a missing report must read as unmeasured, not as zero");
    assert.ok(before.capabilities.length > 0);
    assert.ok(before.world.health !== null, "health comes from the observed player state");

    const result = await fixture.runTask(taskFromControlCenterRequest({ kind: "gather-logs", count: 1 }));
    assert.equal(result.status, "succeeded", `the gather task should succeed in this world: ${JSON.stringify(result.failure)}`);

    const after = await fixture.snapshots();
    assert.equal(after.agent.taskId, "ui-gather-oak_log");
    assert.equal(after.agent.status, "succeeded");
    assert.equal(after.agent.actionsUsed, result.actions.length);
    assert.ok(after.world.inventory.some((item) => item.name === "oak_log" && item.count >= 1), "inventory must be read from the world");
    assert.ok(after.goal, "the last decision trace is exposed");
    assert.equal(typeof after.goal?.rationale, "string");
    assert.ok(after.recentActions.length > 0, "executed skills are listed from the trace");
    assert.ok(
      after.recentActions.every((action) => action.status.length > 0 && action.at.length > 0),
      "every action carries a measured status and time",
    );
    assert.ok(
      after.recentActions.some((action) => /collect/.test(action.goalId ?? "") && action.verification === "verified"),
      "each action is attributed to the goal it served, with its verification state",
    );
    assert.ok(after.skillMetrics.length > 0);
    const collect = after.skillMetrics.find((entry) => entry.skillId === "minecraft.collect-log");
    assert.ok(collect && collect.successes >= 1, "per-skill counters are folded from completed skills");
    const learning = after.learning;
    assert.ok(learning, "a learner attached to the run must be reported");
    assert.ok(learning.episodes >= result.actions.length, "each attempted action became an episode");
    assert.equal(learning.runs, 1);
    assert.ok(learning.lastRun && learning.lastRun.episodes === result.actions.length);
    const safety = after.safety;
    assert.ok(safety);
    assert.ok(safety.actionsApproved > 0);
    assert.equal(safety.actionsDenied, 0);
    assert.ok(
      (after.connection.sequence ?? 0) >= (before.connection.sequence ?? 0),
      "the runtime sequence only moves forward",
    );
    assert.ok(after.world.exploredCells > 0);
  } finally {
    await fixture.close();
  }
});

test("operator commands move the safety broker and the adapter, not just the UI", async () => {
  const fixture = await startFixture();
  try {
    const paused = await fixture.command("pause", "operator stepped away");
    assert.equal(paused.status, 200);
    assert.equal((await fixture.snapshots()).safety?.paused, true);
    assert.equal((await fixture.snapshots()).safety?.pauseReason, "operator stepped away");
    assert.equal((await fixture.snapshots()).agent.state, "paused");

    // A run started while paused is refused instead of silently un-pausing the agent.
    const refused = await fixture.command("startTask", { kind: "gather-logs" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message ?? "", /paused/i);

    const resumed = await fixture.command("resume");
    assert.equal(resumed.status, 200);
    assert.equal((await fixture.snapshots()).safety?.paused, false);

    const tripped = await fixture.command("trip", "saw something I did not like");
    assert.equal(tripped.status, 200);
    const trippedSnapshot = await fixture.snapshots();
    assert.equal(trippedSnapshot.safety?.tripped, true);
    assert.equal(trippedSnapshot.agent.state, "tripped", "the hold is visible in the agent state, not only in safety");

    // While tripped, the action path is denied at the broker: the denial is visible in the same counters.
    const rejectedAction = await fixture.skills.run("minecraft.navigate", { x: 4, y: -60, z: 4, range: 1 });
    assert.equal(rejectedAction.action.status, "rejected");
    assert.equal((await fixture.snapshots()).safety?.actionsDenied, 1);
    assert.equal(
      (await fixture.snapshots()).safety?.recentVerdicts[0]?.code,
      "RUN_TRIPPED",
      "the refusal reason is shown, not swallowed",
    );

    // An independent pause must survive a trip reset, or "reset the trip" would be a hidden unpause.
    const pauseAgain = await fixture.command("pause", "waiting for a person");
    assert.equal(pauseAgain.status, 200);
    const reset = await fixture.command("resetTrip");
    assert.equal(reset.status, 200);
    assert.equal((await fixture.snapshots()).safety?.paused, true, "resetTrip must not release an explicit pause");
    const resumeAfterReset = await fixture.command("resume");
    assert.equal(resumeAfterReset.status, 200);
    const cleared = await fixture.snapshots();
    assert.equal(cleared.safety?.tripped, false);
    assert.equal(cleared.safety?.paused, false);

    const combat = await fixture.command("enableCombat", { enabled: true });
    assert.equal(combat.status, 200);
    assert.equal(fixture.adapter.combatAllowed, true, "the adapter itself must accept attacks");
    const armed = await fixture.snapshots();
    assert.equal(armed.combatAllowed, true);
    assert.deepEqual(armed.safety?.optedInCapabilities, ["minecraft.attack_hostile"]);

    const disarmed = await fixture.command("enableCombat", { enabled: false });
    assert.equal(disarmed.status, 200);
    assert.equal(fixture.adapter.combatAllowed, false);
    assert.deepEqual((await fixture.snapshots()).safety?.optedInCapabilities, []);

    const budget = await fixture.command("setActionBudget", { maxActions: 40 });
    assert.equal(budget.status, 200);
    assert.equal((await fixture.snapshots()).safety?.maxActionsPerRun, 40);
    const tooBig = await fixture.command("setActionBudget", { maxActions: 5_000 });
    assert.equal(tooBig.status, 409);
    assert.match(tooBig.body.message ?? "", /between 1 and 100/);
  } finally {
    await fixture.close();
  }
});

test("a stop request ends the run at the next check instead of burning the rest of the budget", async () => {
  const fixture = await startFixture({ scenarioId: "recovery-persistent-stall", stopAfterActions: 2 });
  try {
    const task = {
      ...taskFromControlCenterRequest({ kind: "gather-logs", count: 8 }),
      maxActions: 40,
    };
    const result = await fixture.runTask(task);
    assert.equal(result.status, "aborted");
    assert.equal(result.failure?.code, "OPERATOR_STOP");
    assert.match(result.failure?.message ?? "", /operator is taking over/);
    assert.equal(result.actions.length, 2, "the stop takes effect at the next check, not mid-action");
    assert.ok(result.actions.length < 40, "the run stopped early instead of burning its whole budget");
    const snapshot = await fixture.snapshots();
    assert.equal(snapshot.agent.state, "stopped");
    assert.equal(snapshot.agent.taskId, task.id);
    assert.equal(snapshot.agent.failure?.code, "OPERATOR_STOP");
    assert.ok(
      snapshot.recentFailures.some((entry) => entry.kind === "run" && entry.summary.includes("aborted")),
      "the aborted run is listed among the failures the operator can read",
    );
  } finally {
    await fixture.close();
  }
});

test("the HTTP surface refuses unknown commands, unauthenticated writes and unknown task kinds", async () => {
  const fixture = await startFixture();
  try {
    const base = new URL(fixture.host.handle?.url ?? "", "http://127.0.0.1").toString();
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).title, "GameMind");

    const unauthenticated = await fetch(`${base}/api/command`, { method: "POST", body: "{}" });
    assert.equal(unauthenticated.status, 403);
    const wrongToken = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "x-gamemind-token": "not-the-token" },
      body: "{}",
    });
    assert.equal(wrongToken.status, 403);

    const unknown = await fixture.command("launchRockets");
    assert.equal(unknown.status, 501, "a control the host cannot honour must not look accepted");
    assert.match(unknown.body.message ?? "", /not available in this run/);

    const badKind = await fixture.command("startTask", { kind: "pvp" });
    assert.equal(badKind.status, 409);
    assert.match(badKind.body.message ?? "", /Unknown task kind 'pvp'/);

    const badResource = await fixture.command("startTask", { kind: "mine-stone", resource: "diamond_block" });
    assert.equal(badResource.status, 409);
    assert.match(badResource.body.message ?? "", /not a mineable block/);

    const startWhileBusy = await fixture.runTask(taskFromControlCenterRequest({ kind: "gather-logs" })).then(
      () => fixture.command("stopTask"),
      () => undefined,
    );
    assert.equal(startWhileBusy?.status, 409, "stopping a finished task reports that nothing is running");

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<canvas id="minimap"/);
    assert.match(html, /id="boot-data"/);
    assert.ok(!html.includes("__CONTROL_TOKEN__"), "the token placeholder must be replaced when serving");
    assert.ok(html.includes(fixture.host.handle?.token ?? "missing"), "the served page carries this server's token");
    const clientScript = await (await fetch(`${base}/app.js`)).text();
    for (const route of ["/api/snapshot", "/api/command", "/api/stream"]) {
      assert.ok(clientScript.includes(route), `the UI must call ${route} on this same server`);
    }
    for (const asset of ["styles.css", "app.js", "index.html"]) {
      const response = await fetch(`${base}/${asset}`);
      assert.equal(response.status, 200, `${asset} must be served from the package, not a CDN`);
      const body = await response.text();
      assert.ok(
        !/https?:\/\/(?!127\.0\.0\.1|localhost|www\.w3\.org)/.test(body),
        `${asset} must not reference external origins: the dashboard runs with no network access`,
      );
      assert.ok(!/<link[^>]+href=["']http/.test(body) && !/<script[^>]+src=["']http/.test(body), `${asset} must not load remote code`);
    }
    const missing = await fetch(`${base}/../etc/passwd`);
    assert.ok(missing.status === 404 || missing.status === 403, "path escapes are refused");
  } finally {
    await fixture.close();
  }
});

test("the event stream pushes snapshots and trace events without a second request", async () => {
  const fixture = await startFixture();
  try {
    const base = new URL(fixture.host.handle?.url ?? "", "http://127.0.0.1").toString();
    const response = await fetch(`${base}/api/stream`, { headers: { accept: "text/event-stream" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body?.getReader();
    assert.ok(reader, "the stream must be readable");
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 10_000;
    let frame: ControlCenterSnapshot | null = null;
    while (!frame && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const marker = buffer.indexOf("event: snapshot\ndata: ");
      if (marker >= 0) {
        const start = marker + "event: snapshot\ndata: ".length;
        const end = buffer.indexOf("\n\n", start);
        if (end > start) {
          frame = JSON.parse(buffer.slice(start, end)) as ControlCenterSnapshot;
        }
      }
    }
    assert.ok(frame, "the server must push a snapshot frame on connect");
    const seen = frame as ControlCenterSnapshot;
    assert.equal(seen.connection.adapterStatus, "connected");
    assert.equal(seen.connection.server, "explore-remote-log#101");
    // A state change is visible in the next pushed frame, proving the stream follows the runtime.
    await fixture.command("pause", "streamed pause");
    let sawPause = false;
    while (!sawPause && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      sawPause = /"pauseReason":"streamed pause"/.test(buffer);
    }
    assert.ok(sawPause, "the pushed frame must carry the operator's pause reason");
    await fixture.command("resume");

    // The stream also carries individual trace events, so the panels follow the loop action by action.
    void fixture.command("startTask", { kind: "gather-logs", count: 1 });
    let sawTraceEvent = "";
    while (!sawTraceEvent && Date.now() < deadline + 15_000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const match = /event: trace\ndata: (\{.*?\})\n\n/.exec(buffer);
      if (match?.[1]) {
        const parsed = JSON.parse(match[1]) as { eventType?: string };
        if (parsed.eventType) sawTraceEvent = parsed.eventType;
      }
    }
    assert.ok(sawTraceEvent, "trace events must be pushed, not only polled");
    reader.cancel().catch(() => undefined);
  } finally {
    await fixture.close();
  }
});

test("the event ring keeps recovery and refusal evidence for the whole run", async () => {
  const fixture = await startFixture({ scenarioId: "recovery-persistent-stall" });
  try {
    const task = taskFromControlCenterRequest({ kind: "gather-logs", count: 4 });
    const result = await fixture.runTask(task);
    assert.notEqual(result.status, "succeeded", "this world is built so the task cannot be completed");
    const snapshot = await fixture.snapshots();
    assert.equal(snapshot.agent.status, result.status);
    assert.ok(snapshot.recentFailures.length > 0, "the dashboard shows why the run did not succeed");
    assert.ok(
      snapshot.recentFailures.some((entry) => entry.kind === "run" && entry.summary.includes(result.status)),
      "the run outcome itself is reported as a failure entry",
    );
    assert.ok(snapshot.recentDecisions.length > 0);
    const decision = snapshot.recentDecisions[0];
    assert.equal(decision?.eventType, "decision.made");
    assert.ok(decision && typeof decision.data === "object");
    assert.ok(
      Array.isArray(decision?.data.rejected) ? (decision.data.rejected as readonly unknown[]).length >= 0 : true,
      "decision payloads stay available for inspection",
    );
    assert.ok(snapshot.goal, "the last decision drives the goal card");
    assert.equal(typeof snapshot.goal?.bandLabel, "string");
  } finally {
    await fixture.close();
  }
});

test("policy commands refuse without evidence and roll back what was learned", async () => {
  const fixture = await startFixture();
  try {
    const empty = await fixture.command("promotePolicy");
    assert.equal(empty.status, 409);
    assert.match(empty.body.message ?? "", /Nothing learned yet/);

    await fixture.runTask(taskFromControlCenterRequest({ kind: "gather-logs", count: 1 }));
    const promoted = await fixture.command("promotePolicy");
    assert.equal(promoted.status, promoted.body.ok ? 200 : 409, `promotion reported: ${promoted.body.message}`);
    const afterPromote = await fixture.snapshots();
    const promotedLearning = afterPromote.learning;
    assert.ok(promotedLearning);
    if (promoted.status === 200) {
      assert.ok(promotedLearning.activePolicy, "a promoted policy becomes the active one");
      assert.match(promotedLearning.activePolicy?.id ?? "", /^(baseline|learned)-/);
      assert.ok(promotedLearning.history[0]?.promoted, "the promotion is recorded in the history");
    } else {
      assert.match(
        promoted.body.message ?? "",
        /contradicted|baseline/,
        "the valid refusals are contradicted evidence or a candidate that never left the baseline",
      );
    }
    const rejected = await fixture.command("rejectPolicy");
    assert.equal(rejected.status, 200);
    const afterReject = (await fixture.snapshots()).learning;
    assert.ok(afterReject);
    assert.equal(afterReject.activePolicy, null, "a rollback must remove the active override, not hide it");
  } finally {
    await fixture.close();
  }
});

test("task requests are validated through the same schemas the CLI uses", () => {
  const gather = taskFromControlCenterRequest({ kind: "gather-logs", resource: "birch_log", count: 3 });
  assert.equal(gather.kind, "gather_resource");
  assert.equal(gather.targetCount, 3);
  assert.equal((gather as { resourceName: string }).resourceName, "birch_log");
  assert.equal(gather.maxActions, 12, "unset limits keep the schema defaults");

  const mine = taskFromControlCenterRequest({ kind: "mine-stone", resource: "deepslate_iron_ore", count: 2 });
  assert.equal(mine.kind, "mine_resource");

  const food = taskFromControlCenterRequest({ kind: "secure-food", count: 14 });
  assert.equal(food.kind, "secure_food");
  assert.equal((food as { targetHunger: number }).targetHunger, 14);

  const craft = taskFromControlCenterRequest({ kind: "craft-wooden-pickaxe" });
  assert.equal(craft.kind, "craft_item");

  assert.throws(() => taskFromControlCenterRequest({ kind: "kill-player" }), /Unknown task kind/);
  assert.throws(() => taskFromControlCenterRequest({ kind: "gather-logs", resource: "cobblestone" }), /not a log/);
  assert.throws(() => taskFromControlCenterRequest({ kind: "gather-logs", count: 999 }));
});

test("the evaluation panel reads the offline report and refuses to invent numbers", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-control-center-report-"));
  try {
    const missing = await readEvaluationSummary(path.join(directory, "absent.json"));
    assert.equal(missing.generatedAt, null);
    assert.equal(missing.passed, null);
    assert.equal(missing.learning, null);
    assert.equal(missing.model, null);

    const file = path.join(directory, "offline-report.json");
    await writeFile(
      file,
      JSON.stringify({
        generatedAt: "2026-01-01T00:00:00.000Z",
        passed: true,
        model: "minecraft-priority-utility.v3",
        seedCount: 20,
        totals: { runs: 400, successRate: 0.75, unsafeActions: 0 },
        scenarios: [{ scenarioId: "a" }, { scenarioId: "b" }, { scenarioId: "c" }],
        learning: [
          {
            scenarioId: "a",
            cold: { actions: 5, wastedActions: 5, successRate: 0 },
            repeated: { actions: 0, wastedActions: 0, successRate: 0 },
            passed: true,
          },
          {
            scenarioId: "b",
            cold: { actions: 2, wastedActions: 1, successRate: 1 },
            repeated: { actions: 2, wastedActions: 1, successRate: 1 },
            passed: true,
          },
        ],
      }),
      "utf8",
    );
    const summary = await readEvaluationSummary(file);
    assert.equal(summary.runs, 400);
    assert.equal(summary.successRate, 0.75);
    assert.equal(summary.unsafeActions, 0);
    assert.equal(summary.passed, true);
    assert.equal(summary.model, "minecraft-priority-utility.v3");
    assert.equal(summary.seedsPerScenario, 20);
    assert.equal(summary.scenarios, 3, "the scenario count comes from the report body");
    assert.deepEqual(summary.learning, {
      baselineWastedActions: 6,
      candidateWastedActions: 1,
      scenarios: 2,
      improved: 1,
      passed: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
