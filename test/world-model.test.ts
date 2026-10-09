import assert from "node:assert/strict";
import test from "node:test";
import { WorldModel } from "../src/core/world-model.js";
import type { GameObservation } from "../src/core/types.js";

const session = {
  id: "session-1",
  gameId: "minecraft-java",
  gameVersion: "1.20.4",
  connectedAt: "2026-01-01T00:00:00.000Z",
};

function observation(sequence: number, sessionId = session.id): GameObservation<{ health: number }> {
  return {
    schemaVersion: 1,
    gameId: session.gameId,
    gameVersion: session.gameVersion,
    sessionId,
    sequence,
    observedAt: "2026-01-01T00:00:01.000Z",
    state: { health: 20 },
  };
}

test("WorldModel accepts a current observation and rejects stale or cross-session data", () => {
  const model = new WorldModel<{ health: number }>();
  model.beginSession(session);
  assert.equal(model.apply(observation(0)).state.health, 20);
  assert.throws(() => model.apply(observation(0)), /Stale observation/);
  assert.throws(() => model.apply(observation(1, "another-session")), /different or expired session/);
});

test("WorldModel rejects mismatched game versions", () => {
  const model = new WorldModel<{ health: number }>();
  model.beginSession(session);
  assert.throws(
    () => model.apply({ ...observation(0), gameVersion: "1.21.4" }),
    /game version changed/,
  );
});
