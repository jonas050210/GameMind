import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

export interface TraceEvent {
  readonly traceId: string;
  readonly eventType: string;
  readonly timestamp: string;
  readonly gameId: string | null;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface TraceSink {
  write(event: TraceEvent): Promise<void>;
  close?(): Promise<void>;
}

const SECRET_KEY = /(password|token|secret|authorization|cookie|credential|access.?key)/i;
const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[MAX_DEPTH]";
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`
      : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      MAX_OBJECT_KEYS,
    );
    return Object.fromEntries(
      entries.map(([key, child]) => [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : sanitize(child, depth + 1),
      ]),
    );
  }
  return String(value);
}

export class JsonlTraceSink implements TraceSink {
  constructor(private readonly directory: string) {}

  async write(event: TraceEvent): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const safeSession = (event.sessionId ?? "unscoped").replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );
    const destination = path.join(this.directory, `${safeSession}.jsonl`);
    await appendFile(destination, `${JSON.stringify(event)}\n`, "utf8");
  }
}

export class MemoryTraceSink implements TraceSink {
  readonly events: TraceEvent[] = [];

  async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
}

/**
 * Writes each event to every sink. A failing secondary sink (the live UI feed) is logged and ignored so
 * it can never break the durable JSONL log or the action path that awaits this write.
 */
export class FanOutTraceSink implements TraceSink {
  constructor(
    private readonly sinks: readonly TraceSink[],
    private readonly logger: Logger,
  ) {}

  async write(event: TraceEvent): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.write(event);
        } catch (error) {
          this.logger.warn({ err: error, eventType: event.eventType }, "Trace sink failed; event kept in the other sinks");
        }
      }),
    );
  }

  async close(): Promise<void> {
    for (const sink of this.sinks) await sink.close?.();
  }
}

/** Keeps a bounded ring of recent events in memory for a live dashboard. */
export class RingBufferTraceSink implements TraceSink {
  private readonly events: TraceEvent[] = [];
  private readonly listeners = new Set<(event: TraceEvent) => void>();

  constructor(private readonly limit = 400) {}

  async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > this.limit) this.events.shift();
    for (const listener of this.listeners) listener(event);
  }

  get recent(): readonly TraceEvent[] {
    return this.events;
  }

  find(eventType: string): TraceEvent | null {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (this.events[index]?.eventType === eventType) return this.events[index] ?? null;
    }
    return null;
  }

  filter(predicate: (event: TraceEvent) => boolean): readonly TraceEvent[] {
    return this.events.filter(predicate);
  }

  subscribe(listener: (event: TraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class TraceRecorder {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sink: TraceSink,
    private readonly logger: Logger,
  ) {}

  async record(input: {
    eventType: string;
    gameId?: string | null;
    sessionId?: string | null;
    correlationId?: string | null;
    data?: Readonly<Record<string, unknown>>;
  }): Promise<TraceEvent> {
    const event: TraceEvent = {
      traceId: randomUUID(),
      eventType: input.eventType,
      timestamp: new Date().toISOString(),
      gameId: input.gameId ?? null,
      sessionId: input.sessionId ?? null,
      correlationId: input.correlationId ?? null,
      data: sanitize(input.data ?? {}) as Readonly<Record<string, unknown>>,
    };

    const write = this.writeQueue.then(() => this.sink.write(event));
    this.writeQueue = write;
    try {
      await write;
    } catch (error) {
      this.logger.error(
        { err: error, eventType: event.eventType, sessionId: event.sessionId },
        "Could not persist GameMind trace; action path is failing closed",
      );
      throw error;
    }

    this.logger.info(
      {
        traceId: event.traceId,
        eventType: event.eventType,
        gameId: event.gameId,
        sessionId: event.sessionId,
        correlationId: event.correlationId,
        data: event.data,
      },
      event.eventType,
    );
    return event;
  }

  async close(): Promise<void> {
    await this.writeQueue;
    await this.sink.close?.();
  }
}
