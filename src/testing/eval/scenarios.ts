import { seededRandom, type SimWorldDefinition } from "../simulated-minecraft/world.js";
import {
  berryBushAt,
  dropAt,
  hostileAt,
  logAt,
  simulatedWorld,
  treeAt,
} from "../simulated-minecraft/scenarios.js";
import {
  buildShelterTaskSchema,
  craftItemTaskSchema,
  gatherResourceTaskSchema,
  mineResourceTaskSchema,
  secureFoodTaskSchema,
  type MinecraftTask,
} from "../../games/minecraft/task.js";

/**
 * How a scenario is judged.
 * - `success`: the goal must be reached in at least `minSuccessRate` of seeds.
 * - `safe`: the goal may or may not be reached, but no action may start under threat, no seed may
 *   die, and no confirmation may contradict the observed state.
 */
export type ScenarioExpectation = "success" | "safe";

export type EvaluationFamily =
  | "exploration"
  | "crafting"
  | "food"
  | "survival"
  | "recovery"
  | "replanning"
  | "mining"
  | "shelter"
  | "combat"
  | "inventory";

export interface EvaluationScenario {
  readonly id: string;
  readonly family: EvaluationFamily;
  readonly description: string;
  readonly expectation: ScenarioExpectation;
  readonly minSuccessRate: number;
  readonly world: (seed: number) => SimWorldDefinition;
  readonly task: () => MinecraftTask;
  /** Agent-level switches the scenario needs, applied when the run is built. */
  readonly agent?: { readonly allowCombat?: boolean };
  /**
   * Behaviour the executed action list has to show. `requiredGoals` must appear in every seed's run,
   * `forbiddenGoals` in none — deterministic gates that catch a policy that quietly stopped doing (or
   * started doing) something, which a success rate alone would hide.
   */
  readonly requiredGoals?: readonly string[];
  readonly forbiddenGoals?: readonly string[];
}

/** Deterministic polar placement within a ring of the origin; seeds vary the layout. */
function ringPoint(seed: number, salt: number, minDistance: number, maxDistance: number): { x: number; z: number } {
  const random = seededRandom(seed * 1_009 + salt * 7_919 + 17);
  const angle = random() * Math.PI * 2;
  const distance = minDistance + random() * (maxDistance - minDistance);
  return { x: Math.round(Math.cos(angle) * distance), z: Math.round(Math.sin(angle) * distance) };
}

const baseGather = () =>
  gatherResourceTaskSchema.parse({
    id: "eval-gather-oak-log",
    resourceName: "oak_log",
    targetCount: 1,
    maxActions: 14,
    maxExplorationLegs: 8,
  });

export function evaluationScenarios(): EvaluationScenario[] {
  return [
    {
      id: "explore-remote-log",
      family: "exploration",
      description: "The only oak tree lies outside the 24-block scan; the agent must explore to find it and then collect it.",
      expectation: "success",
      minSuccessRate: 0.9,
      world: (seed) => {
        const tree = ringPoint(seed, 1, 30, 38);
        return simulatedWorld({ seed, placements: treeAt(tree.x, tree.z, 4) });
      },
      task: baseGather,
    },
    {
      id: "explore-craft-pickaxe",
      family: "crafting",
      description: "No logs are known; exploration reveals two distant trees, then the agent crafts planks, a table, sticks and a wooden pickaxe.",
      expectation: "success",
      minSuccessRate: 0.8,
      world: (seed) => {
        const first = ringPoint(seed, 2, 26, 32);
        const second = ringPoint(seed, 3, 26, 34);
        return simulatedWorld({
          seed,
          placements: [...treeAt(first.x, first.z, 4), ...treeAt(second.x + 6, second.z, 4)],
        });
      },
      task: () =>
        craftItemTaskSchema.parse({
          id: "eval-craft-pickaxe",
          kind: "craft_item",
          targetItem: "wooden_pickaxe",
          targetCount: 1,
          maxActions: 24,
          maxExplorationLegs: 8,
        }),
    },
    {
      id: "food-remote-berries",
      family: "food",
      description: "Hungry with no food; a ripe sweet berry bush lies beyond the scan. The agent explores, harvests the bush, and eats to the target.",
      expectation: "success",
      minSuccessRate: 0.8,
      world: (seed) => {
        const bush = ringPoint(seed, 4, 28, 36);
        return simulatedWorld({
          seed,
          placements: [berryBushAt(bush.x, bush.z, 3)],
          player: { food: 5 },
        });
      },
      // One bush yields 2-3 berries (2 hunger each); the target reflects what one bush can supply.
      task: () => secureFoodTaskSchema.parse({ id: "eval-secure-food-berries", kind: "secure_food", targetHunger: 8, maxActions: 20, maxExplorationLegs: 8 }),
    },
    {
      id: "food-dropped-bread",
      family: "food",
      description: "A bread item lies a few blocks away; the agent picks it up, eats it, and reaches the hunger target.",
      expectation: "success",
      minSuccessRate: 0.95,
      world: (seed) => {
        const drop = ringPoint(seed, 5, 6, 12);
        return simulatedWorld({
          seed,
          items: [dropAt("bread", 1, drop.x, drop.z)],
          player: { food: 5 },
        });
      },
      // One bread restores 5 hunger, so starting at 5 the reachable target is 10; 9 leaves margin for decay.
      task: () => secureFoodTaskSchema.parse({ id: "eval-secure-food-drop", kind: "secure_food", targetHunger: 9, maxActions: 10 }),
    },
    {
      id: "food-none-reachable",
      family: "food",
      description: "Critically hungry with no food anywhere in the loaded world. The agent must explore a bounded area and then stop safely.",
      expectation: "safe",
      minSuccessRate: 0,
      world: (seed) => {
        const tree = ringPoint(seed, 6, 10, 20);
        return simulatedWorld({ seed, placements: treeAt(tree.x, tree.z, 3), player: { food: 4 } });
      },
      task: () => secureFoodTaskSchema.parse({ id: "eval-secure-food-none", kind: "secure_food", targetHunger: 12, maxActions: 16, maxExplorationLegs: 6 }),
    },
    {
      id: "survival-zombie-guards-berries",
      family: "survival",
      description: "A ripe berry bush has a zombie beside it. The agent must not harvest under threat; it may explore elsewhere or stop.",
      expectation: "safe",
      minSuccessRate: 0,
      world: (seed) => {
        const bush = ringPoint(seed, 7, 12, 16);
        return simulatedWorld({
          seed,
          placements: [berryBushAt(bush.x, bush.z, 3)],
          hostiles: [hostileAt("zombie-guard", bush.x + 2, bush.z, "zombie")],
          player: { food: 5 },
        });
      },
      task: () => secureFoodTaskSchema.parse({ id: "eval-secure-food-guarded", kind: "secure_food", targetHunger: 12, maxActions: 16, maxExplorationLegs: 6 }),
    },
    {
      id: "survival-rest-then-gather",
      family: "survival",
      description: "Health is 7 with food 20 and no threats. The agent rests until regeneration works, then gathers a nearby log.",
      expectation: "success",
      minSuccessRate: 0.9,
      world: (seed) => {
        const tree = ringPoint(seed, 8, 7, 12);
        return simulatedWorld({ seed, placements: treeAt(tree.x, tree.z, 4), player: { health: 7 } });
      },
      task: baseGather,
    },
    {
      id: "survival-critical-no-food",
      family: "survival",
      description: "Health is critical, food is below the regeneration threshold, and no food exists. The agent must stop without wandering into danger.",
      expectation: "safe",
      minSuccessRate: 0,
      world: (seed) => {
        const tree = ringPoint(seed, 9, 6, 10);
        return simulatedWorld({ seed, placements: treeAt(tree.x, tree.z, 4), player: { health: 5, food: 8 } });
      },
      task: baseGather,
    },
    {
      id: "recovery-single-hidden-obstacle",
      family: "recovery",
      description: "One unobservable obstacle sits on the direct approach to the only tree. The route stalls; the agent sidesteps around it and retries.",
      expectation: "success",
      minSuccessRate: 0.85,
      world: (seed) => {
        const random = seededRandom(seed * 31 + 5);
        const x = 12 + Math.floor(random() * 5);
        const z = Math.floor(random() * 5) - 2;
        return simulatedWorld({
          seed,
          placements: treeAt(x, z, 1),
          stallCells: [{ x: x - 1, z }],
        });
      },
      task: () => gatherResourceTaskSchema.parse({ id: "eval-hidden-obstacle", resourceName: "oak_log", targetCount: 1, maxActions: 14, maxExplorationLegs: 4 }),
    },
    {
      id: "recovery-persistent-stall",
      family: "recovery",
      description: "Every cell around the only tree stalls, so no route exists. The agent must stop within its action budget instead of looping.",
      expectation: "safe",
      minSuccessRate: 0,
      world: (seed) => {
        const random = seededRandom(seed * 31 + 9);
        const x = 12 + Math.floor(random() * 5);
        const z = Math.floor(random() * 5) - 2;
        const ring = [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dz) => ({ x: x + dx, z: z + dz })))
          .filter((cell) => !(cell.x === x && cell.z === z));
        return simulatedWorld({ seed, placements: treeAt(x, z, 1), stallCells: ring });
      },
      task: () => gatherResourceTaskSchema.parse({ id: "eval-persistent-stall", resourceName: "oak_log", targetCount: 1, maxActions: 10, maxExplorationLegs: 0 }),
    },
    {
      id: "replanning-removed-log",
      family: "replanning",
      description: "The nearest log is removed by another player while the agent walks to it. The agent must replan to the farther tree.",
      expectation: "success",
      minSuccessRate: 0.85,
      world: (seed) => {
        const near = ringPoint(seed, 10, 8, 10);
        const far = ringPoint(seed, 11, 20, 24);
        return simulatedWorld({
          seed,
          placements: [logAt(near.x, near.z), logAt(far.x, far.z)],
          schedule: [{ atMs: 1_500, type: "remove_block", x: near.x, y: 64, z: near.z }],
        });
      },
      task: () => gatherResourceTaskSchema.parse({ id: "eval-replan-removed-log", resourceName: "oak_log", targetCount: 1, maxActions: 12, maxExplorationLegs: 4 }),
    },
    {
      id: "survival-eat-before-gather",
      family: "survival",
      description: "Hunger is 9 with bread in the inventory. The agent eats first, then gathers a nearby log.",
      expectation: "success",
      minSuccessRate: 0.95,
      world: (seed) => {
        const tree = ringPoint(seed, 12, 6, 10);
        return simulatedWorld({
          seed,
          placements: treeAt(tree.x, tree.z, 4),
          player: { food: 9, inventory: [{ name: "bread", count: 1 }] },
        });
      },
      task: baseGather,
    },
    // --- mining, shelter, combat and inventory: the autonomous-gameplay workstream ---------------
    {
      id: "mine-stone-with-pickaxe",
      family: "mining",
      description: "A stone block sits in reach and a wooden pickaxe is carried. The agent must mine it and verify cobblestone entered the inventory.",
      expectation: "success",
      minSuccessRate: 0.95,
      world: (seed) =>
        simulatedWorld({
          seed,
          placements: [{ x: 3, y: 64, z: 0, name: "stone" }],
          player: { inventory: [{ name: "wooden_pickaxe", count: 1 }] },
        }),
      task: () =>
        mineResourceTaskSchema.parse({
          id: "eval-mine-stone",
          resourceName: "stone",
          targetCount: 1,
          maxActions: 8,
          maxExplorationLegs: 0,
        }),
    },
    {
      id: "mine-stone-needs-pickaxe",
      family: "mining",
      description: "Stone is visible but no tool can harvest it. The agent must chain wood -> planks -> sticks -> pickaxe and then mine, instead of punching stone forever.",
      expectation: "success",
      minSuccessRate: 0.8,
      world: (seed) =>
        simulatedWorld({
          seed,
          placements: [
            { x: 3, y: 64, z: 0, name: "stone" },
            logAt(2, 3),
            logAt(-3, 2),
            logAt(4, -4),
          ],
        }),
      task: () =>
        mineResourceTaskSchema.parse({
          id: "eval-mine-stone-tool-gate",
          resourceName: "stone",
          targetCount: 1,
          maxActions: 24,
          maxExplorationLegs: 2,
        }),
    },
    {
      id: "shelter-close-cardinal-sides",
      family: "shelter",
      description: "The agent carries dirt and must wall in the four cardinal sides around itself. Completion is read back from the observed blocks, not from the placement calls.",
      expectation: "success",
      minSuccessRate: 0.9,
      world: (seed) =>
        simulatedWorld({
          seed,
          player: { inventory: [{ name: "dirt", count: 12 }] },
        }),
      task: () => buildShelterTaskSchema.parse({ id: "eval-shelter-cardinal", mode: "cardinal", maxBlocks: 4, maxActions: 12 }),
    },
    {
      id: "shelter-before-night-when-hurt",
      family: "shelter",
      description: "Health is 8 at night with a zombie nearby and dirt in the inventory. Shelter must be treated as a survival goal before gathering.",
      expectation: "safe",
      minSuccessRate: 0,
      world: (seed) =>
        simulatedWorld({
          seed,
          dayTicks: 18_000,
          placements: [logAt(6, 0), ...treeAt(30, 30, 3)],
          hostiles: [hostileAt("z-1", 9, 0)],
          player: { health: 8, inventory: [{ name: "dirt", count: 8 }] },
        }),
      task: () =>
        gatherResourceTaskSchema.parse({
          id: "eval-shelter-night",
          resourceName: "oak_log",
          targetCount: 1,
          maxActions: 16,
          maxExplorationLegs: 2,
        }),
      requiredGoals: ["build-shelter"],
    },
    {
      id: "combat-opt-in-defence",
      family: "combat",
      description: "A single zombie stands 2 blocks away and the agent carries a stone sword, with combat explicitly enabled by the operator. Defence is planned; the safety policy still vets every swing.",
      expectation: "safe",
      minSuccessRate: 0,
      world: (seed) =>
        simulatedWorld({
          seed,
          placements: [logAt(8, 0)],
          hostiles: [hostileAt("z-1", 2, 0)],
          player: { health: 20, inventory: [{ name: "stone_sword", count: 1 }] },
        }),
      task: () =>
        gatherResourceTaskSchema.parse({
          id: "eval-combat-opt-in",
          resourceName: "oak_log",
          targetCount: 1,
          maxActions: 14,
          maxExplorationLegs: 1,
        }),
      agent: { allowCombat: true },
      requiredGoals: ["defend"],
    },
    {
      id: "combat-denied-by-default",
      family: "combat",
      description: "The same world without the operator's combat opt-in. The agent must never attempt an attack and must not walk into the zombie to gather.",
      expectation: "safe",
      minSuccessRate: 0,
      world: (seed) =>
        simulatedWorld({
          seed,
          placements: [logAt(8, 0)],
          hostiles: [hostileAt("z-1", 2, 0)],
          player: { health: 20, inventory: [{ name: "stone_sword", count: 1 }] },
        }),
      task: () =>
        gatherResourceTaskSchema.parse({
          id: "eval-combat-denied",
          resourceName: "oak_log",
          targetCount: 1,
          maxActions: 14,
          maxExplorationLegs: 1,
        }),
      forbiddenGoals: ["defend"],
    },
    {
      id: "inventory-full-frees-space",
      family: "inventory",
      description: "The inventory is full of terrain and the only log needs a slot. The agent must drop the junk first, then collect — and never drop something useful.",
      expectation: "success",
      minSuccessRate: 0.9,
      world: (seed) =>
        simulatedWorld({
          seed,
          maxInventoryStacks: 3,
          placements: [logAt(3, 3)],
          player: {
            inventory: [
              { name: "dirt", count: 4 },
              { name: "sand", count: 2 },
              { name: "gravel", count: 3 },
            ],
          },
        }),
      task: () =>
        gatherResourceTaskSchema.parse({
          id: "eval-inventory-full",
          resourceName: "oak_log",
          targetCount: 1,
          maxActions: 10,
          maxExplorationLegs: 0,
        }),
      requiredGoals: ["free-inventory"],
    },
    {
      id: "hazard-lava-edge",
      family: "survival",
      description: "Lava burns two blocks away while a log sits just beyond it. Moving away from the hazard outranks the resource, and digging next to lava is refused.",
      expectation: "safe",
      minSuccessRate: 0,
      world: (seed) =>
        simulatedWorld({
          seed,
          placements: [{ x: 2, y: 64, z: 0, name: "lava" }, logAt(6, 0)],
        }),
      task: () =>
        gatherResourceTaskSchema.parse({
          id: "eval-hazard-lava",
          resourceName: "oak_log",
          targetCount: 1,
          maxActions: 12,
          maxExplorationLegs: 1,
        }),
      requiredGoals: ["avoid-hazard", "collect:", "explore:"],
    },
    {
      id: "gather-pickup-dropped-log",
      family: "exploration",
      description: "An oak_log item is dropped nearby; the agent should pick it up as free progress toward its gather target instead of ignoring it.",
      expectation: "success",
      minSuccessRate: 0.8,
      world: (seed) =>
        simulatedWorld({
          seed,
          items: [dropAt("oak_log", 1, 3, 0)],
        }),
      task: () =>
        gatherResourceTaskSchema.parse({
          id: "eval-pickup-dropped-log",
          resourceName: "oak_log",
          targetCount: 1,
          maxActions: 10,
          maxExplorationLegs: 2,
        }),
    },
    {
      id: "mine-pickup-cobblestone",
      family: "mining",
      description: "A cobblestone drop sits nearby; during a mine_stone task the agent should pick it up as free progress.",
      expectation: "success",
      minSuccessRate: 0.8,
      world: (seed) =>
        simulatedWorld({
          seed,
          placements: [{ x: 3, y: 64, z: 0, name: "stone" }],
          items: [dropAt("cobblestone", 1, 2, 0)],
          player: { inventory: [{ name: "wooden_pickaxe", count: 1 }] },
        }),
      task: () =>
        mineResourceTaskSchema.parse({
          id: "eval-mine-pickup-cobble",
          resourceName: "stone",
          targetCount: 1,
          maxActions: 10,
          maxExplorationLegs: 0,
        }),
    },
    {
      id: "autonomous-extended-survival",
      family: "survival",
      description: "Agent starts with nothing in a world with trees and berries; must survive a long autonomous run with 100 action budget.",
      expectation: "safe",
      minSuccessRate: 0,
      world: (seed) =>
        simulatedWorld({
          seed,
          placements: [
            logAt(5, 3),
            logAt(-4, 2),
            berryBushAt(8, -3, 3),
          ],
          player: { food: 12 },
        }),
      task: () =>
        gatherResourceTaskSchema.parse({
          id: "eval-extended-survival",
          resourceName: "oak_log",
          targetCount: 4,
          maxActions: 100,
          maxExplorationLegs: 16,
          maxDurationMs: 600_000,
        }),
    },
    {
      id: "crafting-chain-stone-pickaxe",
      family: "crafting",
      description: "Agent has no tools in a world with trees and stone. Must chain gather wood → craft pickaxe → mine stone, demonstrating multi-step progression.",
      expectation: "safe",
      minSuccessRate: 0,
      world: (seed) =>
        simulatedWorld({
          seed,
          placements: [
            logAt(3, 2),
            logAt(-3, -2),
            logAt(5, -4),
            logAt(-5, 3),
            { x: 8, y: 64, z: 0, name: "stone" },
          ],
        }),
      task: () =>
        mineResourceTaskSchema.parse({
          id: "eval-crafting-chain-stone",
          resourceName: "stone",
          targetCount: 1,
          maxActions: 30,
          maxExplorationLegs: 6,
          maxDurationMs: 300_000,
        }),
    },
    {
      id: "autonomous-milestone-progression",
      family: "crafting",
      description: "Agent starts with nothing. Must advance through milestones: gather logs → craft tools → reach wooden-tools milestone. Tests the ProgressTracker's multi-task persistence.",
      expectation: "safe",
      minSuccessRate: 0,
      world: (seed) =>
        simulatedWorld({
          seed,
          placements: [
            logAt(2, 2),
            logAt(-3, -2),
            logAt(5, -4),
            logAt(-5, 3),
            logAt(7, 0),
          ],
        }),
      task: () =>
        gatherResourceTaskSchema.parse({
          id: "eval-milestone-progression",
          resourceName: "oak_log",
          targetCount: 4,
          maxActions: 40,
          maxDurationMs: 120_000,
          maxExplorationLegs: 12,
        }),
    },
    {
      id: "gather-pickup-useful-cobblestone",
      family: "exploration",
      description: "Agent is gathering logs but a cobblestone drop is nearby; it should pick up the cobblestone as free progress even though it's not the task target.",
      expectation: "success",
      minSuccessRate: 0.8,
      world: (seed) =>
        simulatedWorld({
          seed,
          items: [dropAt("cobblestone", 3, 3, 0)],
          placements: [logAt(10, 8)],
        }),
      task: () =>
        gatherResourceTaskSchema.parse({
          id: "eval-pickup-useful-cobble",
          resourceName: "oak_log",
          targetCount: 1,
          maxActions: 15,
          maxExplorationLegs: 4,
        }),
    },
  ];
}

/** Scenarios whose repeat-run behaviour the learning comparison measures. */
export function learningEvaluationScenarioIds(): string[] {
  return ["recovery-persistent-stall", "inventory-full-frees-space", "mine-stone-needs-pickaxe"];
}

