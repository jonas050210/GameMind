import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The operator's world seed, kept in `data/world-config.json`. It is entered by hand: the live session does not
 * reliably expose the seed, so nothing here is auto-detected, and nothing derived from a seed is treated as
 * observed. The file is a single small object written atomically.
 */

export const DEFAULT_WORLD_CONFIG_PATH = "data/world-config.json";

/** Java seeds are signed 64-bit integers (up to 20 characters with a sign); other text seeds are accepted too. */
const NUMERIC_SEED = /^-?\d{1,20}$/;
const MAX_TEXT_SEED_LENGTH = 64;

export class InvalidWorldSeedError extends Error {}

/** Trims and validates a seed typed by the operator. An empty value clears the seed. */
export function normalizeWorldSeed(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new InvalidWorldSeedError("A world seed must be text or a number.");
  }
  const text = String(raw).trim();
  if (text.length === 0) return null;
  if (NUMERIC_SEED.test(text)) {
    const value = BigInt(text);
    if (value < -(2n ** 63n) || value >= 2n ** 63n) {
      throw new InvalidWorldSeedError("A numeric world seed must fit in a signed 64-bit integer.");
    }
    return text;
  }
  if (text.length > MAX_TEXT_SEED_LENGTH) {
    throw new InvalidWorldSeedError(`A text world seed must be at most ${MAX_TEXT_SEED_LENGTH} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new InvalidWorldSeedError("A world seed cannot contain control characters.");
  }
  return text;
}

export class WorldSeedStore {
  private seed: string | null = null;
  private loadError: string | null = null;

  constructor(private readonly path: string = DEFAULT_WORLD_CONFIG_PATH) {
    this.load();
  }

  /** The stored seed, or null when none has been entered. */
  get value(): string | null {
    return this.seed;
  }

  /** Why the stored file could not be read, shown to the operator; null when it was read or absent. */
  get error(): string | null {
    return this.loadError;
  }

  set(raw: unknown): string | null {
    const seed = normalizeWorldSeed(raw);
    const payload = { schemaVersion: 1, seed, updatedAt: new Date().toISOString() };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
    this.seed = seed;
    this.loadError = null;
    return seed;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { seed?: unknown };
      this.seed = normalizeWorldSeed(parsed.seed ?? null);
      this.loadError = null;
    } catch (error) {
      this.seed = null;
      this.loadError = `Could not read ${this.path}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
