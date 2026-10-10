/**
 * Water handling on the Mineflayer double: recognition, the reflexes that respond to drowning, the decision that
 * leaves the water, the swim executor, and the postcondition that verifies it. Offline unit evidence only; the live
 * server has not been reached for these checks (see docs/LIVE_VERIFICATION.md).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isHazardBlockName, isWaterBlockName, observedHazards } from "../src/games/minecraft/block-classes.js";
import { MINECRAFT_SWIM_TO_SURFACE_CAPABILITY, minecraftSwimToSurfaceInputSchema } from "../src/games/minecraft/capabilities.js";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { assessReflex } from "../src/games/minecraft/reflex.js";
import { verifySkillPostcondition } from "../src/games/minecraft/skill-contracts.js";
import { gatherResourceTaskSchema } from "../src/games/minecraft/task.js";
import { createLiveMock, connectAdapter, Vec } from "./support/minecraft-double.js";

/** Water fills x in [-2, 1], y in [56, 63]; land (stone, with air above) starts at x = 2 and rises to y = 62. */
function buildLake(mock: ReturnType<typeof createLiveMock>): void {
  for (let x = -2; x <= 1; x += 1) {
    for (let y = 56; y <= 63; y += 1) {
      for (let z = -2; z <= 2; z += 1) {
        mock.blocks.set(`${x},${y},${z}`, { name: "water", type: 9, boundingBox: "empty" });
      }
    }
  }
  for (let x = 2; x <= 5; x += 1) {
    for (let y = 50; y <= 62; y += 1) {
      for (let z = -2; z <= 2; z += 1) {
        mock.blocks.set(`${x},${y},${z}`, { name: "stone", type: 2, boundingBox: "block" });
      }
    }
  }
}

/** Makes the player's water flags read the live position, as Mineflayer's physics does each tick. */
function bindWaterFlags(mock: ReturnType<typeof createLiveMock>): void {
  const player = mock.bot.entity as unknown as { position: Vec; isInWater?: boolean };
  const waterAt = (x: number, y: number, z: number) => {
    const block = mock.bot.blockAt(new Vec(Math.floor(x), Math.floor(y), Math.floor(z)) as never);
    return block?.name === "water";
  };
  Object.defineProperty(player, "isInWater", {
    configurable: true,
    get: () => waterAt(player.position.x, player.position.y, player.position.z),
  });
}

/** Holding jump rises the player; holding forward steps toward +x. Each control call is one physics step. */
function bindMovement(mock: ReturnType<typeof createLiveMock>): void {
  const bot = mock.bot as unknown as { setControlState: (control: string, on: boolean) => void };
  const player = mock.bot.entity as unknown as { position: Vec };
  bot.setControlState = (control: string, on: boolean) => {
    if (!on) return;
    if (control === "jump") player.position = player.position.offset(0, 0.6, 0);
    if (control === "forward") player.position = player.position.offset(0.6, 0, 0);
  };
}

function withPlayer(state: MinecraftObservation, patch: Partial<MinecraftObservation["player"]>): MinecraftObservation {
  return { ...state, player: { ...state.player, ...patch } };
}

const gatherTask = gatherResourceTaskSchema.parse({
  id: "swim-test",
  kind: "gather_resource",
  resourceName: "oak_log",
  targetCount: 1,
  maxActions: 10,
  maxDurationMs: 60_000,
  maxExplorationLegs: 2,
});

test("water is recognised as water, and is no longer a flee-from hazard", () => {
  assert.equal(isWaterBlockName("water"), true);
  assert.equal(isWaterBlockName("flowing_water"), true);
  assert.equal(isWaterBlockName("lava"), false);
  assert.equal(isHazardBlockName("water"), false, "water is not something to run from");
  assert.equal(isHazardBlockName("lava"), true, "lava still is");
  const hazards = observedHazards(
    [{ name: "water", position: { x: 1, y: 64, z: 0 } }, { name: "lava", position: { x: 2, y: 64, z: 0 } }],
    { x: 0.5, y: 64, z: 0.5 },
  );
  assert.deepEqual(hazards.map((hazard) => hazard.name), ["lava"]);
});

test("submerged with little air is an urgent drowning reflex; a body in water is a notice; dry land is quiet", async () => {
  const mock = createLiveMock();
  buildLake(mock);
  bindWaterFlags(mock);
  const adapter = await connectAdapter(mock);
  const base = (await adapter.observe()).state;

  const drowning = assessReflex(withPlayer(base, { headInWater: true, inWater: true, oxygenLevel: 150 }));
  assert.ok(drowning.urgentCodes.includes("DROWNING"), "150 air ticks under water is urgent");

  const breathing = assessReflex(withPlayer(base, { headInWater: true, inWater: true, oxygenLevel: 290 }));
  assert.equal(breathing.urgentCodes.includes("DROWNING"), false, "a fresh breath is not urgent yet");
  assert.ok(breathing.reasons.some((reason) => reason.code === "IN_WATER" && reason.severity === "notice"));

  const bodyOnly = assessReflex(withPlayer(base, { headInWater: false, inWater: true, oxygenLevel: 300 }));
  assert.equal(bodyOnly.urgentCodes.length, 0, "a body in water with the head clear is a notice, not an emergency");

  const dry = assessReflex(withPlayer(base, { headInWater: false, inWater: false, oxygenLevel: 300 }));
  assert.equal(dry.reasons.some((reason) => reason.code === "IN_WATER" || reason.code === "DROWNING"), false);
  await adapter.disconnect("test");
});

test("the decision leaves the water before gathering, and the swim is the top choice while the head is under", async () => {
  const mock = createLiveMock();
  buildLake(mock);
  bindWaterFlags(mock);
  const adapter = await connectAdapter(mock);
  const state = (await adapter.observe()).state;
  const model = new MinecraftTaskDecisionModel();
  const context = {
    excludedTargets: new Set<string>(),
    previousFailureCode: null,
    availableSkills: new Set(["minecraft.swim-to-surface", "minecraft.navigate", "minecraft.collect-block"]),
  };

  const submerged = model.decide(withPlayer(state, { headInWater: true, inWater: true, oxygenLevel: 120 }), gatherTask, context, 1);
  assert.equal(submerged.selected?.skillId, "minecraft.swim-to-surface");
  assert.equal(submerged.selected?.goalId, "leave-water");
  assert.equal(submerged.selected?.priorityBand, 0, "leaving water is in the safety band");

  const wading = model.decide(withPlayer(state, { headInWater: false, inWater: true, oxygenLevel: 300 }), gatherTask, context, 2);
  assert.equal(wading.selected?.skillId, "minecraft.swim-to-surface", "a body in water still leaves it first");

  const dry = model.decide(withPlayer(state, { headInWater: false, inWater: false, oxygenLevel: 300 }), gatherTask, context, 3);
  assert.notEqual(dry.selected?.skillId, "minecraft.swim-to-surface", "a dry agent is not sent to swim");
  await adapter.disconnect("test");
});

test("the swim executor rises and steps to the shore, and confirms success only from the observed state", async () => {
  const mock = createLiveMock();
  buildLake(mock);
  bindWaterFlags(mock);
  bindMovement(mock);
  const player = mock.bot.entity as unknown as { position: Vec };
  player.position = new Vec(0.5, 62, 0.5);
  const adapter = await connectAdapter(mock);
  const session = adapter.session;
  assert.ok(session);

  const outcome = await adapter.executeAction(
    {
      actionId: randomUUID(),
      sessionId: session.id,
      capability: MINECRAFT_SWIM_TO_SURFACE_CAPABILITY,
      input: minecraftSwimToSurfaceInputSchema.parse({ maxDistance: 8 }),
    },
    new AbortController().signal,
  );
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.confirmation, "observed_out_of_water");
  const details = outcome.details as { steps: number; shore: unknown };
  assert.ok(details.steps >= 1, "the executor took at least one physics step");
  assert.ok(details.shore !== null, "a shore was found within range");

  const after = (await adapter.observe()).state;
  assert.equal(after.player.headInWater, false, "the next observation agrees: the head is out of water");
  assert.equal(after.player.inWater, false, "and so does the body");
  await adapter.disconnect("test");
});

test("a swim that is already complete is confirmed without moving", async () => {
  const mock = createLiveMock();
  buildLake(mock);
  bindWaterFlags(mock);
  bindMovement(mock);
  (mock.bot.entity as unknown as { position: Vec }).position = new Vec(4.5, 64, 0.5);
  const adapter = await connectAdapter(mock);
  const session = adapter.session;
  assert.ok(session);
  const outcome = await adapter.executeAction(
    {
      actionId: randomUUID(),
      sessionId: session.id,
      capability: MINECRAFT_SWIM_TO_SURFACE_CAPABILITY,
      input: { maxDistance: 8 },
    },
    new AbortController().signal,
  );
  assert.equal(outcome.confirmation, "observed_out_of_water_before_swim");
  assert.equal((outcome.details as { steps: number }).steps, 0);
  await adapter.disconnect("test");
});

test("an aborted swim is never reported as success", async () => {
  const mock = createLiveMock();
  buildLake(mock);
  bindWaterFlags(mock);
  // Movement does nothing: the agent stays submerged, so the swim can only end by abort.
  (mock.bot as unknown as { setControlState: () => void }).setControlState = () => undefined;
  (mock.bot.entity as unknown as { position: Vec }).position = new Vec(0.5, 62, 0.5);
  const adapter = await connectAdapter(mock);
  const session = adapter.session;
  assert.ok(session);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 250);
  await assert.rejects(
    adapter.executeAction(
      {
        actionId: randomUUID(),
        sessionId: session.id,
        capability: MINECRAFT_SWIM_TO_SURFACE_CAPABILITY,
        input: { maxDistance: 8 },
      },
      controller.signal,
    ),
  );
  await adapter.disconnect("test");
});

test("the swim postcondition verifies only a real transition from water to the surface", () => {
  const wet = { player: { inWater: true, headInWater: true } } as unknown as MinecraftObservation;
  const dry = { player: { inWater: false, headInWater: false } } as unknown as MinecraftObservation;
  const stillWet = { player: { inWater: true, headInWater: false } } as unknown as MinecraftObservation;
  assert.equal(verifySkillPostcondition("minecraft.swim-to-surface", {}, wet, dry).verified, true);
  assert.equal(verifySkillPostcondition("minecraft.swim-to-surface", {}, wet, stillWet).verified, false);
  assert.equal(verifySkillPostcondition("minecraft.swim-to-surface", {}, dry, dry).verified, false, "nothing was left behind");
});

/**
 * Regression (live finding): Mineflayer's physics flag is computed from a player box contracted vertically, so it
 * can read false while the feet occupy a water block. The live stand-in showed flag false, feet block `water`, and
 * the swim executor confirmed "out of water" with the feet still submerged. These tests pin the block-data check.
 */
function bindFlagReadsOut(mock: ReturnType<typeof createLiveMock>): void {
  const player = mock.bot.entity as unknown as { isInWater?: boolean };
  Object.defineProperty(player, "isInWater", { configurable: true, get: () => false });
}

test("a body whose feet are in water is in water even when the physics flag reads false", async () => {
  const mock = createLiveMock();
  buildLake(mock);
  bindFlagReadsOut(mock);
  // Feet inside the top water cell (y 63); the head (eye at y 64.62) is in air.
  (mock.bot.entity as unknown as { position: Vec }).position = new Vec(0.5, 63, 0.5);
  const adapter = await connectAdapter(mock);
  const observed = (await adapter.observe()).state.player;
  assert.equal(observed.headInWater, false, "the head is clear");
  assert.equal(observed.inWater, true, "the feet are in water, so the body is in water");
  await adapter.disconnect("test");
});

test("the swim keeps stepping until the feet are clear, even when the physics flag reads false", async () => {
  const mock = createLiveMock();
  buildLake(mock);
  bindFlagReadsOut(mock);
  bindMovement(mock);
  // Head clear from the start: the old exit test (flag and head only) would confirm at once with feet submerged.
  (mock.bot.entity as unknown as { position: Vec }).position = new Vec(0.5, 63, 0.5);
  const adapter = await connectAdapter(mock);
  const session = adapter.session;
  assert.ok(session);
  const outcome = await adapter.executeAction(
    {
      actionId: randomUUID(),
      sessionId: session.id,
      capability: MINECRAFT_SWIM_TO_SURFACE_CAPABILITY,
      input: minecraftSwimToSurfaceInputSchema.parse({ maxDistance: 8 }),
    },
    new AbortController().signal,
  );
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.confirmation, "observed_out_of_water");
  assert.ok((outcome.details as { steps: number }).steps >= 1, "the feet were in water, so the executor had to swim");
  const after = mock.bot.blockAt(new Vec(Math.floor(mock.bot.entity.position.x), Math.floor(mock.bot.entity.position.y), Math.floor(mock.bot.entity.position.z)) as never);
  assert.notEqual(after?.name, "water", "the feet block is no longer water when the swim is confirmed");
  await adapter.disconnect("test");
});
