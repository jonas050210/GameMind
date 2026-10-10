import type { TraceEvent, TraceSink } from "../core/trace.js";
import type { AppEventInput, AppEventLog, AppEventSource } from "./event-log.js";

/**
 * Mirrors the parts of the agent trace an operator wants to search later into the app event log: connection
 * changes, session boundaries, task starts and ends, decisions, action outcomes, safety refusals and deaths.
 *
 * It is a secondary trace sink, so it must never throw into the action path; anything it cannot map is ignored.
 * The high-volume events (observations, skill start/stop, action requests) stay in the trace files only.
 */
export class EventLogTraceSink implements TraceSink {
  constructor(
    private readonly log: AppEventLog,
    private readonly source: AppEventSource,
  ) {}

  async write(event: TraceEvent): Promise<void> {
    try {
      const mapped = mapTraceEvent(event, this.source);
      if (mapped) this.log.record(mapped);
    } catch {
      // The event log is advisory; a mapping bug must not break an action.
    }
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function mapTraceEvent(event: TraceEvent, source: AppEventSource): AppEventInput | null {
  const data = record(event.data);
  const base = { sessionId: event.sessionId, source, at: event.timestamp } as const;
  const type = event.eventType;

  if (type.startsWith("adapter.")) {
    const status = type.slice("adapter.".length);
    const reason = text(data.reason);
    const bad = status === "disconnected" || status === "failed";
    return {
      ...base,
      level: bad ? "warn" : "info",
      category: "connection",
      code: `ADAPTER_${status.toUpperCase()}`,
      message: `Game connection ${status}${reason ? `: ${reason}` : ""}`,
      data: { status, reason },
    };
  }
  if (type === "session.started") {
    return { ...base, category: "session", code: "SESSION_STARTED", message: "Game session started", data: { gameVersion: text(data.gameVersion) } };
  }
  if (type === "session.stopping") {
    return { ...base, category: "shutdown", code: "SESSION_STOPPING", message: `Game session stopping: ${text(data.reason) ?? "no reason given"}`, data: { reason: text(data.reason) } };
  }
  if (type === "session.stopped") {
    return { ...base, category: "shutdown", code: "SESSION_STOPPED", message: `Game session stopped: ${text(data.reason) ?? "no reason given"}`, data: { reason: text(data.reason), finalAdapterStatus: text(data.finalAdapterStatus) } };
  }
  if (type === "task.started") {
    const task = record(data.task);
    return { ...base, category: "task", code: "TASK_STARTED", message: `Task started: ${text(task.id) ?? "unknown"} (${text(task.kind) ?? "unknown"})`, data: { taskId: text(task.id), kind: text(task.kind) } };
  }
  if (type === "task.completed") {
    const failure = record(data.failure);
    const status = text(data.status) ?? "unknown";
    const metrics = record(data.metrics);
    return {
      ...base,
      level: status === "succeeded" ? "info" : "warn",
      category: "task",
      code: "TASK_ENDED",
      message: `Task ${text(data.taskId) ?? "unknown"} ended: ${status}${text(failure.code) ? ` (${String(failure.code)})` : ""}`,
      data: {
        taskId: text(data.taskId),
        status,
        failureCode: text(failure.code),
        failureMessage: text(failure.message),
        actions: typeof metrics.actions === "number" ? metrics.actions : null,
        elapsedMs: typeof metrics.elapsedMs === "number" ? metrics.elapsedMs : null,
      },
    };
  }
  if (type === "decision.made") {
    const selected = record(data.selected);
    const summary = text(data.summary);
    const blocking = text(data.blockingCode);
    return {
      ...base,
      level: blocking ? "warn" : "info",
      category: "decision",
      code: blocking ?? "DECISION",
      message: `Decision: ${summary ?? text(selected.goalId) ?? "no goal selected"}`,
      data: {
        goal: text(selected.goalId),
        skill: text(selected.skillId),
        band: typeof selected.priorityBand === "number" ? selected.priorityBand : null,
        blockingCode: blocking,
        terminal: text(data.terminalStatus),
      },
    };
  }
  if (type.startsWith("action.") && type !== "action.requested" && type !== "action.started") {
    const status = type.slice("action.".length);
    const failure = record(data.failure);
    const good = status === "succeeded";
    return {
      ...base,
      level: good ? "info" : "warn",
      category: "action",
      code: text(failure.code) ?? `ACTION_${status.toUpperCase()}`,
      message: `Action ${text(data.capability) ?? "unknown"} ${status}${text(failure.message) ? `: ${String(failure.message)}` : ""}`,
      data: {
        capability: text(data.capability),
        status,
        confirmed: typeof data.confirmed === "boolean" ? data.confirmed : null,
        durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
      },
    };
  }
  if (type === "safety.verdict" && data.allowed === false) {
    return {
      ...base,
      level: "warn",
      category: "safety",
      code: text(data.code) ?? "SAFETY_DENIED",
      message: `Safety refused ${text(data.capability) ?? "an action"}: ${text(data.message) ?? "no reason given"}`,
      data: { capability: text(data.capability), risk: text(data.risk), code: text(data.code) },
    };
  }
  if (type === "player.death") {
    return { ...base, level: "warn", category: "session", code: "PLAYER_DEATH", message: "The player died", data: {} };
  }
  return null;
}
