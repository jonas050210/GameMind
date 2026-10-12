#!/usr/bin/env node
// Runs the complete test suite and records its outcome as roadmap evidence.
// The record is written even when the command fails, so a failing run is never mistaken for a missing one.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const outPath = process.argv[2] ?? "data/evidence/tests.json";
const started = Date.now();
// Windows has no `npm` executable, only `npm.cmd`; without a shell a spawn of "npm" fails with ENOENT there.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = spawnSync(npm, ["test"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32" });
const rawOutput = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const output = rawOutput.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const lastMatch = (pattern) => [...output.matchAll(pattern)].at(-1) ?? null;
const numberFrom = (pattern) => {
  const match = lastMatch(pattern);
  return match ? Number(match[1]) : 0;
};

const nodePassed = numberFrom(/^# pass (\d+)\s*$/gm);
const nodeFailed = numberFrom(/^# fail (\d+)\s*$/gm);
const vitestLine = lastMatch(/^\s*Tests\s+([^\r\n]+)$/gm)?.[1] ?? "";
const vitestPassed = Number(/\b(\d+)\s+passed\b/.exec(vitestLine)?.[1] ?? 0);
const vitestFailed = Number(/\b(\d+)\s+failed\b/.exec(vitestLine)?.[1] ?? 0);
const hasSummary = /^# (?:pass|fail) \d+\s*$/m.test(output) || vitestLine.length > 0;
const exitCode = run.status ?? 1;
const passed = nodePassed + vitestPassed;
let failed = nodeFailed + vitestFailed;
const failures = [...new Set([
  ...[...output.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((match) => match[1].trim()),
  ...[...output.matchAll(/^\s*FAIL\s+(.+)$/gm)].map((match) => match[1].trim()),
])];

if (run.error) failures.push(`Could not start npm test: ${run.error.message}`);
if (!hasSummary || (exitCode !== 0 && failed === 0)) {
  failed = Math.max(1, failed);
  if (failures.length === 0) {
    failures.push(!hasSummary
      ? "npm test produced no recognized Node/Vitest summary"
      : `npm test exited with code ${exitCode} without a parsed failing-test summary`);
  }
}

const record = {
  measuredAt: new Date().toISOString(),
  command: "npm test",
  exitCode,
  durationMs: Date.now() - started,
  passed,
  failed,
  failures,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
process.exit(0);
