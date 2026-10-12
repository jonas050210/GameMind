import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import type { GameMindRuntime } from "../src/core/game-mind-runtime.js";
import type { SkillRuntime } from "../src/core/skill-runtime.js";
import type { WorldState } from "../src/core/types.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { MinecraftChatController, type MinecraftChatMessage, type MinecraftChatTransport } from "../src/games/minecraft/minecraft-chat-controller.js";
import type { CompanionController } from "../src/games/minecraft/companion-controller.js";
import { parseMinecraftChatCommand } from "../src/games/minecraft/chat-commands.js";
import type { MinecraftTask } from "../src/games/minecraft/task.js";
import type { MinecraftTaskResult } from "../src/games/minecraft/task-runner.js";
import { createFakeMinecraftFixture } from "../src/testing/fake-minecraft-adapter.js";

class ChatTransport implements MinecraftChatTransport {
  private readonly listeners = new Set<(message: MinecraftChatMessage) => void>();
  private readonly deathListeners = new Set<() => void>();
  private readonly respawnListeners = new Set<() => void>();
  readonly sent: string[] = [];

  onChatMessage(listener: (message: MinecraftChatMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDeath(listener: () => void): () => void {
    this.deathListeners.add(listener);
    return () => this.deathListeners.delete(listener);
  }

  onRespawn(listener: () => void): () => void {
    this.respawnListeners.add(listener);
    return () => this.respawnListeners.delete(listener);
  }

  sendChat(message: string): void { this.sent.push(message); }

  emit(username: string, message: string): void {
    for (const listener of this.listeners) listener({ username, message });
  }

  emitDeath(): void {
    for (const listener of this.deathListeners) listener();
  }

  emitRespawn(): void {
    for (const listener of this.respawnListeners) listener();
  }
}

type TestWorld = WorldState<MinecraftObservation>;

function stack(name: string, count = 1): MinecraftObservation["inventory"][number] {
  return { slot: 9, name, type: 1, count, metadata: null, durabilityUsed: null };
}

function makeWorld(
  inventory: MinecraftObservation["inventory"] = [stack("diamond", 2)],
  options: {
    readonly operatorVisible?: boolean;
    readonly equipment?: Partial<MinecraftObservation["equipment"]>;
    readonly alive?: boolean;
  } = {},
): TestWorld {
  const fixture = createFakeMinecraftFixture(1337);
  const state: MinecraftObservation = {
    ...fixture,
    player: {
      ...fixture.player,
      position: { x: 0, y: 64, z: 0 },
      alive: options.alive ?? true,
      username: "GameMind",
    },
    inventory,
    equipment: { ...fixture.equipment, ...options.equipment },
    entities: options.operatorVisible === false ? [] : [
      { id: "operator", name: "Operator_1", type: "player", position: { x: 0, y: 64, z: 0.5 }, distance: 0.5, health: 20 },
    ],
  };
  const observedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    gameId: "minecraft-java",
    gameVersion: "1.20.4",
    sessionId: "session",
    sequence: 1,
    observedAt,
    receivedAt: observedAt,
    state,
  };
}

function result(task: MinecraftTask, finalWorld: TestWorld, gained: number): MinecraftTaskResult {
  return {
    taskId: task.id,
    status: "succeeded",
    failure: null,
    metrics: { targetItemsGained: gained } as MinecraftTaskResult["metrics"],
    actions: [],
    finalObservation: finalWorld,
  } as MinecraftTaskResult;
}

type FakeSkillRun = (skillId: string, input: unknown) => Promise<unknown>;

function setup(
  runTask: (task: MinecraftTask) => Promise<MinecraftTaskResult> = async (task) => result(task, makeWorld(), 0),
  options: {
    readonly initialInventory?: MinecraftObservation["inventory"];
    readonly initialEquipment?: Partial<MinecraftObservation["equipment"]>;
    readonly operatorVisible?: boolean;
    readonly skillRun?: FakeSkillRun;
    readonly confirmationTimeoutMs?: number;
    readonly deliveryTimeoutMs?: number;
    readonly taskRunning?: () => boolean;
    readonly currentTask?: () => MinecraftTask | null;
    readonly requestTaskStop?: (reason: string) => void;
  } = {},
) {
  let world = makeWorld(options.initialInventory ?? [stack("diamond", 2)], {
    ...(options.operatorVisible !== undefined ? { operatorVisible: options.operatorVisible } : {}),
    ...(options.initialEquipment !== undefined ? { equipment: options.initialEquipment } : {}),
  });
  const runtime = {
    get currentWorldState() { return world; },
    observeIfStale: async () => world,
    observe: async () => world,
  } as unknown as GameMindRuntime<MinecraftObservation>;
  const calls: Array<{ method: string; mode?: string; target?: string }> = [];
  const companion = {
    setMode: async (mode: string, modeOptions: { targetPlayer?: string | null } = {}) => {
      calls.push({ method: "setMode", mode, ...(modeOptions.targetPlayer ? { target: modeOptions.targetPlayer } : {}) });
      return { ok: true, message: `Mode ${mode}` };
    },
    getStatus: async () => ({ ok: true, message: "Mode follow; health 20/20." }),
    halt: async () => ({ ok: true, message: "Stopped." }),
  } as unknown as CompanionController;
  const transport = new ChatTransport();
  const tasks: MinecraftTask[] = [];
  const skillCalls: Array<{ skillId: string; input: unknown }> = [];
  const skills = {
    run: async (skillId: string, input: unknown) => {
      skillCalls.push({ skillId, input });
      if (options.skillRun) return options.skillRun(skillId, input);
      throw new Error("unexpected direct skill call");
    },
  } as unknown as SkillRuntime<MinecraftObservation>;
  const controller = new MinecraftChatController({
    operatorUsername: "Operator_1",
    transport,
    runtime,
    skills,
    companion,
    logger: pino({ level: "silent" }),
    runTask: async (task) => {
      tasks.push(task);
      const taskResult = await runTask(task);
      if (taskResult.finalObservation) world = taskResult.finalObservation;
      return taskResult;
    },
    currentTask: options.currentTask ?? (() => null),
    taskRunning: options.taskRunning ?? (() => false),
    requestTaskStop: options.requestTaskStop ?? (() => undefined),
    ...(options.confirmationTimeoutMs !== undefined ? { confirmationTimeoutMs: options.confirmationTimeoutMs } : {}),
    ...(options.deliveryTimeoutMs !== undefined ? { deliveryTimeoutMs: options.deliveryTimeoutMs } : {}),
  });
  controller.start();
  return {
    controller,
    transport,
    calls,
    tasks,
    skillCalls,
    get world() { return world; },
    setWorld(next: TestWorld) { world = next; },
  };
}

const flush = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("only the exact configured Minecraft player can issue chat controls", async () => {
  const { controller, transport, calls, tasks } = setup();
  transport.emit("operator_1", "stopp");
  transport.emit("Alex", "hol noch 5 diamanten");
  await flush();
  assert.deepEqual(calls, []);
  assert.deepEqual(tasks, []);
  assert.deepEqual(transport.sent, []);

  transport.emit("Operator_1", "folge mir");
  await flush();
  assert.deepEqual(calls, [{ method: "setMode", mode: "follow", target: "Operator_1" }]);
  assert.equal(transport.sent.length, 1);
  controller.stop();
});

test("chat resource tasks distinguish total targets from explicit additional counts", async () => {
  const { controller, transport, tasks } = setup();
  transport.emit("Operator_1", "hol noch 5 diamanten");
  await flush();
  assert.equal(tasks[0]?.kind, "mine_resource");
  assert.equal(tasks[0]?.kind === "mine_resource" ? tasks[0].targetCount : null, 7, "two carried diamonds plus five additional");

  transport.emit("Operator_1", "farme weiter, bis du 5 hast");
  await flush();
  assert.equal(tasks[1]?.kind, "mine_resource");
  assert.equal(tasks[1]?.kind === "mine_resource" ? tasks[1].targetCount : null, 5, "until five means five total");

  const bareCount = parseMinecraftChatCommand("miniere 5 Diamanten");
  assert.equal(bareCount?.kind, "resource");
  assert.equal(bareCount?.kind === "resource" ? bareCount.countMode : null, "total");
  controller.stop();
});

test("a confirmed resource hand-off waits for the exact nearby operator and verifies the inventory delta", async () => {
  const delivered = makeWorld([stack("diamond", 2)]);
  const { controller, transport, calls, tasks, skillCalls } = setup(
    async (task) => result(task, makeWorld([stack("diamond", 5)]), 3),
    {
      skillRun: async (skillId, input) => {
        assert.equal(skillId, "minecraft.give-item");
        const before = makeWorld([stack("diamond", 5)]);
        return {
          action: { status: "succeeded", confirmed: true, failure: null },
          observationBefore: before,
          observationAfter: delivered,
        };
      },
    },
  );
  transport.emit("Operator_1", "hol noch 3 diamanten");
  await flush();
  assert.match(transport.sent.at(-1) ?? "", /Soll ich zu dir kommen und sie ablegen\?/);
  assert.equal(tasks[0]?.kind, "mine_resource");

  transport.emit("Operator_1", "ja");
  await flush();
  assert.equal(skillCalls.length, 1);
  assert.deepEqual(skillCalls[0], {
    skillId: "minecraft.give-item",
    input: { itemName: "diamond", count: 3, targetUsername: "Operator_1", maxDistance: 3, dangerRadius: 6 },
  });
  assert.match(transport.sent.at(-1) ?? "", /Abgelegt und Inventaränderung geprüft/);
  assert.ok(calls.some((call) => call.method === "setMode" && call.mode === "come"));
  assert.ok(calls.some((call) => call.method === "setMode" && call.mode === "follow"));
  controller.stop();
});

test("stop remains responsive while a confirmed delivery is travelling toward an unseen operator", async () => {
  const { controller, transport, calls, skillCalls } = setup(
    async (task) => result(task, makeWorld([stack("diamond", 3)], { operatorVisible: false }), 1),
    { operatorVisible: false, deliveryTimeoutMs: 10_000 },
  );
  transport.emit("Operator_1", "hol noch 1 diamanten");
  await flush();
  transport.emit("Operator_1", "ja");
  await flush();
  assert.ok(calls.some((call) => call.method === "setMode" && call.mode === "come"));

  transport.emit("Operator_1", "stopp");
  await flush();
  assert.ok(calls.some((call) => call.method === "setMode" && call.mode === "hold"));
  assert.equal(skillCalls.length, 0, "no transfer is attempted while the operator is not visible");
  assert.match(transport.sent.at(-1) ?? "", /Stopp/);
  controller.stop();
});

test("a cuboid excavation captures the receive-time position and changes no blocks before approval", async () => {
  const { controller, transport, tasks } = setup();
  transport.emit("Operator_1", "grabe 4x2x4 hier aus");
  await flush();
  assert.equal(tasks.length, 0, "planning a destructive request must not submit it");
  assert.ok(transport.sent.some((message) => /höchstens 32 Zellen/.test(message)));
  assert.ok(transport.sent.some((message) => /Ja\/Nein/.test(message)));

  transport.emit("Operator_1", "ja");
  await flush();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.kind, "excavate_volume");
  if (tasks[0]?.kind === "excavate_volume") {
    assert.deepEqual(tasks[0].origin, { x: -2, y: 62, z: -2 }, "the requested height extends downward from the ground surface");
    assert.deepEqual([tasks[0].width, tasks[0].height, tasks[0].depth], [4, 2, 4]);
  }
  controller.stop();
});

test("declining a destructive excavation plan submits no task", async () => {
  const { controller, transport, tasks, calls } = setup();
  transport.emit("Operator_1", "dig 2x2x2 at -10 64 22");
  await flush();
  assert.equal(tasks.length, 0);
  transport.emit("Operator_1", "nein");
  await flush();
  assert.equal(tasks.length, 0);
  assert.ok(transport.sent.some((message) => /kein Block verändert/.test(message)));
  assert.ok(calls.some((call) => call.method === "setMode" && call.mode === "follow"));
  controller.stop();
});

test("expired delivery questions fail closed and do not drop items", async () => {
  const { controller, transport, skillCalls, calls } = setup(
    async (task) => result(task, makeWorld([stack("diamond", 3)]), 1),
    { confirmationTimeoutMs: 5 },
  );
  transport.emit("Operator_1", "hol noch 1 diamanten");
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 15));
  transport.emit("Operator_1", "ja");
  await flush();
  assert.equal(skillCalls.length, 0);
  assert.ok(transport.sent.some((message) => /Bestätigungsfrist ist abgelaufen/.test(message)));
  assert.ok(calls.some((call) => call.method === "setMode" && call.mode === "follow"));
  controller.stop();
});

test("after respawn, the previous resource task waits for an explicit confirmation", async () => {
  let firstTask = true;
  const inventory = [stack("diamond", 2), stack("wooden_axe"), stack("wooden_sword")];
  const oldTask = { resolve: null as ((value: MinecraftTaskResult) => void) | null };
  const { controller, transport, calls, tasks } = setup(
    async (task) => {
      if (firstTask) {
        firstTask = false;
        return new Promise<MinecraftTaskResult>((resolve) => { oldTask.resolve = resolve; });
      }
      return result(task, makeWorld(inventory, { equipment: { hand: stack("wooden_pickaxe") } }), 0);
    },
    {
      initialInventory: inventory,
      initialEquipment: { hand: stack("wooden_pickaxe") },
    },
  );

  transport.emit("Operator_1", "hol 1 kohle");
  await flush();
  assert.equal(tasks.length, 1);
  transport.emitDeath();
  transport.emitRespawn();
  await flush();
  assert.match(transport.sent.join(" "), /Soll ich den letzten Auftrag .* fortsetzen\? Ja\/Nein/, "the prompt may be split across deliverable Minecraft chat messages");

  transport.emit("Operator_1", "nein");
  await flush();
  assert.equal(tasks.length, 1, "declining never resumes the previous task");
  assert.ok(calls.some((call) => call.method === "setMode" && call.mode === "follow"));
  controller.stop();
  oldTask.resolve?.(result(tasks[0]!, makeWorld(inventory, { equipment: { hand: stack("wooden_pickaxe") } }), 0));
});

test("a respawn with no interrupted task restores default follow mode", async () => {
  const inventory = [stack("wooden_axe"), stack("wooden_sword")];
  const { controller, transport, calls } = setup(undefined, {
    initialInventory: inventory,
    initialEquipment: { hand: stack("wooden_pickaxe") },
  });
  transport.emitDeath();
  transport.emitRespawn();
  await flush();
  assert.ok(calls.some((call) => call.method === "setMode" && call.mode === "follow"));
  assert.ok(transport.sent.some((message) => /Kein Auftrag wartet auf Bestätigung/.test(message)));
  controller.stop();
});

test("yes after respawn resumes only after the task scheduler is idle and tool requirements are rechecked", async () => {
  let firstTask = true;
  let schedulerRunning = false;
  const inventory = [stack("diamond", 2), stack("wooden_axe"), stack("wooden_sword")];
  const oldTask = { resolve: null as ((value: MinecraftTaskResult) => void) | null };
  const { controller, transport, tasks } = setup(
    async (task) => {
      if (firstTask) {
        firstTask = false;
        schedulerRunning = true;
        return new Promise<MinecraftTaskResult>((resolve) => { oldTask.resolve = resolve; });
      }
      schedulerRunning = true;
      const taskResult = result(task, makeWorld(inventory, { equipment: { hand: stack("wooden_pickaxe") } }), 0);
      schedulerRunning = false;
      return taskResult;
    },
    {
      initialInventory: inventory,
      initialEquipment: { hand: stack("wooden_pickaxe") },
      taskRunning: () => schedulerRunning,
      requestTaskStop: () => { schedulerRunning = false; },
    },
  );

  transport.emit("Operator_1", "hol 1 kohle");
  await flush();
  transport.emitDeath();
  transport.emitRespawn();
  await flush();
  transport.emit("Operator_1", "ja");
  await flush();
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1]?.kind, "mine_resource");
  assert.ok(transport.sent.some((message) => /setze mine coal_ore jetzt fort/.test(message)));
  controller.stop();
  oldTask.resolve?.(result(tasks[0]!, makeWorld(inventory, { equipment: { hand: stack("wooden_pickaxe") } }), 0));
});

test("a diamond mining order is not resumed after respawn without an iron-tier pickaxe", async () => {
  let firstTask = true;
  const inventory = [stack("diamond", 2), stack("wooden_axe"), stack("wooden_sword")];
  const oldTask = { resolve: null as ((value: MinecraftTaskResult) => void) | null };
  const { controller, transport, tasks } = setup(
    async (task) => {
      if (firstTask) {
        firstTask = false;
        return new Promise<MinecraftTaskResult>((resolve) => { oldTask.resolve = resolve; });
      }
      return result(task, makeWorld(inventory, { equipment: { hand: stack("wooden_pickaxe") } }), 0);
    },
    {
      initialInventory: inventory,
      initialEquipment: { hand: stack("wooden_pickaxe") },
    },
  );

  transport.emit("Operator_1", "hol noch 1 diamant");
  await flush();
  transport.emitDeath();
  transport.emitRespawn();
  await flush();
  transport.emit("Operator_1", "ja");
  await flush();
  assert.equal(tasks.length, 1, "a wooden pickaxe cannot resume a diamond-ore order");
  assert.ok(transport.sent.some((message) => /mindestens eine Eisenspitzhacke/.test(message)));
  controller.stop();
  oldTask.resolve?.(result(tasks[0]!, makeWorld(inventory, { equipment: { hand: stack("wooden_pickaxe") } }), 0));
});

test("generic house requests are plan-only and never fall through to the fixed starter prototype", async () => {
  const { controller, transport, tasks, skillCalls } = setup();
  transport.emit("Operator_1", "build a big house");
  await flush();
  assert.equal(tasks.length, 0);
  assert.equal(skillCalls.length, 0);
  assert.ok(transport.sent.some((message) => /Drafts A.*B.*C/.test(message)));
  assert.ok(transport.sent.some((message) => /plan house A.*plan house B.*plan house C/.test(message)));
  controller.stop();
});

test("a plan-only generic house request does not stop an unrelated active task", async () => {
  let stopRequests = 0;
  const { controller, transport, tasks } = setup(undefined, {
    taskRunning: () => true,
    requestTaskStop: () => { stopRequests += 1; },
  });
  transport.emit("Operator_1", "build a house");
  await flush();
  assert.equal(stopRequests, 0);
  assert.equal(tasks.length, 0);
  assert.ok(transport.sent.some((message) => /continues unchanged/.test(message)));
  controller.stop();
});

test("starter house requires separate project and material approvals; declining collection stays inventory-only", async () => {
  const { controller, transport, tasks, skillCalls } = setup();
  transport.emit("Operator_1", "build a small house");
  await flush();
  assert.equal(tasks.length, 0);
  assert.ok(transport.sent.some((message) => /80 Eichenbretter/.test(message)));

  transport.emit("Operator_1", "yes");
  await flush();
  assert.equal(tasks.length, 0, "the first approval must not gather or build");
  assert.ok(transport.sent.some((message) => /Separate Freigabe für Materialsammlung/.test(message)));

  transport.emit("Operator_1", "no");
  await flush();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.kind, "build_house");
  assert.equal(tasks[0]?.kind === "build_house" ? tasks[0].allowMaterialGathering : true, false);
  assert.equal(skillCalls.length, 0, "this controller test must not execute a live skill");
  assert.ok(transport.sent.some((message) => /Materialsammlung abgelehnt/.test(message)));
  controller.stop();
});

test("an explicitly nominated starter-house corner is preserved through the approval flow", async () => {
  const { controller, transport, tasks, skillCalls } = setup();
  transport.emit("Operator_1", "build starter house at -12 64 90");
  await flush();
  assert.ok(transport.sent.some((message) => /unteren Ecke.*Start -12,64,90/.test(message)));

  transport.emit("Operator_1", "yes");
  await flush();
  transport.emit("Operator_1", "no");
  await flush();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.kind, "build_house");
  assert.deepEqual(tasks[0]?.kind === "build_house" ? tasks[0].origin : null, { x: -12, y: 64, z: 90 });
  assert.equal(tasks[0]?.kind === "build_house" ? tasks[0].allowMaterialGathering : true, false);
  assert.equal(skillCalls.length, 0);
  controller.stop();
});

test("separate house material approval enables only the bounded gathering permission", async () => {
  const { controller, transport, tasks } = setup();
  transport.emit("Operator_1", "build starter house");
  await flush();
  transport.emit("Operator_1", "yes");
  await flush();
  transport.emit("Operator_1", "yes");
  await flush();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.kind, "build_house");
  assert.equal(tasks[0]?.kind === "build_house" ? tasks[0].allowMaterialGathering : false, true);
  assert.ok(transport.sent.some((message) => /höchstens 20 Stück/.test(message)));
  controller.stop();
});

test("generic house request cancels an outstanding starter approval without submitting a task", async () => {
  const { controller, transport, tasks } = setup();
  transport.emit("Operator_1", "build starter house");
  await flush();
  transport.emit("Operator_1", "build a house");
  await flush();
  transport.emit("Operator_1", "yes");
  await flush();
  assert.equal(tasks.length, 0);
  assert.match(transport.sent.join(" "), /plan house A/);
  assert.match(transport.sent.join(" "), /earlier yes\/no question was canceled/);
  assert.ok(transport.sent.some((message) => /keine offene Ja\/Nein-Rückfrage/.test(message)));
  controller.stop();
});

test("selected large-house chat concept produces a planning-only preview without task or skill actions", async () => {
  const { controller, transport, tasks, skillCalls } = setup();
  transport.emit("Operator_1", "plan house A");
  await flush();
  assert.equal(tasks.length, 0);
  assert.equal(skillCalls.length, 0);
  assert.match(transport.sent.join(" "), /Offline plan A: Bavarian timber farmhouse/);
  assert.match(transport.sent.join(" "), /planning-only|relative plan only/i);
  assert.match(transport.sent.join(" "), /--house-plan A prints a summary.*--house-plan-json \.\/house-a\.json/);
  controller.stop();
});

test("choosing a large-house preview cancels any pending starter-house approval", async () => {
  const { controller, transport, tasks, skillCalls } = setup();
  transport.emit("Operator_1", "build starter house");
  await flush();
  transport.emit("Operator_1", "plan house A");
  await flush();
  transport.emit("Operator_1", "yes");
  await flush();
  assert.equal(tasks.length, 0);
  assert.equal(skillCalls.length, 0);
  assert.ok(transport.sent.some((message) => /earlier yes\/no prompt was canceled/.test(message)));
  assert.ok(transport.sent.some((message) => /keine offene Ja\/Nein-Rückfrage/i.test(message)));
  controller.stop();
});

test("material approval expiry does not start the house or collect nearby logs", async () => {
  const { controller, transport, tasks, skillCalls } = setup(undefined, { confirmationTimeoutMs: 10 });
  transport.emit("Operator_1", "build starter house");
  await flush();
  transport.emit("Operator_1", "yes");
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 25));
  transport.emit("Operator_1", "yes");
  await flush();
  assert.equal(tasks.length, 0);
  assert.equal(skillCalls.length, 0);
  assert.ok(transport.sent.some((message) => /Bestätigungsfrist ist abgelaufen/.test(message)));
  controller.stop();
});

test("long help replies are split into deliverable Minecraft chat messages instead of truncated", async () => {
  const { controller, transport } = setup();
  transport.emit("Operator_1", "/gamemind help");
  await flush();
  assert.ok(transport.sent.length > 1);
  assert.ok(transport.sent.every((message) => message.length <= 256));
  assert.match(transport.sent[0] ?? "", /^Commands:/);
  assert.match(transport.sent.join(" "), /plan house A\/B\/C/);
  assert.match(transport.sent.join(" "), /10×10×10/);

  transport.emit("Operator_1", "hilfe");
  await flush();
  assert.ok(transport.sent.some((message) => message.startsWith("Befehle:")));
  assert.ok(transport.sent.every((message) => message.length <= 256));
  controller.stop();
});
