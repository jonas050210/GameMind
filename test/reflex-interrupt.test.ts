import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { z } from "zod";
import { ActionExecutor } from "../src/core/action-executor.js";
import { MemoryTraceSink, TraceRecorder } from "../src/core/trace.js";
import type { AdapterAction, CapabilityDefinition } from "../src/core/types.js";
import { REFLEX_CODES } from "../src/games/minecraft/reflex.js";
import { REFLEX_PROTECTED_CAPABILITIES } from "../src/games/minecraft/attach-control-center.js";
import { MINECRAFT_ATTACK_HOSTILE_CAPABILITY, MINECRAFT_EAT_CAPABILITY, MINECRAFT_INSPECT_BLOCK_CAPABILITY, MINECRAFT_LOOK_CAPABILITY, MINECRAFT_SWIM_TO_SURFACE_CAPABILITY } from "../src/games/minecraft/capabilities.js";

/**
 * An adapter whose action runs until it is aborted or a long deadline passes. It stands in for a movement that
 * is in flight when an urgent condition appears, so the reflex interrupt can be checked against a real abort.
 */
function slowAdapter(capabilities: readonly CapabilityDefinition[]) {
  let seen: AbortSignal | null = null;
  const adapter = {
    gameId: "test",
    status: "connected",
    session: { id: "s1", gameId: "test", gameVersion: "1", connectedAt: new Date().toISOString() },
    capabilities,
    async connect() {
      return adapter.session!;
    },
    async observe() {
      throw new Error("not used");
    },
    executeAction(_action: AdapterAction, signal: AbortSignal) {
      seen = signal;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ confirmed: true, confirmation: "time elapsed" }), 2_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("aborted"));
        });
      });
    },
    async cancelActiveAction() {},
    async disconnect() {},
    onStatusChange() {
      return () => {};
    },
  };
  return { adapter: adapter as never, signal: () => seen };
}

function capability(name: string): CapabilityDefinition {
  return {
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    defaultTimeoutMs: 5_000,
    maxTimeoutMs: 5_000,
    risk: "low",
  };
}

test("reflex protection: eating, attacking, looking, inspecting and swimming out of water are never interrupted by a reflex", () => {
  // Swimming out of water is protected too: a hostile on the shore must not stop the agent from breathing.
  assert.deepEqual([...REFLEX_PROTECTED_CAPABILITIES].sort(), [
    MINECRAFT_ATTACK_HOSTILE_CAPABILITY,
    MINECRAFT_EAT_CAPABILITY,
    MINECRAFT_INSPECT_BLOCK_CAPABILITY,
    MINECRAFT_LOOK_CAPABILITY,
    MINECRAFT_SWIM_TO_SURFACE_CAPABILITY,
  ].sort());
  assert.ok(REFLEX_CODES.includes("CRITICAL_HEALTH"));
});

test("an urgent reflex aborts an unprotected in-flight action with REFLEX_INTERRUPT, and the executor reports it", async () => {
  const moveCapability = "minecraft.navigate";
  const { adapter, signal } = slowAdapter([capability(moveCapability)]);
  const trace = new TraceRecorder(new MemoryTraceSink(), pino({ level: "silent" }));
  const executor = new ActionExecutor(adapter, trace, pino({ level: "silent" }));

  const running = executor.execute({ sessionId: "s1", capability: moveCapability, input: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(executor.runningCapability, moveCapability);
  const outcome = executor.interruptActive("Reflex interrupt: Health is 4.0, at or below 6.", {
    code: "REFLEX_INTERRUPT",
    protectedCapabilities: REFLEX_PROTECTED_CAPABILITIES,
  });
  assert.deepEqual(outcome, { interrupted: true, capability: moveCapability });
  const result = await running;
  assert.equal(result.status, "aborted");
  assert.equal(result.failure?.code, "REFLEX_INTERRUPT");
  assert.ok(signal()?.aborted, "the adapter's signal was aborted, not left to run to its deadline");
});

test("an urgent reflex does not interrupt a protected action that is already eating or attacking", async () => {
  const { adapter } = slowAdapter([capability(MINECRAFT_EAT_CAPABILITY)]);
  const trace = new TraceRecorder(new MemoryTraceSink(), pino({ level: "silent" }));
  const executor = new ActionExecutor(adapter, trace, pino({ level: "silent" }));

  const running = executor.execute({ sessionId: "s1", capability: MINECRAFT_EAT_CAPABILITY, input: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const outcome = executor.interruptActive("Reflex interrupt: hostile close", {
    code: "REFLEX_INTERRUPT",
    protectedCapabilities: REFLEX_PROTECTED_CAPABILITIES,
  });
  assert.deepEqual(outcome, { interrupted: false, capability: MINECRAFT_EAT_CAPABILITY });
  const result = await running;
  assert.notEqual(result.failure?.code, "REFLEX_INTERRUPT", "the protected action ran to its own end");
});

test("interrupting an idle executor is a no-op that reports nothing was interrupted", () => {
  const { adapter } = slowAdapter([]);
  const trace = new TraceRecorder(new MemoryTraceSink(), pino({ level: "silent" }));
  const executor = new ActionExecutor(adapter, trace, pino({ level: "silent" }));
  assert.deepEqual(executor.interruptActive("nothing running", { code: "REFLEX_INTERRUPT" }), { interrupted: false, capability: null });
});
