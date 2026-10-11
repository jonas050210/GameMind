/** The Training tab's benchmark listing: reads reports the CLI wrote, tolerates damage, and shows no raw file contents. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readBenchmarkListing, summarizeBenchmark } from "../src/app/benchmark-view.js";

const report = {
  name: "rates",
  createdAt: "2026-10-10T10:00:00.000Z",
  winner: "mid",
  decision: "'mid' passed the gate.",
  entries: [
    { candidate: { id: "greedy", explorationRate: 0 }, status: "completed", error: null, experiment: { baselineSuccess: 0.4, trainedSuccess: 0.5, deltaPoints: 0.1, gateVerdict: "promotable" } },
    { candidate: { id: "wild", explorationRate: 0.3 }, status: "failed", error: "budget exceeded", experiment: null },
  ],
};

test("a report is summarised into rows with plain fields", () => {
  const summary = summarizeBenchmark("/x/rates.json", report);
  assert.equal(summary.winner, "mid");
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows[0]?.explorationRate, 0);
  assert.equal(summary.rows[0]?.gateVerdict, "promotable");
  assert.equal(summary.rows[1]?.status, "failed");
  assert.equal(summary.rows[1]?.error, "budget exceeded");
  assert.equal(summary.rows[1]?.trainedSuccess, null, "a failed candidate has no numbers, and none are invented");
});

test("missing directory gives an empty listing; a damaged file is listed as unreadable and the others still show", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gm-bench-"));
  try {
    assert.deepEqual((await readBenchmarkListing(path.join(root, "none"))).reports, []);
    const dir = path.join(root, "experiments", "benchmarks");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "rates.json"), JSON.stringify(report));
    await writeFile(path.join(dir, "broken.json"), "{ not json");
    await writeFile(path.join(dir, "notes.txt"), "ignored");
    const old = new Date("2026-01-01T00:00:00Z");
    await utimes(path.join(dir, "rates.json"), old, old);
    const listing = await readBenchmarkListing(path.join(root, "experiments"));
    assert.equal(listing.reports.length, 2);
    assert.equal(listing.reports[0]?.unreadable, true, "the broken file is the newest and is marked");
    assert.equal(listing.reports[1]?.winner, "mid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
