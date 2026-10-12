export type LargeHouseConceptId = "A" | "B" | "C";

export interface HouseBlueprintBlock {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly state: string;
}

export interface HouseBlueprintRoom {
  readonly floor: "ground" | "upper";
  readonly name: string;
  /** Inclusive local coordinates; the plan is relative to its minimum corner. */
  readonly bounds: {
    readonly minX: number;
    readonly minZ: number;
    readonly maxX: number;
    readonly maxZ: number;
  };
}

export interface HouseBlueprintLayer {
  readonly y: number;
  readonly blockCount: number;
  readonly materials: Readonly<Record<string, number>>;
}

export interface LargeHouseBlueprint {
  readonly format: "gamemind-house-blueprint-v1";
  readonly conceptId: LargeHouseConceptId;
  readonly name: string;
  readonly style: string;
  readonly dimensions: { readonly x: number; readonly y: number; readonly z: number };
  readonly floors: 2;
  /** Every coordinate is local to origin (0, 0, 0); no world position is inferred. */
  readonly origin: { readonly x: 0; readonly y: 0; readonly z: 0 };
  readonly rooms: readonly HouseBlueprintRoom[];
  readonly blocks: readonly HouseBlueprintBlock[];
  /** Aggregated by namespaced block ID. */
  readonly materials: Readonly<Record<string, number>>;
  readonly layers: readonly HouseBlueprintLayer[];
  readonly exclusions: readonly string[];
  readonly warnings: readonly string[];
}

interface Partition {
  readonly axis: "x" | "z";
  readonly coordinate: number;
  readonly start: number;
  readonly end: number;
  readonly doorway: number;
}

interface ConceptSpec {
  readonly id: LargeHouseConceptId;
  readonly name: string;
  readonly style: string;
  readonly width: number;
  readonly depth: number;
  readonly roofHeight: number;
  readonly courtyard?: { readonly minX: number; readonly minZ: number; readonly maxX: number; readonly maxZ: number };
  readonly foundation: string;
  readonly floor: string;
  readonly frame: string;
  readonly infill: string;
  readonly window: string;
  readonly roof: string;
  readonly parapet?: string;
  readonly rooms: readonly HouseBlueprintRoom[];
  readonly groundPartitions: readonly Partition[];
  readonly upperPartitions: readonly Partition[];
  readonly exclusions: readonly string[];
}

const CONCEPTS: Readonly<Record<LargeHouseConceptId, ConceptSpec>> = {
  A: {
    id: "A",
    name: "Bavarian timber farmhouse",
    style: "timber frame, pale infill, stone base, dark stepped gable roof",
    width: 17,
    depth: 23,
    roofHeight: 4,
    foundation: "minecraft:stone_bricks",
    floor: "minecraft:oak_planks",
    frame: "minecraft:stripped_oak_log[axis=y]",
    infill: "minecraft:white_concrete",
    window: "minecraft:glass_pane[east=false,north=false,south=false,waterlogged=false,west=false]",
    roof: "minecraft:spruce_planks",
    rooms: [
      { floor: "ground", name: "entry and mudroom", bounds: { minX: 1, minZ: 1, maxX: 5, maxZ: 5 } },
      { floor: "ground", name: "kitchen and dining", bounds: { minX: 6, minZ: 1, maxX: 15, maxZ: 11 } },
      { floor: "ground", name: "living room", bounds: { minX: 1, minZ: 12, maxX: 9, maxZ: 21 } },
      { floor: "ground", name: "utility and storage", bounds: { minX: 10, minZ: 14, maxX: 15, maxZ: 21 } },
      { floor: "ground", name: "hall and stair", bounds: { minX: 6, minZ: 6, maxX: 10, maxZ: 13 } },
      { floor: "upper", name: "main bedroom", bounds: { minX: 1, minZ: 1, maxX: 8, maxZ: 8 } },
      { floor: "upper", name: "bedroom two", bounds: { minX: 9, minZ: 1, maxX: 15, maxZ: 7 } },
      { floor: "upper", name: "bedroom three", bounds: { minX: 9, minZ: 8, maxX: 15, maxZ: 14 } },
      { floor: "upper", name: "bathroom and utility", bounds: { minX: 1, minZ: 9, maxX: 6, maxZ: 14 } },
      { floor: "upper", name: "landing", bounds: { minX: 7, minZ: 15, maxX: 15, maxZ: 21 } },
    ],
    groundPartitions: [
      { axis: "x", coordinate: 6, start: 1, end: 21, doorway: 8 },
      { axis: "z", coordinate: 11, start: 1, end: 15, doorway: 8 },
      { axis: "z", coordinate: 13, start: 1, end: 6, doorway: 4 },
    ],
    upperPartitions: [
      { axis: "x", coordinate: 8, start: 1, end: 21, doorway: 5 },
      { axis: "z", coordinate: 8, start: 1, end: 15, doorway: 11 },
      { axis: "z", coordinate: 14, start: 1, end: 8, doorway: 4 },
    ],
    exclusions: ["cellar", "balcony", "detached barn", "garden", "chimney", "furnishings", "landscaping"],
  },
  B: {
    id: "B",
    name: "Modern courtyard house",
    style: "clean stone-and-wood palette, broad windows, open central courtyard, flat roof",
    width: 21,
    depth: 19,
    roofHeight: 2,
    courtyard: { minX: 8, minZ: 7, maxX: 12, maxZ: 11 },
    foundation: "minecraft:smooth_stone",
    floor: "minecraft:oak_planks",
    frame: "minecraft:dark_oak_log[axis=y]",
    infill: "minecraft:stone_bricks",
    window: "minecraft:glass",
    roof: "minecraft:stone_bricks",
    parapet: "minecraft:stone_brick_wall[east=none,north=none,south=none,up=true,waterlogged=false,west=none]",
    rooms: [
      { floor: "ground", name: "entry and flexible room", bounds: { minX: 1, minZ: 1, maxX: 7, maxZ: 6 } },
      { floor: "ground", name: "kitchen, dining and living", bounds: { minX: 13, minZ: 1, maxX: 19, maxZ: 17 } },
      { floor: "ground", name: "storage and stair", bounds: { minX: 1, minZ: 12, maxX: 7, maxZ: 17 } },
      { floor: "upper", name: "bedroom one", bounds: { minX: 1, minZ: 1, maxX: 7, maxZ: 6 } },
      { floor: "upper", name: "bedroom two", bounds: { minX: 13, minZ: 1, maxX: 19, maxZ: 6 } },
      { floor: "upper", name: "bedroom three", bounds: { minX: 13, minZ: 12, maxX: 19, maxZ: 17 } },
      { floor: "upper", name: "landing and shared utility", bounds: { minX: 1, minZ: 12, maxX: 7, maxZ: 17 } },
      { floor: "upper", name: "courtyard gallery", bounds: { minX: 7, minZ: 6, maxX: 13, maxZ: 12 } },
    ],
    groundPartitions: [
      { axis: "x", coordinate: 7, start: 1, end: 17, doorway: 4 },
      { axis: "x", coordinate: 13, start: 1, end: 17, doorway: 9 },
      { axis: "z", coordinate: 6, start: 1, end: 7, doorway: 4 },
      { axis: "z", coordinate: 12, start: 13, end: 19, doorway: 16 },
    ],
    upperPartitions: [
      { axis: "x", coordinate: 7, start: 1, end: 17, doorway: 4 },
      { axis: "x", coordinate: 13, start: 1, end: 17, doorway: 9 },
      { axis: "z", coordinate: 6, start: 1, end: 7, doorway: 4 },
      { axis: "z", coordinate: 12, start: 13, end: 19, doorway: 16 },
    ],
    exclusions: ["rooftop terrace", "water feature", "garage", "pool", "furnishings", "landscaping"],
  },
  C: {
    id: "C",
    name: "Alpine lodge",
    style: "stone lower level, spruce frame, compact glass, steep stepped roof",
    width: 15,
    depth: 21,
    roofHeight: 6,
    foundation: "minecraft:stone_bricks",
    floor: "minecraft:spruce_planks",
    frame: "minecraft:spruce_log[axis=y]",
    infill: "minecraft:spruce_planks",
    window: "minecraft:glass_pane[east=false,north=false,south=false,waterlogged=false,west=false]",
    roof: "minecraft:dark_oak_planks",
    rooms: [
      { floor: "ground", name: "sheltered entry and stair", bounds: { minX: 1, minZ: 1, maxX: 4, maxZ: 6 } },
      { floor: "ground", name: "kitchen and dining", bounds: { minX: 5, minZ: 1, maxX: 13, maxZ: 9 } },
      { floor: "ground", name: "living room", bounds: { minX: 1, minZ: 10, maxX: 8, maxZ: 19 } },
      { floor: "ground", name: "storage and utility", bounds: { minX: 9, minZ: 12, maxX: 13, maxZ: 19 } },
      { floor: "upper", name: "main bedroom", bounds: { minX: 1, minZ: 1, maxX: 7, maxZ: 8 } },
      { floor: "upper", name: "bedroom two", bounds: { minX: 8, minZ: 1, maxX: 13, maxZ: 8 } },
      { floor: "upper", name: "bedroom three", bounds: { minX: 1, minZ: 9, maxX: 7, maxZ: 19 } },
      { floor: "upper", name: "landing and storage", bounds: { minX: 8, minZ: 9, maxX: 13, maxZ: 19 } },
    ],
    groundPartitions: [
      { axis: "x", coordinate: 5, start: 1, end: 19, doorway: 4 },
      { axis: "z", coordinate: 9, start: 1, end: 13, doorway: 7 },
      { axis: "z", coordinate: 11, start: 1, end: 5, doorway: 3 },
    ],
    upperPartitions: [
      { axis: "x", coordinate: 8, start: 1, end: 19, doorway: 4 },
      { axis: "z", coordinate: 8, start: 1, end: 13, doorway: 5 },
    ],
    exclusions: ["porch", "chimney", "balcony", "cellar", "workshop", "furnishings", "landscaping"],
  },
};

const BASE_Y = 0;
const UPPER_FLOOR_Y = 5;
const WALL_HEIGHT = 4;
const DOOR_STATE_LOWER = "minecraft:oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]";
const DOOR_STATE_UPPER = "minecraft:oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]";
const STAIR_STATE = "minecraft:oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]";

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function materialName(state: string): string {
  const properties = state.indexOf("[");
  return properties >= 0 ? state.slice(0, properties) : state;
}

function insideCourtyard(spec: ConceptSpec, x: number, z: number): boolean {
  const bounds = spec.courtyard;
  return bounds !== undefined && x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
}

function isInsideBounds(spec: ConceptSpec, x: number, z: number): boolean {
  return x >= 0 && x < spec.width && z >= 0 && z < spec.depth;
}

function isPerimeter(spec: ConceptSpec, x: number, z: number): boolean {
  if (!isInsideBounds(spec, x, z)) return false;
  return x === 0 || x === spec.width - 1 || z === 0 || z === spec.depth - 1;
}

function buildConcept(spec: ConceptSpec): LargeHouseBlueprint {
  const blocks = new Map<string, HouseBlueprintBlock>();
  const stairsX = spec.courtyard ? 3 : Math.max(2, Math.floor(spec.width / 2) - 1);
  const stairsStartZ = Math.max(2, Math.floor(spec.depth / 2) - 2);
  const put = (x: number, y: number, z: number, state: string): void => {
    if (!isInsideBounds(spec, x, z) || y < 0 || y > 24 || insideCourtyard(spec, x, z)) return;
    blocks.set(key(x, y, z), { x, y, z, state });
  };
  const fillFloor = (y: number): void => {
    for (let z = 0; z < spec.depth; z += 1) {
      for (let x = 0; x < spec.width; x += 1) {
        if (y === UPPER_FLOOR_Y && x === stairsX && z >= stairsStartZ && z < stairsStartZ + 4) continue;
        put(x, y, z, isPerimeter(spec, x, z) ? spec.foundation : spec.floor);
      }
    }
  };
  const putExteriorDoor = (x: number, y: number, z: number): boolean => {
    if (z !== 0 || x !== Math.floor(spec.width / 2) || y < 1 || y > 2) return false;
    put(x, y, z, y === 1 ? DOOR_STATE_LOWER : DOOR_STATE_UPPER);
    return true;
  };
  const isWindow = (x: number, z: number, wallY: number): boolean => {
    if (wallY !== 2 && wallY !== 3 && wallY !== 7 && wallY !== 8) return false;
    if ((z === 0 || z === spec.depth - 1) && [3, 4, spec.width - 5, spec.width - 4].includes(x)) return true;
    if ((x === 0 || x === spec.width - 1) && [4, 5, 10, 11, 16, 17].some((point) => point < spec.depth - 2 && z === point)) return true;
    const court = spec.courtyard;
    return court !== undefined && (wallY === 2 || wallY === 7) && (
      ((x === court.minX - 1 || x === court.maxX + 1) && z >= court.minZ && z <= court.maxZ) ||
      ((z === court.minZ - 1 || z === court.maxZ + 1) && x >= court.minX && x <= court.maxX)
    );
  };
  const buildOuterWall = (floorY: number): void => {
    for (let wallY = floorY + 1; wallY <= floorY + WALL_HEIGHT; wallY += 1) {
      for (let z = 0; z < spec.depth; z += 1) {
        for (let x = 0; x < spec.width; x += 1) {
          if (!isPerimeter(spec, x, z) || insideCourtyard(spec, x, z)) continue;
          if (floorY === BASE_Y && putExteriorDoor(x, wallY, z)) continue;
          if (isWindow(x, z, wallY)) {
            put(x, wallY, z, spec.window);
            continue;
          }
          const verticalPost = (x === 0 || x === spec.width - 1) && z % 4 === 0 ||
            (z === 0 || z === spec.depth - 1) && x % 4 === 0;
          const lowerStone = spec.id === "C" && floorY === BASE_Y && wallY <= 2;
          put(x, wallY, z, lowerStone ? "minecraft:stone_bricks" : verticalPost ? spec.frame : spec.infill);
        }
      }
    }
    if (spec.courtyard) {
      const { minX, maxX, minZ, maxZ } = spec.courtyard;
      for (let wallY = floorY + 1; wallY <= floorY + WALL_HEIGHT; wallY += 1) {
        for (let z = minZ - 1; z <= maxZ + 1; z += 1) {
          for (let x = minX - 1; x <= maxX + 1; x += 1) {
            const innerEdge = x === minX - 1 || x === maxX + 1 || z === minZ - 1 || z === maxZ + 1;
            if (!innerEdge) continue;
            // The ring faces a 5×5 open courtyard, with simple broad windows on both floors.
            const post = (x === minX - 1 || x === maxX + 1) &&
              (z === minZ - 1 || z === maxZ + 1 || (z - minZ) % 3 === 0) ||
              (z === minZ - 1 || z === maxZ + 1) &&
              (x === minX - 1 || x === maxX + 1 || (x - minX) % 3 === 0);
            put(x, wallY, z, isWindow(x, z, wallY) ? spec.window : post ? spec.frame : spec.infill);
          }
        }
      }
    }
  };
  const buildPartitions = (floorY: number, partitions: readonly Partition[]): void => {
    for (const partition of partitions) {
      for (let position = partition.start; position <= partition.end; position += 1) {
        for (let offset = 1; offset <= WALL_HEIGHT; offset += 1) {
          if (position === partition.doorway && offset <= 2) continue;
          const x = partition.axis === "x" ? partition.coordinate : position;
          const z = partition.axis === "z" ? partition.coordinate : position;
          const y = floorY + offset;
          if (blocks.has(key(x, y, z))) continue;
          put(x, y, z, spec.infill);
        }
      }
    }
  };
  const buildStairs = (): void => {
    for (let step = 0; step < 4; step += 1) {
      put(stairsX, BASE_Y + 1 + step, stairsStartZ + step, STAIR_STATE);
    }
  };
  const buildRoof = (): void => {
    if (spec.courtyard) {
      const roofY = UPPER_FLOOR_Y + WALL_HEIGHT + 1;
      for (let z = 0; z < spec.depth; z += 1) {
        for (let x = 0; x < spec.width; x += 1) {
          if (insideCourtyard(spec, x, z)) continue;
          put(x, roofY, z, spec.roof);
          const court = spec.courtyard;
          const courtyardRim = court !== undefined && (
            x === court.minX - 1 || x === court.maxX + 1 || z === court.minZ - 1 || z === court.maxZ + 1
          ) && x >= court.minX - 1 && x <= court.maxX + 1 && z >= court.minZ - 1 && z <= court.maxZ + 1;
          if (spec.parapet && (isPerimeter(spec, x, z) || courtyardRim)) put(x, roofY + 1, z, spec.parapet);
        }
      }
      return;
    }
    const roofBaseY = UPPER_FLOOR_Y + WALL_HEIGHT + 1;
    const maxRise = Math.max(1, spec.roofHeight - 1);
    const maxInset = Math.floor((spec.width - 1) / 2);
    for (let x = 0; x < spec.width; x += 1) {
      const inset = Math.min(x, spec.width - 1 - x);
      const rise = maxInset === 0 ? 0 : Math.round((inset / maxInset) * maxRise);
      const roofY = roofBaseY + rise;
      for (let z = 0; z < spec.depth; z += 1) put(x, roofY, z, spec.roof);
      for (const endZ of [0, spec.depth - 1]) {
        for (let y = roofBaseY; y < roofY; y += 1) put(x, y, endZ, spec.infill);
      }
    }
  };

  fillFloor(BASE_Y);
  buildOuterWall(BASE_Y);
  buildPartitions(BASE_Y, spec.groundPartitions);
  fillFloor(UPPER_FLOOR_Y);
  buildOuterWall(UPPER_FLOOR_Y);
  buildPartitions(UPPER_FLOOR_Y, spec.upperPartitions);
  buildStairs();
  buildRoof();

  const normalizedBlocks = [...blocks.values()].sort((left, right) =>
    left.y - right.y || left.z - right.z || left.x - right.x || left.state.localeCompare(right.state),
  );
  const materials: Record<string, number> = {};
  const layers = new Map<number, { blockCount: number; materials: Record<string, number> }>();
  for (const block of normalizedBlocks) {
    const material = materialName(block.state);
    materials[material] = (materials[material] ?? 0) + 1;
    const layer = layers.get(block.y) ?? { blockCount: 0, materials: {} };
    layer.blockCount += 1;
    layer.materials[material] = (layer.materials[material] ?? 0) + 1;
    layers.set(block.y, layer);
  }
  const roofY = UPPER_FLOOR_Y + WALL_HEIGHT + 1;
  const maxY = spec.courtyard ? roofY + (spec.parapet ? 1 : 0) : roofY + Math.max(2, spec.roofHeight) - 1;
  return {
    format: "gamemind-house-blueprint-v1",
    conceptId: spec.id,
    name: spec.name,
    style: spec.style,
    dimensions: { x: spec.width, y: maxY + 1, z: spec.depth },
    floors: 2,
    origin: { x: 0, y: 0, z: 0 },
    rooms: spec.rooms,
    blocks: normalizedBlocks,
    materials: Object.fromEntries(Object.entries(materials).sort(([left], [right]) => left.localeCompare(right))),
    layers: [...layers.entries()]
      .sort(([left], [right]) => left - right)
      .map(([y, layer]) => ({
        y,
        blockCount: layer.blockCount,
        materials: Object.fromEntries(Object.entries(layer.materials).sort(([left], [right]) => left.localeCompare(right))),
      })),
    exclusions: spec.exclusions,
    warnings: [
      "Planning-only blueprint; it does not inspect a Minecraft world, claim structural validation, or place blocks.",
      "Assumes a flat, already-cleared site. Do not terraform, demolish, or gather materials without separate approval.",
      "Review openings, stair geometry, palette availability, and the exact site/orientation before any future build workflow.",
    ],
  };
}

/** Returns one of three bounded, deterministic, planning-only house blueprints. */
export function generateLargeHouseBlueprint(conceptId: LargeHouseConceptId): LargeHouseBlueprint {
  if (!isLargeHouseConceptId(conceptId)) throw new Error("House concept must be A, B, or C.");
  return buildConcept(CONCEPTS[conceptId]);
}

export function isLargeHouseConceptId(value: string): value is LargeHouseConceptId {
  return value === "A" || value === "B" || value === "C";
}

/** Human-readable preview, including per-layer counts but not an action plan. */
export function formatLargeHouseBlueprint(blueprint: LargeHouseBlueprint): string {
  const materials = Object.entries(blueprint.materials).map(([name, count]) => `  ${name}: ${count}`);
  const rooms = blueprint.rooms.map((room) =>
    `  ${room.floor}: ${room.name} (${room.bounds.minX},${room.bounds.minZ}–${room.bounds.maxX},${room.bounds.maxZ})`,
  );
  const layers = blueprint.layers.map((layer) => `  y=${layer.y}: ${layer.blockCount} blocks`);
  return [
    `Planning-only house blueprint ${blueprint.conceptId}: ${blueprint.name}`,
    `Style: ${blueprint.style}`,
    `Relative dimensions: ${blueprint.dimensions.x}×${blueprint.dimensions.y}×${blueprint.dimensions.z}; ${blueprint.blocks.length} placed block cells; two floors.`,
    "Rooms:",
    ...rooms,
    "Material estimate (block cells):",
    ...(materials.length ? materials : ["  none"]),
    "Layer totals:",
    ...layers,
    "Not included:",
    ...blueprint.exclusions.map((item) => `  ${item}`),
    ...blueprint.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
}
