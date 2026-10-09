import assert from "node:assert/strict";
import type { GameMindRuntime } from "../core/game-mind-runtime.js";
import type { SkillRuntime } from "../core/skill-runtime.js";
import type { ActionStatus } from "../core/types.js";
import type { ScenarioDefinition, ScenarioStep } from "./scenario.js";

export interface ScenarioStepReport {
  readonly id: string;
  readonly kind: "observe" | "skill";
  readonly status: ActionStatus | "observed";
  readonly confirmed: boolean | null;
  readonly observationSequence: number | null;
}

export interface ScenarioReport {
  readonly scenarioId: string;
  readonly seed: number;
  readonly stepsCompleted: number;
  readonly steps: readonly ScenarioStepReport[];
  readonly finalState: unknown;
}

function assertSubset(actual: unknown, expected: unknown, path: string): void {
  if (
    expected !== null &&
    typeof expected === "object" &&
    actual !== null &&
    typeof actual === "object"
  ) {
    if (Array.isArray(expected)) {
      assert.ok(Array.isArray(actual), `${path}: expected an array.`);
      assert.equal(actual.length, expected.length, `${path}: array length differs.`);
      expected.forEach((value, index) => assertSubset(actual[index], value, `${path}[${index}]`));
      return;
    }
    assert.ok(!Array.isArray(actual), `${path}: expected an object.`);
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(key in actual, `${path}.${key}: expected field is missing.`);
      assertSubset(
        (actual as Record<string, unknown>)[key],
        value,
        `${path}.${key}`,
      );
    }
    return;
  }
  assert.deepStrictEqual(actual, expected, `${path}: values differ.`);
}

function expectedStateFromStep(step: ScenarioStep): unknown | undefined {
  return step.kind === "observe" ? step.expectedState : step.expectedStateAfter;
}

export class ScenarioRunner<TState = unknown> {
  constructor(
    private readonly runtime: GameMindRuntime<TState>,
    private readonly skills: SkillRuntime<TState>,
  ) {}

  async run(scenario: ScenarioDefinition): Promise<ScenarioReport> {
    const reports: ScenarioStepReport[] = [];
    let completed = 0;
    let failure: unknown = null;

    try {
      await this.runtime.connect();
      await this.runtime.trace.record({
        eventType: "scenario.started",
        gameId: this.runtime.adapter.gameId,
        sessionId: this.runtime.session?.id ?? null,
        data: {
          scenarioId: scenario.id,
          seed: scenario.seed,
          description: scenario.description,
        },
      });

      for (const step of scenario.steps) {
        const report = await this.runStep(step);
        reports.push(report);
        completed += 1;
      }

      await this.runtime.trace.record({
        eventType: "scenario.completed",
        gameId: this.runtime.adapter.gameId,
        sessionId: this.runtime.session?.id ?? null,
        data: { scenarioId: scenario.id, stepsCompleted: completed },
      });
      return {
        scenarioId: scenario.id,
        seed: scenario.seed,
        stepsCompleted: completed,
        steps: reports,
        finalState: this.runtime.currentWorldState?.state ?? null,
      };
    } catch (error) {
      failure = error;
      try {
        await this.runtime.trace.record({
          eventType: "scenario.failed",
          gameId: this.runtime.adapter.gameId,
          sessionId: this.runtime.session?.id ?? null,
          data: {
            scenarioId: scenario.id,
            stepsCompleted: completed,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } catch {
        // The original scenario failure remains the primary error.
      }
      throw error;
    } finally {
      await this.runtime.shutdown(
        failure ? `scenario ${scenario.id} failed` : `scenario ${scenario.id} finished`,
      );
    }
  }

  private async runStep(step: ScenarioStep): Promise<ScenarioStepReport> {
    if (step.kind === "observe") {
      const observation = await this.runtime.observe();
      if (step.expectedState !== undefined) {
        assertSubset(observation.state, step.expectedState, `step ${step.id}.state`);
      }
      return {
        id: step.id,
        kind: "observe",
        status: "observed",
        confirmed: null,
        observationSequence: observation.sequence,
      };
    }

    const options = step.timeoutMs === undefined
      ? { actionId: `scenario-${step.id}`, source: "scenario" }
      : {
          actionId: `scenario-${step.id}`,
          source: "scenario",
          timeoutMs: step.timeoutMs,
        };
    const result = await this.skills.run(step.skillId, step.input, options);
    assert.equal(
      result.action.status,
      step.expectedStatus,
      `step ${step.id}: action status differs`,
    );
    if (step.expectedConfirmed !== undefined) {
      assert.equal(
        result.action.confirmed,
        step.expectedConfirmed,
        `step ${step.id}: confirmation differs`,
      );
    }
    const expectedState = expectedStateFromStep(step);
    if (expectedState !== undefined) {
      assert.ok(result.observationAfter, `step ${step.id}: no post-action observation was captured.`);
      assertSubset(
        result.observationAfter.state,
        expectedState,
        `step ${step.id}.stateAfter`,
      );
    }
    return {
      id: step.id,
      kind: "skill",
      status: result.action.status,
      confirmed: result.action.confirmed,
      observationSequence: result.observationAfter?.sequence ?? null,
    };
  }
}
