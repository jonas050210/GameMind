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
  craftItemTaskSchema,
  gatherResourceTaskSchema,
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

export interface EvaluationScenario {
  readonly id: string;
  readonly family: "exploration" | "crafting" | "food" | "survival" | "recovery" | "replanning";
  readonly description: string;
  readonly expectation: ScenarioExpectation;
  readonly minSuccessRate: number;
  readonly world: (seed: number) => SimWorldDefinition;
  readonly task: () => MinecraftTask;
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
  ];
}
