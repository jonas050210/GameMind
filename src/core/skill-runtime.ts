import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ZodType } from "zod";
import type { ActionResult, GameSession, WorldState } from "./types.js";
import { ActionExecutor } from "./action-executor.js";
import { TraceRecorder } from "./trace.js";

export interface SkillDefinition<TInput = unknown> {
  readonly id: string;
  readonly description: string;
  readonly capability: string;
  readonly inputSchema: ZodType<TInput>;
  readonly defaultTimeoutMs?: number;
}

export interface SkillRunOptions {
  readonly actionId?: string;
  readonly timeoutMs?: number;
  readonly source?: string;
}

export interface SkillExecutionResult<TState = unknown> {
  readonly skillId: string;
  readonly action: ActionResult;
  readonly observationBefore: WorldState<TState> | null;
  readonly observationAfter: WorldState<TState> | null;
}

export class SkillRuntime<TState = unknown> {
  private readonly skills = new Map<string, SkillDefinition>();

  constructor(
    definitions: readonly SkillDefinition[],
    private readonly actionExecutor: ActionExecutor<TState>,
    private readonly trace: TraceRecorder,
    private readonly logger: Logger,
    private readonly getSession: () => GameSession | null,
    private readonly observe: () => Promise<WorldState<TState>>,
  ) {
    for (const definition of definitions) {
      if (this.skills.has(definition.id)) {
        throw new Error(`Skill '${definition.id}' is already registered.`);
      }
      if (!this.actionExecutor.registry.has(definition.capability)) {
        throw new Error(
          `Skill '${definition.id}' requires unavailable capability '${definition.capability}'.`,
        );
      }
      this.skills.set(definition.id, definition);
    }
  }

  list(): readonly SkillDefinition[] {
    return [...this.skills.values()];
  }

  get(skillId: string): SkillDefinition | undefined {
    return this.skills.get(skillId);
  }

  get capabilityRegistry() {
    return this.actionExecutor.registry;
  }

  async run(
    skillId: string,
    input: unknown,
    options: SkillRunOptions = {},
  ): Promise<SkillExecutionResult<TState>> {
    const definition = this.skills.get(skillId);
    if (!definition) throw new Error(`Unknown skill '${skillId}'.`);

    const actionId = options.actionId ?? randomUUID();
    const session = this.getSession();
    const source = options.source ?? `skill:${skillId}`;
    const skillStartedAt = new Date().toISOString();
    const skillInput = definition.inputSchema.safeParse(input);
    const normalizedInput = skillInput.success ? skillInput.data : input;

    await this.trace.record({
      eventType: "skill.started",
      gameId: session?.gameId ?? null,
      sessionId: session?.id ?? null,
      correlationId: actionId,
      data: {
        skillId,
        capability: definition.capability,
        input: normalizedInput,
        source,
      },
    });

    let observationBefore: WorldState<TState> | null = null;
    let observationFailure: unknown = null;
    try {
      observationBefore = await this.observe();
    } catch (error) {
      observationFailure = error;
      this.logger.warn(
        { err: error, skillId, actionId },
        "Pre-action observation failed; the action will be rejected fail-closed",
      );
    }

    const request = {
      actionId,
      sessionId: session?.id ?? null,
      capability: definition.capability,
      input: normalizedInput,
      source,
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : definition.defaultTimeoutMs !== undefined
          ? { timeoutMs: definition.defaultTimeoutMs }
          : {}),
    };
    const preflightFailure = observationFailure
      ? {
          code: "PRE_ACTION_OBSERVATION_FAILED",
          message:
            observationFailure instanceof Error
              ? observationFailure.message
              : String(observationFailure),
          status: "failed" as const,
        }
      : null;

    const action = await this.actionExecutor.execute(request, preflightFailure);
    let observationAfter: WorldState<TState> | null = null;
    if (action.status !== "disconnected") {
      try {
        observationAfter = await this.observe();
      } catch (error) {
        this.logger.warn(
          { err: error, skillId, actionId },
          "Post-action observation failed; action result remains visible in the trace",
        );
        await this.trace.record({
          eventType: "observation.after_action_failed",
          gameId: session?.gameId ?? null,
          sessionId: session?.id ?? null,
          correlationId: actionId,
          data: {
            skillId,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    const result: SkillExecutionResult<TState> = {
      skillId,
      action,
      observationBefore,
      observationAfter,
    };
    await this.trace.record({
      eventType: "skill.completed",
      gameId: session?.gameId ?? null,
      sessionId: session?.id ?? null,
      correlationId: actionId,
      data: {
        skillId,
        status: action.status,
        confirmed: action.confirmed,
        confirmation: action.confirmation,
        durationMs: action.durationMs,
        observationBeforeSequence: observationBefore?.sequence ?? null,
        observationAfterSequence: observationAfter?.sequence ?? null,
        startedAt: skillStartedAt,
      },
    });
    return result;
  }
}
