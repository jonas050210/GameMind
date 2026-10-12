import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../atomic-file.js";
import { episodeSchema, type Episode } from "./episode.js";

// Configuration constants
const DEFAULT_MAX_EPISODES = 20_000;
const DEFAULT_BUFFER_SIZE = 100;
const FLUSH_TIMEOUT_MS = 1000;

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
  /** Number of episodes to buffer before writing to disk. Larger values reduce I/O but increase memory usage. */
  readonly bufferSize?: number;
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

export class ExperienceStore {
  private readonly directory: string;
  private readonly fileName: string;
  private readonly maxEpisodes: number;
  private queue: Promise<void> = Promise.resolve();
  private cachedLines: number | null = null;
  private buffer: Episode[] = [];
  private readonly bufferSize: number;
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ExperienceStoreOptions) {
    this.directory = options.directory;
    this.fileName = options.fileName ?? "episodes.jsonl";
    this.maxEpisodes = options.maxEpisodes ?? DEFAULT_MAX_EPISODES;
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
  }

  get filePath(): string {
    return path.join(this.directory, this.fileName);
  }

  async append(episode: Episode): Promise<void> {
    this.buffer.push(episode);
    if (this.buffer.length >= this.bufferSize) {
      await this.flushBuffer();
    } else if (this.flushTimeout === null) {
      // Schedule flush after inactivity timeout
      this.flushTimeout = setTimeout(() => this.flushBuffer(), FLUSH_TIMEOUT_MS);
    }
  }

  /**
   * Flushes the internal buffer to disk. Call this before shutdown to ensure all data is written.
   */
  async flush(): Promise<void> {
    if (this.flushTimeout !== null) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    await this.flushBuffer();
  }

  /**
   * Single-write batch append. Learning runs append thousands of episodes, and a per-episode
   * compaction scan would dominate the cost, so the size check happens once here.
   */
  async appendMany(episodes: readonly Episode[]): Promise<void> {
    if (episodes.length === 0) return;
    this.buffer.push(...episodes);
    if (this.buffer.length >= this.bufferSize) {
      await this.flushBuffer();
    } else if (this.flushTimeout === null) {
      // Schedule flush after inactivity timeout
      this.flushTimeout = setTimeout(() => this.flushBuffer(), FLUSH_TIMEOUT_MS);
    }
  }

  /**
   * Internal method to write buffered episodes to disk.
   */
  private async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;
    
    if (this.flushTimeout !== null) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    
    const episodesToWrite = this.buffer.splice(0, this.buffer.length);
    const parsed = episodesToWrite.map((episode) => episodeSchema.parse(episode));
    
    this.queue = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      // The size *before* this batch, because the count is maintained incrementally from here on. It
      // still has to be seeded from disk once, or a file written by an earlier process never compacts.
      const knownLines = this.cachedLines ?? (await this.lineCount());
      await appendFile(this.filePath, `${parsed.map((episode) => JSON.stringify(episode)).join("\n")}\n`, "utf8");
      const lines = knownLines + parsed.length;
      if (lines > this.maxEpisodes) {
        await this.compact(lines - this.maxEpisodes);
        this.cachedLines = this.maxEpisodes;
      } else {
        this.cachedLines = lines;
      }
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
    await writeFileAtomic(this.filePath, kept.length > 0 ? `${kept}\n` : "");
  }

  /**
   * Clean up resources and ensure all buffered data is written.
   */
  async close(): Promise<void> {
    await this.flush();
    if (this.flushTimeout !== null) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
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
    // Reading the file is the one moment the true size is known for free, so refresh the counter here.
    this.cachedLines = lines.length;
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
