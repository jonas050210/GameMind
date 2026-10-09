import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import type { MinecraftObservation } from "./observation.js";
import { WorldMemory, type MemoryUpdate, type WorldMemorySnapshot } from "./world-memory.js";

export interface PersistentWorldMemoryOptions {
  readonly logger?: Logger | null;
  readonly debounceMs?: number;
  readonly maxAgeMs?: number;
}

/**
 * World-scoped resource/exploration memory persisted atomically as JSON. Hostiles and dropped items
 * are intentionally session-only: they move/despawn and must never be treated as current after restart.
 */
export class PersistentWorldMemory extends WorldMemory {
  readonly filePath: string;
  private readonly debounceMs: number;
  private readonly maxAgeMs: number;
  private readonly logger: Logger | null;
  private saveTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    filePath: string,
    private readonly worldKey: string,
    options: PersistentWorldMemoryOptions,
  ) {
    super();
    this.filePath = filePath;
    this.debounceMs = options.debounceMs ?? 500;
    this.maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.logger = options.logger ?? null;
  }

  /** Opens and validates the world memory, rejecting malformed, stale, or cross-world snapshots. */
  static async open(
    directory: string,
    worldKey: string,
    options: PersistentWorldMemoryOptions = {},
  ): Promise<PersistentWorldMemory> {
    if (!worldKey.trim()) throw new Error("Persistent world memory needs a non-empty world key.");
    const filename = `${createHash("sha256").update(worldKey).digest("hex").slice(0, 24)}.json`;
    const memory = new PersistentWorldMemory(path.join(directory, filename), worldKey, options);
    try {
      const raw = await readFile(memory.filePath, "utf8");
      const restored = memory.restoreSnapshot(JSON.parse(raw), worldKey, memory.maxAgeMs);
      if (restored) {
        memory.logger?.info({ worldKey, exploredCells: memory.exploredCellCount }, "Persistent world memory restored");
      } else {
        memory.logger?.warn({ worldKey, filePath: memory.filePath }, "Persistent world memory was invalid, stale, or belonged to another world; starting fresh");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        memory.logger?.warn({ err: error, worldKey, filePath: memory.filePath }, "Persistent world memory could not be read; starting fresh");
      }
    }
    return memory;
  }

  override observe(state: MinecraftObservation, sequence: number): MemoryUpdate {
    const update = super.observe(state, sequence);
    if (sequence > -1) this.scheduleSave();
    return update;
  }

  override forgetBlock(key: string): boolean {
    const changed = super.forgetBlock(key);
    if (changed) this.scheduleSave();
    return changed;
  }

  override forgetMinable(key: string): boolean {
    const changed = super.forgetMinable(key);
    if (changed) this.scheduleSave();
    return changed;
  }

  /** Flushes debounced changes; call on orderly shutdown and in persistence tests. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.enqueueWrite();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.enqueueWrite().catch((error: unknown) => {
        this.logger?.warn({ err: error, worldKey: this.worldKey }, "Persistent world memory could not be written; the current run continues");
      });
    }, this.debounceMs);
    this.saveTimer.unref();
  }

  private enqueueWrite(): Promise<void> {
    const snapshot: WorldMemorySnapshot = this.exportSnapshot(this.worldKey);
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.filePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = operation;
    return operation;
  }
}
