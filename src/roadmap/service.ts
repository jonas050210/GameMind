import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ControlCommandResult } from "../control-center/types.js";
import { loadEvidence, type EvidenceSource, type RuntimeEvidence } from "./evidence.js";
import { deriveCandidates } from "./rules.js";
import {
  ROADMAP_ACTIONS,
  ROADMAP_STATUSES,
  applyAction,
  nextRecommendedTask,
  reconcile,
  type RoadmapAction,
  type RoadmapDecision,
  type RoadmapItem,
  type RoadmapStatus,
} from "./model.js";
import { writeJsonAtomic } from "../training/state.js";

export const ROADMAP_SCHEMA_VERSION = 1;
/** How old the evidence may be before a snapshot request starts a background refresh. */
const REFRESH_AFTER_MS = 30_000;

export interface RoadmapServiceOptions {
  /** Where decisions are saved (data/roadmap). */
  readonly root: string;
  readonly profileDirectory: string;
  readonly testRecordPath: string;
  readonly trainingRoot: string;
  readonly episodeFiles: readonly string[];
  readonly liveVerificationPath: string;
  readonly now?: () => Date;
}

export interface RoadmapSnapshot {
  readonly generatedAt: string | null;
  /** Newest measurement across the sources that were read, or null when there was no evidence at all. */
  readonly evidenceAt: string | null;
  readonly sources: readonly EvidenceSource[];
  readonly items: readonly RoadmapItem[];
  readonly next: { readonly fingerprint: string; readonly title: string; readonly summary: string } | null;
  readonly counts: Readonly<Record<RoadmapStatus, number>>;
  /** Findings that were open before and are no longer measured. They are hidden, not deleted. */
  readonly resolved: number;
  readonly error: string | null;
  readonly note: string;
}

interface SavedRoadmap {
  schemaVersion: typeof ROADMAP_SCHEMA_VERSION;
  decisions: Record<string, RoadmapDecision>;
  lastRefreshAt: string | null;
}

const EMPTY_COUNTS = Object.fromEntries(ROADMAP_STATUSES.map((status) => [status, 0])) as Record<RoadmapStatus, number>;

/**
 * Keeps the improvement roadmap: rebuilds candidates from evidence, merges them with the operator's saved
 * decisions, and applies operator actions. One refresh runs at a time; a request during a refresh gets the
 * same promise instead of starting another.
 */
export class RoadmapService {
  private cached: RoadmapSnapshot | null = null;
  private inFlight: Promise<RoadmapSnapshot> | null = null;
  private queued: Promise<RoadmapSnapshot> | null = null;
  private saved: SavedRoadmap | null = null;
  private lastRefreshMs = 0;
  private loadError: string | null = null;
  private runtime: RuntimeEvidence | null = null;

  constructor(private readonly options: RoadmapServiceOptions) {}

  private get statePath(): string {
    return join(this.options.root, "state.json");
  }

  private get now(): () => Date {
    return this.options.now ?? (() => new Date());
  }

  private async load(): Promise<SavedRoadmap> {
    if (this.saved) return this.saved;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<SavedRoadmap>;
      if (parsed.schemaVersion !== ROADMAP_SCHEMA_VERSION || typeof parsed.decisions !== "object" || parsed.decisions === null) {
        throw new Error("unsupported roadmap state");
      }
      this.saved = { schemaVersion: ROADMAP_SCHEMA_VERSION, decisions: parsed.decisions, lastRefreshAt: parsed.lastRefreshAt ?? null };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // A file that cannot be read is kept as a backup, never silently overwritten with an empty roadmap.
        const backup = `${this.statePath}.unreadable-${this.now().toISOString().replace(/[:.]/g, "-")}.json`;
        await mkdir(this.options.root, { recursive: true });
        await copyFile(this.statePath, backup).catch(() => undefined);
        this.loadError = `The saved roadmap could not be read and was kept at ${backup}. Starting an empty roadmap.`;
      }
      this.saved = { schemaVersion: ROADMAP_SCHEMA_VERSION, decisions: {}, lastRefreshAt: null };
    }
    return this.saved;
  }

  private async persist(): Promise<void> {
    if (!this.saved) return;
    await writeJsonAtomic(this.statePath, this.saved);
  }

  /** Records the newest live runtime measurement. The next refresh uses it; nothing is refreshed here. */
  observeRuntime(runtime: RuntimeEvidence | null): void {
    this.runtime = runtime;
  }

  /** Rebuilds the roadmap from current evidence. Concurrent calls share one run. */
  /** Resolves once no refresh is running or queued, so shutdown never races a write to the roadmap file. */
  async idle(): Promise<void> {
    while (this.inFlight || this.queued) {
      await (this.queued ?? this.inFlight)?.catch(() => undefined);
    }
  }

  refresh(runtime: RuntimeEvidence | null = this.runtime): Promise<RoadmapSnapshot> {
    this.runtime = runtime;
    // A request made while a run is in progress must see evidence read after the request, so it waits for the
    // current run and then runs once more. Requests that pile up while waiting share that one queued run.
    if (this.queued) return this.queued;
    if (this.inFlight) {
      const current = this.inFlight;
      this.queued = current.catch(() => undefined).then(() => {
        this.queued = null;
        return this.refresh();
      });
      return this.queued;
    }
    this.inFlight = this.runRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runRefresh(): Promise<RoadmapSnapshot> {
    const now = this.now().toISOString();
    // Stamped before the work, so a failing refresh is not retried on every snapshot request.
    this.lastRefreshMs = this.now().getTime();
    try {
      const saved = await this.load();
      const loaded = await loadEvidence({
        profileDirectory: this.options.profileDirectory,
        testRecordPath: this.options.testRecordPath,
        trainingRoot: this.options.trainingRoot,
        episodeFiles: this.options.episodeFiles,
        liveVerificationPath: this.options.liveVerificationPath,
        runtime: this.runtime,
      });
      const candidates = deriveCandidates(loaded.bundle);
      const result = reconcile({ candidates, decisions: saved.decisions, now, evidenceAt: loaded.evidenceAt });
      saved.decisions = result.decisions;
      saved.lastRefreshAt = now;
      await this.persist();
      this.cached = this.buildSnapshot(now, loaded.evidenceAt, loaded.sources, result.items, result.resolved, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Keep the previous items on screen with the error, rather than presenting an empty roadmap as a result.
      this.cached = this.cached
        ? { ...this.cached, error: `Refresh failed at ${now}: ${message}` }
        : this.buildSnapshot(now, null, [], [], 0, `Refresh failed: ${message}`);
    }
    if (this.loadError && this.cached) this.cached = { ...this.cached, error: this.loadError };
    return this.cached!;
  }

  private buildSnapshot(
    generatedAt: string,
    evidenceAt: string | null,
    sources: readonly EvidenceSource[],
    items: readonly RoadmapItem[],
    resolved: number,
    error: string | null,
  ): RoadmapSnapshot {
    const sorted = [...items].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const counts: Record<RoadmapStatus, number> = { ...EMPTY_COUNTS };
    for (const item of sorted) counts[item.status] += 1;
    const next = nextRecommendedTask(sorted);
    return {
      generatedAt,
      evidenceAt,
      sources,
      items: sorted,
      next: next
        ? {
            fingerprint: next.fingerprint,
            title: next.title,
            summary: `${next.title}. ${next.expectedBenefit} Effort ${["", "small", "medium", "large"][next.effort]}; confidence ${Math.round(next.confidence * 100)}%.`,
          }
        : null,
      counts,
      resolved,
      error,
      note: "Items come from recorded evidence only. Defects are measured failures; hypotheses have an unestablished cause; ideas are never suggested as the next task.",
    };
  }

  /** Returns the last snapshot at once. Starts a background refresh when none exists or the evidence is old. */
  snapshot(): RoadmapSnapshot | null {
    const stale = this.now().getTime() - this.lastRefreshMs > REFRESH_AFTER_MS;
    if (!this.cached || stale) void this.refresh().catch(() => undefined);
    return this.cached;
  }

  /** Applies an operator decision and saves it. The change takes effect on the next refresh too. */
  async act(payload: { fingerprint?: unknown; action?: unknown; value?: unknown; note?: unknown }): Promise<ControlCommandResult> {
    const fingerprint = typeof payload.fingerprint === "string" ? payload.fingerprint : "";
    const action = typeof payload.action === "string" ? payload.action : "";
    if (!fingerprint) return { ok: false, message: "Choose a roadmap item first." };
    if (!(ROADMAP_ACTIONS as readonly string[]).includes(action)) return { ok: false, message: `Unknown roadmap action '${action}'.` };
    const saved = await this.load();
    const decision = saved.decisions[fingerprint];
    const known = this.cached?.items.find((item) => item.fingerprint === fingerprint);
    if (!decision && !known) return { ok: false, message: "That roadmap item is not known. Refresh the roadmap and try again." };
    const target: RoadmapDecision = decision ?? {
      status: "proposed",
      pinned: false,
      priority: null,
      severity: known?.severity ?? 0,
      dismissedSeverity: null,
      implementedAt: null,
      lastEvidenceAt: known?.measuredAt ?? null,
      firstSeenAt: this.now().toISOString(),
      lastSeenAt: null,
      reopenedCount: 0,
      verification: null,
      history: [],
    };
    const note = typeof payload.note === "string" && payload.note.trim() ? payload.note.trim().slice(0, 200) : null;
    const value = typeof payload.value === "number" ? payload.value : null;
    const outcome = applyAction(target, action as RoadmapAction, value, this.now().toISOString(), known?.severity ?? null, note);
    if (!outcome.ok) return { ok: false, message: outcome.message };
    saved.decisions[fingerprint] = target;
    await this.persist();
    // Recompute the view from evidence and the saved decision, so the response matches what the UI will show.
    await this.refresh();
    return { ok: true, message: `${action} saved for ${fingerprint}.` };
  }
}

/** Default locations, all relative to the data directory (data/ unless overridden). */
export function defaultRoadmapOptions(dataRoot = "data", now?: () => Date): RoadmapServiceOptions {
  return {
    root: join(dataRoot, "roadmap"),
    profileDirectory: join(dataRoot, "profile"),
    testRecordPath: join(dataRoot, "evidence", "tests.json"),
    trainingRoot: join(dataRoot, "training"),
    episodeFiles: [join(dataRoot, "training", "experience", "episodes.jsonl"), join(dataRoot, "learning", "episodes.jsonl")],
    liveVerificationPath: join(dataRoot, "evidence", "live-verification.json"),
    ...(now ? { now } : {}),
  };
}
