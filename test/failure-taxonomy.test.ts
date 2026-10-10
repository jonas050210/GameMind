/**
 * The failure taxonomy is the single place that decides what *kind* of thing stopped the agent, so the
 * Control Center, the task report and the CLI all say the same thing. These tests pin the classification
 * of every family of code the runtime can produce — and, most importantly, fail if a code exists in the
 * source but is unclassified, which is how `blocked` became the only explanation an operator ever got.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REFLEX_CODES } from "../src/games/minecraft/reflex.js";
import {
  FAILURE_KIND_LABELS,
  classifyFailure,
  failureIsExternal,
  formatFailure,
} from "../src/core/failure-taxonomy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("safety refusals are never mistaken for a failure of the agent", () => {
  for (const code of ["SAFETY_LAVA_AHEAD", "RUN_PAUSED", "RUN_TRIPPED", "STALE_OBSERVATION", "RISK_ABOVE_CEILING", "COMBAT_DISABLED"]) {
    const failure = classifyFailure(code, "denied by policy");
    assert.equal(failure.kind, "safety", code);
    assert.equal(failure.owner, "Safety Broker", code);
  }
  assert.equal(classifyFailure("RUN_PAUSED", null).label, "paused by an operator");
  assert.equal(classifyFailure("RUN_TRIPPED", null).retryable, false, "an operator has to lift a trip");
});

test("a missing capability is reported as a missing capability", () => {
  for (const code of ["CAPABILITY_NOT_AVAILABLE", "SKILL_NOT_REGISTERED", "PATHFINDER_UNAVAILABLE", "MINECRAFT_PLUGIN_UNAVAILABLE", "COLLECTOR_UNAVAILABLE", "TASK_BLOCKED_CAPABILITY"]) {
    assert.equal(classifyFailure(code, null).kind, "capability", code);
  }
  const gap = classifyFailure("TASK_BLOCKED_CAPABILITY", "collect logs needs minecraft.collect-log, which this adapter does not advertise.");
  assert.equal(gap.retryable, false, "retrying cannot register a skill");
  assert.match(String(gap.hint), /capability list/i);
});

test("connection faults are separated from task failures", () => {
  for (const code of ["NOT_CONNECTED", "NO_ACTIVE_SESSION", "SESSION_CHANGED_BEFORE_ACTION", "ADAPTER_DISCONNECTED", "ADAPTER_QUARANTINED", "MINECRAFT_KICKED", "PLAYER_NOT_SPAWNED"]) {
    assert.equal(classifyFailure(code, null).kind, "connection", code);
  }
  assert.equal(classifyFailure("ADAPTER_DISCONNECTED", null).owner, "Minecraft session");
  // A socket error thrown without any code at all still reads as a connection problem.
  assert.equal(classifyFailure(null, "connect ECONNREFUSED 127.0.0.1:25565").kind, "connection");
  assert.equal(classifyFailure(null, "Timed out after 15000 ms waiting for Minecraft spawn.").kind, "connection");
  assert.equal(classifyFailure(null, "quitting: kicked").kind, "connection");
  assert.equal(classifyFailure(null, "read EAI_AGAIN minecraft.example").kind, "connection");
});

test("an unreadable world is a perception problem, not a broken plan", () => {
  for (const code of ["PRE_ACTION_OBSERVATION_FAILED", "POST_ACTION_OBSERVATION_FAILED", "OBSERVATION_SCHEMA_INVALID", "WORLD_STATE_UNAVAILABLE", "HEALTH_UNKNOWN", "DIMENSION_UNKNOWN"]) {
    assert.equal(classifyFailure(code, null).kind, "perception", code);
  }
  const schema = classifyFailure("OBSERVATION_SCHEMA_INVALID", 'player.dimension: expected string, received "the_nether"');
  assert.match(schema.label, /did not match its contract/);
  assert.equal(schema.retryable, true, "the next observation may be well-formed");
});

test("planner declines name the reason they declined", () => {
  const mode = classifyFailure("TASK_BLOCKED_MODE", "Minecraft task skills are limited to survival mode; creative (single-source: bot.game.gameMode).");
  assert.equal(mode.kind, "planner");
  assert.equal(mode.retryable, false, "the world has to change, not the plan");
  for (const code of ["NO_FEASIBLE_GOAL", "TASK_BLOCKED_DIMENSION", "TASK_BLOCKED_THREAT", "TASK_BLOCKED_HEALTH", "TASK_BLOCKED_HUNGER", "TASK_BLOCKED_TARGETS", "TASK_BLOCKED_SHELTER", "TASK_BLOCKED_TOOL"]) {
    assert.equal(classifyFailure(code, null).kind, "planner", code);
  }
  // `DIG_FAILED` is the adapter refusing an action; it is not the planner's decision.
  assert.equal(classifyFailure("DIG_FAILED", "dig time for bedrock is Infinity").kind, "action");
  assert.equal(classifyFailure("GAME_MODE_BLOCKS_COLLECTION", "in creative").kind, "action");
});

test("task-level outcomes stay their own category", () => {
  for (const code of ["TASK_DEADLINE", "TASK_ACTION_BUDGET", "OPERATOR_STOP", "RESPAWN_TIMEOUT", "CONSECUTIVE_ACTION_FAILURES", "NO_PROGRESS", "MAX_ACTIONS"]) {
    assert.equal(classifyFailure(code, null).kind, "task", code);
  }
  assert.equal(classifyFailure("TASK_ACTION_BUDGET", null).retryable, false, "the budget is spent");
});

test("an unrecognised code keeps its own words instead of being forced into a bucket", () => {
  const unknown = classifyFailure("SOMETHING_NEW", "a brand new explanation");
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.label, FAILURE_KIND_LABELS.unknown);
  assert.equal(unknown.message, "a brand new explanation", "the exact message must survive classification");
  // A message is only used for the category when the code said nothing; it never rewrites the message.
  assert.equal(classifyFailure("SOMETHING_NEW", "connection refused by server").kind, "unknown");
  assert.equal(classifyFailure(null, "no signal at all here").kind, "unknown");
  assert.equal(classifyFailure(null, null).code, null);
});

test("codes are normalised and hostile input is refused", () => {
  assert.equal(classifyFailure("  not_connected \n").kind, "connection");
  assert.equal(classifyFailure("NOT_CONNECTED; DROP TABLE").kind, "unknown", "an unparsable code stays unclassified rather than being trusted");
  assert.equal(classifyFailure("".padEnd(400, "A")).kind, "unknown");
  assert.equal(classifyFailure(undefined, undefined).code, null);
});

test("formatFailure is one readable line, and external means 'not a code bug'", () => {
  const line = formatFailure(classifyFailure("RUN_PAUSED", "paused from the Control Center"));
  assert.equal(line, "paused by an operator · RUN_PAUSED: paused from the Control Center");
  assert.equal(formatFailure(classifyFailure("NO_FEASIBLE_GOAL", null)), "no feasible goal · NO_FEASIBLE_GOAL");
  assert.equal(failureIsExternal(classifyFailure("NOT_CONNECTED", null)), true);
  assert.equal(failureIsExternal(classifyFailure("TASK_DEADLINE", null)), false, "a spent budget is the run's own outcome");
});

test("every failure code the runtime can raise is classified", () => {
  // The codes are discovered from the source, not from a hand-kept list: a new throw site that nobody
  // classified is exactly how a live run ends up explaining itself with a bare status word.
  const directories = ["src/core", "src/games/minecraft"];
  const literals = new Set<string>();
  const quoted = /"([A-Z][A-Z0-9_]{2,})"/g;

  /** Reads the arguments of a `new SomethingError(…)` call and takes the last string literal in them. */
  function codesFromThrowSite(source: string): void {
    const throws = /new\s+\w*Error\s*\(/g;
    for (const match of source.matchAll(throws)) {
      let index = (match.index ?? 0) + match[0].length;
      let depth = 1;
      while (index < source.length && depth > 0) {
        const character = source[index];
        if (character === "(") depth += 1;
        else if (character === ")") depth -= 1;
        index += 1;
      }
      const args = source.slice((match.index ?? 0) + match[0].length, index);
      const found = [...args.matchAll(quoted)];
      const code = found.at(-1)?.[1];
      if (code) literals.add(code);
    }
  }

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".ts") || full.includes("failure-taxonomy")) continue;
      const source = readFileSync(full, "utf8");
      codesFromThrowSite(source);
      for (const match of source.matchAll(/code:\s*"([A-Z][A-Z0-9_]{2,})"/g)) {
        if (match[1]) literals.add(match[1]);
      }
    }
  };
  for (const directory of directories) walk(path.join(ROOT, directory));

  assert.ok(literals.size > 60, `expected to find the runtime's failure codes, found ${literals.size}`);
  const unclassified = [...literals]
    .filter((code) => classifyFailure(code, null).kind === "unknown")
    // Enums that are not failures at all: verification states, safety verdicts, risk levels, statuses.
    .filter((code) => !/^(VERIFIED|UNVERIFIED|ALLOWED|DENIED|CONFIRMED|NOT_APPLICABLE|UNKNOWN_BLOCK|LOW|MEDIUM|HIGH|CRITICAL|IDLE|RUNNING|CONNECTED|DISCONNECTED|FAILED|SUCCESS)/.test(code))
    // Reflex situations describe the world (e.g. a hostile nearby). When one of them matters to a running action it
    // surfaces as REFLEX_INTERRUPT, which is classified; the situation codes themselves are never failures.
    .filter((code) => !(REFLEX_CODES as readonly string[]).includes(code));
  assert.deepEqual(unclassified, [], "add any new failure code to the taxonomy so it is never shown as unexplained");
});
