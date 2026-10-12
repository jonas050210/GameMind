import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import nbt from "prismarine-nbt";

export interface LitematicBlockState {
  readonly name: string;
  readonly properties: Readonly<Record<string, string>>;
  readonly key: string;
}

export interface LitematicBlock {
  /** Zero-based offset from the minimum corner of the complete schematic. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly state: LitematicBlockState;
}

export interface LitematicRegionSummary {
  readonly name: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  /** Signed source dimensions; a negative axis is normalized in the block offsets. */
  readonly size: { readonly x: number; readonly y: number; readonly z: number };
  readonly volume: number;
  readonly nonAirBlocks: number;
}

export interface LitematicBlueprint {
  readonly format: "litematic";
  readonly sourceName: string;
  readonly author: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly dimensions: { readonly x: number; readonly y: number; readonly z: number };
  readonly sourceBounds: {
    readonly min: { readonly x: number; readonly y: number; readonly z: number };
    readonly max: { readonly x: number; readonly y: number; readonly z: number };
  };
  readonly regions: readonly LitematicRegionSummary[];
  readonly blocks: readonly LitematicBlock[];
  /** Counts aggregate block-state variants by namespaced block identifier. */
  readonly materials: Readonly<Record<string, number>>;
  readonly ignoredEntities: number;
  readonly ignoredBlockEntities: number;
  readonly warnings: readonly string[];
}

export class LitematicImportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LitematicImportError";
  }
}

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_REGIONS = 32;
const MAX_AXIS = 256;
const MAX_TOTAL_VOLUME = 1_000_000;
const MAX_NON_AIR_BLOCKS = 100_000;
const MAX_PALETTE_ENTRIES = 65_536;

interface NbtTag {
  readonly type: string;
  readonly name?: unknown;
  readonly value: unknown;
}

type NbtCompound = Record<string, NbtTag | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compoundFields(tag: unknown, location: string): NbtCompound {
  if (!isRecord(tag) || tag.type !== "compound" || !isRecord(tag.value)) {
    throw new LitematicImportError(`Invalid Litematic NBT: expected compound at ${location}.`);
  }
  return tag.value as NbtCompound;
}

function requiredTag(compound: NbtCompound, key: string, location: string): NbtTag {
  const tag = compound[key];
  if (!tag) throw new LitematicImportError(`Invalid Litematic NBT: missing ${location}.${key}.`);
  return tag;
}

function listItems(tag: NbtTag, location: string): readonly unknown[] {
  if (tag.type !== "list" || !isRecord(tag.value)) {
    throw new LitematicImportError(`Invalid Litematic NBT: expected list at ${location}.`);
  }
  const elementType = tag.value.type;
  const values = tag.value.value;
  if (typeof elementType !== "string" || !Array.isArray(values)) {
    throw new LitematicImportError(`Invalid Litematic NBT: expected list at ${location}.`);
  }
  // prismarine-nbt represents list elements as raw payloads because their shared tag type is stored once
  // on the list itself. Re-wrap each payload so the same strict tag validators can handle list compounds.
  return values.map((value: unknown) => ({ type: elementType, value }));
}

function stringValue(tag: NbtTag, location: string): string {
  if (tag.type !== "string" || typeof tag.value !== "string") {
    throw new LitematicImportError(`Invalid Litematic NBT: expected string at ${location}.`);
  }
  return tag.value;
}

function integerValue(tag: NbtTag, location: string): number {
  if ((tag.type !== "byte" && tag.type !== "short" && tag.type !== "int") || typeof tag.value !== "number" || !Number.isSafeInteger(tag.value)) {
    throw new LitematicImportError(`Invalid Litematic NBT: expected an integer at ${location}.`);
  }
  return tag.value;
}

function optionalString(compound: NbtCompound, key: string, fallback: string): string {
  const tag = compound[key];
  return tag?.type === "string" && typeof tag.value === "string" ? tag.value : fallback;
}

function displayText(value: string, fallback: string, maxLength: number): string {
  const safe = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return safe || fallback;
}

function optionalListCount(compound: NbtCompound, key: string, location: string): number {
  const tag = compound[key];
  if (tag === undefined) return 0;
  return listItems(tag, `${location}.${key}`).length;
}

function normalizeBlockState(tag: unknown, location: string): LitematicBlockState {
  const fields = compoundFields(tag, location);
  const rawName = stringValue(requiredTag(fields, "Name", location), `${location}.Name`);
  const name = rawName.includes(":") ? rawName : `minecraft:${rawName}`;
  if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(name)) {
    throw new LitematicImportError(`Invalid Litematic NBT: invalid block identifier '${rawName}' at ${location}.`);
  }

  const propertiesTag = fields.Properties;
  const properties: Record<string, string> = {};
  if (propertiesTag !== undefined) {
    const propertiesFields = compoundFields(propertiesTag, `${location}.Properties`);
    for (const [propertyName, propertyTag] of Object.entries(propertiesFields)) {
      if (!propertyTag || propertyTag.type !== "string" || typeof propertyTag.value !== "string") {
        throw new LitematicImportError(`Invalid Litematic NBT: block property '${propertyName}' at ${location} is not a string.`);
      }
      if (!/^[a-z0-9_.-]{1,64}$/.test(propertyName) || !/^[a-z0-9_.:/-]{1,128}$/.test(propertyTag.value)) {
        throw new LitematicImportError(`Invalid Litematic NBT: unsafe block property '${propertyName}' at ${location}.`);
      }
      properties[propertyName] = propertyTag.value;
    }
  }
  const key = Object.keys(properties).sort().length === 0
    ? name
    : `${name}[${Object.keys(properties).sort().map((key) => `${key}=${properties[key]}`).join(",")}]`;
  return { name, properties, key };
}

function longArrayValue(tag: NbtTag, location: string): readonly bigint[] {
  if (tag.type !== "longArray" || !Array.isArray(tag.value)) {
    throw new LitematicImportError(`Invalid Litematic NBT: expected long array at ${location}.`);
  }
  return tag.value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new LitematicImportError(`Invalid Litematic NBT: invalid 64-bit word ${index} at ${location}.`);
    }
    const high = entry[0];
    const low = entry[1];
    if (typeof high !== "number" || typeof low !== "number" || !Number.isInteger(high) || !Number.isInteger(low)) {
      throw new LitematicImportError(`Invalid Litematic NBT: invalid 64-bit word ${index} at ${location}.`);
    }
    return BigInt.asUintN(64, (BigInt(high) << 32n) | BigInt.asUintN(32, BigInt(low)));
  });
}

function bitsPerPaletteIndex(paletteSize: number): number {
  return Math.max(2, Math.ceil(Math.log2(paletteSize)));
}

function paletteIndexAt(words: readonly bigint[], index: number, bits: number, location: string): number {
  const bitOffset = index * bits;
  const wordIndex = Math.floor(bitOffset / 64);
  const intraWordOffset = bitOffset % 64;
  const first = words[wordIndex];
  if (first === undefined) throw new LitematicImportError(`Invalid Litematic NBT: block-state data ended early at ${location}[${index}].`);
  let packed = first >> BigInt(intraWordOffset);
  if (intraWordOffset + bits > 64) {
    const second = words[wordIndex + 1];
    if (second === undefined) throw new LitematicImportError(`Invalid Litematic NBT: block-state data ended early at ${location}[${index}].`);
    packed |= second << BigInt(64 - intraWordOffset);
  }
  const mask = (1n << BigInt(bits)) - 1n;
  return Number(packed & mask);
}

function regionCoordinate(position: number, index: number, signedSize: number): number {
  return position + index + (signedSize < 0 ? signedSize + 1 : 0);
}

function isAir(state: LitematicBlockState): boolean {
  return state.name === "minecraft:air" || state.name === "minecraft:cave_air" || state.name === "minecraft:void_air";
}

function coordinateKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function readCoordinate(compound: NbtCompound, axis: "x" | "y" | "z", location: string): number {
  return integerValue(requiredTag(compound, axis, location), `${location}.${axis}`);
}

/**
 * Reads a Java Edition Litematica .litematic file into bounded, normalized blueprint data.
 * This is strictly an offline import: it never connects to Minecraft or changes a world.
 */
export async function readLitematicBlueprint(filePath: string): Promise<LitematicBlueprint> {
  const info = await stat(filePath).catch((error: unknown) => {
    throw new LitematicImportError(`Could not read Litematic file '${filePath}'.`, { cause: error });
  });
  if (!info.isFile()) throw new LitematicImportError(`Litematic path '${filePath}' is not a regular file.`);
  if (info.size <= 0 || info.size > MAX_SOURCE_BYTES) {
    throw new LitematicImportError(`Litematic file must be between 1 byte and ${MAX_SOURCE_BYTES} bytes.`);
  }

  const source = await readFile(filePath).catch((error: unknown) => {
    throw new LitematicImportError(`Could not read Litematic file '${filePath}'.`, { cause: error });
  });
  if (source.length > MAX_SOURCE_BYTES) throw new LitematicImportError(`Litematic file exceeds the ${MAX_SOURCE_BYTES}-byte import limit.`);

  let uncompressed: Buffer;
  try {
    uncompressed = source[0] === 0x1f && source[1] === 0x8b
      ? gunzipSync(source, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
      : source;
  } catch (error) {
    throw new LitematicImportError("Could not decompress the Litematic NBT data within the configured size limit.", { cause: error });
  }
  if (uncompressed.length > MAX_DECOMPRESSED_BYTES) {
    throw new LitematicImportError(`Uncompressed Litematic data exceeds the ${MAX_DECOMPRESSED_BYTES}-byte import limit.`);
  }

  let rootTag: unknown;
  try {
    const result = await nbt.parse(uncompressed, "big");
    rootTag = result.parsed;
  } catch (error) {
    throw new LitematicImportError("The file is not a readable big-endian Java Edition Litematic NBT document.", { cause: error });
  }

  const root = compoundFields(rootTag, "root");
  const metadataTag = root.Metadata;
  const metadata = metadataTag === undefined ? {} : compoundFields(metadataTag, "Metadata");
  const sourceName = displayText(optionalString(metadata, "Name", "Unnamed Litematic"), "Unnamed Litematic", 160);
  const author = displayText(optionalString(metadata, "Author", ""), "", 80);
  const regions = compoundFields(requiredTag(root, "Regions", "root"), "Regions");
  const regionEntries = Object.entries(regions).sort(([left], [right]) => left.localeCompare(right));
  if (regionEntries.length === 0) throw new LitematicImportError("The Litematic contains no regions.");
  if (regionEntries.length > MAX_REGIONS) throw new LitematicImportError(`The Litematic contains ${regionEntries.length} regions; the limit is ${MAX_REGIONS}.`);

  const summaries: LitematicRegionSummary[] = [];
  const blockByCoordinate = new Map<string, LitematicBlockState>();
  const materials: Record<string, number> = {};
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let totalVolume = 0;
  let ignoredEntities = 0;
  let ignoredBlockEntities = 0;

  for (const [regionName, rawRegion] of regionEntries) {
    if (regionName.length === 0 || regionName.length > 160 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(regionName)) {
      throw new LitematicImportError("The Litematic contains a region with an invalid name length.");
    }
    const location = `Regions.${regionName}`;
    const region = compoundFields(rawRegion, location);
    const position = compoundFields(requiredTag(region, "Position", location), `${location}.Position`);
    const size = compoundFields(requiredTag(region, "Size", location), `${location}.Size`);
    const px = readCoordinate(position, "x", `${location}.Position`);
    const py = readCoordinate(position, "y", `${location}.Position`);
    const pz = readCoordinate(position, "z", `${location}.Position`);
    const sx = readCoordinate(size, "x", `${location}.Size`);
    const sy = readCoordinate(size, "y", `${location}.Size`);
    const sz = readCoordinate(size, "z", `${location}.Size`);
    const width = Math.abs(sx);
    const height = Math.abs(sy);
    const depth = Math.abs(sz);
    if (width === 0 || height === 0 || depth === 0 || width > MAX_AXIS || height > MAX_AXIS || depth > MAX_AXIS) {
      throw new LitematicImportError(`Region '${regionName}' has a zero or oversized axis; each dimension must be from 1 through ${MAX_AXIS}.`);
    }
    const volume = width * height * depth;
    totalVolume += volume;
    if (!Number.isSafeInteger(totalVolume) || totalVolume > MAX_TOTAL_VOLUME) {
      throw new LitematicImportError(`The combined region volume exceeds the ${MAX_TOTAL_VOLUME}-cell import limit.`);
    }

    const regionMinX = px + (sx < 0 ? sx + 1 : 0);
    const regionMinY = py + (sy < 0 ? sy + 1 : 0);
    const regionMinZ = pz + (sz < 0 ? sz + 1 : 0);
    const regionMaxX = regionMinX + width - 1;
    const regionMaxY = regionMinY + height - 1;
    const regionMaxZ = regionMinZ + depth - 1;
    minX = Math.min(minX, regionMinX);
    minY = Math.min(minY, regionMinY);
    minZ = Math.min(minZ, regionMinZ);
    maxX = Math.max(maxX, regionMaxX);
    maxY = Math.max(maxY, regionMaxY);
    maxZ = Math.max(maxZ, regionMaxZ);

    const paletteItems = listItems(requiredTag(region, "BlockStatePalette", location), `${location}.BlockStatePalette`);
    if (paletteItems.length === 0 || paletteItems.length > MAX_PALETTE_ENTRIES) {
      throw new LitematicImportError(`Region '${regionName}' has an empty or oversized block-state palette.`);
    }
    const palette = paletteItems.map((entry, index) => normalizeBlockState(entry, `${location}.BlockStatePalette[${index}]`));
    const words = longArrayValue(requiredTag(region, "BlockStates", location), `${location}.BlockStates`);
    const bits = bitsPerPaletteIndex(palette.length);
    const expectedWords = Math.ceil((volume * bits) / 64);
    if (words.length !== expectedWords) {
      throw new LitematicImportError(`Region '${regionName}' has ${words.length} packed block-state words; expected ${expectedWords}.`);
    }

    let regionNonAirBlocks = 0;
    for (let index = 0; index < volume; index += 1) {
      const paletteIndex = paletteIndexAt(words, index, bits, `${location}.BlockStates`);
      const state = palette[paletteIndex];
      if (!state) throw new LitematicImportError(`Region '${regionName}' references missing palette entry ${paletteIndex}.`);
      if (isAir(state)) continue;

      const xIndex = index % width;
      const zIndex = Math.floor(index / width) % depth;
      const yIndex = Math.floor(index / (width * depth));
      const absoluteX = regionCoordinate(px, xIndex, sx);
      const absoluteY = regionCoordinate(py, yIndex, sy);
      const absoluteZ = regionCoordinate(pz, zIndex, sz);
      const key = coordinateKey(absoluteX, absoluteY, absoluteZ);
      const existing = blockByCoordinate.get(key);
      if (existing && existing.key !== state.key) {
        throw new LitematicImportError(`Regions overlap with conflicting blocks at schematic coordinate ${absoluteX}, ${absoluteY}, ${absoluteZ}.`);
      }
      regionNonAirBlocks += 1;
      if (!existing) {
        blockByCoordinate.set(key, state);
        materials[state.name] = (materials[state.name] ?? 0) + 1;
        if (blockByCoordinate.size > MAX_NON_AIR_BLOCKS) {
          throw new LitematicImportError(`The Litematic exceeds the ${MAX_NON_AIR_BLOCKS}-non-air-block import limit.`);
        }
      }
    }

    ignoredEntities += optionalListCount(region, "Entities", location);
    ignoredBlockEntities += optionalListCount(region, "TileEntities", location);
    summaries.push({
      name: regionName,
      position: { x: px, y: py, z: pz },
      size: { x: sx, y: sy, z: sz },
      volume,
      nonAirBlocks: regionNonAirBlocks,
    });
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)) {
    throw new LitematicImportError("The Litematic has no finite region bounds.");
  }
  const dimensions = { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 };
  if (dimensions.x > MAX_AXIS || dimensions.y > MAX_AXIS || dimensions.z > MAX_AXIS) {
    throw new LitematicImportError(`The combined schematic bounds exceed the ${MAX_AXIS}-block per-axis limit.`);
  }
  if (dimensions.x * dimensions.y * dimensions.z > MAX_TOTAL_VOLUME) {
    throw new LitematicImportError(`The combined schematic bounding box exceeds the ${MAX_TOTAL_VOLUME}-cell import limit.`);
  }

  const warnings: string[] = [];
  if (ignoredEntities > 0) warnings.push(`${ignoredEntities} schematic entit${ignoredEntities === 1 ? "y was" : "ies were"} not imported.`);
  if (ignoredBlockEntities > 0) warnings.push(`${ignoredBlockEntities} block-entity record(s) were not imported; inventories and block-entity data are not preserved.`);
  warnings.push("Import is a blueprint preview only. It does not inspect a Minecraft world or place blocks.");

  const normalizedBlocks = [...blockByCoordinate.entries()]
    .map(([key, state]) => {
      const [absoluteX, absoluteY, absoluteZ] = key.split(",").map(Number);
      return {
        x: (absoluteX ?? 0) - minX,
        y: (absoluteY ?? 0) - minY,
        z: (absoluteZ ?? 0) - minZ,
        state,
      };
    })
    .sort((left, right) => left.y - right.y || left.z - right.z || left.x - right.x || left.state.key.localeCompare(right.state.key));

  return {
    format: "litematic",
    sourceName,
    author,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    sourceBytes: source.length,
    dimensions: { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 },
    sourceBounds: { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } },
    regions: summaries,
    blocks: normalizedBlocks,
    materials: Object.fromEntries(Object.entries(materials).sort(([left], [right]) => left.localeCompare(right))),
    ignoredEntities,
    ignoredBlockEntities,
    warnings,
  };
}

const LAYER_PALETTE_SYMBOLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A bounded ASCII top-down view of one normalized Y layer; `.` is air and symbols map to block states. */
export function formatLitematicLayerPreview(blueprint: LitematicBlueprint, y: number): string {
  if (!Number.isInteger(y) || y < 0 || y >= blueprint.dimensions.y) {
    throw new LitematicImportError(`Layer Y must be an integer from 0 through ${blueprint.dimensions.y - 1}.`);
  }
  const blocks = blueprint.blocks.filter((block) => block.y === y);
  const stateKeys = [...new Set(blocks.map((block) => block.state.key))].sort((left, right) => left.localeCompare(right));
  const symbols = new Map(stateKeys.map((state, index) => [state, LAYER_PALETTE_SYMBOLS[index] ?? "?"] as const));
  const rows = Array.from({ length: blueprint.dimensions.z }, () => Array.from({ length: blueprint.dimensions.x }, () => "."));
  for (const block of blocks) {
    const row = rows[block.z];
    if (!row || block.x < 0 || block.x >= blueprint.dimensions.x) continue;
    row[block.x] = symbols.get(block.state.key) ?? "?";
  }
  const legend = stateKeys
    .slice(0, LAYER_PALETTE_SYMBOLS.length)
    .map((state) => `  ${symbols.get(state) ?? "?"}: ${state}`);
  const hiddenStateCount = Math.max(0, stateKeys.length - LAYER_PALETTE_SYMBOLS.length);
  return [
    `Litematic layer Y=${y} (top-down; X increases left-to-right, Z increases top-to-bottom; . = air)`,
    `X: ${Array.from({ length: blueprint.dimensions.x }, (_, x) => String(x % 10)).join("")}`,
    ...rows.map((row, z) => `Z=${String(z).padStart(3, "0")} ${row.join("")}`),
    "Legend:",
    ...(legend.length > 0 ? legend : ["  no non-air blocks on this layer"]),
    ...(hiddenStateCount > 0 ? [`  ?: ${hiddenStateCount} additional block-state variants not individually listed.`] : []),
  ].join("\n");
}

export function formatLitematicBlueprintSummary(blueprint: LitematicBlueprint): string {
  const materialLines = Object.entries(blueprint.materials)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `  ${name}: ${count}`);
  const regionLines = blueprint.regions.map((region) =>
    `  ${region.name}: ${Math.abs(region.size.x)}×${Math.abs(region.size.y)}×${Math.abs(region.size.z)} (${region.nonAirBlocks} non-air blocks)`,
  );
  const lines = [
    `Litematic plan: ${blueprint.sourceName}`,
    `Author: ${blueprint.author || "unknown"}`,
    `Dimensions: ${blueprint.dimensions.x}×${blueprint.dimensions.y}×${blueprint.dimensions.z}`,
    `Non-air blocks: ${blueprint.blocks.length}`,
    `SHA-256: ${blueprint.sourceSha256}`,
    "Regions:",
    ...regionLines,
    "Materials:",
    ...(materialLines.length > 0 ? materialLines : ["  none"]),
    ...blueprint.warnings.map((warning) => `Warning: ${warning}`),
  ];
  return lines.join("\n");
}
