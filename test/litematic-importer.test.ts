import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { formatLitematicLayerPreview, LitematicImportError, readLitematicBlueprint } from "../src/games/minecraft/litematic-importer.js";

const TAG = { end: 0, byte: 1, short: 2, int: 3, long: 4, string: 8, list: 9, compound: 10, longArray: 12 } as const;

type NbtNode =
  | { readonly type: typeof TAG.byte | typeof TAG.short | typeof TAG.int; readonly name: string; readonly value: number }
  | { readonly type: typeof TAG.string; readonly name: string; readonly value: string }
  | { readonly type: typeof TAG.compound; readonly name: string; readonly value: readonly NbtNode[] }
  | { readonly type: typeof TAG.list; readonly name: string; readonly elementType: number; readonly value: readonly NbtNode[] }
  | { readonly type: typeof TAG.longArray; readonly name: string; readonly value: readonly bigint[] };

function writeString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function writePayload(node: NbtNode): Buffer {
  if (node.type === TAG.byte) {
    const value = Buffer.alloc(1);
    value.writeInt8(node.value);
    return value;
  }
  if (node.type === TAG.short) {
    const value = Buffer.alloc(2);
    value.writeInt16BE(node.value);
    return value;
  }
  if (node.type === TAG.int) {
    const value = Buffer.alloc(4);
    value.writeInt32BE(node.value);
    return value;
  }
  if (node.type === TAG.string) return writeString(node.value);
  if (node.type === TAG.compound) {
    return Buffer.concat([...node.value.map(writeNamed), Buffer.from([TAG.end])]);
  }
  if (node.type === TAG.list) {
    const header = Buffer.alloc(5);
    header.writeUInt8(node.elementType, 0);
    header.writeInt32BE(node.value.length, 1);
    return Buffer.concat([header, ...node.value.map(writePayload)]);
  }
  if (node.type === TAG.longArray) {
    const header = Buffer.alloc(4);
    header.writeInt32BE(node.value.length);
    const values = node.value.map((word) => {
      const bytes = Buffer.alloc(8);
      bytes.writeBigInt64BE(BigInt.asIntN(64, word));
      return bytes;
    });
    return Buffer.concat([header, ...values]);
  }
  throw new Error(`Unsupported fixture tag type ${node.type}`);
}

function writeNamed(node: NbtNode): Buffer {
  return Buffer.concat([Buffer.from([node.type]), writeString(node.name), writePayload(node)]);
}

function byte(name: string, value: number): NbtNode { return { type: TAG.byte, name, value }; }
function int(name: string, value: number): NbtNode { return { type: TAG.int, name, value }; }
function string(name: string, value: string): NbtNode { return { type: TAG.string, name, value }; }
function compound(name: string, value: readonly NbtNode[]): NbtNode { return { type: TAG.compound, name, value }; }
function list(name: string, elementType: number, value: readonly NbtNode[]): NbtNode { return { type: TAG.list, name, elementType, value }; }
function longArray(name: string, value: readonly bigint[]): NbtNode { return { type: TAG.longArray, name, value }; }

function paletteState(name: string, properties: readonly NbtNode[] = []): NbtNode {
  return compound("", [string("Name", name), ...(properties.length ? [compound("Properties", properties)] : [])]);
}

function packedStates(indices: readonly number[], paletteSize: number): bigint[] {
  const bits = Math.max(2, Math.ceil(Math.log2(paletteSize)));
  const words = Array.from({ length: Math.ceil(indices.length * bits / 64) }, () => 0n);
  for (const [index, paletteIndex] of indices.entries()) {
    const offset = index * bits;
    const word = Math.floor(offset / 64);
    const intra = offset % 64;
    const value = BigInt(paletteIndex);
    words[word] = (words[word] ?? 0n) | (value << BigInt(intra));
    if (intra + bits > 64) {
      words[word + 1] = (words[word + 1] ?? 0n) | (value >> BigInt(64 - intra));
    }
  }
  return words;
}

interface RegionFixture {
  readonly name: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly size: { readonly x: number; readonly y: number; readonly z: number };
  readonly palette?: readonly NbtNode[];
  readonly indices?: readonly number[];
  readonly rawWords?: readonly bigint[];
  readonly entities?: number;
  readonly tileEntities?: number;
}

function makeRegion(input: RegionFixture): NbtNode {
  const volume = Math.abs(input.size.x) * Math.abs(input.size.y) * Math.abs(input.size.z);
  const palette = input.palette ?? [paletteState("minecraft:air"), paletteState("minecraft:oak_planks")];
  const indices = input.indices ?? Array.from({ length: volume }, (_, index) => index === 0 ? 1 : 0);
  const states = input.rawWords ?? packedStates(indices, palette.length);
  const emptyCompoundList = (count: number): NbtNode => list("", TAG.compound, Array.from({ length: count }, () => compound("", [])));
  const children: NbtNode[] = [
    compound("Position", [int("x", input.position.x), int("y", input.position.y), int("z", input.position.z)]),
    compound("Size", [int("x", input.size.x), int("y", input.size.y), int("z", input.size.z)]),
    list("BlockStatePalette", TAG.compound, palette),
    longArray("BlockStates", states),
  ];
  if (input.entities !== undefined) children.push({ ...emptyCompoundList(input.entities), name: "Entities" });
  if (input.tileEntities !== undefined) children.push({ ...emptyCompoundList(input.tileEntities), name: "TileEntities" });
  return compound(input.name, children);
}

function makeLitematic(regions: readonly NbtNode[], metadata: readonly NbtNode[] = []): Buffer {
  const root = compound("", [
    compound("Metadata", metadata),
    compound("Regions", regions),
  ]);
  return writeNamed(root);
}

async function withFile(bytes: Buffer, run: (filePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-litematic-"));
  const filePath = path.join(directory, "fixture.litematic");
  try {
    await writeFile(filePath, bytes);
    await run(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("imports gzip-compressed multi-region blueprints, source hash, states, and ignored entity metadata", async () => {
  const bytes = gzipSync(makeLitematic([
    makeRegion({ name: "main", position: { x: 10, y: 64, z: -4 }, size: { x: 2, y: 1, z: 1 }, indices: [1, 0], entities: 1, tileEntities: 2 }),
    makeRegion({ name: "upper", position: { x: 10, y: 65, z: -4 }, size: { x: 1, y: 1, z: 1 }, indices: [1] }),
  ], [string("Name", "Test House"), string("Author", "Operator")]));
  await withFile(bytes, async (filePath) => {
    const blueprint = await readLitematicBlueprint(filePath);
    assert.equal(blueprint.format, "litematic");
    assert.equal(blueprint.sourceName, "Test House");
    assert.equal(blueprint.author, "Operator");
    assert.deepEqual(blueprint.dimensions, { x: 2, y: 2, z: 1 });
    assert.deepEqual(blueprint.sourceBounds, { min: { x: 10, y: 64, z: -4 }, max: { x: 11, y: 65, z: -4 } });
    assert.equal(blueprint.blocks.length, 2);
    assert.deepEqual(blueprint.materials, { "minecraft:oak_planks": 2 });
    assert.equal(blueprint.ignoredEntities, 1);
    assert.equal(blueprint.ignoredBlockEntities, 2);
    assert.ok(blueprint.warnings.some((warning) => /inventor|block-entity/i.test(warning)));
    assert.equal(blueprint.sourceSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(blueprint.sourceBytes, bytes.length);
  });
});

test("normalizes negative region dimensions from the negative-side position", async () => {
  const bytes = makeLitematic([
    makeRegion({ name: "signed", position: { x: 10, y: 64, z: 5 }, size: { x: -2, y: 1, z: -2 }, indices: [1, 0, 0, 0] }),
  ]);
  await withFile(bytes, async (filePath) => {
    const blueprint = await readLitematicBlueprint(filePath);
    assert.deepEqual(blueprint.dimensions, { x: 2, y: 1, z: 2 });
    assert.deepEqual(blueprint.sourceBounds, { min: { x: 9, y: 64, z: 4 }, max: { x: 10, y: 64, z: 5 } });
    assert.deepEqual(blueprint.blocks.map(({ x, y, z }) => ({ x, y, z })), [{ x: 0, y: 0, z: 0 }]);
  });
});

test("decodes continuous packed palette values across a 64-bit word boundary", async () => {
  const palette = ["air", "oak_planks", "stone", "glass", "spruce_planks"].map((name) => paletteState(`minecraft:${name}`));
  const indices = Array.from({ length: 22 }, () => 0);
  indices[21] = 4;
  const bytes = gzipSync(makeLitematic([
    makeRegion({ name: "packed", position: { x: 0, y: 0, z: 0 }, size: { x: 22, y: 1, z: 1 }, palette, indices }),
  ]));
  await withFile(bytes, async (filePath) => {
    const blueprint = await readLitematicBlueprint(filePath);
    assert.deepEqual(blueprint.blocks.map((block) => ({ x: block.x, name: block.state.name })), [{ x: 21, name: "minecraft:spruce_planks" }]);
    assert.deepEqual(blueprint.materials, { "minecraft:spruce_planks": 1 });
  });
});

test("identical overlap cells are deduplicated globally but counted in each region summary", async () => {
  const bytes = makeLitematic([
    makeRegion({ name: "first", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, indices: [1] }),
    makeRegion({ name: "second", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, indices: [1] }),
  ]);
  await withFile(bytes, async (filePath) => {
    const blueprint = await readLitematicBlueprint(filePath);
    assert.equal(blueprint.blocks.length, 1);
    assert.deepEqual(blueprint.materials, { "minecraft:oak_planks": 1 });
    assert.deepEqual(blueprint.regions.map((region) => region.nonAirBlocks), [1, 1]);
  });
});

test("rejects conflicting overlaps, invalid palette indexes, and region dimensions outside the import bounds", async () => {
  const overlap = makeLitematic([
    makeRegion({ name: "first", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, indices: [1] }),
    makeRegion({
      name: "second",
      position: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 },
      palette: [paletteState("minecraft:air"), paletteState("minecraft:stone")],
      indices: [1],
    }),
  ]);
  await withFile(overlap, async (filePath) => assert.rejects(readLitematicBlueprint(filePath), /overlap with conflicting blocks/));

  const invalidIndex = makeLitematic([
    makeRegion({ name: "bad-index", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, rawWords: [3n] }),
  ]);
  await withFile(invalidIndex, async (filePath) => assert.rejects(readLitematicBlueprint(filePath), /missing palette entry 3/));

  const oversized = makeLitematic([
    makeRegion({ name: "too-wide", position: { x: 0, y: 0, z: 0 }, size: { x: 257, y: 1, z: 1 }, palette: [paletteState("minecraft:air")], rawWords: [] }),
  ]);
  await withFile(oversized, async (filePath) => assert.rejects(readLitematicBlueprint(filePath), /zero or oversized axis/));
});

test("rejects malformed, empty, missing-region, and corrupt-compressed inputs with a typed error", async () => {
  await assert.rejects(readLitematicBlueprint(path.join(tmpdir(), "gamemind-no-such-litematic.litematic")), LitematicImportError);
  await withFile(Buffer.alloc(0), async (filePath) => assert.rejects(readLitematicBlueprint(filePath), LitematicImportError));
  await withFile(gzipSync(Buffer.from("not NBT")), async (filePath) => assert.rejects(readLitematicBlueprint(filePath), LitematicImportError));
  await withFile(gzipSync(makeLitematic([])), async (filePath) => assert.rejects(readLitematicBlueprint(filePath), /contains no regions/));
});

test("renders a selected normalized schematic layer as a bounded top-down map", async () => {
  const bytes = makeLitematic([
    makeRegion({ name: "main", position: { x: -10, y: 64, z: 7 }, size: { x: 3, y: 1, z: 2 }, indices: [1, 0, 1, 0, 1, 0] }),
  ]);
  await withFile(bytes, async (filePath) => {
    const blueprint = await readLitematicBlueprint(filePath);
    const preview = formatLitematicLayerPreview(blueprint, 0);
    assert.match(preview, /X: 012/);
    assert.ok(preview.includes("\nZ=000"), "preview rows are separated by real newlines");
    assert.match(preview, /Z=000 A\.A/);
    assert.match(preview, /Z=001 \.A\./);
    assert.match(preview, /A: minecraft:oak_planks/);
    assert.throws(() => formatLitematicLayerPreview(blueprint, 1), /Y must be an integer/);
  });
});

test("rejects control characters in untrusted block-state property names and values", async () => {
  const badNames = makeLitematic([
    makeRegion({
      name: "main",
      position: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 },
      palette: [paletteState("minecraft:air"), paletteState("minecraft:oak_planks", [string(`axis${String.fromCharCode(27)}`, "y")])],
      indices: [1],
    }),
  ]);
  const badValues = makeLitematic([
    makeRegion({
      name: "main",
      position: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 },
      palette: [paletteState("minecraft:air"), paletteState("minecraft:oak_planks", [string("axis", `y${String.fromCharCode(27)}[31m`)])],
      indices: [1],
    }),
  ]);
  await withFile(badNames, async (filePath) => assert.rejects(readLitematicBlueprint(filePath), /unsafe block property/));
  await withFile(badValues, async (filePath) => assert.rejects(readLitematicBlueprint(filePath), /unsafe block property/));
});

test("formats a concise offline material summary", async () => {
  const bytes = makeLitematic([
    makeRegion({ name: "main", position: { x: 0, y: 64, z: 0 }, size: { x: 1, y: 1, z: 1 }, indices: [1] }),
  ], [string("Name", "House")]);
  await withFile(bytes, async (filePath) => {
    const blueprint = await readLitematicBlueprint(filePath);
    const { formatLitematicBlueprintSummary } = await import("../src/games/minecraft/litematic-importer.js");
    const summary = formatLitematicBlueprintSummary(blueprint);
    assert.match(summary, /Litematic plan: House/);
    assert.match(summary, /Non-air blocks: 1/);
    assert.match(summary, /minecraft:oak_planks: 1/);
    assert.match(summary, /does not inspect a Minecraft world or place blocks/);
  });
});

// Keep a direct compressed-file read in the test bundle to catch accidental fixture writer truncation.
test("fixture writer produces a complete gzip stream", async () => {
  const bytes = gzipSync(makeLitematic([
    makeRegion({ name: "main", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, indices: [1] }),
  ]));
  await withFile(bytes, async (filePath) => {
    assert.deepEqual(await readFile(filePath), bytes);
    assert.equal((await readLitematicBlueprint(filePath)).blocks.length, 1);
  });
});

test("metadata printed by the offline summary cannot inject terminal control or bidi characters", async () => {
  const bytes = makeLitematic([
    makeRegion({ name: "main", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, indices: [1] }),
  ], [string("Name", "House\u001b[31m\nPlan"), string("Author", "A\u202eB")]);
  await withFile(bytes, async (filePath) => {
    const blueprint = await readLitematicBlueprint(filePath);
    assert.equal(blueprint.sourceName, "House [31m Plan");
    assert.equal(blueprint.author, "A B");
    assert.doesNotMatch(`${blueprint.sourceName}${blueprint.author}`, /[\u0000-\u001f\u007f\u202a-\u202e]/);
  });
});
