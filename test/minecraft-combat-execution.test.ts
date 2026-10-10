/**
 * Melee execution regressions on the Mineflayer double. The double only emits what the adapter is documented to
 * listen for (`entityHurt`, `entityDead`); whether a real server emits them in this order is a live question, listed
 * in docs/LIVE_VERIFICATION.md. Offline results here are unit-level evidence, not live evidence.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MINECRAFT_ATTACK_HOSTILE_CAPABILITY } from "../src/games/minecraft/capabilities.js";
import { attackCooldownMs } from "../src/games/minecraft/combat.js";
import { verifySkillPostcondition } from "../src/games/minecraft/skill-contracts.js";
import { createLiveMock, connectAdapter, run, Vec } from "./support/minecraft-double.js";

interface Hostile {
  id: number;
  name: string;
  type: string;
  position: Vec;
  velocity: Vec;
  yaw: number;
  pitch: number;
  onGround: boolean;
  health: number;
}

function addHostile(mock: ReturnType<typeof createLiveMock>, x: number, z: number): Hostile {
  const hostile: Hostile = {
    id: 5,
    name: "zombie",
    type: "hostile",
    position: new Vec(x, 64, z),
    velocity: new Vec(0, 0, 0),
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
  };
  (mock.bot.entities as unknown as Record<number, unknown>)[hostile.id] = hostile;
  return hostile;
}

interface SwingScript {
  /** Which swing (1-based) kills the hostile; 0 means never. */
  readonly killOnSwing: number;
  /** When true, the hostile is removed from the list without any death event (render-distance edge). */
  readonly vanishInsteadOfDying?: boolean;
}

/**
 * Wires the double so that each swing is recorded with its time, emits the server-side hurt event, and on the
 * configured swing emits death (or silently removes the entity). The pathfinder moves the agent to the given side of
 * the hostile when a follow goal is set, which is how the adapter closes the gap.
 */
function armCombat(mock: ReturnType<typeof createLiveMock>, hostile: Hostile, script: SwingScript, approachPosition?: Vec) {
  const bot = mock.bot as unknown as {
    attack: (target: Hostile) => void;
    pathfinder: { setGoal: (goal: unknown, dynamic?: boolean) => void };
    emit: (event: string, ...args: unknown[]) => boolean;
    entities: Record<number, unknown>;
  };
  const swings: number[] = [];
  (bot as unknown as { lookAt: () => Promise<void> }).lookAt = async () => undefined;
  bot.attack = (target: Hostile) => {
    swings.push(Date.now());
    const swing = swings.length;
    queueMicrotask(() => {
      if (swing === script.killOnSwing) {
        if (script.vanishInsteadOfDying) {
          delete bot.entities[target.id];
        } else {
          bot.emit("entityDead", target);
          delete bot.entities[target.id];
        }
      } else {
        target.health -= 4;
        bot.emit("entityHurt", target);
      }
    });
  };
  bot.pathfinder.setGoal = (goal: unknown) => {
    if (goal && approachPosition) (mock.bot.entity as { position: unknown }).position = approachPosition;
  };
  return { swings };
}

test("attack approaches a hostile beyond reach, swings at the weapon's cooldown, and confirms the kill only from entityDead", async () => {
  const mock = createLiveMock();
  mock.addItem("wooden_sword", 1);
  const hostile = addHostile(mock, 4.5, 0.5);
  const script = armCombat(mock, hostile, { killOnSwing: 2 }, new Vec(3.1, 64, 0.5));
  const adapter = await connectAdapter(mock, { allowCombat: true });

  const outcome = await run(adapter, MINECRAFT_ATTACK_HOSTILE_CAPABILITY, {
    entityId: "5",
    maxHits: 4,
    dangerRadius: 6,
    minHealth: 10,
    retreatHealth: 6,
    requiredDamage: 4,
  });

  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.confirmation, "server_entity_dead_event");
  assert.equal((outcome.details as { outcome: string }).outcome, "killed");
  assert.equal(script.swings.length, 2, "the first swing hurt it, the second killed it");
  const gap = script.swings[1]! - script.swings[0]!;
  assert.ok(gap >= attackCooldownMs("wooden_sword") - 25, `swings are ${gap} ms apart, at least the sword cooldown`);
  assert.equal((outcome.details as { hitsConfirmed: number }).hitsConfirmed, 1, "one hurt event confirmed the first swing");
  await adapter.disconnect("test");
});

test("a hostile that vanishes from the entity list without a death event is reported as lost, never as killed", async () => {
  const mock = createLiveMock();
  mock.addItem("wooden_sword", 1);
  const hostile = addHostile(mock, 4.5, 0.5);
  armCombat(mock, hostile, { killOnSwing: 1, vanishInsteadOfDying: true }, new Vec(3.1, 64, 0.5));
  const adapter = await connectAdapter(mock, { allowCombat: true });

  const outcome = await run(adapter, MINECRAFT_ATTACK_HOSTILE_CAPABILITY, {
    entityId: "5",
    maxHits: 4,
    dangerRadius: 6,
    minHealth: 10,
    retreatHealth: 6,
    requiredDamage: 4,
  });
  assert.equal(outcome.confirmed, false, "leaving the list is not a kill");
  assert.equal((outcome.details as { outcome: string }).outcome, "target_lost_from_view");
  await adapter.disconnect("test");
});

test("no swing is taken when the hostile is behind a wall: the agent repositions, then reports no line of sight", async () => {
  const mock = createLiveMock();
  mock.addItem("wooden_sword", 1);
  const hostile = addHostile(mock, 2.5, 0.5);
  // Solid blocks between the agent and the hostile at eye and chest height.
  mock.blocks.set("1,64,0", { name: "stone", type: 2, boundingBox: "block" });
  mock.blocks.set("1,65,0", { name: "stone", type: 2, boundingBox: "block" });
  // Repositioning keeps the agent on the same side of the wall, so the line stays blocked.
  const script = armCombat(mock, hostile, { killOnSwing: 0 }, new Vec(0.5, 64, 0.5));
  const adapter = await connectAdapter(mock, { allowCombat: true });

  await assert.rejects(
    run(adapter, MINECRAFT_ATTACK_HOSTILE_CAPABILITY, {
      entityId: "5",
      maxHits: 4,
      dangerRadius: 6,
      minHealth: 10,
      retreatHealth: 6,
      requiredDamage: 4,
    }),
    (error: { code?: string }) => error.code === "COMBAT_NO_LINE_OF_SIGHT",
  );
  assert.equal(script.swings.length, 0, "no swing was thrown through a wall");
  await adapter.disconnect("test");
});

test("a hostile beyond the approach limit is refused before any swing or movement", async () => {
  const mock = createLiveMock();
  mock.addItem("wooden_sword", 1);
  const hostile = addHostile(mock, 9.5, 0.5);
  const script = armCombat(mock, hostile, { killOnSwing: 1 });
  const adapter = await connectAdapter(mock, { allowCombat: true });

  await assert.rejects(
    run(adapter, MINECRAFT_ATTACK_HOSTILE_CAPABILITY, {
      entityId: "5",
      maxHits: 4,
      dangerRadius: 6,
      minHealth: 10,
      retreatHealth: 6,
      requiredDamage: 4,
    }),
    (error: { code?: string }) => error.code === "COMBAT_OUT_OF_RANGE",
  );
  assert.equal(script.swings.length, 0);
  await adapter.disconnect("test");
});

test("weapon cooldowns follow approximate vanilla attack speeds, with bare hands the fastest", () => {
  assert.equal(attackCooldownMs("wooden_sword"), 625);
  assert.equal(attackCooldownMs("iron_axe"), 1_100);
  assert.equal(attackCooldownMs("wooden_axe"), 1_000);
  assert.equal(attackCooldownMs("iron_pickaxe"), 833);
  assert.equal(attackCooldownMs(null), 250, "bare hands swing faster than any tool");
  assert.ok(attackCooldownMs("wooden_sword") > attackCooldownMs(null));
});

test("the attack postcondition does not count a target that merely left view as killed", () => {
  const observation = (entities: Array<{ id: string; distance: number }>) =>
    ({ entities: entities.map((entity) => ({ ...entity, name: "zombie", type: "hostile", position: { x: 0, y: 0, z: 0 }, health: null })) }) as never;
  const near = observation([{ id: "5", distance: 2 }]);
  const gone = observation([]);
  const farBefore = observation([{ id: "5", distance: 20 }]);

  const verified = verifySkillPostcondition("minecraft.attack-hostile", { entityId: "5" }, near, gone);
  assert.equal(verified.verified, true, "a near target that is gone is verified");

  const unverified = verifySkillPostcondition("minecraft.attack-hostile", { entityId: "5" }, farBefore, gone);
  assert.equal(unverified.verified, false, "a target that was far away before is not verified as removed by this swing");
});
