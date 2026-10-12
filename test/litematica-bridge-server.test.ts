import assert from "node:assert/strict";
import test from "node:test";
import type { LitematicBlueprint } from "../src/games/minecraft/litematic-importer.js";
import { LitematicaBridgeServer } from "../src/games/minecraft/litematica-bridge-server.js";
import {
  LITEMATICA_BRIDGE_MAX_BODY_BYTES,
  LitematicPlacementGuard,
  signLitematicaBridgeMessage,
  type LitematicPlacementReport,
} from "../src/games/minecraft/litematica-placement-guard.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const HASH = "a".repeat(64);
const blueprint: LitematicBlueprint = {
  format: "litematic",
  sourceName: "Test",
  author: "",
  sourceSha256: HASH,
  sourceBytes: 1,
  dimensions: { x: 1, y: 1, z: 1 },
  sourceBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
  regions: [{ name: "main", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, volume: 1, nonAirBlocks: 1 }],
  blocks: [],
  materials: { "minecraft:stone": 1 },
  ignoredEntities: 0,
  ignoredBlockEntities: 0,
  warnings: [],
};

function makeReport(): LitematicPlacementReport {
  return {
    protocolVersion: 1,
    clientInstanceId: "test-client",
    sequence: 1,
    sentAtMs: Date.now(),
    placementId: "test-placement",
    blueprintSha256: HASH,
    worldId: "local-world",
    dimension: "minecraft:overworld",
    origin: { x: 1, y: 64, z: 1 },
    rotation: 0,
    mirror: "none",
    enabledRegions: ["main"],
    bounds: { min: { x: 1, y: 64, z: 1 }, max: { x: 1, y: 64, z: 1 } },
  };
}

async function withServer(
  run: (baseUrl: string, guard: LitematicPlacementGuard, events: number[]) => Promise<void>,
  options: { readonly host?: string; readonly allowNonLoopback?: boolean } = {},
): Promise<void> {
  const guard = new LitematicPlacementGuard(blueprint, TOKEN);
  const events = [0];
  const server = new LitematicaBridgeServer(guard, {
    ...options,
    port: 0,
    token: TOKEN,
    onPlacement: () => { events[0] = (events[0] ?? 0) + 1; },
  });
  try {
    const address = await server.start();
    assert.equal(address.host, options.host ?? "127.0.0.1");
    await run(`http://127.0.0.1:${address.port}`, guard, events);
  } finally {
    await server.close();
  }
}

test("receiver binds loopback by default and accepts only authenticated placement heartbeats", async () => {
  await withServer(async (baseUrl, guard, events) => {
    const report = makeReport();
    const body = Buffer.from(JSON.stringify(report));
    const signature = signLitematicaBridgeMessage(body, TOKEN);
    const response = await fetch(`${baseUrl}/v1/placement`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gamemind-signature": signature },
      body,
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { accepted: boolean; approved: boolean; fingerprint: string };
    assert.equal(payload.accepted, true);
    assert.equal(payload.approved, false);
    assert.equal(payload.fingerprint, guard.snapshot()?.fingerprint);
    assert.equal(events[0], 1);

    const unsupported = await fetch(`${baseUrl}/v1/action`, { method: "POST" });
    assert.equal(unsupported.status, 404, "the receiver must not expose a Minecraft action endpoint");
  });
});

test("receiver rejects missing or invalid HMAC and malformed content types", async () => {
  await withServer(async (baseUrl, guard) => {
    const body = JSON.stringify(makeReport());
    const missing = await fetch(`${baseUrl}/v1/placement`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(missing.status, 401);
    assert.equal(guard.snapshot(), null);

    const invalid = await fetch(`${baseUrl}/v1/placement`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gamemind-signature": "0".repeat(64) },
      body,
    });
    assert.equal(invalid.status, 401);
    assert.equal(guard.snapshot(), null);

    const contentType = await fetch(`${baseUrl}/v1/placement`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });
    assert.equal(contentType.status, 415);
  });
});

test("receiver caps request size, rejects unknown routes, and never treats a malformed report as current", async () => {
  await withServer(async (baseUrl, guard) => {
    const notFound = await fetch(`${baseUrl}/unknown`, { method: "POST", body: "{}" });
    assert.equal(notFound.status, 404);

    const tooLarge = Buffer.alloc(LITEMATICA_BRIDGE_MAX_BODY_BYTES + 1, 0x20);
    const oversized = await fetch(`${baseUrl}/v1/placement`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: tooLarge,
    });
    assert.equal(oversized.status, 413);
    assert.equal(guard.snapshot(), null);

    const malformed = Buffer.from("{not json}");
    const response = await fetch(`${baseUrl}/v1/placement`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gamemind-signature": signLitematicaBridgeMessage(malformed, TOKEN) },
      body: malformed,
    });
    assert.equal(response.status, 400);
    assert.equal(guard.snapshot(), null);
  });
});

test("receiver requires explicit opt-in before non-loopback binding", () => {
  assert.throws(
    () => new LitematicaBridgeServer(new LitematicPlacementGuard(blueprint, TOKEN), { host: "0.0.0.0", port: 39_990, token: TOKEN }),
    /loopback-only/,
  );
  assert.throws(
    () => new LitematicaBridgeServer(new LitematicPlacementGuard(blueprint, TOKEN), { port: 39_990, token: "short" }),
    /at least 32 UTF-8 bytes/,
  );
  assert.throws(
    () => new LitematicaBridgeServer(new LitematicPlacementGuard(blueprint, TOKEN), { port: 65_536, token: TOKEN }),
    /port must be an integer/,
  );
});
