import assert from "node:assert/strict";
import test from "node:test";
import {
  ClassFailureMemory,
  deriveClassPatternKey,
} from "../src/core/learning/class-failure-memory.js";

test("deriveClassPatternKey: basic key from skill and goal", () => {
  assert.equal(
    deriveClassPatternKey("minecraft.mine_block", "mine", null, null, null),
    "minecraft.mine_block|mine",
  );
});

test("deriveClassPatternKey: includes failure code", () => {
  assert.equal(
    deriveClassPatternKey("minecraft.mine_block", "mine", "no-progress", null, null),
    "minecraft.mine_block|mine|no-progress",
  );
});

test("deriveClassPatternKey: includes equipment tier", () => {
  assert.equal(
    deriveClassPatternKey("minecraft.mine_block", "mine", null, "wooden", null),
    "minecraft.mine_block|mine|eq:wooden",
  );
});

test("deriveClassPatternKey: skips none equipment tier", () => {
  assert.equal(
    deriveClassPatternKey("minecraft.mine_block", "mine", null, "none", null),
    "minecraft.mine_block|mine",
  );
});

test("deriveClassPatternKey: includes time of day", () => {
  assert.equal(
    deriveClassPatternKey("minecraft.gather_resource", "collect", null, null, "night"),
    "minecraft.gather_resource|collect|night",
  );
});

test("deriveClassPatternKey: combines all parts", () => {
  assert.equal(
    deriveClassPatternKey("minecraft.mine_block", "mine", "stuck", "wooden", "night"),
    "minecraft.mine_block|mine|stuck|eq:wooden|night",
  );
});

test("ClassFailureMemory: starts empty", () => {
  const memory = new ClassFailureMemory({ minDistinctTargets: 3, minAttempts: 5 });
  assert.equal(memory.size, 0);
});

test("ClassFailureMemory: records a failure pattern", () => {
  const memory = new ClassFailureMemory({ minDistinctTargets: 3, minAttempts: 5 });
  memory.recordFailure({
    patternKey: "mine|stone|no_iron",
    skillId: "minecraft.mine_block",
    goalClass: "mine",
    condition: "no_iron",
    targetKey: "stone@10,64,-3",
    runIndex: 1,
  });
  assert.equal(memory.size, 1);
});

test("ClassFailureMemory: accumulates attempts", () => {
  const memory = new ClassFailureMemory({ minDistinctTargets: 3, minAttempts: 5 });
  memory.recordFailure({
    patternKey: "mine|stone", skillId: "minecraft.mine_block", goalClass: "mine",
    condition: null, targetKey: "stone@10,64,-3", runIndex: 1,
  });
  memory.recordFailure({
    patternKey: "mine|stone", skillId: "minecraft.mine_block", goalClass: "mine",
    condition: null, targetKey: "stone@15,64,2", runIndex: 1,
  });
  const patterns = memory.activePatterns(1);
  assert.equal(patterns[0]?.attempts, 2);
});

test("ClassFailureMemory: tracks distinct targets", () => {
  const memory = new ClassFailureMemory({ minDistinctTargets: 3, minAttempts: 5 });
  for (let i = 0; i < 4; i++) {
    memory.recordFailure({
      patternKey: "mine|stone", skillId: "minecraft.mine_block", goalClass: "mine",
      condition: null, targetKey: `stone@${i * 10},64,0`, runIndex: i,
    });
  }
  const patterns = memory.activePatterns(4);
  assert.equal(patterns[0]?.distinctTargets, 4);
});

test("ClassFailureMemory: blocks after enough evidence", () => {
  const memory = new ClassFailureMemory({ minDistinctTargets: 3, minAttempts: 5 });
  for (let i = 0; i < 5; i++) {
    memory.recordFailure({
      patternKey: "mine|stone", skillId: "minecraft.mine_block", goalClass: "mine",
      condition: null, targetKey: `stone@${i * 10},64,0`, runIndex: i,
    });
  }
  assert.equal(memory.isBlocked("mine|stone", 5), true);
});

test("ClassFailureMemory: does not block without enough distinct targets", () => {
  const memory = new ClassFailureMemory({ minDistinctTargets: 3, minAttempts: 5 });
  for (let i = 0; i < 10; i++) {
    memory.recordFailure({
      patternKey: "mine|stone", skillId: "minecraft.mine_block", goalClass: "mine",
      condition: null, targetKey: "stone@10,64,0", runIndex: i,
    });
  }
  assert.equal(memory.isBlocked("mine|stone", 10), false);
});

test("ClassFailureMemory: success weakens pattern", () => {
  const memory = new ClassFailureMemory({ minDistinctTargets: 3, minAttempts: 5 });
  for (let i = 0; i < 6; i++) {
    memory.recordFailure({
      patternKey: "mine|stone", skillId: "minecraft.mine_block", goalClass: "mine",
      condition: null, targetKey: `stone@${i * 10},64,0`, runIndex: i,
    });
  }
  assert.equal(memory.isBlocked("mine|stone", 6), true);
  memory.recordSuccess({ patternKey: "mine|stone", targetKey: "stone@0,64,0", runIndex: 7 });
  const pattern = memory.activePatterns(7).find((p: { patternKey: string }) => p.patternKey === "mine|stone");
  assert.ok(pattern && pattern.attempts < 6);
});

test("ClassFailureMemory: penalty decays over time", () => {
  const memory = new ClassFailureMemory({ minDistinctTargets: 3, minAttempts: 5 });
  for (let i = 0; i < 10; i++) {
    memory.recordFailure({
      patternKey: "mine|stone", skillId: "minecraft.mine_block", goalClass: "mine",
      condition: null, targetKey: `stone@${i},64,0`, runIndex: i,
    });
  }
  const earlyPenalty = memory.penaltyFor("mine|stone", 10);
  const latePenalty = memory.penaltyFor("mine|stone", 30);
  assert.ok(latePenalty < earlyPenalty);
});

test("ClassFailureMemory: findBlockingPattern matches skill and goal", () => {
  const memory = new ClassFailureMemory({ minDistinctTargets: 3, minAttempts: 5 });
  for (let i = 0; i < 6; i++) {
    memory.recordFailure({
      patternKey: "mine|stone", skillId: "minecraft.mine_block", goalClass: "mine",
      condition: null, targetKey: `stone@${i},64,0`, runIndex: i,
    });
  }
  const blocked = memory.findBlockingPattern("minecraft.mine_block", "mine", null, 6);
  assert.notEqual(blocked, null);
  assert.equal(blocked?.patternKey, "mine|stone");
});

test("ClassFailureMemory: findBlockingPattern returns null for non-matching skill", () => {
  const memory = new ClassFailureMemory({ minDistinctTargets: 3, minAttempts: 5 });
  for (let i = 0; i < 6; i++) {
    memory.recordFailure({
      patternKey: "mine|stone", skillId: "minecraft.mine_block", goalClass: "mine",
      condition: null, targetKey: `stone@${i},64,0`, runIndex: i,
    });
  }
  const blocked = memory.findBlockingPattern("minecraft.gather_resource", "collect", null, 6);
  assert.equal(blocked, null);
});

test("ClassFailureMemory: prunes stale patterns", () => {
  const memory = new ClassFailureMemory({ minDistinctTargets: 3, minAttempts: 5 });
  memory.recordFailure({
    patternKey: "mine|stone", skillId: "minecraft.mine_block", goalClass: "mine",
    condition: null, targetKey: "stone@10,64,0", runIndex: 1,
  });
  const pruned = memory.prune(100);
  assert.equal(pruned, 1);
  assert.equal(memory.size, 0);
});

test("ClassFailureMemory: snapshots and restores", () => {
  const memory = new ClassFailureMemory();
  memory.recordFailure({
    patternKey: "mine|stone", skillId: "minecraft.mine_block", goalClass: "mine",
    condition: null, targetKey: "stone@10,64,0", runIndex: 1,
  });
  const snap = memory.snapshot();
  const memory2 = new ClassFailureMemory();
  memory2.restore(snap);
  assert.equal(memory2.size, 1);
});
