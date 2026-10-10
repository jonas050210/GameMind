/*
 * Small dependency-free WebGL voxel viewer. It renders only blocks/entities in the current observation
 * plus explicitly styled last-seen memory markers; unloaded or unobserved terrain is never synthesized.
 */
const orbit = { yaw: 0.72, pitch: 0.68, distance: 25, dragging: false, userAdjusted: false, lastX: 0, lastY: 0 };
let renderer = null;
let lastWorld = null;
let lastOptions = { stale: false, provenance: "world-memory" };
/**
 * A failed WebGL context is a property of this browser session, not of the frame, so it is tried once.
 * Retrying on every draw turned a "no GPU here" machine into a page that rebuilt a broken context dozens
 * of times a second while the agent was running.
 */
let rendererAttempted = false;
let suspended = false;

/**
 * Stops all drawing while headless training runs, and redraws the last frame when it resumes. Camera input
 * still updates the orbit state, so the view is correct the moment rendering comes back.
 */
export function setWorldViewSuspended(value) {
  const next = value === true;
  if (next === suspended) return;
  suspended = next;
  if (!suspended && lastWorld) drawWorldView(lastWorld, lastOptions);
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL could not allocate a shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createRenderer(canvas) {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: true, powerPreference: "low-power" });
  if (!gl) return null;
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
    attribute vec3 aPosition;
    attribute vec3 aColor;
    uniform mat4 uMvp;
    uniform float uFogNear;
    uniform float uFogFar;
    varying vec3 vColor;
    varying float vDepth;
    void main() {
      vec4 clip = uMvp * vec4(aPosition, 1.0);
      gl_Position = clip;
      vColor = aColor;
      // Distance along the view axis, in blocks. Normalised clip depth was used before, which collapses
      // to ~1.0 for every vertex whenever the near/far range is wide, fogging the whole scene flat.
      vDepth = clamp((clip.w - uFogNear) / max(uFogFar - uFogNear, 0.001), 0.0, 1.0);
    }
  `);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec3 vColor;
    varying float vDepth;
    void main() {
      vec3 fog = vec3(0.035, 0.055, 0.065);
      gl_FragColor = vec4(mix(vColor, fog, vDepth * 0.52), 1.0);
    }
  `);
  const program = gl.createProgram();
  if (!program) throw new Error("WebGL could not allocate a render program.");
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "unknown shader link error");
  }
  const position = gl.getAttribLocation(program, "aPosition");
  const color = gl.getAttribLocation(program, "aColor");
  const mvp = gl.getUniformLocation(program, "uMvp");
  const fogNear = gl.getUniformLocation(program, "uFogNear");
  const fogFar = gl.getUniformLocation(program, "uFogFar");
  if (position < 0 || color < 0 || !mvp || !fogNear || !fogFar) throw new Error("WebGL shader bindings are unavailable.");
  const positionBuffer = gl.createBuffer();
  const colorBuffer = gl.createBuffer();
  if (!positionBuffer || !colorBuffer) throw new Error("WebGL could not allocate geometry buffers.");
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0.035, 0.055, 0.065, 1);
  return { gl, program, position, color, mvp, fogNear, fogFar, positionBuffer, colorBuffer, canvas };
}

function setupInput(canvas) {
  canvas.addEventListener("pointerdown", (event) => {
    orbit.dragging = true;
    orbit.lastX = event.clientX;
    orbit.lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!orbit.dragging) return;
    orbit.userAdjusted = true;
    orbit.yaw += (event.clientX - orbit.lastX) * 0.008;
    orbit.pitch = Math.max(0.18, Math.min(1.42, orbit.pitch + (event.clientY - orbit.lastY) * 0.006));
    orbit.lastX = event.clientX;
    orbit.lastY = event.clientY;
    if (lastWorld) drawWorldView(lastWorld, lastOptions);
  });
  const stopDrag = () => {
    orbit.dragging = false;
    canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", stopDrag);
  canvas.addEventListener("lostpointercapture", stopDrag);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    orbit.userAdjusted = true;
    orbit.distance = Math.max(7, Math.min(100, orbit.distance * Math.exp(event.deltaY * 0.001)));
    if (lastWorld) drawWorldView(lastWorld, lastOptions);
  }, { passive: false });
  canvas.addEventListener("keydown", (event) => {
    const angle = 0.12;
    if (event.key === "ArrowLeft") orbit.yaw -= angle;
    else if (event.key === "ArrowRight") orbit.yaw += angle;
    else if (event.key === "ArrowUp") orbit.pitch = Math.min(1.42, orbit.pitch + angle);
    else if (event.key === "ArrowDown") orbit.pitch = Math.max(0.18, orbit.pitch - angle);
    else if (event.key === "+" || event.key === "=") orbit.distance = Math.max(7, orbit.distance * 0.9);
    else if (event.key === "-") orbit.distance = Math.min(100, orbit.distance * 1.1);
    else if (event.key === "Home") {
      orbit.yaw = 0.72;
      orbit.pitch = 0.68;
      orbit.userAdjusted = false;
    } else return;
    event.preventDefault();
    if (event.key !== "Home") orbit.userAdjusted = true;
    if (lastWorld) drawWorldView(lastWorld, lastOptions);
  });
}

function colorForBlock(block) {
  const name = String(block.name || "");
  if (block.hazard || /lava|magma|fire/.test(name)) return [0.95, 0.24, 0.20];
  if (block.remembered) return [0.16, 0.82, 0.92];
  if (/water|ice/.test(name)) return [0.20, 0.48, 0.86];
  if (block.resource || /_log$|_ore$|_leaves$|berry/.test(name)) return [0.20, 0.78, 0.53];
  if (/grass|moss|fern|flower|vine|sapling/.test(name)) return [0.19, 0.48, 0.32];
  if (/dirt|sand|gravel|clay|mud/.test(name)) return [0.49, 0.39, 0.27];
  if (/stone|deepslate|cobble|ore/.test(name)) return [0.37, 0.43, 0.45];
  return [0.27, 0.34, 0.36];
}

function pushVertex(positions, colors, point, color) {
  positions.push(point[0], point[1], point[2]);
  colors.push(color[0], color[1], color[2]);
}

function appendCube(positions, colors, center, size, color) {
  const x0 = center[0] - size[0] / 2;
  const x1 = center[0] + size[0] / 2;
  const y0 = center[1] - size[1] / 2;
  const y1 = center[1] + size[1] / 2;
  const z0 = center[2] - size[2] / 2;
  const z1 = center[2] + size[2] / 2;
  const faces = [
    { p: [[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]], k: 1.00 },
    { p: [[x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]], k: 0.70 },
    { p: [[x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]], k: 0.82 },
    { p: [[x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]], k: 0.63 },
    { p: [[x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0]], k: 1.22 },
    { p: [[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]], k: 0.48 },
  ];
  for (const face of faces) {
    const shade = face.k;
    const shaded = [Math.min(1, color[0] * shade), Math.min(1, color[1] * shade), Math.min(1, color[2] * shade)];
    for (const index of [0, 1, 2, 0, 2, 3]) pushVertex(positions, colors, face.p[index], shaded);
  }
}

function appendWireCube(positions, colors, center, size, color) {
  const x0 = center[0] - size[0] / 2;
  const x1 = center[0] + size[0] / 2;
  const y0 = center[1] - size[1] / 2;
  const y1 = center[1] + size[1] / 2;
  const z0 = center[2] - size[2] / 2;
  const z1 = center[2] + size[2] / 2;
  const points = [[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],[x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]];
  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  for (const [a, b] of edges) {
    pushVertex(positions, colors, points[a], color);
    pushVertex(positions, colors, points[b], color);
  }
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function lookAt(eye, center, up) {
  const z = normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
}

function multiply(a, b) {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      result[column * 4 + row] =
        a[row] * b[column * 4] +
        a[4 + row] * b[column * 4 + 1] +
        a[8 + row] * b[column * 4 + 2] +
        a[12 + row] * b[column * 4 + 3];
    }
  }
  return result;
}

function drawGeometry(target, positions, colors, mode) {
  const { gl, position, color, positionBuffer, colorBuffer } = target;
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(color);
  gl.vertexAttribPointer(color, 3, gl.FLOAT, false, 0, 0);
  gl.drawArrays(mode, 0, positions.length / 3);
}

/** Flat 2D projection used when this browser has no usable WebGL context. */
function drawFallback(canvas, world) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#091015";
  ctx.fillRect(0, 0, width, height);
  const position = world.position ?? { x: 0, y: 0, z: 0 };
  const scale = 11;
  const project = (x, y, z) => [width / 2 + (x - position.x - (z - position.z)) * scale, height * 0.62 - (x - position.x + z - position.z) * scale * 0.48 - (y - position.y) * scale];
  for (const block of world.blocks ?? []) {
    const [x, y] = project(block.x, block.y, block.z);
    ctx.fillStyle = block.hazard ? "#f45b52" : block.resource ? "#2bd694" : "#596b70";
    ctx.globalAlpha = block.remembered ? 0.35 : 0.82;
    ctx.fillRect(x, y, scale * 0.85, scale * 0.85);
  }
  const [x, y] = project(position.x, position.y, position.z);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#67e7bd";
  ctx.fillRect(x - 4, y - 10, 8, 18);
  ctx.fillStyle = "#a8bcb9";
  ctx.font = "12px sans-serif";
  ctx.fillText("3D unavailable · simplified observed-block view", 12, height - 26);
  if (lastOptions.stale) {
    ctx.fillStyle = "#e8b45c";
    ctx.fillText("no live observation · remembered blocks only", 12, height - 12);
  }
}

/**
 * Draws the observed world. `options.stale` marks the frame as showing memory rather than a current
 * observation, which the panel reflects instead of drawing remembered blocks as if they were seen now.
 */
export function drawWorldView(world, options) {
  lastWorld = world;
  if (options) lastOptions = options;
  const canvas = document.getElementById("minimap");
  if (!canvas) return;
  // Suspended (headless training): no WebGL or 2D drawing from any caller, including camera input.
  if (suspended) return;
  canvas.dataset.live = lastOptions.stale ? "0" : "1";
  if (!renderer && !rendererAttempted) {
    rendererAttempted = true;
    try {
      renderer = createRenderer(canvas);
      if (renderer) setupInput(canvas);
    } catch (error) {
      console.warn("GameMind voxel viewer failed to initialize:", error);
      renderer = null;
      canvas.dataset.renderer = "fallback";
    }
  }
  if (!renderer) {
    canvas.dataset.renderer = "fallback";
    drawFallback(canvas, world);
    return;
  }
  const target = renderer;
  const { gl } = target;
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  // A hidden or zero-sized canvas gives an aspect ratio of NaN, and every matrix built from it is then
  // NaN — which clears the screen and looks exactly like "the agent sees no blocks".
  if (canvas.clientWidth <= 0 || canvas.clientHeight <= 0) return;
  const displayWidth = Math.max(1, Math.floor(canvas.clientWidth * pixelRatio));
  const displayHeight = Math.max(1, Math.floor(canvas.clientHeight * pixelRatio));
  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(target.program);

  const player = world.position ?? { x: 0, y: 0, z: 0 };
  const blocks = world.blocks ?? [];
  // The camera frames what the agent is *looking at now*. Memory markers can sit far away from the
  // player — that is the point of them — and including them in the auto-fit pushed the camera out to the
  // clamp, which is what made the live blocks render as a dot at the far plane.
  const liveBlocks = blocks.filter((block) => !block.remembered);
  const fitBlocks = liveBlocks.length ? liveBlocks : blocks;
  let extent = 6;
  if (!orbit.userAdjusted && fitBlocks.length) {
    extent = fitBlocks.reduce((radius, block) => Math.max(
      radius,
      Math.hypot(block.x + 0.5 - player.x, block.z + 0.5 - player.z),
      Math.abs(block.y + 0.5 - player.y) * 1.1,
    ), 1);
    orbit.distance = Math.max(12, Math.min(90, extent * 1.35 + 8));
  }
  const horizontal = orbit.distance * Math.cos(orbit.pitch);
  const eye = [
    horizontal * Math.sin(orbit.yaw),
    orbit.distance * Math.sin(orbit.pitch),
    horizontal * Math.cos(orbit.yaw),
  ];
  const center = [0, 0.8, 0];
  const view = lookAt(eye, center, [0, 1, 0]);
  // Depth range around what is actually in the scene: a fixed 0.1..180 range spends almost all of the
  // depth buffer on empty space, so nearby geometry collides at the far plane and disappears.
  const near = Math.max(0.5, orbit.distance - extent - 6);
  const far = orbit.distance + Math.max(extent, 24) + 40;
  const projection = perspective(Math.PI / 3.2, canvas.width / canvas.height, near, far);
  gl.uniformMatrix4fv(target.mvp, false, multiply(projection, view));
  gl.uniform1f(target.fogNear, orbit.distance * 0.55);
  gl.uniform1f(target.fogFar, far * 0.9);

  const blockPositions = [];
  const blockColors = [];
  const memoryPositions = [];
  const memoryColors = [];
  for (const block of blocks) {
    const centerBlock = [block.x + 0.5 - player.x, block.y + 0.5 - player.y, block.z + 0.5 - player.z];
    // A remembered marker is a wireframe and nothing else: it was seen in an earlier observation, and
    // painting it as a solid block would show terrain the agent is not currently observing.
    if (block.remembered || block.source === "memory") appendWireCube(memoryPositions, memoryColors, centerBlock, [0.92, 0.92, 0.92], [0.10, 0.82, 0.96]);
    else appendCube(blockPositions, blockColors, centerBlock, [0.96, 0.96, 0.96], colorForBlock(block));
  }
  appendCube(blockPositions, blockColors, [0, 0.88, 0], [0.48, 1.76, 0.48], [0.24, 0.88, 0.66]);
  for (const entity of world.entities ?? []) {
    if (!entity.hostile || !entity.position) continue;
    appendCube(blockPositions, blockColors, [entity.position.x - player.x, entity.position.y - player.y + 0.58, entity.position.z - player.z], [0.62, 1.16, 0.62], [0.96, 0.26, 0.25]);
  }
  drawGeometry(target, blockPositions, blockColors, gl.TRIANGLES);
  if (memoryPositions.length) drawGeometry(target, memoryPositions, memoryColors, gl.LINES);
  canvas.dataset.renderer = "webgl";
}
