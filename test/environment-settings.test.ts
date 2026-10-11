/**
 * Environment settings and the README must not drift apart.
 *
 * The settings a run honours are read in several places (the CLI, the adapter, the training CLI, the
 * Python launcher) and the README documents them in one list. Both directions are checked here: a
 * setting the code reads has to be documented, and a `MINECRAFT_*`/`GAMEMIND_*` name the README shows
 * has to be something the code actually reads. The list used to be a hand-kept subset — the navigation
 * doors and drop options were honoured but undocumented.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read from the environment, but not a setting a user configures; each is set and used inside one process tree. */
const INTERNAL = new Set([
  "GAMEMIND_EPISODE_SCRATCH", // set by the episode pool for its own workers
  "GAMEMIND_TERMINATION_MARKER", // set by the training manager for its own child process
  "WSLENV", // read for platform detection
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
]);

/** Names the README mentions that are deliberately not read; each has to say so in the same sentence. */
const DOCUMENTED_ABSENT = new Set([
  "MINECRAFT_COMMANDER", // "there is no commander username, and no MINECRAFT_COMMANDER variable is read"
]);

const SETTING_PREFIXES = ["MINECRAFT_", "GAMEMIND_"];
const EXTRA_SETTINGS = new Set(["LOG_LEVEL", "NODE"]);

function isSettingName(name: string): boolean {
  return SETTING_PREFIXES.some((prefix) => name.startsWith(prefix)) || EXTRA_SETTINGS.has(name);
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts") || full.endsWith(".py")) files.push(full);
    }
  };
  for (const directory of ["src", "launcher"]) walk(path.join(ROOT, directory));
  files.push(path.join(ROOT, "main.py"));
  return files;
}

/** Every place the code reads an environment variable. */
const ACCESS_PATTERNS = [
  /\b(?:env|environment|process\.env)\.([A-Z][A-Z0-9_]{2,})/g,
  /\b(?:env|environment|process\.env)\["([A-Z][A-Z0-9_]{2,})"\]/g,
  /\b(?:env|environment|process\.env)\.get\("([A-Z][A-Z0-9_]{2,})"/g,
  /numericEnvironmentSetting\(\s*\w+,\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /\b\w+\.get\("([A-Z][A-Z0-9_]{2,})"\)/g, // launcher: environment.get("MINECRAFT_HOST")
];

/** Any `MINECRAFT_*`/`GAMEMIND_*` token in the source, read as a setting or not (markers, failure codes). */
const NAME_PATTERN = /\b(?:MINECRAFT|GAMEMIND)_[A-Z0-9_]+\b/g;

test("every environment setting the code reads is documented in the README", () => {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  const settings = new Set<string>();
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const pattern of ACCESS_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const name = match[1];
        if (name && isSettingName(name)) settings.add(name);
      }
    }
  }
  assert.ok(settings.size >= 20, `the scan has to find the settings, found ${settings.size}`);
  const undocumented = [...settings].filter((name) => !INTERNAL.has(name) && !readme.includes(name)).sort();
  assert.deepEqual(undocumented, [], `README is missing: ${undocumented.join(", ")}`);
});

test("every MINECRAFT_/GAMEMIND_ name the README shows is a name the code knows", () => {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  const names = new Set<string>();
  for (const file of sourceFiles()) {
    for (const match of readFileSync(file, "utf8").matchAll(NAME_PATTERN)) names.add(match[0]);
  }
  const documented = new Set(
    [...readme.matchAll(NAME_PATTERN)].map((match) => match[0]).filter((name) => !DOCUMENTED_ABSENT.has(name)),
  );
  const unknown = [...documented].filter((name) => !names.has(name)).sort();
  assert.deepEqual(unknown, [], `README documents names the code never mentions: ${unknown.join(", ")}`);
});
