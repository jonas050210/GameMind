import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import type { GameMindRuntime } from "../src/core/game-mind-runtime.js";
import type { SkillRuntime } from "../src/core/skill-runtime.js";
import type { WorldState } from "../src/core/types.js";
import type { MinecraftObservation } from "../src/games/minecraft/observation.js";
import { MinecraftChatController, withChatTimeout, type MinecraftChatMessage, type MinecraftChatTransport } from "../src/games/minecraft/minecraft-chat-controller.js";
import type { MinecraftChatResponder } from "../src/games/minecraft/ollama-chat-responder.js";
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
    readonly chatResponder?: MinecraftChatResponder;
    readonly chatTimeoutMs?: number;
    /** Companion modes whose `setMode` never settles, to reproduce a hung adapter call. */
    readonly hangingModes?: readonly string[];
    /** A logger the test can read, to assert what a session leaves behind in the log. */
    readonly logger?: pino.Logger;
    /** Parks every observation until this resolves, so a queued command is provably still mid-flight. */
    readonly observeGate?: Promise<void>;
  } = {},
) {
  let world = makeWorld(options.initialInventory ?? [stack("diamond", 2)], {
    ...(options.operatorVisible !== undefined ? { operatorVisible: options.operatorVisible } : {}),
    ...(options.initialEquipment !== undefined ? { equipment: options.initialEquipment } : {}),
  });
  const runtime = {
    get currentWorldState() { return world; },
    observeIfStale: async () => {
      if (options.observeGate !== undefined) await options.observeGate;
      return world;
    },
    observe: async () => world,
  } as unknown as GameMindRuntime<MinecraftObservation>;
  const calls: Array<{ method: string; mode?: string; target?: string }> = [];
  const companion = {
    setMode: async (mode: string, modeOptions: { targetPlayer?: string | null } = {}) => {
      calls.push({ method: "setMode", mode, ...(modeOptions.targetPlayer ? { target: modeOptions.targetPlayer } : {}) });
      if (options.hangingModes?.includes(mode)) return new Promise<{ ok: boolean; message: string }>(() => undefined);
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
    logger: options.logger ?? pino({ level: "silent" }),
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
    ...(options.chatResponder !== undefined ? { chatResponder: options.chatResponder } : {}),
    ...(options.chatTimeoutMs !== undefined ? { chatTimeoutMs: options.chatTimeoutMs } : {}),
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

/** Collects log lines instead of writing them, so a test can read what a live session would leave behind. */
function logCapture(): { readonly logger: pino.Logger; readonly lines: string[] } {
  const lines: string[] = [];
  const destination = { write: (chunk: string): void => { lines.push(chunk); } };
  return { logger: pino({ level: "debug" }, destination), lines };
}

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

test("help arrives as one readable chat message per command group", async () => {
  const { controller, transport } = setup();
  transport.emit("Operator_1", "hilfe");
  await flush();
  assert.ok(transport.sent.length >= 8, "each group is its own message, not one run-on sentence");
  assert.ok(transport.sent.every((message) => message.length <= 256));
  assert.ok(transport.sent.every((message) => !message.includes("\n")));
  assert.match(transport.sent[0] ?? "", /^Befehle: status \| hilfe \| stopp \| bleib \| folge mir \| komm$/);
  assert.ok(transport.sent.some((message) => /^Ressourcen: /.test(message)));
  assert.ok(transport.sent.some((message) => /^Planung: plane Haus A\/B\/C/.test(message)));
  assert.ok(transport.sent.some((message) => /^Graben: grabe BxHxT/.test(message)));
  controller.stop();
});

test("an unrecognized message is answered with the most-used commands even without a local model", async () => {
  const { controller, transport, tasks } = setup();
  transport.emit("Operator_1", "ich glaube du kannst das nicht");
  await flush();
  assert.deepEqual(tasks, [], "an unrecognized message never starts a task");
  assert.ok(transport.sent.length >= 4);
  assert.match(transport.sent[0] ?? "", /nicht verstanden/);
  assert.ok(transport.sent.some((message) => /status \| stopp \| bleib \| folge mir \| komm/.test(message)));
  assert.ok(transport.sent.some((message) => /Schreibe hilfe für die vollständige Liste/.test(message)));
  controller.stop();
});

test("a local model answer is used when it is available, and the fallback only explains the helper once", async () => {
  let replies = 0;
  const responder: MinecraftChatResponder = {
    reply: async (message: string) => {
      replies += 1;
      return /baue/.test(message) ? null : "Sende hilfe für die Befehle.";
    },
    unavailableReason: () => (replies > 0 ? "the model 'qwen3:0.6b' is not installed" : null),
  };
  const { controller, transport } = setup(undefined, { chatResponder: responder });

  transport.emit("Operator_1", "what can you do for me?");
  await flush();
  assert.deepEqual(transport.sent, ["Sende hilfe für die Befehle."], "the model answer is relayed unchanged");
  assert.ok(!transport.sent.some((message) => /nicht bereit/.test(message)));

  transport.emit("Operator_1", "baue mir etwas");
  await flush();
  assert.ok(transport.sent.some((message) => /nicht verstanden/.test(message)), "a refused model answer falls back deterministically");
  assert.ok(transport.sent.some((message) => /optionale Chat-Helfer ist nicht bereit/), "the reason is explained once");

  const before = transport.sent.length;
  transport.emit("Operator_1", "und jetzt?");
  await flush();
  assert.ok(transport.sent.length > before);
  assert.equal(transport.sent.filter((message) => /optionale Chat-Helfer ist nicht bereit/.test(message)).length, 1, "the note is not repeated");
  controller.stop();
});

test("a typo'd control word is still executed and never reaches the language model", async () => {
  let asked = 0;
  const responder: MinecraftChatResponder = { reply: async () => { asked += 1; return "Sende hilfe für die Befehle."; } };
  const { controller, transport, calls } = setup(undefined, { chatResponder: responder });
  transport.emit("Operator_1", "folg mir");
  await flush();
  assert.deepEqual(calls, [{ method: "setMode", mode: "follow", target: "Operator_1" }]);
  assert.equal(asked, 0, "a corrected command is executed, not answered by the model");
  assert.deepEqual(transport.sent, ["Mode follow"]);
  controller.stop();
});

test("help answers at once even while an earlier model reply is still pending in the queue", async () => {
  // A hung reply must not hold the queue: before this change, `help` waited behind it and looked dead.
  const hung: MinecraftChatResponder = { reply: () => new Promise<string | null>(() => undefined) };
  const { controller, transport } = setup(undefined, { chatResponder: hung });
  transport.emit("Operator_1", "qwertzuiop asdfgh");
  await flush();
  const before = transport.sent.length;
  transport.emit("Operator_1", "hilfe");
  await flush();
  assert.ok(transport.sent.length > before, "help must be sent while the model reply is still pending");
  controller.stop();
});

test("a queued chat command that never settles is abandoned instead of blocking the queue", async () => {
  await assert.rejects(
    withChatTimeout(new Promise<never>(() => undefined), 20, "hängender Befehl"),
    /timed out after 20 ms/,
  );
  assert.equal(await withChatTimeout(Promise.resolve("fertig"), 1_000, "schneller Befehl"), "fertig");
});

test("a confirmation deadline that hangs while resuming follow mode does not block the queue", async () => {
  const { controller, transport, calls } = setup(
    async (task) => result(task, makeWorld([stack("diamond", 3)]), 1),
    { confirmationTimeoutMs: 5, chatTimeoutMs: 30, hangingModes: ["follow"] },
  );
  transport.emit("Operator_1", "hol noch 1 diamanten");
  await flush();
  // The delivery question expires and resuming follow mode hangs inside the adapter.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(transport.sent.some((message) => /Bestätigungsfrist ist abgelaufen/.test(message)), "expiry must fail closed");
  assert.ok(
    calls.some((call) => call.method === "setMode" && call.mode === "follow"),
    "the hang has to be the follow resume, otherwise this test proves nothing",
  );

  // The queue must recover on its own: a near-miss travels the same chain and is answered.
  const sentBefore = transport.sent.length;
  transport.emit("Operator_1", "sttaus");
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(transport.sent.length > sentBefore, "a hung confirmation deadline must not block later messages");
  assert.match(transport.sent.at(-1) ?? "", /Meintest du/);
  controller.stop();
});

test("chat response times are measured per message, and dropped messages never look like slow answers", async () => {
  const { controller, transport } = setup();
  transport.emit("Alex", "folge mir"); // not the operator
  transport.emit("Operator_1", "   "); // empty
  transport.emit("Operator_1", "folge mir");
  await flush();
  transport.emit("Operator_1", "folge mir"); // the same command again inside the duplicate window
  await flush();

  const latency = controller.chatLatency();
  assert.deepEqual(latency.messages, { received: 1, ignored: 3, handled: 1, timedOut: 0, answered: 1 });
  assert.equal(latency.firstReplyMs.count, 1);
  assert.equal(latency.queueWaitMs.count, 1);
  assert.ok(latency.last !== null && latency.last.timedOut === false);
  assert.deepEqual(
    latency.targets.map((target) => target.met),
    [true, true, true, null],
    "no model answered, so nothing is claimed about the helper",
  );
  controller.stop();
});

test("priority controls and help are measured even though they bypass the queue", async () => {
  const { controller, transport } = setup();
  transport.emit("Operator_1", "status");
  transport.emit("Operator_1", "hilfe");
  await flush();

  const latency = controller.chatLatency();
  assert.deepEqual(latency.messages, { received: 2, ignored: 0, handled: 2, timedOut: 0, answered: 2 });
  assert.equal(latency.queueWaitMs.maxMs, 0, "a message that bypasses the queue does not wait");
  controller.stop();
});

test("an abandoned message is reported as a timeout in the metrics and in the log", async () => {
  const capture = logCapture();
  const responder: MinecraftChatResponder = { reply: () => new Promise<string | null>(() => undefined) };
  const { controller, transport } = setup(undefined, { chatResponder: responder, chatTimeoutMs: 20, logger: capture.logger });
  transport.emit("Operator_1", "erzähl mir was von der welt");
  await new Promise((resolve) => setTimeout(resolve, 80));

  const latency = controller.chatLatency();
  assert.equal(latency.messages.timedOut, 1);
  assert.equal(latency.messages.handled, 0);
  assert.equal(latency.messages.answered, 1, "the operator still receives the failure message");
  assert.ok(latency.last?.timedOut === true);

  const warning = capture.lines.find((line) => line.includes("breached a response-time target"));
  assert.ok(warning, "an abandoned answer must be visible in the log without reading a metric panel");
  assert.match(warning, /abandoned/);
  assert.ok(capture.lines.some((line) => line.includes("Operator chat command failed")));
  controller.stop();
});

test("every answered message leaves one latency line in the log", async () => {
  const capture = logCapture();
  const { controller, transport } = setup(undefined, { logger: capture.logger });
  transport.emit("Operator_1", "folge mir");
  await flush();

  const line = capture.lines.find((entry) => entry.includes("Minecraft chat latency"));
  assert.ok(line, "a normal answer is logged at debug with its numbers");
  assert.match(line, /"queueWaitMs":/);
  assert.match(line, /"handleMs":/);
  assert.match(line, /"firstReplyMs":/);
  controller.stop();
});

test("a presence command sent while an order is being prepared stops that order from starting", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { controller, transport, tasks, calls } = setup(
    async (task) => result(task, makeWorld([stack("diamond", 3)]), 1),
    { observeGate: gate },
  );
  transport.emit("Operator_1", "hol noch 1 diamanten");
  await flush(); // the order is now parked inside its observation, which no wall clock decides
  transport.emit("Operator_1", "komm");
  await flush();
  assert.ok(calls.some((call) => call.method === "setMode" && call.mode === "come"), "the presence command ran at once");

  release(); // only now may the older order continue
  await flush();
  await flush();
  assert.equal(tasks.length, 0, "the queued order must not take over the agent after the operator asked it to come");
  assert.ok(
    transport.sent.some((message) => /nicht gestartet/.test(message)),
    "the operator is told the order was dropped instead of being left to guess",
  );
  controller.stop();
});

test("a stop sent while an order is being prepared is not overridden by that order", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { controller, transport, tasks, calls } = setup(
    async (task) => result(task, makeWorld([stack("diamond", 3)]), 1),
    { observeGate: gate },
  );
  transport.emit("Operator_1", "hol noch 1 diamanten");
  await flush();
  transport.emit("Operator_1", "stopp");
  await flush();
  release();
  await flush();
  await flush();

  assert.equal(tasks.length, 0, "a stop that arrived first must hold; the older order may not start afterwards");
  assert.ok(calls.some((call) => call.method === "setMode" && call.mode === "hold"), "the stop itself ran");
  controller.stop();
});

test("status changes nothing, so it must not drop a queued order", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { controller, transport, tasks } = setup(
    async (task) => result(task, makeWorld([stack("diamond", 3)]), 1),
    { observeGate: gate },
  );
  transport.emit("Operator_1", "hol noch 1 diamanten");
  await flush();
  transport.emit("Operator_1", "status");
  await flush();
  release();
  await flush();
  await flush();

  assert.equal(tasks.length, 1, "a read-only command answers without superseding the operator's order");
  controller.stop();
});

test("a presence command is answered at once even while a slow model reply holds the queue", async () => {
  const responder: MinecraftChatResponder = { reply: () => new Promise<string | null>(() => undefined) };
  const { controller, transport, calls } = setup(undefined, { chatResponder: responder });
  transport.emit("Operator_1", "erzähl mir was von der welt");
  await flush();
  const sentBefore = transport.sent.length;

  transport.emit("Operator_1", "folge mir");
  await flush();
  assert.ok(calls.some((call) => call.method === "setMode" && call.mode === "follow"), "follow does not wait for the pending reply");
  assert.ok(transport.sent.length > sentBefore, "and the operator hears it immediately");
  controller.stop();
});

test("an unrecognized near-miss of a control word asks 'Meintest du …?' and executes nothing", async () => {
  const { controller, transport, calls } = setup();
  transport.emit("Operator_1", "sttaus");
  await flush();
  assert.deepEqual(calls, [], "a suggestion never runs a command");
  assert.match(transport.sent.at(-1) ?? "", /Meintest du „status“/);
  controller.stop();
});
