/**
 * Integration tests for pause/resume/stop functionality
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTraining } from "../../training/trainer.js";
import { trainingPaths } from "../../training/state.js";
import { TRAINING_STAGES } from "../../training/curriculum.js";
import { mkdir, rm } from "node:fs/promises";

const TEST_DIR = "data/test-integration";

async function cleanupTestDir() {
  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

describe("Training Integration", () => {
  beforeEach(async () => {
    await cleanupTestDir();
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  it("should complete training with default settings", async () => {
    const state = await runTraining({
      root: TEST_DIR,
      maxEpisodes: 3,
      episodesPerStage: 3,
      workers: 1,
      quiet: true,
      fresh: true,
      stages: TRAINING_STAGES.slice(0, 1),
    });

    expect(state.status).toBe("completed");
    expect(state.totalEpisodes).toBeGreaterThan(0);
    expect(state.checkpoints.length).toBeGreaterThan(0);
  }, 30000);
});
