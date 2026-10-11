/** The Training Hub finds active runs in all persisted training folders, not just the currently selected one. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppEventLog } from "../src/app/event-log.js";
import { TrainingHub } from "../src/app/training-hub.js";

test("an unselected directory with a live training lock is discovered and blocks CPU-heavy work", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "gamemind-training-hub-"));
  try {
    const other = path.join(dataDirectory, "other-run");
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "training.lock"), JSON.stringify({ pid: process.pid, kind: "train", startedAt: new Date().toISOString() }));
    const hub = new TrainingHub({
      dataDirectory,
      displayData: "data",
      events: { record: () => undefined } as unknown as AppEventLog,
    });
    assert.equal(await hub.activeDirectory(), "other-run");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
