import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../core/atomic-file.js";
import type { CompanionMode } from "./companion-modes.js";
import { homepointNamePattern } from "./companion-modes.js";

const locationSchema = z.object({
  x: z.number().finite(), y: z.number().finite(), z: z.number().finite(),
  dimension: z.string().min(1).nullable(),
  savedAt: z.string().datetime(),
  observationSequence: z.number().int().nonnegative(),
});
const homepointSchema = z.object({
  name: z.string().regex(homepointNamePattern),
  location: locationSchema,
});
const modeSchema = z.enum(["idle", "follow", "come", "hold", "combat", "afk", "guard", "return", "explore", "unstuck", "task"]);
const storageSchema = z.array(z.object({
  blockName: z.string(), x: z.number().int(), y: z.number().int(), z: z.number().int(),
  dimension: z.string().nullable(), lastSeenAt: z.string().datetime(), lastSeenSequence: z.number().int().nonnegative(),
})).max(256).default([]);
const lastTaskSchema = z.object({ id: z.string(), status: z.string(), at: z.string().datetime(), failureCode: z.string().nullable() }).nullable();

const snapshotSchema = z.object({
  schemaVersion: z.literal(2),
  worldKey: z.string(),
  savedAt: z.string().datetime(),
  /** Legacy-compatible alias of the `default` homepoint. */
  home: locationSchema.nullable(),
  homepoints: z.array(homepointSchema).max(64),
  guard: locationSchema.nullable(),
  hold: locationSchema.nullable(),
  preferredMode: modeSchema,
  targetPlayer: z.string().nullable(),
  storage: storageSchema,
  lastTask: lastTaskSchema,
});
const legacySnapshotSchema = z.object({
  schemaVersion: z.literal(1), worldKey: z.string(), savedAt: z.string().datetime(),
  home: locationSchema.nullable(), guard: locationSchema.nullable(), hold: locationSchema.nullable(),
  preferredMode: modeSchema, targetPlayer: z.string().nullable(), storage: storageSchema,
  lastTask: lastTaskSchema,
});

export type CompanionLocation = z.infer<typeof locationSchema>;
export type CompanionHomepoint = z.infer<typeof homepointSchema>;
export type CompanionMemorySnapshot = z.infer<typeof snapshotSchema>;

/** Small world-scoped companion journal. Dynamic entities and active actions are never persisted. */
export class CompanionMemory {
  readonly filePath: string | null;
  private state: CompanionMemorySnapshot;

  private constructor(filePath: string | null, worldKey: string) {
    this.filePath = filePath;
    this.state = {
      schemaVersion: 2,
      worldKey,
      savedAt: new Date().toISOString(),
      home: null,
      homepoints: [],
      guard: null,
      hold: null,
      preferredMode: "idle",
      targetPlayer: null,
      storage: [],
      lastTask: null,
    };
  }

  static async open(directory: string | null, worldKey: string): Promise<CompanionMemory> {
    const file = directory
      ? path.join(directory, `companion-${createHash("sha256").update(worldKey).digest("hex").slice(0, 24)}.json`)
      : null;
    const memory = new CompanionMemory(file, worldKey);
    if (!file) return memory;
    try {
      const raw: unknown = JSON.parse(await readFile(file, "utf8"));
      const current = snapshotSchema.safeParse(raw);
      if (current.success && current.data.worldKey === worldKey) {
        memory.state = current.data;
      } else {
        const legacy = legacySnapshotSchema.safeParse(raw);
        if (legacy.success && legacy.data.worldKey === worldKey) {
          const { schemaVersion: _schemaVersion, ...saved } = legacy.data;
          memory.state = {
            ...saved,
            schemaVersion: 2,
            homepoints: saved.home ? [{ name: "default", location: saved.home }] : [],
          };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return memory;
  }

  snapshot(): CompanionMemorySnapshot {
    return structuredClone(this.state);
  }

  async update(patch: Partial<Omit<CompanionMemorySnapshot, "schemaVersion" | "worldKey" | "savedAt">>): Promise<void> {
    this.state = snapshotSchema.parse({ ...this.state, ...patch, savedAt: new Date().toISOString() });
    await this.persist();
  }

  homepoint(name: string): CompanionHomepoint | null {
    return structuredClone(this.state.homepoints.find((entry) => entry.name === name) ?? null);
  }

  async createHomepoint(name: string, location: CompanionLocation): Promise<{ ok: boolean; reason: string }> {
    if (!homepointNamePattern.test(name)) return { ok: false, reason: "invalid homepoint name" };
    if (!locationSchema.safeParse(location).success) return { ok: false, reason: "invalid or non-finite homepoint coordinates" };
    if (this.state.homepoints.some((entry) => entry.name === name)) {
      return { ok: false, reason: `Homepoint '${name}' already exists; delete it explicitly before replacing it.` };
    }
    const homepoints = [...this.state.homepoints, { name, location }];
    await this.update({ homepoints, ...(name === "default" ? { home: location } : {}) });
    return { ok: true, reason: `Homepoint '${name}' saved.` };
  }

  async deleteHomepoint(name: string): Promise<boolean> {
    if (!this.state.homepoints.some((entry) => entry.name === name)) return false;
    await this.update({
      homepoints: this.state.homepoints.filter((entry) => entry.name !== name),
      ...(name === "default" ? { home: null } : {}),
    });
    return true;
  }

  async revalidateHomepoint(name: string, observedAt: string, observationSequence: number): Promise<boolean> {
    const entry = this.state.homepoints.find((point) => point.name === name);
    if (!entry) return false;
    const location = { ...entry.location, savedAt: observedAt, observationSequence };
    await this.update({
      homepoints: this.state.homepoints.map((point) => point.name === name ? { ...point, location } : point),
      ...(name === "default" ? { home: location } : {}),
    });
    return true;
  }

  async rememberMode(mode: CompanionMode, targetPlayer: string | null): Promise<void> {
    await this.update({ preferredMode: mode, targetPlayer });
  }

  async rememberStorage(entries: CompanionMemorySnapshot["storage"]): Promise<void> {
    if (!entries.length) return;
    const merged = new Map(this.state.storage.map((entry) => [`${entry.dimension}:${entry.x},${entry.y},${entry.z}`, entry]));
    let changed = false;
    for (const entry of entries) {
      const key = `${entry.dimension}:${entry.x},${entry.y},${entry.z}`;
      const previous = merged.get(key);
      if (!previous || previous.lastSeenSequence < entry.lastSeenSequence || previous.blockName !== entry.blockName) {
        merged.set(key, entry);
        changed = true;
      }
    }
    if (changed) await this.update({ storage: [...merged.values()].slice(-256) });
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    await writeFileAtomic(this.filePath, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
  }
}
