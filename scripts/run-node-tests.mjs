#!/usr/bin/env node
// The main TypeScript tests use node:test; Vitest is reserved for the integration suite under src/testing/integration.
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(repositoryRoot, "test");
const files = [];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(filename);
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path.relative(repositoryRoot, filename));
    }
  }
}

try {
  await collect(testRoot);
} catch (error) {
  console.error(`Could not discover TypeScript tests under ${testRoot}:`, error);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No .test.ts files were found under ${testRoot}.`);
  process.exit(1);
}

const run = spawnSync(process.execPath, [
  "--import", "tsx",
  "--test",
  "--test-concurrency=4",
  "--test-reporter=tap",
  ...files,
], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

if (run.error) {
  console.error("Could not start the Node.js test runner:", run.error);
  process.exit(1);
}
process.exit(run.status ?? 1);
