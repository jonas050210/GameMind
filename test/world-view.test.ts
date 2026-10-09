/**
 * Offline tests for the voxel world view. They load the real front-end module with a stubbed DOM and a
 * recording WebGL context, so the checks are about what the viewer actually submits to the GPU: which
 * geometry is drawn, how the camera is fitted, and what happens when there is nothing to look at.
 *
 * The motivation is a specific live failure: the world panel drew remembered blocks and live blocks
 * identically, the camera was fitted to whichever marker was furthest away, and the fog was computed from
 * a normalised depth that collapsed to "far away" for everything — which read as a broken/blank view.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface Recorded {
  readonly drawArrays: Array<{ mode: number; count: number }>;
  readonly matrices: number[][];
  readonly uniforms: Array<{ name: string; value: number }>;
  readonly viewport: number[][];
  readonly contextCalls: string[];
  positions: number[];
}

interface Viewer {
  readonly draw: (world: unknown, options?: unknown) => void;
  readonly dataset: Record<string, string>;
  readonly recorded: Recorded;
}

let moduleCounter = 0;

/** Loads a fresh copy of the viewer module (its camera and renderer state are module-level on purpose). */
async function loadViewer(options: { webgl?: boolean; width?: number; height?: number } = {}): Promise<Viewer> {
  const source = await readFile(fileURLToPath(new URL("../src/control-center/public/world-view.js", import.meta.url)), "utf8");
  const recorded: Recorded = { drawArrays: [], matrices: [], uniforms: [], viewport: [], contextCalls: [], positions: [] };
  const width = options.width ?? 720;
  const height = options.height ?? 420;
  let slot = 0;

  const makeGL = () => ({
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    DYNAMIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 9,
    LINES: 10,
    DEPTH_TEST: 11,
    LEQUAL: 12,
    CULL_FACE: 13,
    COLOR_BUFFER_BIT: 14,
    DEPTH_BUFFER_BIT: 15,
    createShader: () => ({}),
    shaderSource: () => undefined,
    compileShader: () => undefined,
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader: () => undefined,
    createProgram: () => ({}),
    attachShader: () => undefined,
    linkProgram: () => undefined,
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    getAttribLocation: (_program: unknown, name: string) => (name === "aPosition" ? 0 : 1),
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    createBuffer: () => ({}),
    enable: () => undefined,
    disable: () => undefined,
    depthFunc: () => undefined,
    clearColor: () => undefined,
    clear: () => undefined,
    viewport: (...args: number[]) => recorded.viewport.push(args),
    useProgram: () => undefined,
    bindBuffer: () => undefined,
    bufferData: (_target: unknown, data: Float32Array) => {
      // The viewer uploads positions then colours per geometry pass; keep the positions for inspection.
      if (slot % 2 === 0) recorded.positions = Array.from(data);
      slot += 1;
    },
    enableVertexAttribArray: () => undefined,
    vertexAttribPointer: () => undefined,
    uniformMatrix4fv: (_location: unknown, _transpose: unknown, matrix: Float32Array) => {
      recorded.matrices.push(Array.from(matrix));
    },
    uniform1f: (location: { name?: string }, value: number) => {
      recorded.uniforms.push({ name: String(location?.name ?? "?"), value });
    },
    drawArrays: (mode: number, _first: number, count: number) => recorded.drawArrays.push({ mode, count }),
  });

  const dataset: Record<string, string> = {};
  const canvas: Record<string, unknown> = {
    clientWidth: width,
    clientHeight: height,
    width,
    height,
    dataset,
    classList: { add: () => undefined, remove: () => undefined },
    addEventListener: () => undefined,
    setPointerCapture: () => undefined,
    getContext(kind: string) {
      recorded.contextCalls.push(kind);
      if (kind === "webgl") return options.webgl === false ? null : (makeGL() as unknown);
      // The 2D fallback needs no recording: these tests only assert that it was asked for.
      return {
        clearRect: () => undefined,
        fillRect: () => undefined,
        fillText: () => undefined,
        fillStyle: "",
        font: "",
        globalAlpha: 1,
      };
    },
  };

  const previous = {
    document: (globalThis as Record<string, unknown>).document,
    window: (globalThis as Record<string, unknown>).window,
  };
  (globalThis as Record<string, unknown>).document = { getElementById: (id: string) => (id === "minimap" ? canvas : null) };
  (globalThis as Record<string, unknown>).window = { devicePixelRatio: 1 };
  moduleCounter += 1;
  // A data: URL is cached by its text, so a per-load marker is what gives each test a fresh module.
  const url = `data:text/javascript;base64,${Buffer.from(`${source}\n// instance ${moduleCounter}\n`).toString("base64")}`;
  let mod: { drawWorldView: (world: unknown, options?: unknown) => void };
  try {
    mod = await import(url);
  } finally {
    (globalThis as Record<string, unknown>).document = previous.document;
    (globalThis as Record<string, unknown>).window = previous.window;
  }
  const viewer: Viewer = {
    dataset,
    recorded,
    draw: (world, viewerOptions) => {
      (globalThis as Record<string, unknown>).document = { getElementById: (id: string) => (id === "minimap" ? canvas : null) };
      (globalThis as Record<string, unknown>).window = { devicePixelRatio: 1 };
      try {
        mod.drawWorldView(world, viewerOptions);
      } finally {
        (globalThis as Record<string, unknown>).document = previous.document;
        (globalThis as Record<string, unknown>).window = previous.window;
      }
    },
  };
  return viewer;
}

const WORLD = {
  position: { x: 6.5, y: 65, z: 5.5 },
  blocks: [
    { x: 6, y: 64, z: 5, name: "grass_block", hazard: false, resource: false, remembered: false, source: "observation" },
    { x: 7, y: 64, z: 5, name: "oak_log", hazard: false, resource: true, remembered: false, source: "observation" },
    { x: 3, y: 63, z: 3, name: "stone", hazard: false, resource: false, remembered: false, source: "observation" },
    // A remembered log far away: it must be drawn, but it must not decide where the camera stands.
    { x: 30, y: 63, z: 0, name: "oak_log", hazard: false, resource: true, remembered: true, source: "memory" },
  ],
  entities: [{ id: "1", name: "zombie", position: { x: 9, y: 64, z: 5.5 }, distance: 2.5, hostile: true }],
};

/** Multiplies the recorded clip matrix by a point and returns normalised device coordinates. */
function project(matrix: number[], point: [number, number, number]): { x: number; y: number; z: number; w: number } {
  const at = (index: number): number => matrix[index] ?? 0;
  const out = [0, 0, 0, 0];
  for (let row = 0; row < 4; row += 1) {
    out[row] = at(row) * point[0] + at(4 + row) * point[1] + at(8 + row) * point[2] + at(12 + row);
  }
  const depth = out[3] ?? 0;
  const w = depth || 1e-9;
  return { x: (out[0] ?? 0) / w, y: (out[1] ?? 0) / w, z: (out[2] ?? 0) / w, w: depth };
}

test("the observed blocks are inside the frustum and spread across its depth", async () => {
  const viewer = await loadViewer();
  viewer.draw(WORLD, { stale: false, provenance: "live-observation" });
  assert.equal(viewer.recorded.matrices.length, 1, "one camera matrix is uploaded per frame");
  const matrix = viewer.recorded.matrices[0];
  assert.ok(matrix, "the matrix must be recorded");

  const centers: Array<[string, [number, number, number]]> = [
    ["grass", [6 + 0.5 - 6.5, 64 + 0.5 - 65, 5 + 0.5 - 5.5]],
    ["log", [7 + 0.5 - 6.5, 64 + 0.5 - 65, 5 + 0.5 - 5.5]],
    ["stone", [3 + 0.5 - 6.5, 63 + 0.5 - 65, 3 + 0.5 - 5.5]],
    ["player", [0, 0.88, 0]],
  ];
  for (const [label, point] of centers) {
    const clip = project(matrix, point);
    assert.ok(clip.w > 0 && clip.w < 40, `${label} sits at a readable distance, got w=${clip.w.toFixed(2)}`);
    assert.ok(Math.abs(clip.x) <= 1 && Math.abs(clip.y) <= 1, `${label} is on screen, got ndc ${clip.x.toFixed(2)} ${clip.y.toFixed(2)}`);
    // The defect this pins: with a 0.1..180 near/far range everything landed at z≈0.998, i.e. glued to
    // the far plane and washed out by the depth-driven fog.
    assert.ok(clip.z < 0.95, `${label} must not be pinned to the far plane, got z=${clip.z.toFixed(3)}`);
    assert.ok(clip.z > -1, `${label} must be in front of the near plane`);
  }
});

test("a far remembered marker does not push the camera away from the live blocks", async () => {
  const withMemory = await loadViewer();
  withMemory.draw(WORLD, { stale: false, provenance: "live-observation" });
  const withoutMemory = await loadViewer();
  withoutMemory.draw({ ...WORLD, blocks: WORLD.blocks.filter((block) => !block.remembered) }, { stale: false, provenance: "live-observation" });

  const distanceOf = (recorded: Recorded): number => {
    const matrix = recorded.matrices[0];
    assert.ok(matrix);
    // w of the player's own position is the camera distance for a target-centred orbit camera.
    return project(matrix, [0, 0.88, 0]).w;
  };
  const withDistance = distanceOf(withMemory.recorded);
  const plainDistance = distanceOf(withoutMemory.recorded);
  assert.ok(Math.abs(withDistance - plainDistance) < 0.01, `framing must follow the live blocks: ${withDistance.toFixed(2)} vs ${plainDistance.toFixed(2)}`);
  assert.ok(withDistance < 30, `the view stays close to the player, got ${withDistance.toFixed(2)}`);
});

test("fog is driven by view distance, with the range the camera actually uses", async () => {
  const viewer = await loadViewer();
  viewer.draw(WORLD, { stale: false, provenance: "live-observation" });
  const near = viewer.recorded.uniforms.find((entry) => entry.name === "uFogNear");
  const far = viewer.recorded.uniforms.find((entry) => entry.name === "uFogFar");
  assert.ok(near !== undefined && far !== undefined, "the fog range is uploaded every frame");
  assert.ok(far.value > near.value, `fog far must exceed fog near (${near.value} / ${far.value})`);
  assert.ok(near.value > 0, "fog must not start behind the camera");
});

test("live blocks are solid and remembered blocks are wireframes only", async () => {
  const viewer = await loadViewer();
  viewer.draw(WORLD, { stale: false, provenance: "live-observation" });
  const triangles = viewer.recorded.drawArrays.filter((entry) => entry.mode === 9);
  const lines = viewer.recorded.drawArrays.filter((entry) => entry.mode === 10);
  assert.equal(triangles.length, 1, "one solid pass per frame");
  assert.equal(lines.length, 1, "one wireframe pass for the memory markers");
  // 3 live blocks + the player + 1 hostile = 5 cubes of 36 vertices, and the far marker is 24 line vertices.
  assert.equal(triangles[0]?.count, 5 * 36);
  assert.equal(lines[0]?.count, 24);
});

test("an empty world draws only the player, and says so on the canvas", async () => {
  const viewer = await loadViewer();
  viewer.draw({ position: { x: 0, y: 0, z: 0 }, blocks: [], entities: [] }, { stale: true, provenance: "world-memory" });
  assert.equal(viewer.dataset.live, "0", "a stale frame is marked for the CSS overlay");
  const triangles = viewer.recorded.drawArrays.filter((entry) => entry.mode === 9);
  assert.equal(triangles[0]?.count, 36, "only the player marker is drawn");
  assert.ok(!viewer.recorded.drawArrays.some((entry) => entry.mode === 10), "no memory markers exist to draw");
});

test("a hidden canvas is skipped instead of producing a NaN camera", async () => {
  const viewer = await loadViewer({ width: 0, height: 0 });
  viewer.draw(WORLD, { stale: false, provenance: "live-observation" });
  assert.deepEqual(viewer.recorded.drawArrays, [], "nothing is submitted while the panel has no size");
  assert.deepEqual(viewer.recorded.matrices, []);
});

test("WebGL is asked for once, not on every frame, when it is unavailable", async () => {
  const viewer = await loadViewer({ webgl: false });
  viewer.draw(WORLD, { stale: false, provenance: "live-observation" });
  viewer.draw(WORLD, { stale: false, provenance: "live-observation" });
  viewer.draw(WORLD, { stale: true, provenance: "world-memory" });
  assert.equal(
    viewer.recorded.contextCalls.filter((kind) => kind === "webgl").length,
    1,
    "a machine without a usable context must not rebuild a broken one every frame",
  );
  assert.equal(viewer.dataset.renderer, "fallback", "the panel records that the 2D view is in use");
  assert.ok(viewer.recorded.contextCalls.includes("2d"), "the fallback still paints the observed blocks");
});
