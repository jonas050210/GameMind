import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { parseCompanionCommand } from "../src/games/minecraft/companion-command.js";
import { CompanionMemory } from "../src/games/minecraft/companion-memory.js";
import { CompanionController } from "../src/games/minecraft/companion-controller.js";
import { WorldMemory } from "../src/games/minecraft/world-memory.js";
import { observationAt } from "./support/observations.js";

const logger = pino({ level: "silent" });

test("validated companion commands cover every supported behavior and reject unsafe arguments", () => {
  const commands = [
    "#follow Alex", "#come Alex", "#hold", "#combat", "#afk Alex", "#guard", "#home", "#return",
    "#gather birch 4", "#explore", "#status", "#unstuck", "#stop",
  ];
  for (const input of commands) assert.ok(parseCompanionCommand(input, "Alex").command, input);
  assert.deepEqual(parseCompanionCommand("#gather birch 4").command, { type: "gather", resource: "birch_log", count: 4 });
  assert.equal(parseCompanionCommand("#gather diamond 100").command, null);
  assert.match(parseCompanionCommand("#gather oak 0").error ?? "", /1 through 64/);
});

test("named homepoint commands validate and normalize names without changing legacy #home", () => {
  assert.deepEqual(parseCompanionCommand("#sethome MainBase").command, { type: "save-home", name: "mainbase" });
  assert.deepEqual(parseCompanionCommand("#home mine").command, { type: "go-home", name: "mine" });
  assert.deepEqual(parseCompanionCommand("#home").command, { type: "save-home", name: "default" });
  assert.deepEqual(parseCompanionCommand("#homes").command, { type: "list-homes" });
  assert.deepEqual(parseCompanionCommand("#delhome farm").command, { type: "delete-home", name: "farm" });
  assert.equal(parseCompanionCommand("#sethome ../base").command, null);
  assert.equal(parseCompanionCommand("#sethome two names").command, null);
});

test("bounded natural-language teamwork requests map to dependent verified objectives", () => {
  assert.deepEqual(parseCompanionCommand("we need more wood", "Alex").command, { type: "gather", resource: "oak_log", count: 8 });
  assert.equal(parseCompanionCommand("help me build a house", "Alex").command?.type, "build-shelter");
  assert.deepEqual(parseCompanionCommand("come with me", "Alex").command, { type: "set-mode", mode: "follow", targetPlayer: "Alex" });
  assert.equal(parseCompanionCommand("become omnipotent", "Alex").command, null);
});

test("companion home, mode and task outcome memory persists per world", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-companion-"));
  try {
    const memory = await CompanionMemory.open(directory, "world-a");
    await memory.update({
      home: { x: 4.5, y: 64, z: -2.5, dimension: "overworld", savedAt: new Date().toISOString(), observationSequence: 7 },
      preferredMode: "hold",
      storage: [{ blockName: "chest", x: 8, y: 64, z: 2, dimension: "overworld", lastSeenAt: new Date().toISOString(), lastSeenSequence: 7 }],
      lastTask: { id: "gather", status: "blocked", at: new Date().toISOString(), failureCode: "NO_TARGET" },
    });
    const restored = await CompanionMemory.open(directory, "world-a");
    assert.equal(restored.snapshot().home?.x, 4.5);
    assert.equal(restored.snapshot().preferredMode, "hold");
    assert.equal(restored.snapshot().storage[0]?.blockName, "chest");
    assert.equal(restored.snapshot().lastTask?.failureCode, "NO_TARGET");
    const other = await CompanionMemory.open(directory, "world-b");
    assert.equal(other.snapshot().home, null, "locations never cross world identities");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function controllerFixture(options: { targetDistance?: number | null; navigationStatus?: "succeeded" | "failed"; dimension?: string; observedAt?: string } = {}) {
  const distance = options.targetDistance === undefined ? 10 : options.targetDistance;
  const entities = distance === null ? [] : [{ id: "2", name: "Alex", type: "player", position: { x: 0.5 + distance, y: 64, z: 0.5 }, distance, health: 20 }];
  const base = observationAt({ x: 0.5, y: 64, z: 0.5 }, { entities });
  base.player.dimension = options.dimension ?? "overworld";
  const world = { schemaVersion: 1, gameId: "minecraft-java", gameVersion: "1.20.4", sessionId: "s", sequence: 1, observedAt: options.observedAt ?? new Date().toISOString(), receivedAt: new Date().toISOString(), state: base };
  const calls: Array<{ skill: string; input: unknown }> = [];
  let stopReason: string | null = null;
  let combat = false;
  const runtime = {
    currentWorldState: world,
    status: () => ({ adapterStatus: "connected" }),
    observeIfStale: async () => world,
  };
  const skills = {
    run: async (skill: string, input: unknown) => {
      calls.push({ skill, input });
      const status = options.navigationStatus ?? "succeeded";
      return { action: { status, confirmed: status === "succeeded", confirmation: status === "succeeded" ? "test_verified" : null, failure: status === "failed" ? { message: "path blocked" } : null } };
    },
  };
  return { runtime, skills, calls, world, state: base, stop: () => stopReason, setStop: (reason: string) => { stopReason = reason; }, combat: () => combat, setCombat: (value: boolean) => { combat = value; } };
}

test("named homepoints persist, reject duplicates, look up by name, and delete explicitly", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-homepoints-"));
  try {
    const memory = await CompanionMemory.open(directory, "named-world");
    const location = { x: 12.5, y: 70, z: -8.5, dimension: "overworld", savedAt: new Date().toISOString(), observationSequence: 11 };
    assert.equal((await memory.createHomepoint("mainbase", location)).ok, true);
    assert.equal((await memory.createHomepoint("broken", { ...location, x: Number.NaN })).ok, false, "coordinates are validated at the memory boundary");
    assert.equal((await memory.createHomepoint("mainbase", { ...location, x: 99 })).ok, false, "duplicates never silently overwrite");
    assert.equal(memory.homepoint("mainbase")?.location.x, 12.5);
    const restored = await CompanionMemory.open(directory, "named-world");
    assert.equal(restored.homepoint("mainbase")?.location.z, -8.5);
    assert.equal(await restored.deleteHomepoint("mainbase"), true);
    assert.equal(await restored.deleteHomepoint("mainbase"), false);
    assert.equal((await CompanionMemory.open(directory, "named-world")).homepoint("mainbase"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("follow, come, hold, combat and stop transitions are explicit and interruptible", async () => {
  const fixture = controllerFixture();
  const memory = await CompanionMemory.open(null, "test-world");
  const controller = new CompanionController({
    runtime: fixture.runtime as never,
    skills: fixture.skills as never,
    memory: new WorldMemory(),
    companionMemory: memory,
    logger,
    runTask: async () => { throw new Error("not used"); },
    taskRunning: () => false,
    requestTaskStop: fixture.setStop,
    setCombatAllowed: (enabled) => { fixture.setCombat(enabled); return { ok: true, message: "ok" }; },
    intervalMs: 5,
  });

  assert.equal((await controller.submit("#follow Alex", "control-center")).ok, true);
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.stop();
  assert.ok(fixture.calls.some((call) => call.skill === "minecraft.navigate"), "follow uses the shared verified navigation skill");
  assert.equal(controller.snapshot().mode, "follow");

  assert.equal((await controller.submit("#combat", "control-center")).ok, true);
  assert.equal(fixture.combat(), true);
  assert.equal(controller.snapshot().mode, "combat");

  assert.equal((await controller.submit("#hold", "control-center")).ok, true);
  assert.equal(controller.snapshot().mode, "hold");
  assert.ok(controller.snapshot().anchor);

  assert.equal((await controller.submit("#stop", "control-center")).ok, true);
  assert.equal(controller.snapshot().mode, "idle");
  assert.match(fixture.stop() ?? "", /stopped by/);
});

test("homepoint navigation reports lookup, stale coordinates, and dimension availability honestly", async () => {
  const fixture = controllerFixture();
  const memory = await CompanionMemory.open(null, "home-navigation-world");
  const controller = new CompanionController({
    runtime: fixture.runtime as never, skills: fixture.skills as never, memory: new WorldMemory(), companionMemory: memory, logger,
    runTask: async () => { throw new Error("not used"); }, taskRunning: () => false, requestTaskStop: fixture.setStop,
    setCombatAllowed: () => ({ ok: true, message: "ok" }), intervalMs: 5,
  });
  assert.equal((await controller.submit("#sethome mainbase", "control-center")).ok, true);
  assert.equal((await controller.submit("#sethome mainbase", "control-center")).ok, false);
  assert.match((await controller.submit("#homes", "control-center")).message, /mainbase: overworld/);
  assert.equal((await controller.submit("#home missing", "control-center")).ok, false);

  await memory.createHomepoint("mine", { x: 20, y: 64, z: 0, dimension: "overworld", savedAt: new Date(0).toISOString(), observationSequence: 0 });
  const goMine = await controller.submit("#home mine", "control-center");
  assert.equal(goMine.ok, true);
  assert.match(goMine.message, /stale.*revalidation/i);
  assert.equal(controller.snapshot().activeHomepoint, "mine");
  assert.equal(controller.snapshot().homepoints.find((entry) => entry.name === "mine")?.availability, "stale");
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 15));
  controller.stop();
  assert.ok(fixture.calls.some((call) => call.skill === "minecraft.navigate" && (call.input as { x: number }).x === 20));

  await memory.createHomepoint("oldfarm", { x: 0.5, y: 64, z: 0.5, dimension: "overworld", savedAt: new Date(0).toISOString(), observationSequence: 0 });
  await controller.submit("#home oldfarm", "control-center");
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.stop();
  assert.equal(controller.snapshot().homepoints.find((entry) => entry.name === "oldfarm")?.availability, "available", "a fresh observed arrival revalidates stale coordinates");

  await memory.createHomepoint("netherfarm", { x: 1, y: 64, z: 1, dimension: "the_nether", savedAt: new Date().toISOString(), observationSequence: 1 });
  const mismatch = await controller.submit("#home netherfarm", "control-center");
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.message, /No verified cross-dimension route/);
  assert.equal((await controller.submit("#delhome mainbase", "control-center")).ok, true);
  assert.equal(memory.homepoint("mainbase"), null);
});

test("follow uses measured distance, hysteresis, catch-up priority, and obstacle outcomes", async () => {
  for (const sample of [
    { distance: 4, status: "succeeded" as const, expectedState: "close", calls: 0 },
    { distance: 10, status: "succeeded" as const, expectedState: "following", calls: 1 },
    { distance: 30, status: "succeeded" as const, expectedState: "catching-up", calls: 1 },
    { distance: 40, status: "succeeded" as const, expectedState: "catching-up", calls: 1 },
    { distance: 10, status: "failed" as const, expectedState: "blocked", calls: 1 },
  ]) {
    const fixture = controllerFixture({ targetDistance: sample.distance, navigationStatus: sample.status });
    const controller = new CompanionController({
      runtime: fixture.runtime as never, skills: fixture.skills as never, memory: new WorldMemory(),
      companionMemory: await CompanionMemory.open(null, `follow-${sample.distance}-${sample.status}`), logger,
      runTask: async () => { throw new Error("not used"); }, taskRunning: () => false, requestTaskStop: () => undefined,
      setCombatAllowed: () => ({ ok: true, message: "ok" }), intervalMs: 50,
    });
    await controller.submit("#follow Alex", "control-center");
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 65));
    controller.stop();
    assert.equal(controller.snapshot().measuredSeparation, sample.distance);
    assert.equal(controller.snapshot().followState, sample.expectedState);
    assert.equal(fixture.calls.length, sample.calls);
    if (fixture.calls.length) assert.equal((fixture.calls[0]?.input as { range: number }).range, 4, "navigation preserves the preferred follow range");
    if (sample.distance > 32) assert.match(controller.snapshot().lastOutcome ?? "", /exceeds the normal 32-block target.*no claim/i);
  }
});

test("follow refreshes navigation from the player's newly observed movement", async () => {
  const fixture = controllerFixture({ targetDistance: 10 });
  const controller = new CompanionController({
    runtime: fixture.runtime as never, skills: fixture.skills as never, memory: new WorldMemory(),
    companionMemory: await CompanionMemory.open(null, "moving-follow"), logger,
    runTask: async () => { throw new Error("not used"); }, taskRunning: () => false, requestTaskStop: () => undefined,
    setCombatAllowed: () => ({ ok: true, message: "ok" }), intervalMs: 12,
  });
  await controller.submit("#follow Alex", "control-center");
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 16));
  const target = fixture.state.entities[0];
  assert.ok(target);
  target.position = { x: 20.5, y: 64, z: 0.5 };
  target.distance = 20;
  fixture.world.observedAt = new Date().toISOString();
  fixture.world.sequence += 1;
  await new Promise((resolve) => setTimeout(resolve, 17));
  controller.stop();
  const destinations = fixture.calls.map((call) => (call.input as { x: number }).x);
  assert.ok(destinations.includes(10.5));
  assert.ok(destinations.includes(20.5), "the next cycle uses the newly observed position rather than the previous coordinate");
});

test("follow refuses to move toward stale player coordinates", async () => {
  const fixture = controllerFixture({ targetDistance: 12, observedAt: new Date(Date.now() - 10_000).toISOString() });
  const controller = new CompanionController({
    runtime: fixture.runtime as never, skills: fixture.skills as never, memory: new WorldMemory(),
    companionMemory: await CompanionMemory.open(null, "stale-follow"), logger,
    runTask: async () => { throw new Error("not used"); }, taskRunning: () => false, requestTaskStop: () => undefined,
    setCombatAllowed: () => ({ ok: true, message: "ok" }), intervalMs: 5,
  });
  await controller.submit("#follow Alex", "control-center");
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 12));
  controller.stop();
  assert.equal(fixture.calls.length, 0);
  assert.equal(controller.snapshot().followState, "observation-stale");
});

test("lost follow targets stop movement and recover by holding instead of wandering", async () => {
  const fixture = controllerFixture({ targetDistance: null });
  const controller = new CompanionController({
    runtime: fixture.runtime as never, skills: fixture.skills as never, memory: new WorldMemory(),
    companionMemory: await CompanionMemory.open(null, "lost-player"), logger,
    runTask: async () => { throw new Error("not used"); }, taskRunning: () => false, requestTaskStop: () => undefined,
    setCombatAllowed: () => ({ ok: true, message: "ok" }), intervalMs: 5,
  });
  await controller.submit("#follow Alex", "control-center");
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  controller.stop();
  assert.equal(fixture.calls.length, 0);
  assert.equal(controller.snapshot().mode, "hold");
  assert.equal(controller.snapshot().followState, "holding-lost");
  assert.match(controller.snapshot().reason, /absent.*holding/i);
});

test("a dimension change during follow stops recovery movement", async () => {
  const fixture = controllerFixture({ targetDistance: 10 });
  const controller = new CompanionController({
    runtime: fixture.runtime as never, skills: fixture.skills as never, memory: new WorldMemory(),
    companionMemory: await CompanionMemory.open(null, "follow-dimension"), logger,
    runTask: async () => { throw new Error("not used"); }, taskRunning: () => false, requestTaskStop: () => undefined,
    setCombatAllowed: () => ({ ok: true, message: "ok" }), intervalMs: 5,
  });
  await controller.submit("#follow Alex", "control-center");
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 8));
  fixture.state.player.dimension = "the_nether";
  fixture.state.entities = [];
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.stop();
  assert.equal(controller.snapshot().mode, "hold");
  assert.equal(controller.snapshot().followState, "holding-lost");
  assert.match(controller.snapshot().reason, /last observed in overworld.*the_nether.*holding/i);
});

test("catch-up separation prevents ordinary work from replacing follow priority", async () => {
  const fixture = controllerFixture({ targetDistance: 30 });
  const controller = new CompanionController({
    runtime: fixture.runtime as never, skills: fixture.skills as never, memory: new WorldMemory(),
    companionMemory: await CompanionMemory.open(null, "catchup-priority"), logger,
    runTask: async () => { throw new Error("must not run"); }, taskRunning: () => false, requestTaskStop: () => undefined,
    setCombatAllowed: () => ({ ok: true, message: "ok" }),
  });
  await controller.submit("#follow Alex", "control-center");
  const gather = await controller.submit("#gather oak 2", "control-center");
  assert.equal(gather.ok, false);
  assert.match(gather.message, /catch-up has priority/);
  const explore = await controller.submit("#explore", "control-center");
  assert.equal(explore.ok, false);
  assert.match(explore.message, /catch-up has priority/);
  assert.equal(controller.snapshot().mode, "follow");
});

test("hold reliably requests interruption of an incompatible running task", async () => {
  const fixture = controllerFixture();
  const controller = new CompanionController({
    runtime: fixture.runtime as never, skills: fixture.skills as never, memory: new WorldMemory(),
    companionMemory: await CompanionMemory.open(null, "interrupt-world"), logger,
    runTask: async () => { throw new Error("not used"); }, taskRunning: () => true,
    requestTaskStop: fixture.setStop, setCombatAllowed: () => ({ ok: true, message: "ok" }),
  });
  const result = await controller.submit("#hold", "control-center");
  assert.equal(result.ok, true);
  assert.equal(controller.snapshot().mode, "hold");
  assert.match(fixture.stop() ?? "", /interrupted by companion mode hold/);
});

test("gather chat starts the standard task runner contract and records evidence-based completion", async () => {
  const fixture = controllerFixture();
  const memory = await CompanionMemory.open(null, "task-world");
  let task: { kind?: string; targetCount?: number } | null = null;
  const controller = new CompanionController({
    runtime: fixture.runtime as never,
    skills: fixture.skills as never,
    memory: new WorldMemory(), companionMemory: memory, logger,
    runTask: async (next) => {
      task = next;
      return { taskId: next.id, status: "succeeded", failure: null } as never;
    },
    taskRunning: () => false,
    requestTaskStop: () => undefined,
    setCombatAllowed: () => ({ ok: true, message: "ok" }),
  });
  const accepted = await controller.submit("#gather oak 3", "control-center");
  assert.equal(accepted.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(task);
  const startedTask = task as { kind?: string; targetCount?: number };
  assert.equal(startedTask.kind, "gather_resource");
  assert.equal(startedTask.targetCount, 3);
  assert.match(controller.snapshot().lastOutcome ?? "", /verified game state/);
  assert.equal(memory.snapshot().lastTask?.status, "succeeded");
});
