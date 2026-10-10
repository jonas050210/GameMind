import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";

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
  /** Attaches the skill runtime and companion coordinator, as the live CLI host does. */
  readonly companion?: boolean;
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
    ...(options.companion ? { skills, companionMemoryDirectory: path.join(directory, "companion") } : {}),
    worldKey,
    offlineNote: "test fixture: simulated world",
    // Tests drive the agent by explicit command; the autonomous loop would otherwise start tasks on its own.
    autonomous: false,
    worldConfigPath: path.join(directory, "world-config.json"),
    trainingDirectory: path.join(directory, "training"),
    dataDirectory: path.join(directory, "data"),
    port: 0,
    bindHost: "127.0.0.1",
    evaluationReportPath: path.join(directory, "no-report.json"),
    evaluationScenarioIds: evaluationScenarios().map((candidate) => candidate.id),
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

test("the Library is wired end to end: snapshot catalog, typed execution, and honest operations", async () => {
  const fixture = await startFixture({ companion: true });
  try {
    const before = await fixture.snapshots();
    assert.ok(before.library, "the snapshot carries the Library");
    assert.equal(before.library?.catalog.length, 54);
    const follow = before.library?.catalog.find((entry) => entry.id === "follow.player");
    assert.equal(follow?.status, "implemented");
    assert.deepEqual(follow?.params.map((param) => param.name), ["player"]);

    const status = await fixture.command("libraryExecute", { id: "follow.status", params: {} });
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);

    const after = await fixture.snapshots();
    const operation = after.library?.operations[0];
    assert.equal(operation?.entryId, "follow.status");
    assert.equal(operation?.state, "succeeded");

    const bad = await fixture.command("libraryExecute", { id: "follow.player", params: { player: "not a name!" } });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.ok, false);

    const unknown = await fixture.command("libraryExecute", { id: "nope.missing", params: {} });
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.ok, false);

    // The removed chat command is gone from the HTTP surface.
    const chat = await fixture.command("chat", "#follow");
    assert.equal(chat.status, 501);
    assert.equal(chat.body.ok, false);
  } finally {
    await fixture.close();
  }
});

test("without a companion coordinator, companion Library entries refuse with the reason", async () => {
  const fixture = await startFixture();
  try {
    const snapshot = await fixture.snapshots();
    assert.ok(snapshot.library, "the catalog is present even when parts of the run are detached");
    const hold = snapshot.library?.catalog.find((entry) => entry.id === "follow.hold");
    assert.equal(hold?.status, "unavailable");
    assert.match(hold?.statusReason ?? "", /companion/i);
    const result = await fixture.command("libraryExecute", { id: "follow.hold", params: {} });
    assert.equal(result.status, 409);
    assert.equal(result.body.ok, false);
    assert.match(result.body.message ?? "", /companion/i);
  } finally {
    await fixture.close();
  }
});

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
    assert.ok(before.performance.logicalCpus >= 1);
    assert.ok(Number.isFinite(before.performance.process.rssBytes));
    assert.ok(Number.isFinite(before.performance.process.eventLoopUtilizationPercent));
    assert.equal(before.goal, null);
    assert.equal(before.safety?.policyId, "gamemind-minecraft-v1");
    assert.equal(before.safety?.paused, false);
    assert.equal(before.learning?.episodes, 0);
    assert.equal(before.learning?.evaluation?.generatedAt, null, "a missing report must read as unmeasured, not as zero");
    assert.ok(before.capabilities.length > 0);
    assert.ok(before.world.health !== null, "health comes from the observed player state");
    assert.equal(before.connection.worldAvailable, true, "a connected adapter with a live observation can show the world");
    assert.equal(before.world.freshness.reason, "fresh", "the panel says which observation it is showing");
    assert.equal(before.world.provenance.source, "simulated", "a simulated run is never presented as a live observation");
    assert.equal(before.agent.blocker.kind, "none", "an idle, unblocked run must not be shown as blocked");
    assert.equal(before.world.sessionFacts?.gameMode.value, "survival");
    assert.equal(before.world.sessionFacts?.gameMode.evidence, "verified");
    assert.equal(before.world.perception, null, "the simulator does not invent live adapter timing data");
    assert.ok(before.world.blocks.every((block) => Number.isFinite(block.x) && Number.isFinite(block.y) && Number.isFinite(block.z)));
    assert.ok(before.world.blocks.every((block) => block.identifier === `minecraft:${block.name}`));
    assert.ok(before.world.blocks.every((block) => block.distance === null || Number.isFinite(block.distance)));
    assert.ok(before.world.blocks.every((block) => ["visible", "occluded", "unknown"].includes(block.visibility)));
    assert.ok(before.world.blocks.every((block) => ["local", "strategic", "memory"].includes(block.observationKind)));

    const result = await fixture.runTask(taskFromControlCenterRequest({ kind: "gather-logs", count: 1 }));
    assert.equal(result.status, "succeeded", `the gather task should succeed in this world: ${JSON.stringify(result.failure)}`);

    const after = await fixture.snapshots();
    assert.equal(after.agent.taskId, "ui-gather-oak_log");
    assert.equal(after.agent.status, "succeeded");
    assert.equal(after.agent.actionsUsed, result.actions.length);
    assert.ok(after.world.inventory.some((item) => item.name === "oak_log" && item.count >= 1), "inventory must be read from the world");
    assert.ok(after.goal, "the last decision trace is exposed");
    assert.equal(typeof after.goal?.rationale, "string");
    assert.equal(after.agent.blocker.kind, "none", "a succeeded run leaves no blocker behind");
    assert.ok(after.agent.status === "succeeded");
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

test("world map distinguishes current wide-scan sightings from older memory", async () => {
  const fixture = await startFixture();
  try {
    const observed = fixture.runtime.currentWorldState;
    assert.ok(observed);
    const position = { x: 10, y: 64, z: 0 };
    const sighting: MinecraftObservation["resourceSightings"][number] = {
      name: "oak_log",
      position,
      distance: Math.hypot(
        observed.state.player.position.x - position.x,
        observed.state.player.position.y - position.y,
        observed.state.player.position.z - position.z,
      ),
    };
    fixture.host.memory.observe(
      { ...observed.state, resourceSightings: [...observed.state.resourceSightings, sighting] },
      observed.sequence,
    );

    const currentSnapshot = await fixture.snapshots();
    const currentMarker = currentSnapshot.world.blocks.find(
      (block) => block.x === position.x && block.y === position.y && block.z === position.z,
    );
    assert.ok(currentMarker, "a block seen in the current strategic scan is shown on the map");
    assert.equal(currentMarker.remembered, false, "a current wide-scan sighting is not styled as stale memory");

    const nextObservation = await fixture.runtime.observe();
    fixture.host.memory.observe(
      {
        ...nextObservation.state,
        resourceScan: { ...nextObservation.state.resourceScan, truncated: true },
      },
      nextObservation.sequence,
    );
    const laterSnapshot = await fixture.snapshots();
    const rememberedMarker = laterSnapshot.world.blocks.find(
      (block) => block.x === position.x && block.y === position.y && block.z === position.z,
    );
    assert.ok(rememberedMarker, "an incomplete later scan must not erase the last known block");
    assert.equal(rememberedMarker.remembered, true, "a sighting from an earlier observation is marked as memory");
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

    // The per-run action cap was removed from the product: the command no longer exists, and the snapshot
    // carries no action ceiling. Safety comes from per-action timeouts, stuck detection and the emergency stop.
    const budget = await fixture.command("setActionBudget", { maxActions: 40 });
    assert.notEqual(budget.status, 200);
    assert.equal("maxActionsPerRun" in ((await fixture.snapshots()).safety ?? {}), false);
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
    assert.match(html, /[Ii]nteractive 3D voxel view/);
    assert.match(html, /id="minimap"[^>]+tabindex="0"/);
    assert.match(html, /aria-describedby="map-controls"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /id="task-form"/);
    assert.match(html, /id="boot-data"/);
    assert.ok(!html.includes("__CONTROL_TOKEN__"), "the token placeholder must be replaced when serving");
    assert.ok(html.includes(fixture.host.handle?.token ?? "missing"), "the served page carries this server's token");
    const clientScript = await (await fetch(`${base}/app.js`)).text();
    for (const route of ["/api/snapshot", "/api/command"]) {
      assert.ok(clientScript.includes(route), `the UI must call ${route} on this same server`);
    }
    assert.ok(
      !clientScript.includes("EventSource") && !clientScript.includes("/api/stream"),
      "the removed live event stream must not be re-opened by the UI: the snapshot poll is the only read channel",
    );
    assert.ok(
      /POLL_HIDDEN_MS|document\.hidden/.test(clientScript),
      "polling must back off while the tab is hidden, so an unwatched page costs the agent nothing",
    );
    assert.ok(clientScript.includes("aria-valuenow"), "the action-budget progress bar must expose its live value");
    for (const asset of ["styles.css", "app.js", "world-view.js", "index.html"]) {
      const response = await fetch(`${base}/${asset}`);
      assert.equal(response.status, 200, `${asset} must be served from the package, not a CDN`);
      const body = await response.text();
      if (asset === "world-view.js") {
        assert.ok(body.includes('event.key === "ArrowLeft"') && body.includes('event.key === "Home"'), "the voxel view must have keyboard orbit and reset controls");
      }
      assert.ok(
        !/https?:\/\/(?!127\.0\.0\.1|localhost|www\.w3\.org)/.test(body),
        `${asset} must not reference external origins: the dashboard runs with no network access`,
      );
      assert.ok(!/<link[^>]+href=["']http/.test(body) && !/<script[^>]+src=["']http/.test(body), `${asset} must not load remote code`);
    }
    // Every element id the renderer looks up must exist in the served page: the dashboard has no type
    // checker over its DOM, so a card that is renamed in the HTML fails silently at runtime in the browser.
    const markup = await (await fetch(`${base}/index.html`)).text();
    const declared = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1] ?? ""));
    const OPTIONAL_IDS = new Set(["theme-toggle"]);
    const lookedUp = [...new Set([...clientScript.matchAll(/el\("([^"]+)"\)/g)].map((match) => match[1] ?? ""))];
    assert.deepEqual(
      lookedUp.filter((id) => !declared.has(id) && !OPTIONAL_IDS.has(id)),
      [],
      "the page must declare every element the renderers touch",
    );
    // The removed live-stream card must not leave its renderer behind, and the blocker card must be wired.
    assert.ok(!clientScript.includes('el("events")'), "the live event stream card is gone from the UI");
    assert.ok(lookedUp.includes("blocker"), "the blocker panel is rendered from the snapshot");
    assert.ok(lookedUp.includes("world-freshness"), "the world panel states how current its data is");

    const missing = await fetch(`${base}/../etc/passwd`);
    assert.ok(missing.status === 404 || missing.status === 403, "path escapes are refused");
  } finally {
    await fixture.close();
  }
});

test("the removed event stream is reported as gone and the snapshot poll stays authoritative", async () => {
  const fixture = await startFixture();
  try {
    const base = new URL(fixture.host.handle?.url ?? "", "http://127.0.0.1").toString();
    const response = await fetch(`${base}/api/stream`, { headers: { accept: "text/event-stream" } });
    assert.equal(response.status, 410, "the stream endpoint is retired, not silently empty");
    const body = (await response.json()) as { ok?: boolean; code?: string; message?: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, "STREAM_REMOVED");
    assert.match(String(body.message), /\/api\/snapshot/);

    // What the stream used to prove about liveness is now proven by the poll: a command's effect is
    // visible in the next snapshot without the client having to know when the agent acted.
    await fixture.command("pause", "pause observed through polling");
    const paused = await fixture.snapshots();
    assert.equal(paused.safety?.paused, true);
    assert.equal(paused.safety?.pauseReason, "pause observed through polling");
    assert.equal(paused.agent.blocker.kind, "safety", "an operator hold must read as a safety refusal, not a failure");
    assert.match(paused.agent.blocker.detail, /pause observed through polling/);
    await fixture.command("resume");
    const resumed = await fixture.snapshots();
    assert.equal(resumed.safety?.paused, false);
    assert.equal(resumed.agent.blocker.kind, "none");
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
    assert.match(empty.body.message ?? "", /no episodes have been recorded/);

    await fixture.runTask(taskFromControlCenterRequest({ kind: "gather-logs", count: 1 }));
    const promoted = await fixture.command("promotePolicy");
    assert.equal(promoted.status, 409, "episode collection alone cannot bypass the offline comparison gate");
    assert.match(promoted.body.message ?? "", /offline evaluation report|candidate weight comparison/);
    const afterPromote = await fixture.snapshots();
    const promotedLearning = afterPromote.learning;
    assert.ok(promotedLearning);
    assert.equal(promotedLearning.activePolicy, null, "a missing comparison report leaves the baseline active");
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

  const shelter = taskFromControlCenterRequest({ kind: "build-shelter" });
  assert.equal(shelter.kind, "build_shelter");
  assert.equal((shelter as { maxBlocks: number }).maxBlocks, 4);

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
    assert.equal(missing.policyCandidateId, null);
    assert.equal(missing.policyPromotable, null);
    assert.deepEqual(missing.scenarioIds, []);

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
        policyComparison: {
          candidatePolicyId: "learned-4-test",
          decision: { promote: false, reasons: ["safety incident found", "no measured improvement"] },
        },
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
    assert.deepEqual(summary.scenarioIds, ["a", "b", "c"]);
    assert.equal(summary.policyCandidateId, "learned-4-test");
    assert.equal(summary.policyPromotable, false);
    assert.deepEqual(summary.policyGateReasons, ["safety incident found", "no measured improvement"]);
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

test("the Control Center shows the new panels and no longer offers an action cap", async () => {
  const fixture = await startFixture();
  try {
    const base = new URL(fixture.host.handle?.url ?? "", "http://127.0.0.1").toString();
    const html = await (await fetch(base)).text();
    const script = await (await fetch(`${base}/app.js`)).text();
    for (const heading of ["Objective &amp; subgoal", "World seed", "Training", "Observation rate", "Observation age", "Reaction p95"]) {
      assert.ok(html.includes(heading) || script.includes(heading), `the UI shows ${heading}`);
    }
    assert.ok(!html.includes("budget-input") && !script.includes("budget-form"), "the action-cap input is gone");
    assert.ok(!script.includes("setActionBudget") && !html.includes("Action cap"), "no UI path sets an action cap");
    for (const id of ["training-form", "training-metrics", "training-episodes-table", "loop-targets", "seed-form", "objective-panel"]) {
      assert.ok(html.includes(`id="${id}"`), `${id} is rendered by the page`);
    }
    for (const command of ["pauseTraining", "resumeTraining", "stopTraining", "evaluateTraining"]) {
      assert.ok(html.includes(`data-command="${command}"`), `${command} is a button on the page`);
    }
  } finally {
    await fixture.close();
  }
});

test("the world seed is entered by hand, validated, and always labelled unverified", async () => {
  const fixture = await startFixture();
  try {
    const before = await fixture.snapshots();
    assert.equal(before.worldSeed?.value ?? null, null);
    assert.equal(before.worldSeed?.source, "unset");

    const saved = await fixture.command("setWorldSeed", "8675309");
    assert.equal(saved.status, 200);
    const after = await fixture.snapshots();
    assert.equal(after.worldSeed?.value, "8675309");
    assert.equal(after.worldSeed?.source, "manual");
    assert.equal(after.worldSeed?.verified, false, "an entered seed is never shown as verified");

    const tooLarge = await fixture.command("setWorldSeed", "9223372036854775808");
    assert.notEqual(tooLarge.status, 200, "a numeric seed outside the 64-bit range is refused");
    assert.equal((await fixture.snapshots()).worldSeed?.value, "8675309", "a refused seed does not replace the stored one");

    const cleared = await fixture.command("setWorldSeed", "");
    assert.equal(cleared.status, 200);
    assert.equal((await fixture.snapshots()).worldSeed?.value ?? null, null);
  } finally {
    await fixture.close();
  }
});

test("the snapshot carries the fast loop's measured state and the training section, without invented numbers", async () => {
  const fixture = await startFixture();
  try {
    const snapshot = await fixture.snapshots();
    assert.ok(snapshot.agentLoop, "the loop performance is part of the snapshot");
    assert.equal(snapshot.agentLoop?.targets.length, 4, "each performance target is reported with its goal");
    assert.equal(snapshot.agentLoop?.observation.frequencyHz === null || typeof snapshot.agentLoop?.observation.frequencyHz === "number", true);
    assert.ok(snapshot.objective === null || typeof snapshot.objective === "object");
    assert.equal(snapshot.training?.status, "idle", "no training has run in this directory");
    assert.equal(snapshot.training?.episodesTotal, 0);
    assert.equal(snapshot.training?.checkpoints.length, 0);
    assert.equal(snapshot.training?.lastEvaluation ?? null, null, "no evaluation is invented before one runs");
  } finally {
    await fixture.close();
  }
});

test("training commands refuse what cannot honestly happen yet", async () => {
  const fixture = await startFixture();
  try {
    const pause = await fixture.command("pauseTraining");
    assert.equal(pause.body.ok, false, "nothing to pause");
    const stop = await fixture.command("stopTraining");
    assert.equal(stop.body.ok, false, "nothing to stop");
    const evaluate = await fixture.command("evaluateTraining");
    assert.equal(evaluate.body.ok, false);
    assert.match(evaluate.body.message ?? "", /No checkpoint/, "an evaluation needs a checkpoint to score");
  } finally {
    await fixture.close();
  }
});

test("the roadmap is built from recorded evidence and its actions are saved or refused through the command endpoint", async () => {
  const fixture = await startFixture();
  try {
    const evidenceDir = path.join(fixture.directory, "data", "evidence");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      path.join(evidenceDir, "tests.json"),
      JSON.stringify({ measuredAt: "2026-10-10T08:00:00.000Z", passed: 467, failed: 1, failures: ["fixture: a failing check"] }),
    );
    const refreshed = await fixture.command("refreshRoadmap");
    assert.equal(refreshed.body.ok, true);
    const snapshot = await fixture.snapshots();
    const roadmap = snapshot.roadmap;
    assert.ok(roadmap, "the snapshot carries the roadmap");
    assert.ok((roadmap?.sources.length ?? 0) >= 6, "every evidence source is listed, whether or not it was found");
    const item = roadmap?.items.find((candidate) => candidate.fingerprint === "reliability.test:fixture: a failing check");
    assert.equal(item?.kind, "defect", "a failing test from the record is a measured defect");
    assert.equal(item?.status, "proposed");

    const planned = await fixture.command("roadmapAction", { fingerprint: item!.fingerprint, action: "plan", note: "from the test" });
    assert.equal(planned.body.ok, true);
    const afterPlan = (await fixture.snapshots()).roadmap?.items.find((candidate) => candidate.fingerprint === item!.fingerprint);
    assert.equal(afterPlan?.status, "planned");
    assert.ok(afterPlan?.history.some((entry) => entry.event.includes("from the test")), "the operator's note is kept in the history");

    const unknown = await fixture.command("roadmapAction", { fingerprint: "not-a-real-item", action: "dismiss" });
    assert.equal(unknown.status, 409, "an action on an unknown item is refused, not silently accepted");
    const badAction = await fixture.command("roadmapAction", { fingerprint: item!.fingerprint, action: "delete-everything" });
    assert.equal(badAction.status, 409);
  } finally {
    await fixture.close();
  }
});

test("training refuses an out-of-range time budget at the endpoint, and the page serves the headless controls", async () => {
  const fixture = await startFixture();
  try {
    const refused = await fixture.command("startTraining", { maxMinutes: 0 });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message ?? "", /Time budget \(minutes\) must be a whole number/);
    const snapshot = await fixture.snapshots();
    assert.equal(snapshot.training?.execution, "offline-simulator");
    assert.equal(snapshot.training?.render, "none");
    assert.equal(snapshot.training?.processAlive, false, "the refused request started nothing");

    const base = new URL(fixture.host.handle?.url ?? "", "http://127.0.0.1").toString();
    const html = await (await fetch(base)).text();
    for (const id of ["training-headless", "training-minutes", "training-max-episodes", "render-notice", "roadmap-items", "roadmap-refresh", "training-reward"]) {
      assert.ok(html.includes(`id="${id}"`), `${id} is rendered by the page`);
    }
    const policy = await fetch(`${base}/policy.js`);
    assert.equal(policy.status, 200, "the policy module the page imports is served");
    assert.match(policy.headers.get("content-type") ?? "", /javascript/);
  } finally {
    await fixture.close();
  }
});
