/*
  GameMind Control Center front-end.
  No framework, no build step, and deliberately no network fetches other than to this server: the page is
  served by the same process that owns the agent, and every value on screen comes from GET /api/snapshot.
*/

const boot = (() => {
  try {
    return JSON.parse(document.getElementById("boot-data")?.textContent ?? "{}");
  } catch {
    return { token: "", banner: "", title: "GameMind" };
  }
})();

const TOKEN = typeof boot.token === "string" ? boot.token : "";
const state = { snapshot: null, stream: null, lastError: null, busy: false, pollTimer: null };

const el = (id) => document.getElementById(id);
const clear = (node) => node && node.replaceChildren();

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function metric(label, value, options = {}) {
  const box = node("div", "metric");
  if (options.tone) box.dataset.tone = options.tone;
  box.append(node("b", null, value), node("span", null, label));
  if (options.note) box.append(node("small", null, options.note));
  return box;
}

function chip(text, dataset = {}) {
  const element = node("span", "chip", text);
  for (const [key, value] of Object.entries(dataset)) element.dataset[key] = value;
  return element;
}

function num(value, digits = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
}

function pct(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

function ago(iso) {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function clock(iso) {
  const at = iso ? new Date(iso) : new Date();
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleTimeString([], { hour12: false });
}

function toast(message, tone) {
  const target = el("toast");
  if (!target) return;
  target.textContent = message;
  if (tone) target.dataset.tone = tone;
  else delete target.dataset.tone;
}

/* ------------------------------------------------------------------ rendering */

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  document.title = `${snapshot.agent.taskId ?? "GameMind"} · Control Center`;
  renderHeader(snapshot);
  renderRun(snapshot);
  renderGoal(snapshot);
  renderSafety(snapshot);
  renderLearning(snapshot);
  renderWorld(snapshot);
  renderSkills(snapshot);
  renderActions(snapshot);
}

function renderHeader(snapshot) {
  const connection = snapshot.connection ?? {};
  const pill = el("connection-pill");
  const adapter = String(connection.adapterStatus ?? "unknown");
  pill.dataset.state = adapter === "connected" ? "online" : adapter === "disconnected" ? "offline" : "degraded";
  el("connection-text").textContent =
    adapter === "connected"
      ? `${connection.gameId ?? "adapter"} · seq ${connection.sequence ?? 0}`
      : `adapter ${adapter}`;
  const agent = snapshot.agent ?? {};
  const agentPill = el("agent-pill");
  const agentState = snapshot.safety?.tripped ? "tripped" : agent.state ?? "idle";
  agentPill.dataset.state = agentState;
  el("agent-text").textContent = agentState;
  el("updated").textContent = `updated ${clock(snapshot.generatedAt)}`;
  el("subtitle").textContent = [connection.server, connection.gameVersion].filter(Boolean).join(" · ") || "Control Center";
}

function renderRun(snapshot) {
  const agent = snapshot.agent ?? {};
  const safety = snapshot.safety ?? {};
  const metrics = el("run-metrics");
  clear(metrics);
  metrics.append(
    metric("Task", agent.taskId ?? "none", { note: agent.taskKind ? String(agent.taskKind) : null }),
    metric("Actions", `${agent.actionsUsed ?? 0}${agent.maxActions ? ` / ${agent.maxActions}` : ""}`, {
      tone: agent.maxActions && agent.actionsUsed / agent.maxActions > 0.8 ? "warn" : null,
    }),
    metric("Approved", safety.actionsApproved ?? 0, { tone: "good" }),
    metric("Denied", safety.actionsDenied ?? 0, { tone: safety.actionsDenied ? "bad" : null }),
    metric("Elapsed", agent.elapsedMs != null ? `${num(agent.elapsedMs / 1000, 1)}s` : "—"),
    metric("Status", agent.status ?? (agent.taskId ? "running" : "idle"), {
      tone: agent.status === "success" ? "good" : agent.status ? "bad" : null,
    }),
  );
  const progress = el("run-progress");
  const ratio = agent.maxActions ? Math.min(1, (agent.actionsUsed ?? 0) / agent.maxActions) : 0;
  progress.style.width = `${Math.round(ratio * 100)}%`;
  el("run-hint").textContent = agent.startedAt ? `started ${ago(agent.startedAt)}` : "no run in progress";
  if (agent.failure) {
    el("run-hint").textContent = `failure: ${agent.failure.code ?? "unknown"}`;
  }
  const budget = el("budget-input");
  if (document.activeElement !== budget && agent.maxActions != null) budget.value = String(agent.maxActions);
  const combat = el("combat-toggle");
  if (snapshot.combatAllowed === null || snapshot.combatAllowed === undefined) {
    combat.closest(".switch").hidden = true;
    combat.closest(".switch").setAttribute("title", "This adapter has no runtime combat switch.");
  } else {
    combat.closest(".switch").hidden = false;
    combat.checked = snapshot.combatAllowed === true;
  }
  for (const button of document.querySelectorAll("[data-command]")) {
    if (!(button instanceof HTMLButtonElement)) continue;
    button.disabled = state.busy;
  }
  el("actions-hint").textContent = `${(snapshot.recentActions ?? []).length} kept in memory`;
}

function renderGoal(snapshot) {
  const goal = snapshot.goal;
  const host = el("goal");
  clear(host);
  const alternatives = el("alternatives");
  clear(alternatives);
  if (!goal) {
    host.append(node("p", "reason", "No decision recorded yet — the run has not asked the decision model for a goal."));
    el("alternatives-details").hidden = true;
    el("goal-hint").textContent = "";
    return;
  }
  el("goal-hint").textContent = goal.safety ? (goal.safety.allowed ? "safety: allowed" : `safety: ${goal.safety.code}`) : "safety not consulted";
  const line = node("div", "goal-line");
  line.append(
    chip(goal.bandLabel ?? `band ${goal.band}`, { band: String(goal.band ?? "") }),
    chip(goal.skillId ?? "no skill"),
  );
  if (goal.targetKey) {
    const target = chip(goal.targetKey);
    target.classList.add("mono");
    line.append(target);
  }
  if (goal.progress) {
    line.append(chip(`${goal.progress.have} / ${goal.progress.of} ${goal.progress.unit}`));
  }
  host.append(line);
  if (goal.rationale) host.append(node("p", "reason", goal.rationale));
  if (goal.safety && !goal.safety.allowed) host.append(node("p", "reason", `Safety: ${goal.safety.message || goal.safety.code}`));
  if (goal.plan?.length) {
    const list = node("ol", "plan");
    for (const step of goal.plan) list.append(node("li", null, step));
    host.append(list);
  }
  const rejected = goal.rejected ?? [];
  if (rejected.length || (goal.alternatives?.length ?? 0) > 1) {
    el("alternatives-details").hidden = false;
    for (const entry of goal.alternatives ?? []) {
      const item = node("div", "list-item");
      const chosen = entry.goalId === goal.goalId;
      item.append(node("b", null, `${entry.goalId}${entry.targetKey ? ` · ${entry.targetKey}` : ""}`), node("span", "num mono", num(entry.score, 1)));
      item.append(node("p", null, chosen ? "selected — highest score in its band" : `score ${num(entry.score, 1)}`));
      if (!chosen) item.dataset.lost = "true";
      alternatives.append(item);
    }
    for (const entry of rejected) {
      const item = node("div", "list-item");
      item.append(
        node("b", null, `${entry.goalId}${entry.targetKey ? ` · ${entry.targetKey}` : ""}`),
        chip(entry.reason ?? "rejected"),
      );
      if (entry.detail) item.append(node("p", null, entry.detail));
      item.dataset.lost = "true";
      alternatives.append(item);
    }
  } else {
    el("alternatives-details").hidden = true;
  }

  const history = el("decision-history");
  clear(history);
  const earlier = (snapshot.recentDecisions ?? []).slice(1, 8);
  if (earlier.length) {
    el("decision-history-details").hidden = false;
    const list = node("div", "list");
    for (const event of earlier) {
      const data = event.data ?? {};
      const item = node("div", "list-item");
      item.append(node("b", "mono", clock(event.timestamp)), chip(String(data.terminalStatus ?? "decided")));
      const selected = data.selected;
      const detail =
        typeof selected === "object" && selected !== null
          ? `${selected.goalId ?? "?"} · band ${selected.priorityBand ?? "?"}${data.summary ? ` — ${data.summary}` : ""}`
          : String(data.summary ?? "");
      if (detail) item.append(node("p", null, detail));
      list.append(item);
    }
    history.append(list);
  } else {
    el("decision-history-details").hidden = true;
  }
}

function renderSafety(snapshot) {
  const safety = snapshot.safety ?? {};
  const metrics = el("safety-metrics");
  clear(metrics);
  metrics.append(
    metric("Policy", safety.policyId ?? "—", { note: safety.enabled === false ? "disabled" : `max risk ${safety.maxRisk ?? "—"} · budget ${safety.maxActionsPerRun ?? "—"}` }),
    metric("Paused", safety.paused ? "yes" : "no", { tone: safety.paused ? "warn" : null, note: safety.pauseReason ?? null }),
    metric("Tripped", safety.tripped ? "yes" : "no", { tone: safety.tripped ? "bad" : null, note: safety.tripReason ?? null }),
    metric("Denied", safety.actionsDenied ?? 0, { tone: safety.actionsDenied ? "bad" : "good" }),
  );
  el("safety-hint").textContent = Object.keys(safety.deniedByCode ?? {}).length
    ? `denials: ${Object.entries(safety.deniedByCode).map(([code, count]) => `${code} ×${count}`).join(", ")}`
    : "no denials in this run";
  const body = el("verdicts").tBodies[0];
  body.replaceChildren();
  for (const verdict of safety.recentVerdicts ?? []) {
    const row = document.createElement("tr");
    row.append(node("td", "mono", verdict.capability), node("td", null, verdict.risk));
    const allowed = node("td", verdict.allowed ? "ok" : "no", verdict.allowed ? "allowed" : `denied · ${verdict.code}`);
    row.append(allowed, node("td", null, verdict.message ?? ""));
    body.append(row);
  }
  if (!body.childElementCount) body.append(emptyRow(4, "No capability has been evaluated yet."));
}

function emptyRow(span, message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = span;
  cell.textContent = message;
  cell.style.opacity = "0.6";
  row.append(cell);
  return row;
}

function renderLearning(snapshot) {
  const learning = snapshot.learning ?? {};
  const metrics = el("learning-metrics");
  clear(metrics);
  const evaluation = learning.evaluation ?? null;
  const contextCount = (learning.contexts ?? []).length;
  metrics.append(
    metric("Episodes", learning.episodes ?? 0, { note: learning.enabled ? `${learning.runs ?? 0} runs recorded` : "learner disabled" }),
    metric("Contexts", contextCount, { tone: contextCount ? "accent" : null, note: "goal · skill · target buckets" }),
    metric("Active policy", learning.activePolicy?.id ?? "baseline", { note: learning.activePolicy ? `${learning.activePolicy.contexts} weighted contexts` : "hand-tuned defaults in force" }),
    metric("Candidate", learning.candidatePolicy?.id ?? "—", { note: `${learning.candidatePolicy?.contexts ?? 0} derived contexts` }),
    metric("Blocked targets", (learning.blockedTargets ?? []).filter((entry) => entry.blocked).length, {
      tone: (learning.blockedTargets ?? []).length ? "warn" : "good",
      note: "known failures avoided in later runs",
    }),
    metric("Eval success", evaluation ? pct(evaluation.successRate) : "—", {
      tone: evaluation?.passed ? "good" : evaluation ? "bad" : null,
      note: evaluation?.reportPath
        ? `${evaluation.scenarios} scenarios · ${evaluation.runs} runs · ${evaluation.model ?? "unknown model"} · ${evaluation.seedsPerScenario ?? "?"} seeds${evaluation.generatedAt ? ` · ${ago(evaluation.generatedAt)}` : ""}`
        : "run npm run eval:offline to measure",
    }),
  );
  const unsafe = evaluation?.unsafeActions;
  if (typeof unsafe === "number") {
    metrics.append(metric("Unsafe in eval", unsafe, { tone: unsafe === 0 ? "good" : "bad", note: "from the stored offline report" }));
  }
  if (evaluation?.learning) {
    const evidence = evaluation.learning;
    metrics.append(
      metric("Wasted actions", `${evidence.baselineWastedActions} → ${evidence.candidateWastedActions}`, {
        tone: evidence.passed ? "good" : "warn",
        note: `cold vs repeat run over the same seeds; ${evidence.improved}/${evidence.scenarios} scenario(s) improved. Residual waste can be the only path to progress, so this is measured, not minimised.`,
      }),
    );
  }
  const blocked = el("blocked");
  clear(blocked);
  const entries = (learning.blockedTargets ?? []).slice(0, 6);
  if (entries.length) {
    const list = node("div", "list");
    for (const entry of entries) {
      const item = node("div", "list-item");
      item.append(node("b", "mono", entry.targetKey), chip(entry.blocked ? "blocked" : "watching"));
      item.append(node("p", null, `${entry.attempts} failed attempt(s)${entry.failureCode ? ` · last ${entry.failureCode}` : ""}`));
      list.append(item);
    }
    blocked.append(list);
  }
  const history = (learning.history ?? []).slice(-4).reverse();
  if (history.length) {
    const list = node("div", "list");
    for (const entry of history) {
      const item = node("div", "list-item");
      item.append(node("b", "mono", entry.runId), chip(entry.promoted ? "promoted" : "baseline kept"));
      item.append(node("p", null, `${entry.note ?? ""}${entry.at ? ` · ${ago(entry.at)}` : ""}`));
      list.append(item);
    }
    blocked.append(list);
  }
  el("learning-hint").textContent = learning.lastRun
    ? `last run: ${learning.lastRun.episodes} episodes, ${learning.lastRun.successes} succeeded, ${learning.lastRun.failures} failed`
    : "waiting for the first finished run";
}

function renderWorld(snapshot) {
  const world = snapshot.world ?? {};
  const vitals = el("vitals");
  clear(vitals);
  const health = typeof world.health === "number" ? world.health : null;
  const food = typeof world.food === "number" ? world.food : null;
  vitals.append(
    vital("Health", health === null ? "—" : `${num(health, 1)} / 20`, health === null ? null : Math.max(0, Math.min(1, health / 20)), health === null ? null : health < 8 ? "bad" : health < 14 ? "warn" : null),
    vital("Hunger", food === null ? "—" : `${num(food)} / 20`, food === null ? null : Math.max(0, Math.min(1, food / 20)), food === null ? null : food < 6 ? "bad" : food < 12 ? "warn" : null),
    vital("Position", world.position ? `${num(world.position.x, 0)} ${num(world.position.y, 0)} ${num(world.position.z, 0)}` : "—", null, null, "mono"),
    vital("Time", world.time ? `${num(world.time.dayTicks)} ticks${world.time.isNight ? " · night" : " · day"}` : "—", null, null),
    vital("Air", world.airTicks == null ? "—" : `${num(world.airTicks)} ticks`, null, world.airTicks != null && world.airTicks < 100 ? "bad" : null),
    vital("Mode", [world.dimension, world.gameMode].filter(Boolean).join(" · ") || "—", null, null),
    vital("On ground", world.onGround === null || world.onGround === undefined ? "—" : world.onGround ? "yes" : "no", null, world.onGround === false ? "warn" : null),
    vital("Inventory full", world.inventoryFull === null || world.inventoryFull === undefined ? "—" : world.inventoryFull ? "yes" : "no", null, world.inventoryFull ? "bad" : null),
  );
  const census = Object.values(world.knownResourceBlocks ?? {}).reduce((total, count) => total + count, 0);
  el("world-hint").textContent = `explored ${world.exploredCells ?? 0} cells · ${world.minableBlocks ?? 0} minable · ${census} resource block(s) remembered`;
  const inventory = el("inventory");
  clear(inventory);
  const items = world.inventory ?? [];
  if (!items.length) inventory.append(node("span", "item empty", "empty"));
  for (const entry of items.slice(0, 40)) {
    const item = node("span", "item");
    item.append(node("b", null, `×${entry.count}`), document.createTextNode(` ${entry.name}`));
    item.title = `slot ${entry.slot}`;
    inventory.append(item);
  }
  const equipment = el("equipment");
  clear(equipment);
  const gear = world.equipment ?? {};
  const slots = Object.entries(gear).filter(([, value]) => value);
  if (!slots.length) equipment.append(node("span", "item empty", "nothing equipped"));
  for (const [slot, name] of slots) equipment.append(node("span", "item", `${slot}: ${name}`));
  const threats = (world.entities ?? []).filter((entry) => entry.hostile);
  const hostiles = el("hostiles");
  clear(hostiles);
  if (threats.length) {
    for (const entity of threats.slice(0, 6)) hostiles.append(node("span", "item", `${entity.name} at ${num(entity.distance, 1)} m`));
  } else {
    hostiles.append(node("span", "item empty", (world.entities ?? []).length ? "no hostiles in view" : "no entities observed"));
  }
  drawMinimap(world);
}

function vital(label, value, ratio, tone, className) {
  const box = node("div", className ? `vital ${className}` : "vital");
  if (tone) box.dataset.low = tone;
  box.append(node("span", null, label), node("b", null, value));
  if (ratio !== null && ratio !== undefined) {
    const bar = node("div", "bar");
    const fill = document.createElement("i");
    fill.style.width = `${Math.round(ratio * 100)}%`;
    bar.append(fill);
    box.append(bar);
  }
  return box;
}

/**
 * Top-down plot of the blocks the world model actually holds. Coordinates are the agent's real
 * observations; nothing here is decorative — an unobserved chunk simply stays empty.
 */
function drawMinimap(world) {
  const canvas = el("minimap");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  const blocks = world.blocks ?? [];
  // Fit the observed window instead of a fixed zoom: a 7x7 scan should fill the panel, while a wide scan
  // still shows the surroundings. Clamped so a single stray block cannot zoom the map to absurdity.
  let scale = 18;
  if (blocks.length > 1) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const block of blocks) {
      minX = Math.min(minX, block.x);
      maxX = Math.max(maxX, block.x);
      minZ = Math.min(minZ, block.z);
      maxZ = Math.max(maxZ, block.z);
    }
    const spanX = Math.max(1, maxX - minX) + 3;
    const spanZ = Math.max(1, maxZ - minZ) + 3;
    scale = Math.max(4, Math.min(28, Math.floor(Math.min(width / spanX, height / spanZ))));
  }
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.fillRect(0, 0, width, height);
  const position = world.position ?? { x: 0, y: 0, z: 0 };
  const project = (x, z) => [width / 2 + (x - position.x) * scale, height / 2 + (z - position.z) * scale];
  ctx.globalAlpha = 0.25;
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  const gridStep = scale > 12 ? 2 : 10;
  for (let step = -Math.ceil(width / 2 / scale); step <= Math.ceil(width / 2 / scale); step += gridStep) {
    const [gx] = project(step, 0);
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, height);
    ctx.stroke();
    const gy = height / 2 + step * scale;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(width, gy);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const block of blocks) {
    const [x, y] = project(block.x, block.z);
    if (x < -scale || y < -scale || x > width || y > height) continue;
    const depth = block.y - position.y;
    if (depth > 3 || depth < -6) continue;
    let fill = "rgba(154,172,200,0.55)";
    if (block.hazard) fill = "rgba(255,102,116,0.95)";
    else if (block.resource) fill = "rgba(124,196,255,0.95)";
    else if (block.name === "water") fill = "rgba(84,150,255,0.7)";
    ctx.fillStyle = fill;
    ctx.globalAlpha = depth === 0 ? 1 : depth > 0 ? 0.45 : 0.65;
    const size = Math.max(3, (block.resource || block.hazard ? scale * 0.92 : scale * 0.78) - 1);
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
  }
  ctx.globalAlpha = 1;
  const [px, py] = project(position.x, position.z);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(px, py, 3.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.beginPath();
  ctx.arc(px, py, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillStyle = "rgba(230,238,255,0.62)";
  ctx.fillText(`${blocks.length} observed blocks · ${scale}px/block · y ${num(position.y, 0)}`, 8, height - 8);
}

function renderSkills(snapshot) {
  const body = el("skills").tBodies[0];
  body.replaceChildren();
  for (const entry of snapshot.skillMetrics ?? []) {
    const row = document.createElement("tr");
    row.append(
      node("td", "mono", entry.skillId),
      node("td", "num", entry.attempts),
      node("td", "num", `${entry.successes} / ${entry.attempts}`),
      node("td", "num", `${num(entry.meanDurationMs)} ms`),
    );
    body.append(row);
  }
  if (!body.childElementCount) body.append(emptyRow(4, "No skill has executed yet in this process."));
}

function renderActions(snapshot) {
  const list = el("actions");
  clear(list);
  const actions = (snapshot.recentActions ?? []).slice(0, 12);
  for (const action of actions) {
    const item = document.createElement("li");
    item.dataset.status = action.status;
    item.append(node("time", null, clock(action.at)));
    const what = node("div", "what");
    const head = node("div", null, `${action.skillId ?? action.capability ?? "action"}${action.goalId ? ` → ${action.goalId}` : ""}`);
    what.append(head);
    const badges = node("div", "goal-line");
    badges.append(chip(action.status === "succeeded" ? "succeeded" : `status ${action.status}`));
    if (action.confirmed === true) badges.append(chip(action.verification === "contradicted" ? "issued, then contradicted" : "confirmed by observation"));
    else if (action.confirmed === false) badges.append(chip("not confirmed by the adapter"));
    if (action.durationMs !== null && action.durationMs !== undefined) badges.append(chip(`${Math.round(action.durationMs)} ms`));
    what.append(badges);
    if (action.note) what.append(node("div", "why", action.note));
    item.append(what);
    list.append(item);
  }
  if (!actions.length) list.append(node("li", null, "Nothing has been executed in this process yet."));

  const failures = el("failures");
  clear(failures);
  const entries = (snapshot.recentFailures ?? []).slice(0, 8);
  for (const failure of entries) {
    const item = document.createElement("li");
    item.dataset.status = "failed";
    item.append(node("time", null, clock(failure.at)));
    const what = node("div", "what");
    what.append(node("div", null, `${failure.kind === "safety" ? "refused by safety" : failure.kind === "run" ? "run outcome" : "action problem"}: ${failure.summary}`));
    if (failure.detail) what.append(node("div", "why", failure.detail));
    item.append(what);
    failures.append(item);
  }
  if (!entries.length) failures.append(node("li", null, "No refusals, contradictions or failed runs recorded."));
  const recovery = (snapshot.recentActions ?? []).filter((action) =>
    /escape|flee|recover|rest|retreat|defend|regain/i.test(`${action.goalId ?? ""} ${action.skillId ?? ""}`),
  ).length;
  el("actions-hint").textContent = `${(snapshot.recentActions ?? []).length} action(s) kept in memory${recovery ? ` · ${recovery} recovery/defence action(s)` : ""}`;
}

function renderOffline(snapshot) {
  const banner = el("banner");
  const note = snapshot.offlineNote;
  const boot_ = typeof boot.banner === "string" && boot.banner.length ? boot.banner : null;
  const text = [note, boot_].filter(Boolean).join(" — ");
  if (text) {
    banner.hidden = false;
    banner.textContent = text;
  } else {
    banner.hidden = true;
  }
}

/* ------------------------------------------------------------------ transport */

async function loadSnapshot(force) {
  try {
    const response = await fetch(`/api/snapshot${force ? "?fresh=1" : ""}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.snapshot = await response.json();
    state.lastError = null;
    render();
    renderOffline(state.snapshot);
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    el("connection-pill").dataset.state = "offline";
    el("connection-text").textContent = `disconnected (${state.lastError})`;
  }
}

async function sendCommand(type, payload) {
  if (state.busy) return;
  state.busy = true;
  render();
  toast(`${type}: waiting for the agent…`);
  try {
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gamemind-token": TOKEN },
      body: JSON.stringify(payload === undefined ? { type } : { type, payload }),
    });
    const result = await response.json().catch(() => ({ ok: false, message: `HTTP ${response.status} with an unreadable body.` }));
    toast(`${type}: ${result.message ?? (result.ok ? "accepted" : "refused")}`, result.ok ? "good" : "bad");
    await loadSnapshot(true);
  } catch (error) {
    toast(`${type} failed: ${error instanceof Error ? error.message : String(error)}`, "bad");
  } finally {
    state.busy = false;
    render();
  }
}

function wireControls() {
  for (const button of document.querySelectorAll("button[data-command]")) {
    button.addEventListener("click", () => {
      const payload = button.dataset.payload;
      void sendCommand(button.dataset.command, payload === undefined ? undefined : payload);
    });
  }
  const combat = el("combat-toggle");
  combat.addEventListener("change", () => void sendCommand("enableCombat", { enabled: combat.checked }));
  el("budget-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = Number(el("budget-input").value);
    if (!Number.isInteger(value) || value < 1) {
      toast("setActionBudget: enter a whole number of at least 1.", "bad");
      return;
    }
    void sendCommand("setActionBudget", { maxActions: value });
  });
  const theme = el("theme-toggle");
  if (theme) {
    theme.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      theme.textContent = next === "light" ? "Light" : "Dark";
      try {
        localStorage.setItem("gamemind-theme", next);
      } catch {
        // Storage can be blocked; the choice simply reverts on the next load.
      }
    });
    try {
      const saved = localStorage.getItem("gamemind-theme");
      if (saved === "light" || saved === "dark") {
        document.documentElement.dataset.theme = saved;
        theme.textContent = saved === "light" ? "Light" : "Dark";
      }
    } catch {
      // Ignore unavailable storage.
    }
  }
}

function connect() {
  if (typeof EventSource !== "function") {
    state.pollTimer = setInterval(() => void loadSnapshot(false), 2000);
    return;
  }
  const stream = new EventSource("/api/stream");
  state.stream = stream;
  stream.addEventListener("snapshot", (event) => {
    try {
      state.snapshot = JSON.parse(event.data);
      render();
      renderOffline(state.snapshot);
    } catch {
      void loadSnapshot(true);
    }
  });
  stream.addEventListener("change", () => void loadSnapshot(true));
  // A trace event means the agent just acted: refresh shortly after, coalescing a burst of events into
  // one request so a long action chain does not turn the stream into a polling loop.
  let traceRefresh = 0;
  stream.addEventListener("trace", () => {
    if (traceRefresh) return;
    traceRefresh = setTimeout(() => {
      traceRefresh = 0;
      void loadSnapshot(false);
    }, 150);
  });
  stream.addEventListener("command", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data?.message) toast(`${data.type}: ${data.message}`, data.ok ? "good" : "bad");
    } catch {
      // The command result was already shown by the fetch response.
    }
    void loadSnapshot(true);
  });
  stream.addEventListener("closing", () => stream.close());
  stream.onerror = () => {
    el("connection-pill").dataset.state = "degraded";
    el("connection-text").textContent = "reconnecting to the agent…";
  };
}

if (typeof boot.title === "string" && boot.title.length) {
  el("title").textContent = boot.title;
}
wireControls();
connect();
void loadSnapshot(true);
// If the event stream is gone (proxy restart, closed socket) fall back to polling, so the dashboard
// keeps showing live state instead of freezing on its last frame.
setInterval(() => {
  const disconnected = !state.stream || state.stream.readyState === EventSource.CLOSED;
  if (disconnected) void loadSnapshot(false);
}, 3000);
