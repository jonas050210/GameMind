import type { MinecraftObservation } from "./observation.js";
import { isHazardBlockName } from "./block-classes.js";

export interface RouteAssessment {
  readonly sampledColumns: number;
  readonly obstacleColumns: number;
  readonly hazardColumns: number;
  readonly waterColumns: number;
  readonly unknownColumns: number;
  /** Relative planning cost, not a claim that Mineflayer cannot find another route. */
  readonly risk: number;
  readonly confidence: "observed" | "partial" | "unknown";
  readonly summary: string;
}

export interface TerrainSummary {
  readonly observedColumns: number;
  readonly obstacleColumns: number;
  readonly hazardColumns: number;
  readonly waterColumns: number;
  readonly unknownCells: number;
  readonly sampledCells: number;
  readonly truncated: boolean;
}

interface Column {
  readonly names: Set<string>;
  readonly bodySolids: Set<number>;
  readonly hazard: boolean;
  readonly water: boolean;
}

function key(x: number, z: number): string {
  return `${x},${z}`;
}

/**
 * Current-observation-only terrain model. It intentionally does not consume world memory: a remembered
 * tree is useful as a destination, but remembered water or a remembered free cell is not safe enough to
 * drive a route. Unknown columns stay unknown.
 */
export class LocalTerrainModel {
  private readonly columns = new Map<string, Column>();
  private readonly playerY: number;

  constructor(readonly state: MinecraftObservation) {
    this.playerY = Math.floor(state.player.position.y);
    for (const block of state.nearbyBlocks) {
      const columnKey = key(block.position.x, block.position.z);
      const previous = this.columns.get(columnKey);
      const column: Column = previous ?? {
        names: new Set<string>(),
        bodySolids: new Set<number>(),
        hazard: false,
        water: false,
      };
      column.names.add(block.name);
      const hazard = isHazardBlockName(block.name);
      // Fluids can be represented with version-dependent bounding boxes. They are route hazards, not
      // solid obstacles; counting both would exaggerate the same evidence.
      if (!hazard && block.boundingBox === "block" && block.position.y >= this.playerY && block.position.y <= this.playerY + 1) {
        column.bodySolids.add(block.position.y);
      }
      (column as { hazard: boolean }).hazard ||= hazard;
      (column as { water: boolean }).water ||= block.name === "water";
      this.columns.set(columnKey, column);
    }
  }

  summary(): TerrainSummary {
    let obstacleColumns = 0;
    let hazardColumns = 0;
    let waterColumns = 0;
    for (const column of this.columns.values()) {
      if (column.bodySolids.size > 0) obstacleColumns += 1;
      if (column.hazard) hazardColumns += 1;
      if (column.water) waterColumns += 1;
    }
    return {
      observedColumns: this.columns.size,
      obstacleColumns,
      hazardColumns,
      waterColumns,
      unknownCells: this.state.sampledRegion.unknownCells,
      sampledCells: this.state.sampledRegion.sampledCells,
      truncated: this.state.sampledRegion.truncated,
    };
  }

  /** True only for a currently observed unsafe/occupied destination column. */
  destinationUnsafe(x: number, z: number): boolean {
    const column = this.columns.get(key(Math.floor(x), Math.floor(z)));
    return column !== undefined && (column.hazard || column.bodySolids.size > 0);
  }

  /** Samples the direct horizontal corridor. Pathfinder may route around it; this is a ranking signal. */
  assessRoute(to: { readonly x: number; readonly z: number }): RouteAssessment {
    const from = this.state.player.position;
    const distance = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.max(1, Math.ceil(distance));
    const visited = new Set<string>();
    let obstacleColumns = 0;
    let hazardColumns = 0;
    let waterColumns = 0;
    let unknownColumns = 0;
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      const x = Math.floor(from.x + (to.x - from.x) * ratio);
      const z = Math.floor(from.z + (to.z - from.z) * ratio);
      const columnKey = key(x, z);
      if (visited.has(columnKey)) continue;
      visited.add(columnKey);
      const column = this.columns.get(columnKey);
      if (!column) {
        unknownColumns += 1;
        continue;
      }
      if (column.bodySolids.size > 0) obstacleColumns += 1;
      if (column.hazard) hazardColumns += 1;
      if (column.water) waterColumns += 1;
    }
    const sampledColumns = visited.size;
    const risk = hazardColumns * 24 + waterColumns * 8 + obstacleColumns * 5 + unknownColumns * 0.35;
    const confidence = unknownColumns === 0
      ? "observed"
      : unknownColumns === sampledColumns
        ? "unknown"
        : "partial";
    const parts = [
      obstacleColumns ? `${obstacleColumns} obstacle column${obstacleColumns === 1 ? "" : "s"}` : null,
      waterColumns ? `${waterColumns} water column${waterColumns === 1 ? "" : "s"}` : null,
      hazardColumns > waterColumns ? `${hazardColumns - waterColumns} other hazard column${hazardColumns - waterColumns === 1 ? "" : "s"}` : null,
      unknownColumns ? `${unknownColumns} unknown column${unknownColumns === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    return {
      sampledColumns,
      obstacleColumns,
      hazardColumns,
      waterColumns,
      unknownColumns,
      risk,
      confidence,
      summary: parts.length ? parts.join(", ") : "direct corridor observed clear",
    };
  }
}

export function buildLocalTerrainModel(state: MinecraftObservation): LocalTerrainModel {
  return new LocalTerrainModel(state);
}
