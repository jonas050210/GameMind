import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { CapabilityRegistry } from "./capability-registry.js";
import type { SafetyBroker } from "./safety-broker.js";
import type {
  ActionFailure,
  ActionRequest,
  ActionResult,
  ActionStatus,
  AdapterStatusChange,
  GameAdapter,
} from "./types.js";
import { TraceRecorder } from "./trace.js";

interface RaceOutcome {
  readonly kind: "outcome";
  readonly value: Awaited<ReturnType<GameAdapter["executeAction"]>>;
}

interface RaceError {
  readonly kind: "error";
  readonly error: unknown;
}

interface RaceInterruption {
  readonly kind: "interruption";
}

interface RaceTimeout {
  readonly kind: "timeout";
}

type ActionRace = RaceOutcome | RaceError | RaceInterruption | RaceTimeout;

const CANCELLATION_GRACE_MS = 500;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "ADAPTER_ACTION_FAILED";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ActionExecutorOptions {
  /**
   * Optional Safety Broker. When set, every non-read-only action is put through it after input
   * validation and before the adapter is asked to execute. A denial is recorded as a rejected
   * action with the broker's own code, so traces always explain who stopped the action.
   */
  readonly safety?: SafetyBroker;
  readonly riskOf?: (capability: string) => "low" | "medium" | "high";
}

export class ActionExecutor<TState = unknown> {
  private busy = false;
  private stopping = false;
  private quarantined = false;
  private activeActionId: string | null = null;
  private activeAbortController: AbortController | null = null;
  private activeCapability: string | null = null;
  private activeInterrupt: ((reason: string, code: string) => void) | null = null;
  private readonly capabilities: CapabilityRegistry;

  private readonly safety: SafetyBroker | null;
  private readonly riskOf: (capability: string) => "low" | "medium" | "high";

  constructor(
    private readonly adapter: GameAdapter<TState>,
    private readonly trace: TraceRecorder,
    private readonly logger: Logger,
    options: ActionExecutorOptions = {},
  ) {
    this.capabilities = new CapabilityRegistry(adapter.capabilities);
    this.safety = options.safety ?? null;
    this.riskOf = options.riskOf ?? ((capability) => this.capabilities.get(capability)?.risk ?? "medium");
  }

  get registry(): CapabilityRegistry {
    return this.capabilities;
  }

  /** The capability of the action in flight, or null when the executor is idle. */
  get runningCapability(): string | null {
    return this.activeCapability;
  }

  /**
   * Stops the action in flight, if there is one, and reports the reason with its failure code. The
   * interrupted action settles as `aborted` (never `succeeded`), so the caller decides what to do next
   * with a fresh observation. Protected capabilities (for example an eat or an attack that must finish)
   * are left running and reported as not interrupted.
   */
  interruptActive(
    reason: string,
    options: { readonly code?: string; readonly protectedCapabilities?: readonly string[] } = {},
  ): { readonly interrupted: boolean; readonly capability: string | null } {
    const capability = this.activeCapability;
    if (!this.activeInterrupt || capability === null) return { interrupted: false, capability: null };
    if (options.protectedCapabilities?.includes(capability)) return { interrupted: false, capability };
    this.activeInterrupt(reason, options.code ?? "ACTION_INTERRUPTED");
    return { interrupted: true, capability };
  }

  /** The broker that gates this executor, when one is attached. */
  get safetyBroker(): SafetyBroker | null {
    return this.safety;
  }

  async execute(
    request: ActionRequest,
    preflightFailure: (ActionFailure & { readonly status?: ActionStatus }) | null = null,
  ): Promise<ActionResult> {
    const actionId = request.actionId ?? randomUUID();
    const requestedAt = new Date().toISOString();
    const startedClock = Date.now();

    if (this.busy) {
      return this.reject(request, actionId, requestedAt, startedClock, {
        code: "ACTION_IN_PROGRESS",
        message: "Another action is still being processed; concurrent actions are rejected.",
      });
    }
    this.busy = true;

    try {
      if (this.stopping) {
        return this.reject(request, actionId, requestedAt, startedClock, {
          code: "RUNTIME_STOPPING",
          message: "The action runtime is shutting down.",
          status: "aborted",
        });
      }
      if (this.quarantined) {
        return this.reject(request, actionId, requestedAt, startedClock, {
          code: "ADAPTER_QUARANTINED",
          message: "A previous action did not settle after cancellation; reconnect before acting.",
          status: "disconnected",
        });
      }
      if (
        request.sessionId === null ||
        this.adapter.status !== "connected" ||
        !this.adapter.session ||
        this.adapter.session.id !== request.sessionId
      ) {
        return this.reject(request, actionId, requestedAt, startedClock, {
          code: "NO_ACTIVE_SESSION",
          message: "The requested session is not currently connected.",
          status: "disconnected",
        });
      }

      const capability = this.capabilities.get(request.capability);
      if (!capability) {
        return this.reject(request, actionId, requestedAt, startedClock, {
          code: "CAPABILITY_NOT_AVAILABLE",
          message: `Capability '${request.capability}' is not advertised by this adapter.`,
        });
      }

      const parsed = capability.inputSchema.safeParse(request.input);
      if (!parsed.success) {
        return this.reject(request, actionId, requestedAt, startedClock, {
          code: "INVALID_ACTION_INPUT",
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
            .join("; "),
        });
      }

      const timeoutMs = request.timeoutMs ?? capability.defaultTimeoutMs;
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > capability.maxTimeoutMs
      ) {
        return this.reject(request, actionId, requestedAt, startedClock, {
          code: "INVALID_ACTION_TIMEOUT",
          message: `Timeout must be an integer between 1 and ${capability.maxTimeoutMs} ms.`,
        });
      }

      if (preflightFailure) {
        return this.reject(request, actionId, requestedAt, startedClock, {
          code: preflightFailure.code,
          message: preflightFailure.message,
          status: preflightFailure.status ?? "failed",
        });
      }

      if (this.safety) {
        const verdict = this.safety.evaluate({
          capability: request.capability,
          risk: this.riskOf(request.capability),
          ...(request.skillId !== undefined ? { skillId: request.skillId } : {}),
          ...(request.source !== undefined ? { source: request.source } : {}),
        });
        await this.trace.record({
          eventType: "safety.verdict",
          gameId: this.adapter.gameId,
          sessionId: request.sessionId,
          correlationId: actionId,
          data: {
            capability: verdict.capability,
            risk: verdict.risk,
            allowed: verdict.allowed,
            code: verdict.code,
            message: verdict.message,
            checks: verdict.checks,
            source: request.source ?? "unspecified",
          },
        });
        if (!verdict.allowed) {
          return this.reject(request, actionId, requestedAt, startedClock, {
            code: `SAFETY_${verdict.code}`,
            message: verdict.message,
          });
        }
      }

      const session = this.adapter.session;
      if (!session || session.id !== request.sessionId || this.adapter.status !== "connected") {
        return this.reject(request, actionId, requestedAt, startedClock, {
          code: "SESSION_CHANGED_BEFORE_ACTION",
          message: "The adapter session changed during action validation.",
          status: "disconnected",
        });
      }

      await this.trace.record({
        eventType: "action.requested",
        gameId: this.adapter.gameId,
        sessionId: request.sessionId,
        correlationId: actionId,
        data: {
          actionId,
          capability: request.capability,
          input: request.input,
          source: request.source ?? "unspecified",
          timeoutMs: request.timeoutMs ?? null,
        },
      });

      const startedAt = new Date().toISOString();
      await this.trace.record({
        eventType: "action.started",
        gameId: this.adapter.gameId,
        sessionId: request.sessionId,
        correlationId: actionId,
        data: {
          capability: request.capability,
          source: request.source ?? "unspecified",
          timeoutMs,
        },
      });

      const controller = new AbortController();
      this.activeAbortController = controller;
      this.activeActionId = actionId;
      let timedOut = false;
      const interruption: { status: ActionStatus; code: string | null; message: string | null } = {
        status: "aborted",
        code: null,
        message: null,
      };
      let timeoutHandle: NodeJS.Timeout | undefined;
      let resolveInterruption: (() => void) | undefined;

      const interrupted = new Promise<RaceInterruption>((resolve) => {
        resolveInterruption = () => resolve({ kind: "interruption" });
      });
      controller.signal.addEventListener("abort", () => resolveInterruption?.(), {
        once: true,
      });
      const onStatusChange = (change: AdapterStatusChange): void => {
        if (
          this.activeActionId === actionId &&
          change.status !== "connected" &&
          change.status !== "connecting"
        ) {
          interruption.status =
            change.status === "disconnected" || change.status === "failed"
              ? "disconnected"
              : "aborted";
          if (!controller.signal.aborted) controller.abort(new Error(change.reason ?? change.status));
          resolveInterruption?.();
        }
      };
      const unsubscribe = this.adapter.onStatusChange(onStatusChange);
      this.activeCapability = request.capability;
      this.activeInterrupt = (reason: string, code: string): void => {
        if (controller.signal.aborted) return;
        interruption.status = "aborted";
        interruption.code = code;
        interruption.message = reason;
        controller.abort(new Error(reason));
        resolveInterruption?.();
      };

      const operation: Promise<ActionRace> = Promise.resolve()
        .then(() =>
          this.adapter.executeAction(
            {
              actionId,
              sessionId: request.sessionId as string,
              capability: request.capability,
              input: parsed.data,
            },
            controller.signal,
          ),
        )
        .then(
          (value) => ({ kind: "outcome", value }) satisfies RaceOutcome,
          (error: unknown) => ({ kind: "error", error }) satisfies RaceError,
        );

      const timeout = new Promise<RaceTimeout>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolve({ kind: "timeout" });
          if (!controller.signal.aborted) controller.abort(new Error("Action deadline exceeded."));
          resolveInterruption?.();
        }, timeoutMs);
      });

      let raced: ActionRace;
      try {
        raced = await Promise.race([operation, timeout, interrupted]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        unsubscribe();
      }

      if (raced.kind === "timeout" || raced.kind === "interruption") {
        if (raced.kind === "interruption" && !timedOut) {
          // Preserve the reason captured by the adapter status listener.
        }
        await this.cancelAndQuiesce(actionId, timedOut ? "timeout" : "interrupted", operation);
        const status: ActionStatus = timedOut ? "timed_out" : interruption.status;
        const result = this.makeResult({
          actionId,
          sessionId: request.sessionId,
          capability: request.capability,
          status,
          confirmed: false,
          confirmation: null,
          requestedAt,
          startedAt,
          startedClock,
          failure: {
            code: timedOut
              ? "ACTION_TIMEOUT"
              : status === "disconnected"
                ? "ADAPTER_DISCONNECTED"
                : (interruption.code ?? "ACTION_ABORTED"),
            message: timedOut
              ? `Action exceeded its ${timeoutMs} ms deadline and was cancelled.`
              : status === "disconnected"
                ? "The Minecraft session ended while the action was running."
                : (interruption.message ?? "The action was cancelled during safe shutdown."),
          },
          details: { capability: request.capability, timeoutMs },
        });
        await this.recordResult(result, request.source ?? "unspecified");
        return result;
      }

      if (raced.kind === "error") {
        const disconnected =
          this.adapter.status !== "connected" || this.adapter.session?.id !== request.sessionId;
        const status: ActionStatus = disconnected
          ? "disconnected"
          : controller.signal.aborted
            ? "aborted"
            : "failed";
        const result = this.makeResult({
          actionId,
          sessionId: request.sessionId,
          capability: request.capability,
          status,
          confirmed: false,
          confirmation: null,
          requestedAt,
          startedAt,
          startedClock,
          failure: {
            code: disconnected ? "ADAPTER_DISCONNECTED" : errorCode(raced.error),
            message: errorMessage(raced.error),
          },
          details: null,
        });
        await this.recordResult(result, request.source ?? "unspecified");
        return result;
      }

      if (
        this.adapter.status !== "connected" ||
        this.adapter.session?.id !== request.sessionId
      ) {
        const result = this.makeResult({
          actionId,
          sessionId: request.sessionId,
          capability: request.capability,
          status: "disconnected",
          confirmed: false,
          confirmation: null,
          requestedAt,
          startedAt,
          startedClock,
          failure: {
            code: "SESSION_ENDED_AFTER_ACTION",
            message: "The adapter session ended before the action result could be trusted.",
          },
          details: raced.value.details ?? null,
        });
        await this.recordResult(result, request.source ?? "unspecified");
        return result;
      }

      const result = this.makeResult({
        actionId,
        sessionId: request.sessionId,
        capability: request.capability,
        status: raced.value.confirmed ? "succeeded" : "failed",
        confirmed: raced.value.confirmed,
        confirmation: raced.value.confirmation,
        requestedAt,
        startedAt,
        startedClock,
        failure: raced.value.confirmed
          ? null
          : {
              code: "ACTION_NOT_CONFIRMED",
              message: "The adapter completed the action but could not confirm its effect.",
            },
        details: raced.value.details ?? null,
      });
      await this.recordResult(result, request.source ?? "unspecified");
      return result;
    } finally {
      this.busy = false;
      this.activeActionId = null;
      this.activeAbortController = null;
      this.activeCapability = null;
      this.activeInterrupt = null;
    }
  }

  async shutdown(reason = "runtime shutdown"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const actionId = this.activeActionId;
    if (actionId && this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.activeAbortController.abort(new Error(reason));
      try {
        await this.adapter.cancelActiveAction(actionId, reason);
      } catch (error) {
        this.logger.warn({ err: error, actionId }, "Adapter action cancellation failed during shutdown");
      }
    }
  }

  private async cancelAndQuiesce(
    actionId: string,
    reason: string,
    operation: Promise<ActionRace>,
  ): Promise<void> {
    try {
      await this.adapter.cancelActiveAction(actionId, reason);
    } catch (error) {
      this.logger.warn({ err: error, actionId, reason }, "Adapter could not cancel active action");
    }

    const settled = await Promise.race([
      operation.then(() => true),
      delay(CANCELLATION_GRACE_MS).then(() => false),
    ]);
    if (!settled) {
      this.quarantined = true;
      this.logger.error(
        { actionId, reason },
        "Action did not quiesce after cancellation; disconnecting and quarantining adapter",
      );
      try {
        await this.adapter.disconnect(`Unresponsive action ${actionId}`);
      } catch (error) {
        this.logger.error({ err: error, actionId }, "Disconnect after action timeout failed");
      }
    }
  }

  private async reject(
    request: ActionRequest,
    actionId: string,
    requestedAt: string,
    startedClock: number,
    failure: ActionFailure & { readonly status?: ActionStatus },
  ): Promise<ActionResult> {
    await this.trace.record({
      eventType: "action.requested",
      gameId: this.adapter.gameId,
      sessionId: request.sessionId,
      correlationId: actionId,
      data: {
        actionId,
        capability: request.capability,
        input: request.input,
        source: request.source ?? "unspecified",
        timeoutMs: request.timeoutMs ?? null,
      },
    });
    const result = this.makeResult({
      actionId,
      sessionId: request.sessionId,
      capability: request.capability,
      status: failure.status ?? "rejected",
      confirmed: false,
      confirmation: null,
      requestedAt,
      startedAt: null,
      startedClock,
      failure: { code: failure.code, message: failure.message },
      details: null,
    });
    await this.recordResult(result, request.source ?? "unspecified");
    return result;
  }

  private makeResult(input: {
    actionId: string;
    sessionId: string | null;
    capability: string;
    status: ActionStatus;
    confirmed: boolean;
    confirmation: string | null;
    requestedAt: string;
    startedAt: string | null;
    startedClock: number;
    failure: ActionFailure | null;
    details: Readonly<Record<string, unknown>> | null;
  }): ActionResult {
    return {
      actionId: input.actionId,
      sessionId: input.sessionId,
      capability: input.capability,
      status: input.status,
      confirmed: input.confirmed,
      confirmation: input.confirmation,
      requestedAt: input.requestedAt,
      startedAt: input.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - input.startedClock),
      failure: input.failure,
      details: input.details,
    };
  }

  private async recordResult(result: ActionResult, source: string): Promise<void> {
    await this.trace.record({
      eventType: `action.${result.status}`,
      gameId: this.adapter.gameId,
      sessionId: result.sessionId,
      correlationId: result.actionId,
      data: {
        actionId: result.actionId,
        capability: result.capability,
        source,
        status: result.status,
        confirmed: result.confirmed,
        confirmation: result.confirmation,
        durationMs: result.durationMs,
        failure: result.failure,
        details: result.details,
      },
    });
  }
}
