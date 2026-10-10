#!/usr/bin/env node
// Runs the full test suite and records the outcome as evidence for the improvement roadmap.
// The record is written to data/evidence/tests.json. It is written even when tests fail, so a failing
// run is never mistaken for a missing one.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const outPath = process.argv[2] ?? "data/evidence/tests.json";
const started = Date.now();
const run = spawnSync("npm", ["test"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const passed = Number(/^# pass (\d+)/m.exec(output)?.[1]);
const failed = Number(/^# fail (\d+)/m.exec(output)?.[1]);
if (!Number.isFinite(passed) || !Number.isFinite(failed)) {
  console.error("Could not read the pass/fail summary from npm test; no record written.");
  process.exit(2);
}
const failures = [...new Set([...output.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((match) => match[1].trim()))];
const record = {
  measuredAt: new Date().toISOString(),
  command: "npm test",
  exitCode: run.status,
  durationMs: Date.now() - started,
  passed,
  failed,
  failures,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
process.exit(0);
