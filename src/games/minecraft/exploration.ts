import {
  coverageCellCenter,
  coverageCellOf,
  type WorldMemory,
} from "./world-memory.js";

export interface ExplorationRequest {
  /** Current player position; legs are measured from here. */
  readonly from: { readonly x: number; readonly z: number };
  /** Where the task started; the search never leaves `maxRadius` of this point. */
  readonly origin: { readonly x: number; readonly z: number };
  readonly maxRadius: number;
  readonly minLeg: number;
  readonly maxLeg: number;
  /** Waypoints this close to a recently seen hostile are rejected. */
  readonly hostileAvoidRadius: number;
  readonly excludedKeys: ReadonlySet<string>;
  /** Current-observation terrain gate. Remembered free space must never make a waypoint look safe. */
  readonly destinationUnsafe?: (x: number, z: number) => boolean;
  /** Current direct-corridor risk used only for ranking; pathfinder remains the route authority. */
  readonly routeRisk?: (x: number, z: number) => number;
}

export interface ExplorationWaypoint {
  readonly key: string;
  readonly x: number;
  readonly z: number;
  readonly distance: number;
  /** Number of unexplored neighbouring coverage cells; higher means a larger unknown area. */
  readonly novelty: number;
  readonly score: number;
}

export function explorationWaypointKey(cellX: number, cellZ: number): string {
  return `explore:${cellX},${cellZ}`;
}

function scoreWaypoints(memory: WorldMemory, request: ExplorationRequest, minLeg: number): ExplorationWaypoint | null {
  const ring = Math.ceil(request.maxLeg / 8) + 1;
  const fromCellX = coverageCellOf(request.from.x);
  const fromCellZ = coverageCellOf(request.from.z);
  const hostiles = memory.hostileSightings();
  let best: ExplorationWaypoint | null = null;

  for (let cellX = fromCellX - ring; cellX <= fromCellX + ring; cellX += 1) {
    for (let cellZ = fromCellZ - ring; cellZ <= fromCellZ + ring; cellZ += 1) {
      if (memory.isCellExplored(cellX, cellZ)) continue;
      const key = explorationWaypointKey(cellX, cellZ);
      if (request.excludedKeys.has(key)) continue;
      const center = coverageCellCenter(cellX, cellZ);
      const distance = Math.hypot(center.x - request.from.x, center.z - request.from.z);
      if (distance < minLeg || distance > request.maxLeg) continue;
      if (Math.hypot(center.x - request.origin.x, center.z - request.origin.z) > request.maxRadius) continue;
      if (request.destinationUnsafe?.(center.x, center.z)) continue;
      const nearHostile = hostiles.some(
        (hostile) => Math.hypot(center.x - hostile.position.x, center.z - hostile.position.z) <= request.hostileAvoidRadius,
      );
      if (nearHostile) continue;

      let novelty = 0;
      for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
        for (let deltaZ = -1; deltaZ <= 1; deltaZ += 1) {
          if (deltaX === 0 && deltaZ === 0) continue;
          if (!memory.isCellExplored(cellX + deltaX, cellZ + deltaZ)) novelty += 1;
        }
      }
      // Novelty dominates; current observed hazards/obstacles then distance break ties. Unknown terrain
      // remains eligible because exploration would be impossible if unknown were treated as blocked.
      const routeRisk = request.routeRisk?.(center.x, center.z) ?? 0;
      const score = novelty * 2 - distance / 8 - routeRisk;
      const candidate: ExplorationWaypoint = {
        key,
        x: Math.round(center.x),
        z: Math.round(center.z),
        distance,
        novelty,
        score,
      };
      if (
        !best ||
        candidate.score > best.score ||
        (candidate.score === best.score && candidate.key < best.key)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * Chooses the next unexplored coverage cell to visit. Returns null when the bounded search area
 * has no reachable-looking frontier left; the caller then stops exploring instead of wandering.
 */
export function chooseExplorationWaypoint(
  memory: WorldMemory,
  request: ExplorationRequest,
): ExplorationWaypoint | null {
  const preferred = scoreWaypoints(memory, request, request.minLeg);
  if (preferred || request.minLeg <= 4) return preferred;
  // Near-field frontier: allow short legs when everything beyond the preferred distance is explored.
  return scoreWaypoints(memory, request, 4);
}
