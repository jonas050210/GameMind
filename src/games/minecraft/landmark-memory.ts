import type { MinecraftBlockPosition, MinecraftVector } from "./observation.js";

/**
 * A persistent landmark represents a significant location the agent has discovered.
 * Unlike transient block/item sightings, landmarks survive observation gaps and influence
 * long-term planning (navigation, exploration, autonomous progression).
 *
 * Types:
 *  - village: discovered village (potential trading, food source)
 *  - shelter: built shelter or safe location
 *  - cave: discovered cave system (potential ore, danger)
 *  - resource-vein: concentrated resource deposit (ore cluster, tree grove)
 *  - danger-zone: area with persistent threats (spawner, lava, etc.)
 */

export type LandmarkType = "village" | "shelter" | "cave" | "resource-vein" | "danger-zone" | "resource-cache";

export interface Landmark {
  readonly id: string;
  readonly type: LandmarkType;
  readonly position: MinecraftBlockPosition;
  /** Short description for display and planning. */
  readonly label: string;
  /** When the landmark was first recorded (ISO timestamp). */
  readonly createdAt: string;
  /** Last observation sequence when the landmark was confirmed. */
  readonly lastConfirmedSequence: number;
  /** Optional metadata for specific landmark types. */
  readonly metadata?: {
    /** For resource-vein: what resource was found. */
    readonly resourceName?: string;
    /** For resource-vein: approximate quantity observed. */
    readonly quantity?: number;
    /** For cave: estimated depth or direction. */
    readonly depth?: string;
    /** For danger-zone: what kind of danger. */
    readonly hazardType?: string;
  };
}

/**
 * Persistent landmark storage. Landmarks are keyed by type + approximate position
 * to avoid duplicates when the same landmark is observed multiple times.
 */
export class LandmarkMemory {
  private readonly landmarks = new Map<string, Landmark>();
  private readonly positionTolerance = 16; // merge landmarks within 16 blocks

  get all(): readonly Landmark[] {
    return [...this.landmarks.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt),
    );
  }

  getByType(type: LandmarkType): readonly Landmark[] {
    return this.all.filter((l) => l.type === type);
  }

  getNearest(
    position: MinecraftVector | MinecraftBlockPosition,
    type?: LandmarkType,
    maxDistance?: number,
  ): Landmark | null {
    let best: Landmark | null = null;
    let bestDist = maxDistance ?? Infinity;

    for (const landmark of this.landmarks.values()) {
      if (type && landmark.type !== type) continue;
      const dist = this.distance(position, landmark.position);
      if (dist < bestDist) {
        bestDist = dist;
        best = landmark;
      }
    }
    return best;
  }

  /**
   * Record a landmark. If a similar landmark exists nearby (same type, within tolerance),
   * update it instead of creating a duplicate.
   */
  record(input: {
    readonly type: LandmarkType;
    readonly position: MinecraftBlockPosition;
    readonly label: string;
    readonly sequence: number;
    readonly metadata?: Exclude<Landmark["metadata"], undefined>;
  }): Landmark {
    // Check for nearby landmark of same type
    const nearby = this.findNearby(input.position, input.type);
    const resolvedMetadata: Exclude<Landmark["metadata"], undefined> | null =
      (input.metadata as Exclude<Landmark["metadata"], undefined> | undefined) ??
      (this.findNearby(input.position, input.type)?.metadata as Exclude<Landmark["metadata"], undefined> | undefined) ??
      null;

    if (nearby) {
      // Update existing landmark
      const base: Omit<Landmark, "metadata"> & { lastConfirmedSequence: number; label: string } = {
        ...nearby,
        lastConfirmedSequence: input.sequence,
        label: input.label || nearby.label,
      };
      const updated: Landmark = resolvedMetadata
        ? { ...base, metadata: resolvedMetadata }
        : { ...base };
      this.landmarks.set(nearby.id, updated);
      return updated;
    }

    // Create new landmark
    const base = {
      id: `landmark-${input.type}-${input.position.x}-${input.position.y}-${input.position.z}-${Date.now()}`,
      type: input.type as LandmarkType,
      position: input.position,
      label: input.label,
      createdAt: new Date().toISOString(),
      lastConfirmedSequence: input.sequence,
    };
    const landmark: Landmark = resolvedMetadata
      ? { ...base, metadata: resolvedMetadata }
      : { ...base };
    this.landmarks.set(landmark.id, landmark);
    return landmark;
  }

  /** Remove a landmark by ID. */
  remove(id: string): boolean {
    return this.landmarks.delete(id);
  }

  /** Count of stored landmarks. */
  get size(): number {
    return this.landmarks.size;
  }

  private findNearby(position: MinecraftBlockPosition, type: LandmarkType): Landmark | null {
    for (const landmark of this.landmarks.values()) {
      if (landmark.type !== type) continue;
      const dist = this.distance(position, landmark.position);
      if (dist <= this.positionTolerance) {
        return landmark;
      }
    }
    return null;
  }

  private distance(
    a: MinecraftVector | MinecraftBlockPosition,
    b: MinecraftBlockPosition,
  ): number {
    const dx = a.x - b.x;
    const dy = (a.y ?? b.y) - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Serialize for persistence. */
  toJSON(): { landmarks: Landmark[] } {
    return { landmarks: [...this.landmarks.values()] };
  }

  /** Restore from persistence. */
  static fromJSON(data: unknown): LandmarkMemory {
    const memory = new LandmarkMemory();
    if (typeof data === "object" && data !== null && "landmarks" in data) {
      const raw = data as { landmarks: unknown };
      if (Array.isArray(raw.landmarks)) {
        for (const entry of raw.landmarks) {
          if (typeof entry === "object" && entry !== null) {
            const lm = entry as Partial<Landmark>;
            if (
              typeof lm.id === "string" &&
              typeof lm.type === "string" &&
              typeof lm.position === "object" &&
              lm.position !== null
            ) {
              const restored: Omit<Landmark, "metadata"> = {
                id: lm.id,
                type: lm.type as LandmarkType,
                position: {
                  x: Number(lm.position.x) | 0,
                  y: Number(lm.position.y) | 0,
                  z: Number(lm.position.z) | 0,
                },
                label: typeof lm.label === "string" ? lm.label : "",
                createdAt: typeof lm.createdAt === "string" ? lm.createdAt : new Date().toISOString(),
                lastConfirmedSequence: typeof lm.lastConfirmedSequence === "number" ? lm.lastConfirmedSequence : 0,
              };
              const metadataValue = lm.metadata && typeof lm.metadata === "object" ? lm.metadata as Exclude<Landmark["metadata"], undefined> : null;
              const fullLandmark: Landmark = metadataValue
                ? { ...restored, metadata: metadataValue }
                : restored;
              memory.landmarks.set(lm.id, fullLandmark);
            }
          }
        }
      }
    }
    return memory;
  }
}
