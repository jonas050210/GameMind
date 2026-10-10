import { appendFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { redactDeep, redactText, type RedactionContext } from "./redact.js";

/**
 * The searchable, timestamped record of what the platform did: connections, lifecycle transitions, task
 * transitions, decisions, actions, safety refusals, training and evaluation jobs, errors and shutdown reasons.
 *
 * It is a diagnostic surface, so two rules are enforced here rather than left to callers: every message and every
 * data field is redacted before it is stored (no tokens, no home directory, no absolute paths), and data values
 * are flat scalars so nothing nested or oversized can ride along. Events carry the provenance of what they
 * describe (`live`, `simulated`, `offline`, `system`) so a viewer can never mistake one for another.
 */

export type AppEventLevel = "debug" | "info" | "warn" | "error";

export type AppEventCategory =
  | "app"
  | "session"
  | "connection"
  | "task"
  | "decision"
  | "action"
  | "safety"
  | "training"
  | "evaluation"
  | "learning"
  | "memory"
  | "browser"
  | "shutdown"
  | "error";

export type AppEventSource = "live" | "simulated" | "offline" | "system";

export type AppEventData = Readonly<Record<string, string | number | boolean | null>>;

export interface AppEventInput {
  readonly level?: AppEventLevel;
  readonly category: AppEventCategory;
  readonly code?: string | null;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>> | null;
  readonly sessionId?: string | null;
  readonly source?: AppEventSource;
  /** Overrides the clock; used when replaying events from a trace. */
  readonly at?: string;
}

export interface AppEvent {
  readonly seq: number;
  /** Identifies the process that recorded the event, so events from earlier runs can be shown as history. */
  readonly boot: string;
  readonly at: string;
  readonly level: AppEventLevel;
  readonly category: AppEventCategory;
  readonly code: string | null;
  readonly message: string;
  readonly data: AppEventData | null;
  readonly sessionId: string | null;
  readonly source: AppEventSource;
}

export interface AppEventQuery {
  /** Only events with `seq` greater than this. */
  readonly after?: number;
  readonly limit?: number;
  /** Case-insensitive substring over message, code, category and data values. */
  readonly q?: string;
  readonly category?: AppEventCategory | readonly AppEventCategory[];
  readonly level?: AppEventLevel;
  /** Include events at this level and above (info includes warn and error). */
  readonly minLevel?: AppEventLevel;
  readonly source?: AppEventSource;
  readonly sessionId?: string;
  /** ISO timestamp lower bound (inclusive). */
  readonly since?: string;
  /** `current` keeps this boot's events only; `previous` only the history loaded from disk; default both. */
  readonly scope?: "current" | "previous" | "all";
}

export interface AppEventLogOptions {
  readonly redaction: RedactionContext;
  readonly capacity?: number;
  /** When set, events are also appended to JSONL files here and the newest history is reloaded at start. */
  readonly directory?: string | null;
  readonly now?: () => number;
  readonly boot?: string;
  /** Rotates the active file once it exceeds this many bytes. */
  readonly maxFileBytes?: number;
  readonly keepFiles?: number;
  /** Called when persistence fails; the log keeps working in memory. */
  readonly onPersistError?: (error: Error) => void;
}

const LEVEL_RANK: Readonly<Record<AppEventLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_MESSAGE_LENGTH = 600;
const MAX_DATA_VALUE_LENGTH = 240;
const MAX_DATA_KEYS = 24;
const ACTIVE_FILE = "events.jsonl";

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export class AppEventLog {
  readonly boot: string;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly events: AppEvent[] = [];
  private readonly listeners = new Set<(event: AppEvent) => void>();
  private sequence = 0;
  private writes: Promise<void> = Promise.resolve();
  private loaded = 0;
  private persistFailures = 0;

  constructor(private readonly options: AppEventLogOptions) {
    this.capacity = Math.max(50, options.capacity ?? 2_000);
    this.now = options.now ?? (() => Date.now());
    this.boot = options.boot ?? `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  get latestSeq(): number {
    return this.sequence;
  }

  get size(): number {
    return this.events.length;
  }

  /** How many historical events were reloaded from earlier runs. */
  get historyLoaded(): number {
    return this.loaded;
  }

  get persistenceFailures(): number {
    return this.persistFailures;
  }

  /**
   * Reloads the newest persisted events as history. They are numbered below this boot's own events and keep the
   * boot id they were recorded under, so the UI can group and dim them. Never throws: unreadable history is skipped.
   */
  async loadHistory(maxEvents = 500): Promise<number> {
    const directory = this.options.directory;
    if (!directory) return 0;
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => /^events(\.\d+)?\.jsonl$/.test(name));
    } catch {
      return 0;
    }
    // events.jsonl is newest; events.1.jsonl, events.2.jsonl ... are progressively older.
    names.sort((left, right) => rotationIndex(left) - rotationIndex(right));
    const collected: AppEvent[] = [];
    for (const name of names) {
      let text: string;
      try {
        text = await readFile(path.join(directory, name), "utf8");
      } catch {
        continue;
      }
      const parsed: AppEvent[] = [];
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        try {
          const value = JSON.parse(line) as Partial<AppEvent>;
          if (typeof value.at === "string" && typeof value.message === "string" && typeof value.category === "string") {
            parsed.push(normaliseLoaded(value));
          }
        } catch {
          // A torn last line from a crash is expected; skip it.
        }
      }
      collected.unshift(...parsed);
      if (collected.length >= maxEvents) break;
    }
    const history = collected.slice(-maxEvents).filter((event) => event.boot !== this.boot);
    // Renumber so history sorts before this boot's events and `after` cursors stay monotonic.
    const offset = history.length;
    this.events.unshift(...history.map((event, index) => ({ ...event, seq: index + 1 - offset })));
    this.loaded = history.length;
    return history.length;
  }

  record(input: AppEventInput): AppEvent {
    const context = this.options.redaction;
    this.sequence += 1;
    const event: AppEvent = {
      seq: this.sequence,
      boot: this.boot,
      at: input.at ?? new Date(this.now()).toISOString(),
      level: input.level ?? "info",
      category: input.category,
      code: input.code ?? null,
      message: clip(redactText(input.message, context), MAX_MESSAGE_LENGTH),
      data: input.data ? this.flatten(input.data) : null,
      sessionId: input.sessionId ?? null,
      source: input.source ?? "system",
    };
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener cannot break recording.
      }
    }
    this.persist(event);
    return event;
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(query: AppEventQuery = {}): { readonly events: readonly AppEvent[]; readonly latestSeq: number; readonly total: number; readonly matched: number; readonly truncated: boolean } {
    const needle = query.q?.trim().toLowerCase() ?? "";
    const categories = query.category === undefined ? null : new Set(Array.isArray(query.category) ? query.category : [query.category as AppEventCategory]);
    const minimum = query.minLevel ? LEVEL_RANK[query.minLevel] : null;
    const since = query.since ? Date.parse(query.since) : null;
    const scope = query.scope ?? "all";
    const matches = this.events.filter((event) => {
      if (query.after !== undefined && event.seq <= query.after) return false;
      if (scope === "current" && event.boot !== this.boot) return false;
      if (scope === "previous" && event.boot === this.boot) return false;
      if (categories && !categories.has(event.category)) return false;
      if (query.level && event.level !== query.level) return false;
      if (minimum !== null && LEVEL_RANK[event.level] < minimum) return false;
      if (query.source && event.source !== query.source) return false;
      if (query.sessionId && event.sessionId !== query.sessionId) return false;
      if (since !== null && Number.isFinite(since) && Date.parse(event.at) < since) return false;
      if (needle.length > 0 && !haystack(event).includes(needle)) return false;
      return true;
    });
    const limit = Math.max(1, Math.min(1_000, query.limit ?? 200));
    const events = matches.slice(-limit);
    return { events, latestSeq: this.sequence, total: this.events.length, matched: matches.length, truncated: matches.length > events.length };
  }

  /** Waits for queued disk writes; used on shutdown so the last events (the shutdown reason) are not lost. */
  async flush(): Promise<void> {
    await this.writes;
  }

  private flatten(data: Readonly<Record<string, unknown>>): AppEventData {
    const safe = redactDeep(data, this.options.redaction);
    const output: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(safe).slice(0, MAX_DATA_KEYS)) {
      if (value === null || typeof value === "boolean") output[key] = value;
      else if (typeof value === "number") output[key] = Number.isFinite(value) ? value : null;
      else if (typeof value === "string") output[key] = clip(value, MAX_DATA_VALUE_LENGTH);
      else if (value !== undefined) output[key] = clip(JSON.stringify(value) ?? "", MAX_DATA_VALUE_LENGTH);
    }
    return output;
  }

  private persist(event: AppEvent): void {
    const directory = this.options.directory;
    if (!directory) return;
    const line = `${JSON.stringify(event)}\n`;
    this.writes = this.writes
      .then(async () => {
        await mkdir(directory, { recursive: true });
        await this.rotateIfNeeded(directory);
        await appendFile(path.join(directory, ACTIVE_FILE), line, "utf8");
      })
      .catch((error: unknown) => {
        this.persistFailures += 1;
        this.options.onPersistError?.(error instanceof Error ? error : new Error(String(error)));
      });
  }

  private async rotateIfNeeded(directory: string): Promise<void> {
    const limit = this.options.maxFileBytes ?? 2_000_000;
    const keep = Math.max(1, this.options.keepFiles ?? 4);
    let size = 0;
    try {
      size = (await stat(path.join(directory, ACTIVE_FILE))).size;
    } catch {
      return;
    }
    if (size < limit) return;
    for (let index = keep - 1; index >= 1; index -= 1) {
      try {
        await rename(path.join(directory, `events.${index}.jsonl`), path.join(directory, `events.${index + 1}.jsonl`));
      } catch {
        // Missing rotation slots are normal.
      }
    }
    await rename(path.join(directory, ACTIVE_FILE), path.join(directory, "events.1.jsonl")).catch(() => undefined);
  }
}

function rotationIndex(name: string): number {
  const match = /^events\.(\d+)\.jsonl$/.exec(name);
  return match ? Number(match[1]) : 0;
}

function haystack(event: AppEvent): string {
  const data = event.data ? Object.values(event.data).map((value) => String(value)).join(" ") : "";
  return `${event.message} ${event.code ?? ""} ${event.category} ${event.level} ${event.source} ${data}`.toLowerCase();
}

function normaliseLoaded(value: Partial<AppEvent>): AppEvent {
  const level = (["debug", "info", "warn", "error"] as const).includes(value.level as AppEventLevel) ? (value.level as AppEventLevel) : "info";
  const source = (["live", "simulated", "offline", "system"] as const).includes(value.source as AppEventSource) ? (value.source as AppEventSource) : "system";
  return {
    seq: typeof value.seq === "number" ? value.seq : 0,
    boot: typeof value.boot === "string" ? value.boot : "unknown",
    at: String(value.at),
    level,
    category: value.category as AppEventCategory,
    code: typeof value.code === "string" ? value.code : null,
    message: String(value.message),
    data: value.data && typeof value.data === "object" ? (value.data as AppEventData) : null,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    source,
  };
}
