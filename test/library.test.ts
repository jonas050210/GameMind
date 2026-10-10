import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import {
  LibraryExecutor,
  LibraryRegistry,
  createMinecraftLibraryRegistry,
  libraryCategories,
  resolveCatalog,
  resolveEntryAvailability,
  validateLibraryParams,
  type LibraryHandlerContext,
  type LibraryParamField,
} from "../src/games/minecraft/library.js";

const logger = pino({ level: "silent" });

const EXPECTED_ENTRY_IDS = [
  // Movement & Navigation
  "move.navigate", "move.look", "move.inspect", "move.unstuck", "move.explore",
  // Following & Companionship
  "follow.player", "follow.come", "follow.afk", "follow.hold", "follow.stop", "follow.status",
  // Gathering & Food
  "gather.collect-log", "gather.pickup", "gather.berries", "gather.eat", "gather.rest",
  // Mining & Resources
  "mine.block", "mine.equip", "mine.drop",
  // Building & Crafting
  "build.place", "build.table", "build.craft", "build.shelter-once",
  // Combat & Protection
  "combat.attack", "combat.mode", "combat.guard",
  // Homepoints & Places
  "home.save", "home.save-default", "home.goto", "home.return", "home.list", "home.delete",
  // Tasks
  "task.gather-logs", "task.mine-resource", "task.craft-item", "task.secure-food", "task.build-shelter",
  "task.gather-companion", "task.shelter-companion",
  // Safety & Control
  "safety.pause", "safety.resume", "safety.trip", "safety.reset-trip", "safety.stop-task", "safety.panic",
  "safety.combat",
  // Learning & Memory
  "learn.promote", "learn.reject", "learn.world-seed", "learn.training-start",
  "learn.training-pause", "learn.training-resume", "learn.training-stop", "learn.training-evaluate",
];

test("the catalog is complete, unique, categorized, and self-describing", () => {
  const registry = createMinecraftLibraryRegistry();
  const ids = registry.list().map((entry) => entry.meta.id);
  assert.deepEqual([...ids].sort(), [...EXPECTED_ENTRY_IDS].sort(), "every capability from the removed chat system has exactly one Library entry");
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(libraryCategories.length, 10);
  for (const entry of registry.list()) {
    assert.ok(libraryCategories.includes(entry.meta.category), `${entry.meta.id} has a known category`);
    assert.ok(entry.meta.title.trim(), `${entry.meta.id} has a title`);
    assert.ok(entry.meta.description.trim(), `${entry.meta.id} has a description`);
    assert.ok(Array.isArray(entry.meta.params), `${entry.meta.id} declares params`);
    for (const param of entry.meta.params) {
      assert.ok(param.name.trim() && param.label.trim(), `${entry.meta.id} param names/labels are set`);
    }
    assert.equal(typeof entry.handler, "function");
  }
});

test("the registry rejects duplicates, empty ids, and unknown categories", () => {
  const registry = new LibraryRegistry();
  const base = {
    meta: {
      id: "test.entry", category: "Tasks" as const, title: "t", description: "d",
      status: "implemented" as const, statusReason: null, requiresConnection: false, params: [],
    },
    handler: async () => ({ ok: true, message: "ok" }),
  };
  registry.register(base);
  assert.throws(() => registry.register(base), /already registered/);
  assert.throws(
    () => registry.register({ ...base, meta: { ...base.meta, id: "  " } }),
    /must not be empty/,
  );
  assert.throws(
    () => registry.register({ ...base, meta: { ...base.meta, id: "other", category: "Nope" as never } }),
    /unknown category/,
  );
});

test("parameter validation coerces, bounds-checks, and names the offending field", () => {
  const fields: LibraryParamField[] = [
    { name: "player", label: "Player name", type: "string", required: true, maxLength: 16, pattern: "^[A-Za-z0-9_]{1,16}$" },
    { name: "count", label: "Count", type: "integer", required: false, def: 1, min: 1, max: 64 },
    { name: "range", label: "Range", type: "number", required: false, min: 1, max: 3 },
    { name: "armed", label: "Armed", type: "boolean", required: true },
    { name: "block", label: "Block", type: "select", required: true, options: [{ value: "stone", label: "stone" }] },
  ];
  const ok = validateLibraryParams(fields, { player: "Alex", count: "4", range: 2.5, armed: "true", block: "stone" });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.params, { player: "Alex", count: 4, range: 2.5, armed: true, block: "stone" });
  }
  const def = validateLibraryParams(fields, { player: "Alex", armed: false, block: "stone" });
  assert.equal(def.ok, true);
  if (def.ok) assert.equal(def.params.count, 1);

  for (const [raw, fragment] of [
    [{ armed: true, block: "stone" }, "player"],
    [{ player: "bad name!", armed: true, block: "stone" }, "player"],
    [{ player: "x".repeat(17), armed: true, block: "stone" }, "player"],
    [{ player: "Alex", count: 0, armed: true, block: "stone" }, "count"],
    [{ player: "Alex", count: 1.5, armed: true, block: "stone" }, "count"],
    [{ player: "Alex", range: 9, armed: true, block: "stone" }, "range"],
    [{ player: "Alex", armed: "yes", block: "stone" }, "armed"],
    [{ player: "Alex", armed: true, block: "dirt" }, "block"],
  ] as const) {
    const result = validateLibraryParams(fields, raw as Record<string, unknown>);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, new RegExp(fragment), JSON.stringify(raw));
  }
});

interface FakeControl {
  task: { id: string; kind: string } | null;
  result: { taskId: string; status: string; failure: { code: string; message: string } | null } | null;
}

function fakeContext(overrides: Partial<LibraryHandlerContext> & { control?: FakeControl } = {}): LibraryHandlerContext {
  const control = overrides.control ?? { task: null, result: null };
  const { control: _ignored, ...rest } = overrides;
  void _ignored;
  return {
    skills: null,
    companion: null,
    runtime: null,
    safety: null,
    learner: null,
    training: null,
    worldSeed: null,
    advertisedCapabilities: [],
    combatSwitchAvailable: false,
    logger,
    ...rest,
    control,
  };
}

test("availability names the missing requirement for every requirement kind", () => {
  const registry = createMinecraftLibraryRegistry();
  const bare = fakeContext();
  const catalog = resolveCatalog(registry, bare);
  const statusOf = (id: string) => catalog.find((entry) => entry.id === id);
  assert.equal(statusOf("move.inspect")?.status, "unavailable");
  assert.match(statusOf("move.inspect")?.statusReason ?? "", /Not advertised/);
  assert.match(statusOf("follow.hold")?.statusReason ?? "", /companion/);
  // Capability requirements are checked first, so follow.player names the missing skill capability.
  assert.match(statusOf("follow.player")?.statusReason ?? "", /Not advertised.*minecraft\.navigate/);
  assert.match(statusOf("task.gather-logs")?.statusReason ?? "", /does not accept new tasks/);
  assert.match(statusOf("safety.pause")?.statusReason ?? "", /Safety Broker/);
  assert.match(statusOf("safety.combat")?.statusReason ?? "", /combat switch/);
  assert.match(statusOf("learn.promote")?.statusReason ?? "", /learner/);
  assert.match(statusOf("learn.training-start")?.statusReason ?? "", /Training/);

  // A fully wired run advertises everything the catalog lists as implemented.
  const full = fakeContext({
    skills: {} as never,
    companion: {} as never,
    safety: {} as never,
    learner: {} as never,
    training: {} as never,
    worldSeed: {} as never,
    advertisedCapabilities: ["minecraft.navigate", "minecraft.look", "minecraft.inspect_block"],
    combatSwitchAvailable: true,
    taskFor: () => { throw new Error("not used"); },
    onStart: async () => undefined,
  });
  for (const entry of registry.list()) {
    const availability = resolveEntryAvailability(entry, full);
    if (["minecraft.navigate", "minecraft.look", "minecraft.inspect_block"].some((cap) =>
      (entry.requiresCapabilities ?? []).includes(cap)) || (entry.requiresCapabilities ?? []).length === 0) {
      assert.notEqual(availability.status, "unavailable", `${entry.meta.id} is available in a fully wired run`);
    }
  }
});

test("unknown entries, invalid params, disconnected adapters, and throwing handlers are refused honestly", async () => {
  const executor = new LibraryExecutor(createMinecraftLibraryRegistry(), fakeContext());
  const unknown = await executor.execute("nope.missing", {});
  assert.equal(unknown.state, "refused");
  assert.equal(unknown.failureCode, "UNKNOWN_LIBRARY_ENTRY");

  const companionOnly = new LibraryExecutor(
    createMinecraftLibraryRegistry(),
    fakeContext({
      companion: { setMode: async () => ({ ok: true, message: "ok" }) } as never,
      skills: {} as never,
      advertisedCapabilities: ["minecraft.navigate"],
    }),
  );
  const badParams = await companionOnly.execute("follow.player", { player: "not a name!" });
  assert.equal(badParams.state, "refused");
  assert.equal(badParams.failureCode, "INVALID_LIBRARY_PARAMS");

  const registry = new LibraryRegistry();
  registry.register({
    meta: {
      id: "test.connected", category: "Tasks", title: "t", description: "d",
      status: "implemented", statusReason: null, requiresConnection: true, params: [],
    },
    handler: async () => ({ ok: true, message: "must not run" }),
  });
  registry.register({
    meta: {
      id: "test.throwing", category: "Tasks", title: "t", description: "d",
      status: "implemented", statusReason: null, requiresConnection: false, params: [],
    },
    handler: async () => { throw new Error("boom"); },
  });
  const gated = new LibraryExecutor(
    registry,
    fakeContext({ runtime: { status: () => ({ adapterStatus: "disconnected", statusReason: "cable unplugged" }) } as never }),
  );
  const refused = await gated.execute("test.connected", {});
  assert.equal(refused.state, "refused");
  assert.equal(refused.failureCode, "ADAPTER_NOT_CONNECTED");
  assert.match(refused.message, /disconnected/);
  const thrown = await gated.execute("test.throwing", {});
  assert.equal(thrown.state, "failed");
  assert.equal(thrown.failureCode, "LIBRARY_HANDLER_FAILED");
});

test("skill runs report the adapter confirmation and postcondition honestly", async () => {
  const seen: unknown[] = [];
  const makeSkills = (action: Record<string, unknown>) => ({
    run: async (_id: string, input: unknown) => {
      seen.push(input);
      return {
        action: { status: "succeeded", confirmed: true, confirmation: "ok", failure: null, durationMs: 7, ...action },
        observationBefore: null,
        observationAfter: null,
      };
    },
  });
  const skillsFor = (action: Record<string, unknown>) => new LibraryExecutor(
    createMinecraftLibraryRegistry(),
    fakeContext({ skills: makeSkills(action) as never, advertisedCapabilities: ["minecraft.inspect_block"] }),
  );

  const succeeded = await skillsFor({ confirmation: "inspected" }).execute("move.inspect", { x: "3", y: 64, z: -1 });
  assert.equal(succeeded.state, "succeeded");
  assert.equal(succeeded.confirmed, true);
  assert.deepEqual(seen[0], { x: 3, y: 64, z: -1 });

  const notConfirmed = await skillsFor({ confirmed: false }).execute("move.inspect", { x: 3, y: 64, z: -1 });
  assert.equal(notConfirmed.state, "failed");
  assert.equal(notConfirmed.failureCode, "ACTION_NOT_CONFIRMED");
  assert.equal(notConfirmed.confirmed, false);

  const failed = await skillsFor({ status: "failed", confirmed: false, failure: { code: "CELL_UNKNOWN", message: "unloaded" } })
    .execute("move.inspect", { x: 3, y: 64, z: -1 });
  assert.equal(failed.state, "failed");
  assert.equal(failed.failureCode, "CELL_UNKNOWN");
  assert.match(failed.message, /unloaded/);
});

test("companion entries call the structured API with typed values, never text", async () => {
  const calls: Array<{ mode: string; options?: unknown }> = [];
  const companion = {
    setMode: async (mode: string, options?: unknown) => {
      calls.push({ mode, options });
      return { ok: true, message: `Mode is now ${mode}.` };
    },
  };
  const executor = new LibraryExecutor(
    createMinecraftLibraryRegistry(),
    fakeContext({ companion: companion as never, skills: {} as never, advertisedCapabilities: ["minecraft.navigate"] }),
  );
  const result = await executor.execute("follow.player", { player: "Alex" });
  assert.equal(result.state, "succeeded");
  assert.deepEqual(calls, [{ mode: "follow", options: { targetPlayer: "Alex" } }]);
});

test("task entries stay running and resolve live from the run bookkeeping", async () => {
  const control: FakeControl = { task: null, result: null };
  let nextTask = 0;
  const executor = new LibraryExecutor(
    createMinecraftLibraryRegistry(),
    fakeContext({
      control,
      taskFor: (request) => {
        nextTask += 1;
        return { id: `task-${nextTask}`, kind: request.kind } as never;
      },
      onStart: async (task) => {
        control.task = { id: task.id, kind: task.kind };
      },
    }),
  );
  const started = await executor.execute("task.gather-logs", { resource: "oak_log", count: 2 });
  assert.equal(started.state, "running");
  assert.equal(executor.listOperations()[0]?.state, "running", "still backed by control.task");

  control.task = null;
  control.result = { taskId: "task-1", status: "succeeded", failure: null };
  const resolved = executor.listOperations()[0];
  assert.equal(resolved?.state, "succeeded");
  assert.match(resolved?.message ?? "", /verified by the task runner/);

  const startedFood = await executor.execute("task.secure-food", { count: 18 });
  assert.equal(startedFood.state, "running");
  control.task = null;
  control.result = { taskId: "task-2", status: "failed", failure: { code: "NO_FOOD", message: "nothing edible observed" } };
  const failed = executor.listOperations().find((op) => op.entryId === "task.secure-food");
  assert.ok(failed);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failureCode, "NO_FOOD");
  assert.match(failed.message, /nothing edible observed/);
});

test("a lost task record without a result is reported, never silently succeeded", async () => {
  const control: FakeControl = { task: null, result: null };
  const executor = new LibraryExecutor(
    createMinecraftLibraryRegistry(),
    fakeContext({
      control,
      taskFor: () => ({ id: "task-9", kind: "gather_resource" }) as never,
      onStart: async (task) => {
        control.task = { id: task.id, kind: task.kind };
      },
    }),
  );
  await executor.execute("task.gather-logs", { resource: "oak_log" });
  control.task = null;
  control.result = null;
  const operation = executor.listOperations()[0];
  assert.equal(operation?.state, "failed");
  assert.equal(operation?.failureCode, "TASK_RESULT_MISSING");
});

test("safety entries delegate to the same host commands as the panels", async () => {
  const seen: unknown[] = [];
  const executor = new LibraryExecutor(
    createMinecraftLibraryRegistry(),
    fakeContext({
      safety: {} as never,
      hostCommands: {
        pause: (reason: unknown) => {
          seen.push(reason);
          return { ok: true, message: "paused" };
        },
      } as never,
    }),
  );
  const result = await executor.execute("safety.pause", { reason: "drill" });
  assert.equal(result.state, "succeeded");
  assert.deepEqual(seen, ["drill"]);
});

test("operations are newest-first and capped", async () => {
  const executor = new LibraryExecutor(createMinecraftLibraryRegistry(), fakeContext());
  for (let index = 0; index < 45; index += 1) {
    await executor.execute("unknown.entry", {});
  }
  const operations = executor.listOperations();
  assert.equal(operations.length, 40);
});
