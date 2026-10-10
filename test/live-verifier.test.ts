import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLiveVerificationReport,
  DEFAULT_SERVER_CONFIG,
  type LiveVerificationReport,
} from "../src/testing/live/live-verifier.js";

// ─── Server config tests ─────────────────────────────────────────────────────

test("live verifier: default server config targets localhost", () => {
  assert.equal(DEFAULT_SERVER_CONFIG.host, "127.0.0.1");
  assert.equal(DEFAULT_SERVER_CONFIG.port, 25565);
  assert.equal(DEFAULT_SERVER_CONFIG.version, "1.20.4");
  assert.ok(DEFAULT_SERVER_CONFIG.botUsername.length > 0);
  assert.ok(DEFAULT_SERVER_CONFIG.connectTimeoutMs > 0);
});

// ─── Report formatting tests ─────────────────────────────────────────────────

test("live verifier: format report shows server and mode", () => {
  const report: LiveVerificationReport = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    server: "192.168.1.10:25565",
    mode: "verify",
    phases: [],
    passed: 0,
    failed: 0,
    total: 0,
    allPassed: true,
    reachedServer: false,
  };
  const text = formatLiveVerificationReport(report);
  assert.ok(text.includes("192.168.1.10:25565"));
  assert.ok(text.includes("verify"));
});

test("live verifier: format report shows reached status", () => {
  const report: LiveVerificationReport = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    server: "mc.example.com:25565",
    mode: "learn",
    phases: [],
    passed: 0,
    failed: 0,
    total: 0,
    allPassed: false,
    reachedServer: true,
  };
  const text = formatLiveVerificationReport(report);
  assert.ok(text.includes("YES"));
  assert.ok(text.includes("REAL Minecraft server"));
});

test("live verifier: format report shows unreached status", () => {
  const report: LiveVerificationReport = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    server: "10.0.0.99:25565",
    mode: "verify",
    phases: [],
    passed: 0,
    failed: 0,
    total: 0,
    allPassed: false,
    reachedServer: false,
  };
  const text = formatLiveVerificationReport(report);
  assert.ok(text.includes("NO"));
  assert.ok(text.includes("server unreachable") || text.includes("not reached"));
});

test("live verifier: format report shows phase results", () => {
  const report: LiveVerificationReport = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    server: "localhost:25565",
    mode: "verify",
    phases: [
      {
        phase: "connection",
        passed: true,
        durationMs: 1500,
        assertions: [
          { name: "Has position", passed: true, expected: "defined", actual: "defined" },
        ],
        error: null,
        notes: ["Connected successfully"],
      },
      {
        phase: "observation",
        passed: false,
        durationMs: 3000,
        assertions: [],
        error: "Connection refused",
        notes: [],
      },
    ],
    passed: 1,
    failed: 1,
    total: 2,
    allPassed: false,
    reachedServer: true,
  };
  const text = formatLiveVerificationReport(report);
  assert.ok(text.includes("connection"));
  assert.ok(text.includes("observation"));
  assert.ok(text.includes("Connection refused"));
  assert.ok(text.includes("Has position"));
  assert.ok(text.includes("Connected successfully"));
  assert.ok(text.includes("1/2"));
});

test("live verifier: format report shows all passed", () => {
  const report: LiveVerificationReport = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    server: "localhost:25565",
    mode: "verify",
    phases: [
      {
        phase: "connection",
        passed: true,
        durationMs: 500,
        assertions: [],
        error: null,
        notes: [],
      },
    ],
    passed: 1,
    failed: 0,
    total: 1,
    allPassed: true,
    reachedServer: true,
  };
  const text = formatLiveVerificationReport(report);
  assert.ok(text.includes("ALL PASSED"));
});

test("live verifier: format report includes learning details", () => {
  const report: LiveVerificationReport = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    server: "localhost:25565",
    mode: "learn",
    phases: [
      {
        phase: "learning-update",
        passed: true,
        durationMs: 200,
        assertions: [
          { name: "Checkpoint created", passed: true, expected: "≥1 checkpoint", actual: "1" },
        ],
        error: null,
        notes: ["Reward: mean=1.234, positive rate=80%"],
      },
    ],
    passed: 1,
    failed: 0,
    total: 1,
    allPassed: true,
    reachedServer: true,
  };
  const text = formatLiveVerificationReport(report);
  assert.ok(text.includes("learning-update"));
  assert.ok(text.includes("Checkpoint created"));
  assert.ok(text.includes("mean=1.234"));
});

// ─── Integration: learning pipeline without server ───────────────────────────

test("live verifier: learning pipeline produces reward data from episodes", async () => {
  const { ExperienceLearner } = await import("../src/core/learning/learner.js");
  const learner = new ExperienceLearner();
  learner.beginRun({ runId: "test-pipeline", taskId: "test", worldKey: "mock-world" });

  // Record episodes that simulate what the live verifier would do
  learner.recordEpisode({
    runId: "test-pipeline",
    taskId: "test",
    sessionId: null,
    sequence: 0,
    worldKey: "mock-world",
    policyVersion: null,
    targetKey: "block@0,64,0",
    features: {
      goalClass: "collect",
      skillId: "minecraft.gather_resource",
      band: 0,
      distance: 0,
      distanceBand: "adjacent",
      health: 20,
      hunger: 18,
      vitality: "ok",
      threat: "none",
      timeOfDay: "day",
      targetKind: "ground",
      actionIndex: 0,
      attemptsOnTarget: 0,
    },
    outcome: {
      status: "succeeded",
      confirmed: true,
      verified: true,
      progress: true,
      failureCode: null,
      itemsGained: 1,
      itemsConsumed: 0,
      healthDelta: 0,
      foodDelta: 0,
      durationMs: 500,
      distanceAfter: 0,
      safetyDenied: false,
    },
  });

  const snap = learner.snapshot();
  assert.ok(snap.reward.totalEpisodes >= 1);
  assert.ok(snap.reward.meanReward > 0);
  assert.ok(Array.isArray(snap.classPatterns));
  assert.ok(snap.checkpoints !== undefined);
  assert.ok(snap.rlReadiness !== undefined);
});

test("live verifier: ControlCenterLearning snapshot has all new fields after learning", async () => {
  const { ExperienceLearner } = await import("../src/core/learning/learner.js");
  const learner = new ExperienceLearner();
  learner.beginRun({ runId: "cc-test", taskId: "test", worldKey: "mock-world" });
  learner.recordEpisode({
    runId: "cc-test",
    taskId: "test",
    sessionId: null,
    sequence: 0,
    worldKey: "mock-world",
    policyVersion: null,
    targetKey: "res@0,64,0",
    features: {
      goalClass: "collect",
      skillId: "minecraft.gather_resource",
      band: 4,
      distance: 12,
      distanceBand: "medium",
      health: 20,
      hunger: 18,
      vitality: "ok",
      threat: "none",
      timeOfDay: "day",
      targetKind: "resource",
      actionIndex: 0,
      attemptsOnTarget: 0,
    },
    outcome: {
      status: "succeeded",
      confirmed: true,
      verified: true,
      progress: true,
      failureCode: null,
      itemsGained: 1,
      itemsConsumed: 0,
      healthDelta: 0,
      foodDelta: 0,
      durationMs: 1000,
      distanceAfter: 5,
      safetyDenied: false,
    },
  });
  await learner.finishRun();

  const snap = learner.snapshot();

  // These fields must be present for the ControlCenterLearning type
  assert.ok("reward" in snap);
  assert.ok("classPatterns" in snap);
  assert.ok("checkpoints" in snap);
  assert.ok("experiments" in snap);
  assert.ok("rlReadiness" in snap);

  // Verify types match what the ControlCenterLearning interface expects
  assert.ok(typeof snap.reward.meanReward === "number");
  assert.ok(typeof snap.reward.ewmaReward === "number");
  assert.ok(typeof snap.reward.positiveRate === "number");
  assert.ok(typeof snap.reward.totalEpisodes === "number");
  assert.ok(Array.isArray(snap.classPatterns));
  assert.ok(typeof snap.checkpoints.total === "number");
  assert.ok(Array.isArray(snap.experiments));
  assert.ok(typeof snap.rlReadiness.score === "number");
  assert.ok(typeof snap.rlReadiness.maxScore === "number");
});

test("live verifier: reward computation with safety denial", async () => {
  const { ExperienceLearner } = await import("../src/core/learning/learner.js");
  const learner = new ExperienceLearner();
  learner.beginRun({ runId: "safety-test", taskId: "test", worldKey: "mock" });
  learner.recordEpisode({
    runId: "safety-test",
    taskId: "test",
    sessionId: null,
    sequence: 0,
    worldKey: "mock",
    policyVersion: null,
    targetKey: null,
    features: {
      goalClass: "collect",
      skillId: "minecraft.gather_resource",
      band: 0,
      distance: 2,
      distanceBand: "adjacent",
      health: 18,
      hunger: 16,
      vitality: "ok",
      threat: "visible",
      timeOfDay: "night",
      targetKind: "resource",
      actionIndex: 0,
      attemptsOnTarget: 0,
    },
    outcome: {
      status: "rejected",
      confirmed: false,
      verified: null,
      progress: false,
      failureCode: "SAFETY_HOSTILE_NEARBY",
      itemsGained: 0,
      itemsConsumed: 0,
      healthDelta: 0,
      foodDelta: 0,
      durationMs: 50,
      distanceAfter: null,
      safetyDenied: true,
    },
  });
  const snap = learner.snapshot();
  assert.ok(snap.reward.totalEpisodes >= 1);
  // Safety denial should produce a non-positive reward
  assert.ok(snap.reward.meanReward <= 0, `Expected non-positive reward for safety denial, got ${snap.reward.meanReward}`);
});

test("live verifier: failure creates class pattern entry", async () => {
  const { ExperienceLearner } = await import("../src/core/learning/learner.js");
  const learner = new ExperienceLearner();
  learner.beginRun({ runId: "failure-test", taskId: "test", worldKey: "mock" });
  learner.recordEpisode({
    runId: "failure-test",
    taskId: "test",
    sessionId: null,
    sequence: 0,
    worldKey: "mock",
    policyVersion: null,
    targetKey: "stone@10,64,0",
    features: {
      goalClass: "mine",
      skillId: "minecraft.mine_block",
      band: 2,
      distance: 6,
      distanceBand: "near",
      health: 20,
      hunger: 18,
      vitality: "ok",
      threat: "none",
      timeOfDay: "day",
      targetKind: "stone",
      actionIndex: 0,
      attemptsOnTarget: 0,
    },
    outcome: {
      status: "failed",
      confirmed: false,
      verified: false,
      progress: false,
      failureCode: "no-progress",
      itemsGained: 0,
      itemsConsumed: 0,
      healthDelta: 0,
      foodDelta: 0,
      durationMs: 2000,
      distanceAfter: 6,
      safetyDenied: false,
    },
  });
  const snap = learner.snapshot();
  assert.ok(snap.classPatterns.length > 0, "A failure should create a class pattern");
  assert.ok(snap.classPatterns[0]?.patternKey.includes("mine"));
});
