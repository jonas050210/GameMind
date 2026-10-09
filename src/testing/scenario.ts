import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ActionStatus } from "../core/types.js";

const actionStatuses: readonly [ActionStatus, ...ActionStatus[]] = [
  "succeeded",
  "rejected",
  "failed",
  "timed_out",
  "disconnected",
  "aborted",
];

const observeStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("observe"),
  expectedState: z.unknown().optional(),
});

const skillStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("skill"),
  skillId: z.string().min(1),
  input: z.unknown(),
  expectedStatus: z.enum(actionStatuses).default("succeeded"),
  expectedConfirmed: z.boolean().optional(),
  expectedStateAfter: z.unknown().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const scenarioSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  seed: z.number().int(),
  description: z.string(),
  steps: z.array(z.discriminatedUnion("kind", [observeStepSchema, skillStepSchema])).min(1),
});

export type ScenarioDefinition = z.infer<typeof scenarioSchema>;
export type ScenarioStep = ScenarioDefinition["steps"][number];

export async function loadScenario(filePath: string): Promise<ScenarioDefinition> {
  const content = await readFile(filePath, "utf8");
  let decoded: unknown;
  try {
    decoded = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Scenario file '${filePath}' is not valid JSON.`, { cause: error });
  }
  return scenarioSchema.parse(decoded);
}
