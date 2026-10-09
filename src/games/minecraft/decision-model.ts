import type {
  DecisionCandidate,
  DecisionContext,
  DecisionModel,
  DecisionRecord,
} from "../../core/decision-model.js";
import {
  minecraftLogNames,
  minecraftPlankNames,
} from "./capabilities.js";
import type { MinecraftObservation } from "./observation.js";
import type { CraftItemTask, MinecraftTask } from "./task.js";
import type { CraftableMinecraftItem } from "./recipes.js";
import {
  countItemAndEquipment,
  isMinecraftFoodName,
  isMinecraftLogName,
  minecraftFoodNutrition,
  minecraftWoodRecipePlans,
  plankNameForLog,
} from "./recipes.js";
import { isHostileMinecraftEntity } from "./threats.js";
export { isHostileMinecraftEntity } from "./threats.js";

const FOOD_PRIORITY_THRESHOLD = 10;
const CRITICAL_FOOD_THRESHOLD = 4;
const CRITICAL_HEALTH_THRESHOLD = 6;
const MAX_CRAFTING_TABLE_DISTANCE = 4.5;

function inventoryCount(state: MinecraftObservation, itemName: string): number {
  return state.inventory
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0);
}

function itemCount(state: MinecraftObservation, itemName: string): number {
  return countItemAndEquipment(state.inventory, state.equipment, itemName);
}

function totalPlanks(state: MinecraftObservation): number {
  return minecraftPlankNames.reduce((sum, name) => sum + inventoryCount(state, name), 0);
}

function positionKey(position: { x: number; y: number; z: number }): string {
  return `${position.x},${position.y},${position.z}`;
}

function distance(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function notExcluded(
  candidate: DecisionCandidate,
  excludedTargets: ReadonlySet<string>,
): DecisionCandidate | null {
  return candidate.targetKey && excludedTargets.has(candidate.targetKey) ? null : candidate;
}

function fleeCandidates(
  state: MinecraftObservation,
  threats: MinecraftObservation["entities"],
  excludedTargets: ReadonlySet<string>,
): DecisionCandidate[] {
  const player = state.player.position;
  if (threats.length === 0) return [];

  const averageThreatX = threats.reduce((sum, threat) => sum + threat.position.x, 0) / threats.length;
  const averageThreatZ = threats.reduce((sum, threat) => sum + threat.position.z, 0) / threats.length;
  let awayX = player.x - averageThreatX;
  let awayZ = player.z - averageThreatZ;
  if (Math.hypot(awayX, awayZ) < 0.001) {
    awayX = 1;
    awayZ = 0;
  }
  const baseAngle = Math.atan2(awayZ, awayX);
  const candidates: Array<{ x: number; z: number; score: number }> = [];

  for (let index = 0; index < 8; index += 1) {
    const angle = baseAngle + (index * Math.PI) / 4;
    const x = Math.round(player.x + Math.cos(angle) * 9);
    const z = Math.round(player.z + Math.sin(angle) * 9);
    const minThreatDistance = Math.min(
      ...threats.map((threat) => Math.hypot(x + 0.5 - threat.position.x, z + 0.5 - threat.position.z)),
    );
    const travelDistance = Math.hypot(x + 0.5 - player.x, z + 0.5 - player.z);
    candidates.push({ x, z, score: minThreatDistance - travelDistance * 0.1 });
  }

  return candidates
    .sort((left, right) => right.score - left.score || left.x - right.x || left.z - right.z)
    .map((candidate, index) => ({
      goalId: "avoid-nearby-hostile",
      priorityBand: 0,
      score: 1_000 + candidate.score - index * 0.01,
      skillId: "minecraft.navigate",
      input: { x: candidate.x, y: Math.floor(player.y), z: candidate.z, range: 1 },
      targetKey: `flee:${candidate.x},${Math.floor(player.y)},${candidate.z}`,
      rationale: `Move away from ${threats.length} visible hostile entit${threats.length === 1 ? "y" : "ies"}; conservative navigation avoids digging and building.`,
    }))
    .filter((candidate) => !excludedTargets.has(candidate.targetKey ?? ""))
    .slice(0, 3);
}

function nearbySafeLogs(
  state: MinecraftObservation,
  task: MinecraftTask,
  hostiles: MinecraftObservation["entities"],
  excludedTargets: ReadonlySet<string>,
  wantedLogNames: ReadonlySet<string> | null = null,
): Array<{ block: MinecraftObservation["nearbyBlocks"][number]; distance: number }> {
  return state.nearbyBlocks
    .filter((block) => state.player.dimension === "overworld" && isMinecraftLogName(block.name))
    .filter((block) => !wantedLogNames || wantedLogNames.has(block.name))
    .filter((block) => !excludedTargets.has(positionKey(block.position)))
    .map((block) => ({ block, distance: distance(block.position, state.player.position) }))
    .filter(({ distance: targetDistance }) => targetDistance <= task.maxTargetDistance)
    .filter(({ block }) =>
      !hostiles.some(
        (hostile) => distance(hostile.position, {
          x: block.position.x + 0.5,
          y: block.position.y + 0.5,
          z: block.position.z + 0.5,
        }) <= task.dangerRadius,
      ),
    )
    .sort((left, right) => left.distance - right.distance || positionKey(left.block.position).localeCompare(positionKey(right.block.position)));
}

function craftCandidate(
  item: CraftableMinecraftItem,
  count: number,
  table?: { x: number; y: number; z: number },
): DecisionCandidate {
  return {
    goalId: `craft:${item}`,
    priorityBand: 1,
    score: 500,
    skillId: "minecraft.craft-item",
    input: { item, count, ...(table ? { craftingTable: table } : {}) },
    targetKey: `craft:${item}:${count}`,
    rationale: `Craft the next allowlisted prerequisite (${item}) from observed inventory and recipe requirements.`,
  };
}

function foodCandidate(state: MinecraftObservation, excludedTargets: ReadonlySet<string>): DecisionCandidate | null {
  const hunger = state.player.food;
  if (hunger === null || hunger > FOOD_PRIORITY_THRESHOLD || hunger >= 20) return null;
  const options = state.inventory
    .filter((item) => isMinecraftFoodName(item.name) && item.count > 0)
    .map((item) => ({ item, nutrition: minecraftFoodNutrition[item.name as keyof typeof minecraftFoodNutrition] }))
    .filter(({ item }) => !excludedTargets.has(`eat:${item.name}`))
    .sort((left, right) => {
      const leftWaste = Math.max(0, left.nutrition - (20 - hunger));
      const rightWaste = Math.max(0, right.nutrition - (20 - hunger));
      return leftWaste - rightWaste || right.nutrition - left.nutrition || left.item.name.localeCompare(right.item.name);
    });
  const selected = options[0];
  if (!selected) return null;
  return {
    goalId: "restore-hunger",
    priorityBand: 0,
    score: 900 + selected.nutrition,
    skillId: "minecraft.eat-food",
    input: { item: selected.item.name },
    targetKey: `eat:${selected.item.name}`,
    rationale: `Hunger is ${hunger}/20; consume available ${selected.item.name} before non-survival progress.`,
  };
}

function tableSafety(
  block: MinecraftObservation["nearbyBlocks"][number],
  hostiles: MinecraftObservation["entities"],
  dangerRadius: number,
): boolean {
  const center = { x: block.position.x + 0.5, y: block.position.y + 0.5, z: block.position.z + 0.5 };
  return !hostiles.some((hostile) => distance(hostile.position, center) <= dangerRadius);
}

function craftingTableCandidate(
  state: MinecraftObservation,
  task: CraftItemTask,
  hostiles: MinecraftObservation["entities"],
  excludedTargets: ReadonlySet<string>,
): DecisionCandidate | null {
  const tables = state.nearbyBlocks
    .filter((block) => block.name === "crafting_table")
    .filter((block) => tableSafety(block, hostiles, task.dangerRadius))
    .map((block) => ({ block, distance: distance(state.player.position, block.position) }))
    .filter(({ distance: tableDistance }) => tableDistance <= task.maxTargetDistance)
    .sort((left, right) => left.distance - right.distance);
  const distant = tables.find(({ block }) => !excludedTargets.has(`craft-table:${positionKey(block.position)}`));
  if (!distant) return null;
  const { x, y, z } = distant.block.position;
  return {
    goalId: "reach-crafting-table",
    priorityBand: 1,
    score: 450 - distant.distance,
    skillId: "minecraft.navigate",
    input: { x, y, z, range: 1 },
    targetKey: `craft-table:${positionKey(distant.block.position)}`,
    rationale: `Navigate to the nearest observed crafting table (${distant.distance.toFixed(1)} blocks away) before crafting a table-required item.`,
  };
}

function placementCandidate(
  state: MinecraftObservation,
  task: CraftItemTask,
  hostiles: MinecraftObservation["entities"],
  excludedTargets: ReadonlySet<string>,
): DecisionCandidate | null {
  const player = state.player.position;
  const blocksByPosition = new Map(state.nearbyBlocks.map((block) => [positionKey(block.position), block]));
  const supportBlocks = state.nearbyBlocks
    .filter((block) => block.boundingBox === "block")
    .map((support) => ({
      support,
      target: { x: support.position.x, y: support.position.y + 1, z: support.position.z },
    }))
    .filter(({ target }) => !blocksByPosition.has(positionKey(target)))
    .map((candidate) => ({
      ...candidate,
      distance: distance(player, candidate.target),
      targetDistanceFromPlayer: Math.hypot(player.x - (candidate.target.x + 0.5), player.z - (candidate.target.z + 0.5)),
    }))
    .filter(({ distance: targetDistance }) => targetDistance <= MAX_CRAFTING_TABLE_DISTANCE)
    .filter(({ targetDistanceFromPlayer }) => targetDistanceFromPlayer >= 0.9)
    .filter(({ target }) => !hostiles.some((hostile) => distance(hostile.position, {
      x: target.x + 0.5,
      y: target.y + 0.5,
      z: target.z + 0.5,
    }) <= task.dangerRadius))
    .filter(({ target }) => !excludedTargets.has(`place-table:${positionKey(target)}`))
    .sort((left, right) => left.distance - right.distance || positionKey(left.target).localeCompare(positionKey(right.target)));
  const chosen = supportBlocks[0];
  if (!chosen) return null;
  return {
    goalId: "place-crafting-table",
    priorityBand: 1,
    score: 430 - chosen.distance,
    skillId: "minecraft.place-crafting-table",
    input: { ...chosen.target, dangerRadius: task.dangerRadius },
    targetKey: `place-table:${positionKey(chosen.target)}`,
    rationale: `Place the carried crafting table above observed solid support ${positionKey(chosen.support.position)} after checking the destination is locally unoccupied and outside visible threat range.`,
  };
}

function plankProductionCandidate(
  state: MinecraftObservation,
  task: CraftItemTask,
  hostiles: MinecraftObservation["entities"],
  excludedTargets: ReadonlySet<string>,
  requiredTotalPlanks: number,
): DecisionCandidate | null {
  const currentPlanks = totalPlanks(state);
  if (currentPlanks >= requiredTotalPlanks) return null;
  const shortage = requiredTotalPlanks - currentPlanks;
  const logKinds: readonly (typeof minecraftLogNames)[number][] =
    task.targetItem === "oak_planks" ? ["oak_log"] : minecraftLogNames;
  const availableLogsInInventory = logKinds
    .filter((name) => inventoryCount(state, name) > 0)
    .sort((left, right) => inventoryCount(state, right) - inventoryCount(state, left));
  const candidateLog = availableLogsInInventory[0];
  const candidateLogCount = candidateLog ? inventoryCount(state, candidateLog) : 0;
  const logsNeededForAllMissingPlanks = Math.ceil(shortage / 4);
  const wantedLogs = task.targetItem === "oak_planks" ? new Set<string>(["oak_log"]) : null;
  const visibleLog = nearbySafeLogs(state, task, hostiles, excludedTargets, wantedLogs)[0];

  if (candidateLog && candidateLogCount >= logsNeededForAllMissingPlanks) {
    const plank = plankNameForLog(candidateLog);
    return notExcluded(
      craftCandidate(plank, inventoryCount(state, plank) + shortage),
      excludedTargets,
    );
  }
  if (visibleLog) {
    return {
      goalId: `collect:${visibleLog.block.name}`,
      priorityBand: 1,
      score: 400 - visibleLog.distance,
      skillId: "minecraft.collect-log",
      input: {
        x: visibleLog.block.position.x,
        y: visibleLog.block.position.y,
        z: visibleLog.block.position.z,
        blockName: visibleLog.block.name,
        dangerRadius: task.dangerRadius,
      },
      targetKey: positionKey(visibleLog.block.position),
      rationale: `Collect the nearest safe observed ${visibleLog.block.name} needed to satisfy a wood/plank prerequisite (${currentPlanks}/${requiredTotalPlanks} planks currently available).`,
    };
  }
  if (candidateLog) {
    const plank = plankNameForLog(candidateLog);
    const partialOutput = Math.min(shortage, candidateLogCount * 4);
    if (partialOutput > 0) {
      return notExcluded(
        craftCandidate(plank, inventoryCount(state, plank) + partialOutput),
        excludedTargets,
      );
    }
  }
  return null;
}

function craftPlan(
  state: MinecraftObservation,
  task: CraftItemTask,
  hostiles: MinecraftObservation["entities"],
  excludedTargets: ReadonlySet<string>,
): { candidate: DecisionCandidate | null; reason: string } {
  const targetCount = itemCount(state, task.targetItem);
  const missingTarget = Math.max(0, task.targetCount - targetCount);
  const plan = minecraftWoodRecipePlans[task.targetItem];
  if (!plan) return { candidate: null, reason: `No offline recipe plan is available for '${task.targetItem}'.` };
  const operations = Math.ceil(missingTarget / plan.outputCount);
  if (operations <= 0) return { candidate: null, reason: "Craft target count is already satisfied." };

  const requiresTable = plan.requiresCraftingTable;
  const tableBlocks = state.nearbyBlocks.filter((block) =>
    block.name === "crafting_table" && tableSafety(block, hostiles, task.dangerRadius),
  );
  const closeTable = tableBlocks
    .map((block) => ({ block, distance: distance(state.player.position, block.position) }))
    .filter(({ distance: tableDistance }) => tableDistance <= MAX_CRAFTING_TABLE_DISTANCE)
    .sort((left, right) => left.distance - right.distance)[0]?.block;
  const tableItemCount = inventoryCount(state, "crafting_table");
  const needTable = requiresTable && !closeTable;

  if (needTable) {
    const reachableTable = craftingTableCandidate(state, task, hostiles, excludedTargets);
    if (reachableTable) return { candidate: reachableTable, reason: "A safe observed crafting table is too far away; navigate closer first." };
    if (tableItemCount > 0) {
      const placement = placementCandidate(state, task, hostiles, excludedTargets);
      if (placement) return { candidate: placement, reason: "Place the crafting table already in inventory on a safe observed support block." };
      return { candidate: null, reason: "A crafting table is in inventory, but no safe visible supported placement cell is available." };
    }
    if (task.targetItem !== "crafting_table") {
      const planks = totalPlanks(state);
      if (planks >= 4) {
        const candidate = notExcluded(
          craftCandidate("crafting_table", inventoryCount(state, "crafting_table") + 1),
          excludedTargets,
        );
        return { candidate, reason: "Craft a table before attempting a 3-by-3 recipe." };
      }
      const plankCandidate = plankProductionCandidate(state, task, hostiles, excludedTargets, 4);
      return plankCandidate
        ? { candidate: plankCandidate, reason: "Gather or craft planks for the missing crafting-table prerequisite." }
        : { candidate: null, reason: "A crafting table is required but no table, four planks, or safe nearby logs are available." };
    }
  }

  const tableForCraft = closeTable?.position;
  let requiredPlanks = 0;
  let requiredSticks = 0;
  for (const [ingredient, quantity] of Object.entries(plan.ingredients)) {
    if (ingredient === "any_planks") requiredPlanks += quantity * operations;
    else if (ingredient === "stick") requiredSticks += quantity * operations;
  }

  const currentSticks = inventoryCount(state, "stick");
  const missingSticks = Math.max(0, requiredSticks - currentSticks);
  if (missingSticks > 0) {
    const planksForSticks = Math.ceil(missingSticks / 4) * 2;
    if (totalPlanks(state) < planksForSticks) {
      const planksNeededForTarget = requiredPlanks + planksForSticks;
      const candidate = plankProductionCandidate(state, task, hostiles, excludedTargets, planksNeededForTarget);
      return candidate
        ? { candidate, reason: `Produce ${planksNeededForTarget} planks before crafting the missing sticks.` }
        : { candidate: null, reason: `Missing ${missingSticks} sticks and insufficient planks/logs are available.` };
    }
    return {
      candidate: notExcluded(craftCandidate("stick", currentSticks + missingSticks), excludedTargets),
      reason: `Craft ${missingSticks} sticks for the target recipe.`,
    };
  }

  const totalPlanksNeeded = requiredPlanks;
  if (totalPlanks(state) < totalPlanksNeeded) {
    const candidate = plankProductionCandidate(state, task, hostiles, excludedTargets, totalPlanksNeeded);
    return candidate
      ? { candidate, reason: `Produce the remaining planks before crafting ${task.targetItem}.` }
      : { candidate: null, reason: `Missing ${totalPlanksNeeded - totalPlanks(state)} planks and no safe, observed log prerequisite is available.` };
  }

  const specificLog = task.targetItem.endsWith("_planks")
    ? task.targetItem.replace(/_planks$/, "_log")
    : null;
  if (specificLog) {
    const exactPlanks = inventoryCount(state, task.targetItem);
    if (exactPlanks < task.targetCount) {
      const logs = inventoryCount(state, specificLog);
      const missingPlanks = task.targetCount - exactPlanks;
      if (logs >= Math.ceil(missingPlanks / 4)) {
        return {
          candidate: notExcluded(craftCandidate(task.targetItem, task.targetCount), excludedTargets),
          reason: "Craft requested planks from the matching wood type.",
        };
      }
      const log = nearbySafeLogs(state, task, hostiles, excludedTargets, new Set([specificLog]))[0];
      if (log) {
        return {
          candidate: {
            goalId: `collect:${specificLog}`,
            priorityBand: 1,
            score: 400 - log.distance,
            skillId: "minecraft.collect-log",
            input: { ...log.block.position, blockName: specificLog, dangerRadius: task.dangerRadius },
            targetKey: positionKey(log.block.position),
            rationale: `Collect the nearest safe ${specificLog} to produce the requested plank variant.`,
          },
          reason: "Collect the required matching log before crafting planks.",
        };
      }
      if (logs > 0) {
        return {
          candidate: notExcluded(craftCandidate(task.targetItem, exactPlanks + logs * 4), excludedTargets),
          reason: "Craft the plank amount supported by current matching logs; stop/replan if the target still lacks material.",
        };
      }
      return { candidate: null, reason: `No ${specificLog} is available for the requested plank type.` };
    }
  }

  return {
    candidate: notExcluded(
      craftCandidate(task.targetItem, task.targetCount, requiresTable ? tableForCraft : undefined),
      excludedTargets,
    ),
    reason: `All modeled prerequisites are available for ${task.targetItem}; craft and verify the resulting inventory count.`,
  };
}

export class MinecraftTaskDecisionModel
  implements DecisionModel<MinecraftObservation, MinecraftTask>
{
  readonly modelId = "minecraft-priority-utility.v2";

  decide(
    state: MinecraftObservation,
    task: MinecraftTask,
    context: DecisionContext,
    observationSequence = 0,
  ): DecisionRecord {
    const targetItem = task.kind === "gather_resource" ? task.resourceName : task.targetItem;
    const currentTargetCount = itemCount(state, targetItem);
    if (currentTargetCount >= task.targetCount) {
      return {
        modelId: this.modelId,
        decidedAt: new Date().toISOString(),
        observationSequence,
        selected: null,
        alternatives: [],
        terminalStatus: "completed",
        summary: `Task condition met: inventory/equipment contains ${currentTargetCount}/${task.targetCount} ${targetItem}.`,
      };
    }

    const visibleHostiles = state.entities.filter((entity) =>
      isHostileMinecraftEntity(entity.name, entity.type),
    );
    const nearbyHostiles = visibleHostiles.filter(
      (entity) => distance(entity.position, state.player.position) <= task.dangerRadius,
    );
    const dangerOptions = nearbyHostiles.length > 0
      ? fleeCandidates(state, nearbyHostiles, context.excludedTargets)
      : [];

    let terminalStatus: DecisionRecord["terminalStatus"] = null;
    let summary = "";
    let selected: DecisionCandidate | null = null;
    let alternatives: DecisionCandidate[] = [];

    if (nearbyHostiles.length > 0) {
      if (dangerOptions.length > 0) {
        selected = dangerOptions[0] ?? null;
        alternatives = dangerOptions.slice(1);
        summary = "Safety goal outranks eating and progression; leave the nearby hostile's threat radius first.";
      } else {
        terminalStatus = "blocked";
        summary = "All untried conservative flee destinations were exhausted while a hostile remains nearby; stop rather than approach a resource.";
      }
    } else if (state.player.health !== null && state.player.health <= CRITICAL_HEALTH_THRESHOLD) {
      terminalStatus = "blocked";
      summary = `Health is critically low (${state.player.health}/20) and no validated healing skill is available; stop rather than risk further damage.`;
    } else if (state.player.gameMode !== "survival") {
      terminalStatus = "blocked";
      summary = `Minecraft task skills are limited to survival mode; current mode is '${state.player.gameMode}'.`;
    } else if (task.kind === "gather_resource" && state.player.dimension !== "overworld") {
      terminalStatus = "blocked";
      summary = `Log collection is currently restricted to the overworld; current dimension is '${state.player.dimension}'.`;
    } else {
      const food = foodCandidate(state, context.excludedTargets);
      if (food) {
        selected = food;
        summary = "Survival needs outrank non-critical task progress; consume and verify food before continuing.";
      } else if (
        state.player.food !== null &&
        state.player.food <= CRITICAL_FOOD_THRESHOLD &&
        !state.inventory.some((item) => isMinecraftFoodName(item.name) && item.count > 0)
      ) {
        terminalStatus = "blocked";
        summary = `Hunger is critically low (${state.player.food}/20), but no supported food is in inventory; stop instead of spending the remaining survival budget on task progress.`;
      } else if (task.kind === "gather_resource") {
        const currentCount = itemCount(state, task.resourceName);
        const observedResourceBlocks = state.nearbyBlocks.filter((block) => block.name === task.resourceName);
        const untriedResourceBlocks = observedResourceBlocks.filter(
          (block) => !context.excludedTargets.has(positionKey(block.position)),
        );
        const threatenedResourceBlocks = untriedResourceBlocks.filter((block) =>
          visibleHostiles.some((hostile) => distance(hostile.position, {
            x: block.position.x + 0.5,
            y: block.position.y + 0.5,
            z: block.position.z + 0.5,
          }) <= task.dangerRadius),
        );
        const gatherOptions = untriedResourceBlocks
          .filter((block) => !threatenedResourceBlocks.includes(block))
          .map((block) => ({
            block,
            distance: distance(state.player.position, {
              x: block.position.x + 0.5,
              y: block.position.y + 0.5,
              z: block.position.z + 0.5,
            }),
          }))
          .filter(({ distance: targetDistance }) => targetDistance <= task.maxTargetDistance)
          .map(({ block, distance: targetDistance }) => ({
            goalId: `collect:${task.resourceName}`,
            priorityBand: 1,
            score: 500 - targetDistance,
            skillId: "minecraft.collect-log",
            input: { ...block.position, blockName: task.resourceName, dangerRadius: task.dangerRadius },
            targetKey: positionKey(block.position),
            rationale: `Collect the nearest observed ${task.resourceName} (${targetDistance.toFixed(1)} blocks away); inventory has ${currentCount}/${task.targetCount}.`,
          } satisfies DecisionCandidate))
          .sort((left, right) => right.score - left.score || (left.targetKey ?? "").localeCompare(right.targetKey ?? ""));

        if (currentCount >= task.targetCount) {
          terminalStatus = "completed";
          summary = `Task condition met: inventory contains ${currentCount}/${task.targetCount} ${task.resourceName}.`;
        } else if (gatherOptions.length > 0) {
          selected = gatherOptions[0] ?? null;
          alternatives = gatherOptions.slice(1);
          summary = "Collect an observed safe log; replan after the action and verify the inventory delta.";
        } else {
          terminalStatus = "blocked";
          summary = threatenedResourceBlocks.length > 0
            ? `Observed ${task.resourceName} blocks are inside the ${task.dangerRadius}-block danger radius of a visible hostile; collection is deferred rather than approaching the threat.`
            : untriedResourceBlocks.length > 0
              ? `Observed ${task.resourceName} targets are beyond the ${task.maxTargetDistance}-block task limit.`
              : observedResourceBlocks.length > 0 || context.previousFailureCode
                ? `No untried observed ${task.resourceName} target remains${context.previousFailureCode ? ` after ${context.previousFailureCode}` : ""}.`
                : `No ${task.resourceName} block is currently present in the observed local world state.`;
        }
      } else {
        const currentCount = itemCount(state, task.targetItem);
        if (currentCount >= task.targetCount) {
          terminalStatus = "completed";
          summary = `Task condition met: inventory/equipment contains ${currentCount}/${task.targetCount} ${task.targetItem}.`;
        } else {
          const plan = craftPlan(state, task, visibleHostiles, context.excludedTargets);
          if (plan.candidate) {
            selected = plan.candidate;
            summary = plan.reason;
          } else {
            terminalStatus = "blocked";
            summary = plan.reason;
          }
        }
      }
    }

    return {
      modelId: this.modelId,
      decidedAt: new Date().toISOString(),
      observationSequence,
      selected,
      alternatives,
      terminalStatus,
      summary,
    };
  }
}
