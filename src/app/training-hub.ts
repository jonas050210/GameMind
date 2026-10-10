import { mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ControlCenterTraining, ControlCommandResult } from "../control-center/types.js";
import { TrainingManager, type TrainingControl, type TrainingPreflight, type TrainingStartOptions } from "../training/manager.js";
import type { AppEventLog } from "./event-log.js";

/**
 * Training for the whole app: any number of directories under the data folder, but at most one run in flight.
 *
 * Offline training is CPU-heavy and each run owns its directory (the lock file enforces that across processes). Letting
 * the operator start a second one in another folder would not break correctness, but it would starve the agent's own
 * observation loop, so the hub refuses it with a sentence that says which run is active. Directory names are validated
 * here, once: a name under the data folder, never a path, so the browser cannot point training at an arbitrary location.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
export const DEFAULT_TRAINING_DIRECTORY = "training";

/**
 * Folders GameMind itself keeps under the data folder. A training run writes its own state, checkpoints and lock files into
 * its directory, so pointing one at any of these would overwrite other data (the roadmap store, for one, also keeps a
 * state.json). They are never offered and never accepted, whatever their contents look like.
 */
export const RESERVED_DATA_FOLDERS: ReadonlySet<string> = new Set([
  "events", "jobs", "learning", "learning-simulated", "world-memory", "traces", "run", "eval", "roadmap", "companion",
  "live-verification", "profiles", "evidence", "episodes", "library", "memory",
]);

export class TrainingDirectoryNameError extends Error {
  constructor(name: string, reserved = false) {
    super(
      reserved
        ? `'${name}' is a folder GameMind uses for something else (${[...RESERVED_DATA_FOLDERS].sort().join(", ")}). Pick another training folder name.`
        : `'${name}' is not a valid training folder name. Use 1 to 48 letters, digits, dots, dashes or underscores, starting with a letter or digit; it is created inside the data folder.`,
    );
    this.name = "TrainingDirectoryNameError";
  }
}

export interface TrainingHubOptions {
  /** Absolute data directory; training folders live directly inside it. */
  readonly dataDirectory: string;
  /** How the data directory is shown to the operator (project-relative, e.g. "data"). */
  readonly displayData: string;
  readonly events: AppEventLog;
  /** Test seam for the per-directory manager. */
  readonly createManager?: (root: string, displayRoot: string) => TrainingManager;
}

export class TrainingHub implements TrainingControl {
  private readonly managers = new Map<string, TrainingManager>();
  private selectedName = DEFAULT_TRAINING_DIRECTORY;

  constructor(private readonly options: TrainingHubOptions) {}

  get selected(): string {
    return this.selectedName;
  }

  /** Resolves a folder name to its manager, creating it on first use. Throws for an invalid name. */
  manager(name: string): TrainingManager {
    if (!NAME.test(name) || name === "." || name === "..") throw new TrainingDirectoryNameError(name);
    if (RESERVED_DATA_FOLDERS.has(name.toLowerCase())) throw new TrainingDirectoryNameError(name, true);
    let manager = this.managers.get(name);
    if (!manager) {
      const root = path.join(this.options.dataDirectory, name);
      const display = `${this.options.displayData}/${name}`;
      manager = this.options.createManager ? this.options.createManager(root, display) : new TrainingManager({ root, displayRoot: display });
      this.managers.set(name, manager);
    }
    return manager;
  }

  /** Folders that already hold training data, plus the default, for the directory picker. */
  directories(): readonly string[] {
    const names = new Set<string>([DEFAULT_TRAINING_DIRECTORY, ...this.managers.keys()]);
    try {
      for (const entry of readdirSync(this.options.dataDirectory)) {
        if (!NAME.test(entry) || RESERVED_DATA_FOLDERS.has(entry.toLowerCase())) continue;
        const folder = path.join(this.options.dataDirectory, entry);
        try {
          if (statSync(folder).isDirectory() && this.isTrainingFolder(folder)) names.add(entry);
        } catch {
          // unreadable entries are simply not offered
        }
      }
    } catch {
      // no data directory yet
    }
    return [...names].sort();
  }

  private isTrainingFolder(folder: string): boolean {
    for (const marker of ["state.json", "checkpoints", "training.lock"]) {
      try {
        statSync(path.join(folder, marker));
        return true;
      } catch {
        // try the next marker
      }
    }
    return false;
  }

  select(name: string): void {
    this.manager(name);
    this.selectedName = name;
  }

  private current(): TrainingManager {
    return this.manager(this.selectedName);
  }

  /** The name of a directory whose run is active, if any. */
  async activeDirectory(): Promise<string | null> {
    for (const [name, manager] of this.managers) {
      const view = await manager.snapshot();
      if (view.processAlive || view.status === "evaluating") return name;
    }
    return null;
  }

  async start(options: TrainingStartOptions = {}): Promise<ControlCommandResult> {
    let name = this.selectedName;
    if (options.directory !== undefined) {
      name = options.directory.trim() === "" ? DEFAULT_TRAINING_DIRECTORY : options.directory.trim();
      try {
        this.manager(name);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    const active = await this.activeDirectory();
    if (active !== null && active !== name) {
      return { ok: false, message: `Training is already running in '${active}'. Only one run is active at a time; stop it before starting another.` };
    }
    const { directory: _ignored, ...rest } = options;
    void _ignored;
    const result = await this.manager(name).start(rest);
    if (result.ok) {
      this.selectedName = name;
      this.options.events.record({
        category: "training",
        code: options.fresh ? "TRAINING_STARTED_FRESH" : "TRAINING_STARTED",
        message: `${options.fresh ? "Fresh training" : "Training"} requested in '${name}'`,
        source: "offline",
        data: { directory: name, fresh: options.fresh === true, maxEpisodes: options.maxEpisodes ?? null, maxMinutes: options.maxMinutes ?? null, explorationRate: options.explorationRate ?? null },
      });
    } else {
      this.options.events.record({ level: "warn", category: "training", code: "TRAINING_START_REFUSED", message: `Training start refused: ${result.message}`, source: "offline", data: { directory: name } });
    }
    return result;
  }

  async pause(): Promise<ControlCommandResult> {
    return this.logged("pause", await this.current().pause());
  }

  async resume(): Promise<ControlCommandResult> {
    const active = await this.activeDirectory();
    if (active !== null && active !== this.selectedName) {
      return { ok: false, message: `Training is running in '${active}'; stop it before resuming another folder.` };
    }
    return this.logged("resume", await this.current().resume());
  }

  async stop(): Promise<ControlCommandResult> {
    return this.logged("stop", await this.current().stop());
  }

  async evaluate(checkpointId?: string): Promise<ControlCommandResult> {
    const active = await this.activeDirectory();
    if (active !== null && active !== this.selectedName) {
      return { ok: false, message: `Training is running in '${active}'; wait for it before evaluating another folder.` };
    }
    return this.logged("evaluate", await this.current().evaluate(checkpointId));
  }

  async snapshot(): Promise<ControlCenterTraining> {
    return this.current().snapshot();
  }

  /** Evaluation reports of the selected folder, newest first. */
  evaluationReports(limit?: number): ReturnType<TrainingManager["evaluationReports"]> {
    return this.current().evaluationReports(limit);
  }

  /** What starting in `directory` (default: the selected one) would do. Creates nothing on disk. */
  async preflight(directory?: string): Promise<TrainingPreflight & { readonly directoryName: string; readonly directories: readonly string[] }> {
    const name = directory === undefined || directory.trim() === "" ? this.selectedName : directory.trim();
    const result = await this.manager(name).preflight();
    return { ...result, directoryName: name, directories: this.directories() };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.managers.values()].map((manager) => manager.dispose()));
  }

  /** Creates the data folder if needed; used by the app at start so a first run can write immediately. */
  ensureDataDirectory(): void {
    mkdirSync(this.options.dataDirectory, { recursive: true });
  }

  private logged(action: string, result: ControlCommandResult): ControlCommandResult {
    this.options.events.record({
      level: result.ok ? "info" : "warn",
      category: "training",
      code: `TRAINING_${action.toUpperCase()}${result.ok ? "" : "_REFUSED"}`,
      message: `Training ${action}: ${result.message}`,
      source: "offline",
      data: { directory: this.selectedName },
    });
    return result;
  }
}
