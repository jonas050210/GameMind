import assert from "node:assert/strict";
import test from "node:test";
import type { LitematicBlueprint } from "../src/games/minecraft/litematic-importer.js";
import {
  LITEMATICA_PLACEMENT_MAX_AGE_MS,
  LITEMATICA_PLACEMENT_MAX_FUTURE_SKEW_MS,
  LitematicPlacementError,
  LitematicPlacementGuard,
  signLitematicaBridgeMessage,
  type LitematicPlacementReport,
} from "../src/games/minecraft/litematica-placement-guard.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;
const HASH = "a".repeat(64);

const blueprint: LitematicBlueprint = {
  format: "litematic",
  sourceName: "Test house",
  author: "test",
  sourceSha256: HASH,
  sourceBytes: 100,
  dimensions: { x: 2, y: 1, z: 1 },
  sourceBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 0 } },
  regions: [{ name: "main", position: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 1 }, volume: 2, nonAirBlocks: 1 }],
  blocks: [],
  materials: { "minecraft:oak_planks": 1 },
  ignoredEntities: 0,
  ignoredBlockEntities: 0,
  warnings: [],
};

function report(overrides: Partial<LitematicPlacementReport> = {}): LitematicPlacementReport {
  return {
    protocolVersion: 1,
    clientInstanceId: "client-1",
    sequence: 1,
    sentAtMs: NOW,
    placementId: "placement-1",
    blueprintSha256: HASH,
    worldId: "world-save-1",
    dimension: "minecraft:overworld",
    origin: { x: 10, y: 64, z: -3 },
    rotation: 0,
    mirror: "none",
    enabledRegions: ["main"],
    bounds: { min: { x: 10, y: 64, z: -3 }, max: { x: 11, y: 64, z: -3 } },
    ...overrides,
  };
}

function signed(reportValue: LitematicPlacementReport, token = TOKEN): { body: Buffer; signature: string } {
  const body = Buffer.from(JSON.stringify(reportValue), "utf8");
  return { body, signature: signLitematicaBridgeMessage(body, token) };
}

function receive(guard: LitematicPlacementGuard, value: LitematicPlacementReport, now = NOW): ReturnType<LitematicPlacementGuard["receive"]> {
  const message = signed(value);
  return guard.receive(message.body, message.signature, now);
}

test("fresh authenticated report binds exact blueprint, regions, bounds, and review fingerprint", () => {
  const guard = new LitematicPlacementGuard(blueprint, TOKEN);
  const snapshot = receive(guard, report());
  assert.equal(snapshot.approved, false);
  assert.equal(snapshot.report.worldId, "world-save-1");
  assert.equal(snapshot.expiresAtMs, NOW + LITEMATICA_PLACEMENT_MAX_AGE_MS);
  const approval = guard.approve(snapshot.fingerprint, NOW + 1);
  assert.equal(approval.fingerprint, snapshot.fingerprint);
  assert.equal(guard.requireApproval(snapshot.fingerprint, NOW + 2).placementId, "placement-1");

  const heartbeat = receive(guard, report({ sequence: 2, sentAtMs: NOW + 2 }), NOW + 2);
  assert.equal(heartbeat.fingerprint, snapshot.fingerprint, "heartbeat sequence and timestamp do not change placement identity");
  assert.equal(heartbeat.approved, true);
});

test("transform, world, dimension, client, and placement changes invalidate the prior approval", () => {
  const changes: Array<Partial<LitematicPlacementReport>> = [
    { origin: { x: 11, y: 64, z: -3 }, bounds: { min: { x: 11, y: 64, z: -3 }, max: { x: 12, y: 64, z: -3 } }, sequence: 2 },
    { rotation: 180, sequence: 2 },
    { mirror: "left_right", sequence: 2 },
    { worldId: "different-world", sequence: 2 },
    { dimension: "minecraft:the_nether", sequence: 2 },
    { placementId: "placement-2", sequence: 2 },
    { clientInstanceId: "client-2", sequence: 0 },
  ];
  for (const change of changes) {
    const guard = new LitematicPlacementGuard(blueprint, TOKEN);
    const initial = receive(guard, report());
    guard.approve(initial.fingerprint, NOW + 1);
    const changed = receive(guard, report({ ...change, sentAtMs: NOW + 2 }), NOW + 2);
    assert.notEqual(changed.fingerprint, initial.fingerprint);
    assert.equal(changed.approved, false);
    assert.throws(() => guard.requireApproval(changed.fingerprint, NOW + 2), LitematicPlacementError);
  }
});

test("invalid signatures, replays, stale heartbeats, and invalid timestamps fail closed", () => {
  const guard = new LitematicPlacementGuard(blueprint, TOKEN);
  const original = signed(report());
  assert.throws(() => guard.receive(original.body, "0".repeat(64), NOW), /signature is invalid/);
  assert.equal(guard.snapshot(NOW), null);

  receive(guard, report(), NOW);
  assert.throws(() => receive(guard, report(), NOW + 1), /replay or arrived out of sequence/);
  assert.equal(guard.snapshot(NOW + 1), null);

  const staleGuard = new LitematicPlacementGuard(blueprint, TOKEN);
  assert.throws(
    () => receive(staleGuard, report({ sentAtMs: NOW - LITEMATICA_PLACEMENT_MAX_AGE_MS - 1 }), NOW),
    /stale or its clock/,
  );
  assert.throws(
    () => receive(new LitematicPlacementGuard(blueprint, TOKEN), report({ sentAtMs: NOW + LITEMATICA_PLACEMENT_MAX_FUTURE_SKEW_MS + 1 }), NOW),
    /stale or its clock/,
  );
});

test("blueprint hash, full region set, and transformed dimensions must match", () => {
  const cases: Array<{ value: LitematicPlacementReport; message: RegExp }> = [
    { value: report({ blueprintSha256: "b".repeat(64) }), message: /does not match/ },
    { value: report({ enabledRegions: [] }), message: /every imported Litematic region/ },
    { value: report({ bounds: { min: { x: 10, y: 64, z: -3 }, max: { x: 12, y: 64, z: -3 } } }), message: /bounds do not match/ },
    { value: report({ origin: { x: 11, y: 64, z: -3 } }), message: /origin must equal/ },
    { value: report({ worldId: "world\u202espoof" }), message: /worldId.*invalid/ },
  ];
  for (const item of cases) {
    const guard = new LitematicPlacementGuard(blueprint, TOKEN);
    assert.throws(() => receive(guard, item.value), item.message);
    assert.equal(guard.snapshot(NOW), null);
  }
});

test("approval expires with heartbeat lease, and malformed reports clear the current review", () => {
  const guard = new LitematicPlacementGuard(blueprint, TOKEN);
  const snapshot = receive(guard, report());
  guard.approve(snapshot.fingerprint, NOW + 1);
  assert.equal(guard.snapshot(NOW + LITEMATICA_PLACEMENT_MAX_AGE_MS), null);
  assert.match(guard.invalidationReason ?? "", /expired/);
  assert.throws(() => guard.requireApproval(snapshot.fingerprint, NOW + LITEMATICA_PLACEMENT_MAX_AGE_MS), /No current approval/);

  const second = receive(guard, report({ sequence: 2, sentAtMs: NOW + 6_000 }), NOW + 6_000);
  guard.approve(second.fingerprint, NOW + 6_000);
  const bad = signed(report({ sequence: 3, sentAtMs: NOW + 6_001, placementId: "invalid placement id" }));
  assert.throws(() => guard.receive(bad.body, bad.signature, NOW + 6_001), /unsupported characters/);
  assert.equal(guard.snapshot(NOW + 6_001), null);
});

test("bridge HMAC helpers reject short secrets and sign exact request bytes", () => {
  const body = Buffer.from('{"sequence":1}', "utf8");
  const signature = signLitematicaBridgeMessage(body, TOKEN);
  assert.equal(signature.length, 64);
  assert.equal(receive(new LitematicPlacementGuard(blueprint, TOKEN), report()).report.sequence, 1);
  assert.throws(() => new LitematicPlacementGuard(blueprint, "short"), /at least 32 UTF-8 bytes/);
  assert.throws(() => signLitematicaBridgeMessage(body, "short"), /at least 32 UTF-8 bytes/);
  assert.throws(() => new LitematicPlacementGuard(blueprint, TOKEN).receive(body, signature, NOW), /JSON|protocol/);
});
