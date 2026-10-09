import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { episodeSchema, type Episode } from "./episode.js";

/**
 * Append-only JSONL experience log. Every line is one validated episode; malformed or unsupported
 * lines are counted and skipped rather than poisoning the learner, so a truncated write from a
 * crashed process degrades into "lost the last episode" instead of "learning state unusable".
 */
export interface ExperienceStoreOptions {
  readonly directory: string;
  /** Episodes above this count trigger a compaction that keeps the most recent entries. */
  readonly maxEpisodes?: number;
  readonly fileName?: string;
}

export interface ExperienceStoreStats {
  readonly episodes: number;
  readonly skippedLines: number;
  readonly firstRunId: string | null;
  readonly lastRunId: string | null;
  readonly runs: number;
}

export interface LoadedEpisodes {
  readonly episodes: Episode[];
  readonly skippedLines: number;
}

const DEFAULT_MAX_EPISODES = 20_000;

export class ExperienceStore {
  private readonly directory: string;
  private readonly fileName: string;
  private readonly maxEpisodes: number;
  private queue: Promise<void> = Promise.resolve();
  private cachedLines: number | null = null;

  constructor(options: ExperienceStoreOptions) {
    this.directory = options.directory;
    this.fileName = options.fileName ?? "episodes.jsonl";
    this.maxEpisodes = options.maxEpisodes ?? DEFAULT_MAX_EPISODES;
  }

  get filePath(): string {
    return path.join(this.directory, this.fileName);
  }

  async append(episode: Episode): Promise<void> {
    await this.appendMany([episode]);
  }

  /**
   * Single-write batch append. Learning runs append thousands of episodes, and a per-episode
   * compaction scan would dominate the cost, so the size check happens once here.
   */
  async appendMany(episodes: readonly Episode[]): Promise<void> {
    if (episodes.length === 0) return;
    const parsed = episodes.map((episode) => episodeSchema.parse(episode));
    this.queue = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(this.filePath, `${parsed.map((episode) => JSON.stringify(episode)).join("\n")}\n`, "utf8");
      const lines = await this.lineCount();
      if (lines > this.maxEpisodes) await this.compact(lines - this.maxEpisodes);
      this.cachedLines = lines > this.maxEpisodes ? this.maxEpisodes : lines;
    });
    await this.queue;
  }

  private async lineCount(): Promise<number> {
    if (this.cachedLines !== null && this.cachedLines < this.maxEpisodes) return this.cachedLines;
    try {
      const raw = await readFile(this.filePath, "utf8");
      return raw.split("\n").filter((line) => line.trim().length > 0).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  /** Drops the oldest `drop` lines. Written to a temp file and renamed so a crash cannot truncate the log. */
  private async compact(drop: number): Promise<void> {
    const raw = await readFile(this.filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const kept = lines.slice(drop).join("\n");
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, kept.length > 0 ? `${kept}\n` : "", "utf8");
    await rename(temporary, this.filePath);
  }

  async load(limit?: number): Promise<LoadedEpisodes> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { episodes: [], skippedLines: 0 };
      }
      throw error;
    }
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const selected = limit === undefined ? lines : lines.slice(Math.max(0, lines.length - limit));
    const episodes: Episode[] = [];
    let skippedLines = 0;
    for (const line of selected) {
      try {
        const parsed = episodeSchema.parse(JSON.parse(line));
        episodes.push(parsed);
      } catch {
        skippedLines += 1;
      }
    }
    return { episodes, skippedLines };
  }

  async stats(): Promise<ExperienceStoreStats> {
    const { episodes, skippedLines } = await this.load();
    const runs = new Set(episodes.map((episode) => episode.runId));
    return {
      episodes: episodes.length,
      skippedLines,
      runs: runs.size,
      firstRunId: episodes[0]?.runId ?? null,
      lastRunId: episodes.at(-1)?.runId ?? null,
    };
  }

  /** Test support and demos: forget everything recorded so far. */
  async clear(): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        await writeFile(this.filePath, "", "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
    await this.queue;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}

/** In-memory store used by tests and short-lived evaluations. */
export class InMemoryExperienceStore {
  readonly episodes: Episode[] = [];
  private readonly maxEpisodes: number;

  constructor(maxEpisodes = DEFAULT_MAX_EPISODES) {
    this.maxEpisodes = maxEpisodes;
  }

  async append(episode: Episode): Promise<void> {
    this.episodes.push(episodeSchema.parse(episode));
    if (this.episodes.length > this.maxEpisodes) this.episodes.shift();
  }

  async appendMany(episodes: readonly Episode[]): Promise<void> {
    for (const episode of episodes) await this.append(episode);
  }

  async load(limit?: number): Promise<LoadedEpisodes> {
    const episodes = limit === undefined ? [...this.episodes] : this.episodes.slice(-limit);
    return { episodes, skippedLines: 0 };
  }

  async stats(): Promise<ExperienceStoreStats> {
    const runs = new Set(this.episodes.map((episode) => episode.runId));
    return {
      episodes: this.episodes.length,
      skippedLines: 0,
      runs: runs.size,
      firstRunId: this.episodes[0]?.runId ?? null,
      lastRunId: this.episodes.at(-1)?.runId ?? null,
    };
  }

  async clear(): Promise<void> {
    this.episodes.length = 0;
  }

  async flush(): Promise<void> {
    // Nothing to flush; the array is the store.
  }
}

export type ExperienceStoreLike = Pick<
  ExperienceStore,
  "append" | "appendMany" | "load" | "stats" | "clear" | "flush"
>;
