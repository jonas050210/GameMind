/*
  GameMind Control Center front-end.
  No framework, no build step, and deliberately no network fetches other than to this server: the page is
  served by the same process that owns the agent, and every value on screen comes from GET /api/snapshot.
*/

import { drawWorldView, setWorldViewSuspended } from "./world-view.js";
import {
  HEADLESS_STORAGE_KEY,
  ROADMAP_ACTIONS_WITH_NOTE,
  ROADMAP_ACTION_LABELS,
  ROADMAP_KIND_LABELS,
  ROADMAP_STATUS_LABELS,
  filterRoadmap,
  groupByCategory,
  isClosed,
  parseHeadless,
  renderingSuspended,
  roadmapActionsFor,
} from "./policy.js";

const boot = (() => {
  try {
    return JSON.parse(document.getElementById("boot-data")?.textContent ?? "{}");
  } catch {
    return { token: "", banner: "", title: "GameMind" };
  }
})();

const TOKEN = typeof boot.token === "string" ? boot.token : "";
const state = {
  snapshot: null,
  lastError: null,
  busy: false,
  pollTimer: null,
  // Headless training: on by default. It stops the browser drawing the 3D world while training runs.
  headless: parseHeadless(readStoredHeadless()),
};

function readStoredHeadless() {
  try {
    return localStorage.getItem(HEADLESS_STORAGE_KEY);
  } catch {
    return null;
  }
}

/*
  The page pulls one snapshot per tick; there is no push channel. The interval widens while the agent is
  idle and while the tab is hidden, so an operator watching a live run sees each step while an open-but-
  unwatched page costs the agent nothing.
*/
const POLL_RUNNING_MS = 1_000;
const POLL_IDLE_MS = 3_000;
const POLL_HIDDEN_MS = 15_000;

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
  renderSituationBar(snapshot);
  renderThreats(snapshot);
  renderRun(snapshot);
  renderCompanion(snapshot);
  renderGoal(snapshot);
  renderProgression(snapshot);
  renderSafety(snapshot);
  renderLearning(snapshot);
  renderWorld(snapshot);
  renderPerformance(snapshot);
  renderObjective(snapshot);
  renderWorldSeed(snapshot);
  renderTraining(snapshot);
  renderRoadmap(snapshot);
  renderSkills(snapshot);
  renderActions(snapshot);
  renderBlocker(snapshot);
}

function renderHeader(snapshot) {
  const connection = snapshot.connection ?? {};
  const pill = el("connection-pill");
  const adapter = String(connection.adapterStatus ?? "unknown");
  pill.dataset.state = adapter === "connected" ? "online" : adapter === "disconnected" ? "offline" : "degraded";
  el("connection-text").textContent =
    adapter === "connected"
      ? `${connection.gameId ?? "adapter"} · seq ${connection.sequence ?? 0}`
      : `adapter ${adapter}${connection.statusReason ? ` · ${connection.statusReason}` : ""}`;
  el("connection-text").title = [
    `adapter: ${adapter}`,
    connection.statusChangedAt ? `since ${connection.statusChangedAt}` : null,
    connection.statusReason ? `reason: ${connection.statusReason}` : "reason: none reported",
    connection.worldAvailable ? "world: live observation available" : "world: no live observation",
  ].filter(Boolean).join("\n");
  const agent = snapshot.agent ?? {};
  const agentPill = el("agent-pill");
  const agentState = snapshot.safety?.tripped ? "tripped" : agent.state ?? "idle";
  agentPill.dataset.state = agentState;
  el("agent-text").textContent = agentState;
  el("updated").textContent = connection.lastObservationAt
    ? `OBS ${ago(connection.lastObservationAt)}`
    : `UPDATED ${clock(snapshot.generatedAt)}`;
  el("subtitle").textContent = [connection.server, connection.gameVersion].filter(Boolean).join(" · ") || "Control Center";
}

function renderRun(snapshot) {
  const agent = snapshot.agent ?? {};
  const safety = snapshot.safety ?? {};
  const metrics = el("run-metrics");
  clear(metrics);
  metrics.append(
    metric("Task", agent.taskId ?? "none", { note: agent.taskKind ? String(agent.taskKind) : null }),
    metric("Actions", `${agent.actionsUsed ?? 0}`, { note: "no action cap; guarded by timeouts and stuck detection" }),
    metric("Approved", safety.actionsApproved ?? 0, { tone: "good" }),
    metric("Denied", safety.actionsDenied ?? 0, { tone: safety.actionsDenied ? "bad" : null }),
    metric("Elapsed", agent.elapsedMs != null ? `${num(agent.elapsedMs / 1000, 1)}s` : "—"),
    metric("Status", agent.status ?? (agent.taskId ? "running" : agent.state ?? "idle"), {
      tone: ["succeeded", "idle", "stopped"].includes(agent.status ?? agent.state) ? "good" : agent.status ? "bad" : null,
    }),
  );
  // The bar shows the goal's own progress when the goal reports one; it is not an action budget.
  const progress = el("run-progress");
  const goalProgress = snapshot.goal?.progress ?? null;
  const ratio = goalProgress && goalProgress.of > 0 ? Math.min(1, Math.max(0, goalProgress.have / goalProgress.of)) : 0;
  progress.style.width = `${Math.round(ratio * 100)}%`;
  progress.parentElement?.setAttribute("aria-valuemax", "100");
  progress.parentElement?.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  el("run-hint").textContent = agent.startedAt ? `started ${ago(agent.startedAt)}` : "no run in progress";
  const blocker = agent.blocker;
  if (blocker && blocker.kind !== "none") {
    el("run-hint").textContent = blocker.headline;
    el("run-hint").title = [blocker.detail, blocker.hint].filter(Boolean).join("\n\n");
  }
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
  const startButton = document.querySelector("#task-form button[type=submit]");
  if (startButton) startButton.disabled = state.busy || agent.state === "running" || agent.state === "paused" || agent.state === "tripped";
  el("actions-hint").textContent = `${(snapshot.recentActions ?? []).length} action(s) in trace window`;
}

/**
 * The one panel that answers "why is it not moving?". The classification comes from the agent (there is a
 * single classifier in the runtime) and the text is the source's own words: the panel never rewrites a
 * reason into a friendlier sentence, because the exact wording is what makes a live bug reportable.
 */
function renderBlocker(snapshot) {
  const host = el("blocker");
  if (!host) return;
  clear(host);
  const blocker = snapshot.agent?.blocker ?? null;
  const kind = blocker?.kind ?? "none";
  host.dataset.kind = kind;
  if (!blocker || kind === "none") {
    const row = node("div", "blocker-clear");
    row.append(
      chip(blocker?.label === "running" ? "acting" : "idle", { tone: "good" }),
      node("span", null, blocker?.detail ?? "Nothing is blocking the agent."),
    );
    host.append(row);
    el("blocker-note").textContent = "";
    return;
  }
  const head = node("div", "blocker-head");
  head.append(
    chip(blocker.label ?? kind, { tone: kind === "safety" ? "warn" : "bad" }),
    node("b", null, blocker.code ?? "no code"),
    node("span", "blocker-owner", `owner: ${blocker.owner ?? "unknown"} · source: ${blocker.source ?? "unknown"} · ${blocker.retryable ? "the agent can retry" : "needs an outside change"}`),
  );
  host.append(head);
  host.append(node("p", "blocker-detail", blocker.detail ?? "no reason text was reported"));
  if (blocker.hint) host.append(node("p", "blocker-hint", blocker.hint));
  if (blocker.at) host.append(node("p", "blocker-at", `recorded ${ago(blocker.at)} (${clock(blocker.at)})`));
  el("blocker-note").textContent = blocker.headline ?? "";
}

function renderSituationBar(snapshot) {
  const world = snapshot.world ?? {};
  const health = typeof world.health === "number" ? world.health : null;
  const food = typeof world.food === "number" ? world.food : null;
  const air = typeof world.airTicks === "number" ? world.airTicks : null;

  // Health
  const healthEl = el("sit-health-value");
  const healthBar = el("sit-health-bar");
  if (healthEl) {
    healthEl.textContent = health === null ? "—/20" : `${num(health, 1)}/20`;
    if (healthBar) healthBar.style.width = health === null ? "0%" : `${Math.round((health / 20) * 100)}%`;
    const healthItem = el("sit-health");
    if (healthItem) healthItem.dataset.tone = health === null ? "warn" : health < 8 ? "bad" : health < 14 ? "warn" : "good";
  }

  // Hunger
  const hungerEl = el("sit-hunger-value");
  const hungerBar = el("sit-hunger-bar");
  if (hungerEl) {
    hungerEl.textContent = food === null ? "—/20" : `${num(food)}/20`;
    if (hungerBar) hungerBar.style.width = food === null ? "0%" : `${Math.round((food / 20) * 100)}%`;
    const hungerItem = el("sit-hunger");
    if (hungerItem) hungerItem.dataset.tone = food === null ? "warn" : food < 6 ? "bad" : food < 12 ? "warn" : "good";
  }

  // Air
  const airEl = el("sit-air-value");
  const airBar = el("sit-air-bar");
  if (airEl) {
    airEl.textContent = air === null ? "—" : `${num(air)}/300`;
    if (airBar) airBar.style.width = air === null ? "0%" : `${Math.round((air / 300) * 100)}%`;
    const airItem = el("sit-air");
    if (airItem) airItem.dataset.tone = air === null ? "warn" : air < 100 ? "bad" : "good";
  }

  // Weapon
  const weaponEl = el("sit-weapon-value");
  if (weaponEl) {
    const hand = world.equipment?.hand;
    weaponEl.textContent = hand && hand !== "null" ? String(hand) : "None";
  }

  // Safety
  const safetyEl = el("sit-safety-value");
  const safetyItem = el("sit-safety");
  if (safetyEl) {
    const safety = snapshot.safety;
    if (safety?.tripped) {
      safetyEl.textContent = "Tripped";
      if (safetyItem) safetyItem.dataset.tone = "bad";
    } else if (safety?.paused) {
      safetyEl.textContent = "Paused";
      if (safetyItem) safetyItem.dataset.tone = "warn";
    } else {
      safetyEl.textContent = "OK";
      if (safetyItem) safetyItem.dataset.tone = "good";
    }
  }

  // Task
  const taskEl = el("sit-task-value");
  if (taskEl) {
    const agent = snapshot.agent ?? {};
    if (agent.autonomous) {
      taskEl.textContent = "Autonomous";
    } else if (agent.taskId) {
      taskEl.textContent = `${agent.taskKind ?? "task"} (${agent.actionsUsed ?? 0} actions)`;
    } else {
      taskEl.textContent = "None";
    }
  }

  // Threats
  const threatsEl = el("sit-threats-value");
  if (threatsEl) {
    const entities = world.entities ?? [];
    const hostiles = entities.filter((e) => e.hostile);
    threatsEl.textContent = hostiles.length === 0 ? "None" : `${hostiles.length} hostile${hostiles.length > 1 ? "s" : ""}`;
    const threatsItem = el("sit-threats");
    if (threatsItem) threatsItem.dataset.tone = hostiles.length === 0 ? "good" : hostiles.length <= 2 ? "warn" : "bad";
  }

  // Decision
  const decisionEl = el("sit-decision-value");
  if (decisionEl) {
    const goal = snapshot.goal;
    decisionEl.textContent = goal?.goalId ?? (snapshot.agent?.blocker?.kind !== "none" ? "Blocked" : "Idle");
  }
}

function renderThreats(snapshot) {
  const container = el("threat-list");
  if (!container) return;
  clear(container);
  const entities = snapshot.world?.entities ?? [];
  const hostiles = entities.filter((e) => e.hostile).sort((a, b) => a.distance - b.distance);
  if (hostiles.length === 0) {
    container.append(node("div", "threat-empty", "No hostile entities detected."));
    return;
  }
  for (const hostile of hostiles) {
    const level = hostile.distance < 6 ? "high" : hostile.distance < 12 ? "medium" : "low";
    const item = node("div", "threat-item");
    item.dataset.level = level;
    const name = node("span", "threat-name", hostile.name.replace(/_/g, " "));
    const dist = node("span", "threat-distance", `${num(hostile.distance, 1)} blocks`);
    item.append(name, dist);
    container.append(item);
  }
  const hint = el("threat-hint");
  if (hint) hint.textContent = `${hostiles.length} hostile(s) observed`;
}

function renderCompanion(snapshot) {
  const companion = snapshot.companion;
  const summary = el("companion-summary");
  const history = el("chat-history");
  if (!summary || !history) return;
  clear(summary);
  clear(history);
  el("companion-mode").textContent = companion ? `${companion.mode}${companion.executing ? " · acting" : ""}` : "not attached";
  if (!companion) {
    summary.append(node("p", "reason", "Companion coordination is unavailable in this run."));
    return;
  }
  summary.append(
    intentCell("Active mode", companion.mode, companion.reason),
    intentCell("Follow target", companion.targetPlayer ?? "none", `${companion.followState ?? "inactive"} · measured ${companion.measuredSeparation == null ? "unknown" : `${num(companion.measuredSeparation, 1)} blocks`}`),
    intentCell("Follow distances", `${num(companion.preferredFollowDistance, 0)} block preference`, `${num(companion.normalMaximumSeparation, 0)} block normal maximum target`),
    intentCell("Homepoints", `${(companion.homepoints ?? []).length} saved`, companion.activeHomepoint ? `active: ${companion.activeHomepoint}` : (companion.homepoints ?? []).map((entry) => `${entry.name} (${entry.availability})`).join(", ") || "none"),
    intentCell("Anchor & storage", companion.anchor ? `${num(companion.anchor.x, 1)}, ${num(companion.anchor.y, 1)}, ${num(companion.anchor.z, 1)}` : "no active anchor", `${(companion.knownStorage ?? []).length} storage location(s) known`),
    intentCell("Latest outcome", companion.lastOutcome ?? "none", `transition ${ago(companion.lastTransitionAt)}`),
  );
  for (const message of (companion.history ?? []).slice(0, 16).reverse()) {
    const row = node("div", `chat-message ${message.direction}`);
    const head = node("span", null, `${message.direction === "in" ? message.speaker ?? message.source : "GameMind"} · ${clock(message.at)}`);
    row.append(head, node("p", null, message.text));
    if (message.ok === false) row.dataset.tone = "bad";
    history.append(row);
  }
  if (!history.childElementCount) history.append(node("p", "reason", "No companion messages yet."));
}

function intentCell(label, value, note) {
  const cell = node("div", "intent-cell");
  cell.append(node("span", null, label), node("b", null, value));
  if (note) cell.append(node("small", null, note));
  return cell;
}

function renderGoal(snapshot) {
  const goal = snapshot.goal;
  const host = el("goal");
  clear(host);
  const intent = el("intent-summary");
  clear(intent);
  const lastConfirmed = (snapshot.recentActions ?? []).find((action) => action.verification === "verified");
  const progress = goal?.progress;
  intent.append(
    intentCell("Current goal", goal?.goalId ?? (snapshot.agent?.taskId ? "awaiting decision" : "none"), goal?.targetKey ?? null),
    intentCell("Last confirmed action", lastConfirmed?.skillId ?? lastConfirmed?.capability ?? "none recorded", lastConfirmed ? `${clock(lastConfirmed.at)} · verified` : "No verified action in the trace window"),
    intentCell("Next intended action", goal?.skillId ?? "none", goal?.plan?.[0] ?? (goal ? "No executable step selected" : "No active decision")),
    intentCell("Verified progress", progress ? `${progress.have} / ${progress.of} ${progress.unit}` : "unavailable", progress ? "Read from current game state" : "No measurable task target"),
  );
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

function renderProgression(snapshot) {
  const host = el("progression-panel");
  if (!host) return;
  clear(host);
  const progression = snapshot.progression;
  const landmarks = snapshot.landmarks;
  if (!progression && !landmarks?.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  if (progression) {
    // Current milestone header
    const header = node("div", "progression-header");
    header.append(
      node("span", "progression-label", "Active milestone"),
      node("span", "progression-name", progression.currentMilestoneName || progression.currentMilestone),
    );
    host.append(header);

    // Milestone progress list
    const list = node("div", "progression-list");
    for (const milestone of progression.milestones) {
      const item = node("div", "progression-item");
      if (milestone.completed) item.classList.add("completed");
      if (milestone.id === progression.currentMilestone) item.classList.add("current");
      item.append(
        node("span", "progression-status", milestone.completed ? "✓" : "○"),
        node("span", "progression-title", milestone.name),
        node("span", "progression-desc", milestone.description),
      );
      list.append(item);
    }
    host.append(list);

    // Inventory summary
    const inv = progression.inventorySummary;
    if (inv) {
      const summary = node("div", "progression-inventory");
      const items = [
        `Logs: ${inv.logs}`,
        `Planks: ${inv.planks}`,
        `Cobble: ${inv.cobblestone}`,
        `Food: ${inv.food}`,
        inv.hasWoodenPickaxe ? "🪓 Wooden" : "",
        inv.hasStonePickaxe ? "⛏ Stone" : "",
        inv.hasIronPickaxe ? "💎 Iron" : "",
      ].filter(Boolean);
      summary.append(node("span", "progression-inv-label", "Inventory: "));
      summary.append(node("span", "progression-inv-items", items.join(" · ")));
      host.append(summary);
    }
  }

  // Landmarks section
  if (landmarks && landmarks.length > 0) {
    const lmHeader = node("div", "progression-header");
    lmHeader.append(
      node("span", "progression-label", `Landmarks (${landmarks.length})`),
    );
    host.append(lmHeader);
    const lmList = node("div", "progression-list");
    for (const lm of landmarks.slice(0, 10)) {
      const item = node("div", "progression-item");
      const icon = lm.type === "danger-zone" ? "⚠" : lm.type === "resource-vein" ? "💎" : lm.type === "shelter" ? "🏠" : lm.type === "village" ? "🏘" : "📍";
      item.append(
        node("span", "progression-status", icon),
        node("span", "progression-title", lm.label),
        node("span", "progression-desc", `(${lm.position.x}, ${lm.position.y}, ${lm.position.z}) · ${lm.type}`),
      );
      lmList.append(item);
    }
    if (landmarks.length > 10) {
      lmList.append(node("div", "progression-desc", `... and ${landmarks.length - 10} more`));
    }
    host.append(lmList);
  }
}

function renderSafety(snapshot) {
  const safety = snapshot.safety ?? {};
  const metrics = el("safety-metrics");
  clear(metrics);
  metrics.append(
    metric("Policy", safety.policyId ?? "—", { note: safety.enabled === false ? "disabled" : `max risk ${safety.maxRisk ?? "—"}` }),
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
    metric(
      "Weight candidate gate",
      evaluation?.policyPromotable === true ? "pass" : evaluation?.policyCandidateId ? "held" : "not measured",
      {
        tone: evaluation?.policyPromotable === true ? "good" : evaluation?.policyCandidateId ? "warn" : null,
        note: evaluation?.policyCandidateId
          ? `${evaluation.policyCandidateId} · real baseline comparison; promotion also requires the full 20+ seed scenario set${evaluation.policyGateReasons?.[0] ? ` · ${evaluation.policyGateReasons[0]}` : ""}`
          : (learning.candidatePolicy?.contexts ?? 0) > 0
            ? "a weighted candidate exists, but this report has not measured it against the baseline"
            : "no derived weight candidate is available from current experience",
      },
    ),
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

  // Reward signal section
  renderRewardSection(learning);
  // Class-level failure patterns
  renderClassPatterns(learning);
  // Policy checkpoints
  renderCheckpoints(learning);
  // Experiments
  renderExperiments(learning);
  // RL readiness
  renderRLReadiness(learning);
}

function renderRewardSection(learning) {
  const reward = learning.reward ?? null;
  const metrics = el("reward-metrics");
  if (!metrics) return;
  clear(metrics);
  if (!reward || reward.totalEpisodes === 0) {
    metrics.append(node("p", "hint", "No reward data yet — rewards are computed when episodes are recorded with the enhanced learner."));
    return;
  }
  metrics.append(
    metric("Mean reward", reward.meanReward.toFixed(3), { tone: reward.meanReward > 0 ? "good" : reward.meanReward < 0 ? "bad" : null }),
    metric("EWMA reward", reward.ewmaReward.toFixed(3), { note: "exponentially weighted recent trend" }),
    metric("Positive rate", pct(reward.positiveRate), { note: `${reward.totalEpisodes} episodes scored` }),
  );
  const bar = el("reward-bar-fill");
  if (bar) {
    // Map reward from [-1, 3] to [0%, 100%]
    const pct = Math.max(0, Math.min(100, ((reward.meanReward + 1) / 4) * 100));
    bar.style.width = `${pct}%`;
    bar.style.background = pct > 60 ? "var(--accent-green, #4ade80)" : pct > 30 ? "var(--accent-yellow, #fbbf24)" : "var(--accent-red, #ef4444)";
  }
}

function renderClassPatterns(learning) {
  const patterns = learning.classPatterns ?? [];
  const tbody = document.querySelector("#class-patterns tbody");
  if (!tbody) return;
  clear(tbody);
  if (patterns.length === 0) {
    const tr = node("tr");
    const td = node("td");
    td.colSpan = 4;
    td.textContent = "No class-level patterns yet";
    td.className = "hint";
    tr.append(td);
    tbody.append(tr);
    return;
  }
  for (const pattern of patterns.slice(0, 10)) {
    const tr = node("tr");
    tr.append(node("td", "mono", pattern.patternKey));
    tr.append(node("td", null, String(pattern.attempts)));
    tr.append(node("td", null, String(pattern.distinctTargets)));
    tr.append(node("td", null, pattern.blocked ? chip("blocked") : chip("watching")));
    tbody.append(tr);
  }
}

function renderCheckpoints(learning) {
  const checkpoints = learning.checkpoints ?? null;
  const container = el("checkpoints-list");
  if (!container) return;
  clear(container);
  if (!checkpoints || checkpoints.total === 0) {
    container.append(node("p", "hint", "No policy checkpoints yet — checkpoints are saved when candidate policies are derived."));
    return;
  }
  container.append(node("p", null, `${checkpoints.total} checkpoint(s) · active: ${checkpoints.activeId ?? "baseline"}`));
  const list = node("div", "list");
  for (const cp of checkpoints.recent) {
    const item = node("div", "list-item");
    item.append(node("b", "mono", cp.id), chip(cp.id === checkpoints.activeId ? "active" : "archived"));
    item.append(node("p", null, `${cp.reason} · ${ago(cp.createdAt)}`));
    list.append(item);
  }
  container.append(list);
}

function renderExperiments(learning) {
  const experiments = learning.experiments ?? [];
  const container = el("experiments-list");
  if (!container) return;
  clear(container);
  if (experiments.length === 0) {
    container.append(node("p", "hint", "No experiments recorded yet."));
    return;
  }
  const list = node("div", "list");
  for (const exp of experiments) {
    const item = node("div", "list-item");
    item.append(node("b", "mono", exp.name), chip(exp.promoted ? "promoted" : exp.status));
    list.append(item);
  }
  container.append(list);
}

function renderRLReadiness(learning) {
  const rl = learning.rlReadiness ?? null;
  const container = el("rl-readiness");
  if (!container) return;
  clear(container);
  if (!rl) {
    container.append(node("p", "hint", "RL readiness not assessed. Run the assessment after live testing data is available."));
    return;
  }
  const pctScore = Math.round((rl.score / rl.maxScore) * 100);
  container.append(node("p", null, `Score: ${rl.score}/${rl.maxScore} (${pctScore}%)`));
  if (rl.ready.length > 0) {
    container.append(node("h4", null, "Ready:"));
    const ul = node("ul");
    for (const item of rl.ready) {
      ul.append(node("li", null, `✓ ${item}`));
    }
    container.append(ul);
  }
  if (rl.blockers.length > 0) {
    container.append(node("h4", null, "Blockers:"));
    const ul = node("ul");
    for (const item of rl.blockers) {
      ul.append(node("li", null, `✗ ${item}`));
    }
    container.append(ul);
  }
}

function renderWorld(snapshot) {
  const world = snapshot.world ?? {};
  const facts = world.sessionFacts ?? null;
  const vitals = el("vitals");
  clear(vitals);
  const health = typeof world.health === "number" ? world.health : null;
  const food = typeof world.food === "number" ? world.food : null;
  vitals.append(
    vital("Health", health === null ? "not reported" : `${num(health, 1)} / 20`, health === null ? null : Math.max(0, Math.min(1, health / 20)), health === null ? "warn" : health < 8 ? "bad" : health < 14 ? "warn" : null),
    vital("Hunger", food === null ? "not reported" : `${num(food)} / 20`, food === null ? null : Math.max(0, Math.min(1, food / 20)), food === null ? "warn" : food < 6 ? "bad" : food < 12 ? "warn" : null),
    vital("Position", world.position ? `${num(world.position.x, 0)} ${num(world.position.y, 0)} ${num(world.position.z, 0)}` : "—", null, null, "mono"),
    vital(
      "Time",
      world.time
        ? `${world.time.dayTicks === null || world.time.dayTicks === undefined ? "ticks not reported" : `${num(world.time.dayTicks)} ticks`} · ${world.time.isNight ? "night" : "day"}${world.time.source ? ` (${world.time.source})` : ""}`
        : "not reported",
      null,
      world.time ? null : "warn",
    ),
    // The gauge tops out at 300 ticks = 20 levels of air; "—" here means the session never sent one,
    // which is a different situation from full lungs and must not be drawn as a full bar.
    vital("Air", world.airTicks == null ? "not reported" : `${num(world.airTicks)} / 300 ticks`, world.airTicks == null ? null : Math.max(0, Math.min(1, world.airTicks / 300)), world.airTicks != null && world.airTicks < 100 ? "bad" : null),
    vital("Dimension", factText(facts?.dimension, world.dimension), null, factTone(facts?.dimension), "mono"),
    vital("Game mode", factText(facts?.gameMode, world.gameMode), null, factTone(facts?.gameMode), "mono"),
    vital("On ground", world.onGround === null || world.onGround === undefined ? "—" : world.onGround ? "yes" : "no", null, world.onGround === false ? "warn" : null),
    // "not reported" is load-bearing: the agent reads it as 'not proven dead', so a session that never
    // sent a health packet must not be shown as a death.
    vital("Life state", world.alive === null || world.alive === undefined ? "not reported" : world.alive ? "alive" : "dead", null, world.alive === false ? "bad" : null),
    vital("Vitals seen", world.vitalsObservedAt ? ago(world.vitalsObservedAt) : "never in this session", null, world.vitalsObservedAt ? null : "warn"),
    vital("Deaths", world.deathCount === null || world.deathCount === undefined ? "—" : world.deathCount, null, world.deathCount ? "warn" : null),
    vital("Inventory full", world.inventoryFull === null || world.inventoryFull === undefined ? "—" : world.inventoryFull ? "yes" : "no", null, world.inventoryFull ? "bad" : null),
  );
  const census = Object.values(world.knownResourceBlocks ?? {}).reduce((total, count) => total + count, 0);
  el("world-hint").textContent = `explored ${world.exploredCells ?? 0} cells · ${world.minableBlocks ?? 0} minable · ${census} resources remembered`;
  const freshness = world.freshness ?? null;
  const provenance = world.provenance ?? null;
  const stale = freshness?.stale === true || provenance?.source === "world-memory";
  const freshnessLine = el("world-freshness");
  if (freshnessLine) {
    freshnessLine.dataset.state = stale ? "stale" : "live";
    freshnessLine.textContent = freshnessReason(freshness, provenance, snapshot.connection ?? {});
    if (facts?.lastChange) {
      freshnessLine.title = `last session change (${facts.lastChange.kind}): ${facts.lastChange.detail} at ${facts.lastChange.at}`;
    }
  }
  const rememberedCount = (world.blocks ?? []).filter((block) => block.remembered).length;
  const visibleCount = (world.blocks ?? []).filter((block) => !block.remembered).length;
  const mapMeta = el("map-meta");
  if (mapMeta) mapMeta.textContent = stale
    ? `${rememberedCount} remembered · ${visibleCount} live · no current observation`
    : `${visibleCount} current · ${rememberedCount} last seen · ${world.perception?.loadedChunks ?? "?"} loaded chunks`;
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
  const observationsBody = el("observations")?.tBodies?.[0];
  if (observationsBody) {
    observationsBody.replaceChildren();
    const relevant = (block) => block.resource || block.hazard || /(^|_)(oak|birch)_log$|_leaves$|^(grass_block|dirt|coarse_dirt|rooted_dirt|stone|cobblestone)$/.test(block.name ?? "");
    const blocks = [...(world.blocks ?? [])]
      .sort((left, right) => Number(relevant(right)) - Number(relevant(left)) || (left.distance ?? Infinity) - (right.distance ?? Infinity))
      .slice(0, 18);
    for (const block of blocks) {
      const row = document.createElement("tr");
      if (block.remembered) row.dataset.stale = "true";
      if (block.hazard) row.dataset.hazard = "true";
      const identifier = block.identifier ?? (block.name ? `minecraft:${block.name}` : "unknown");
      const evidence = block.remembered
        ? "stale memory"
        : `${block.observationKind ?? "observation"} · obs #${freshness?.sequence ?? "?"}`;
      row.append(
        node("td", "mono block-id", identifier),
        node("td", "num", `${block.x}, ${block.y}, ${block.z}`),
        node("td", "num", block.distance == null ? "unknown" : `${num(block.distance, 1)} m`),
        node("td", block.visibility === "visible" ? "ok" : block.visibility === "occluded" ? "warn" : "muted", block.visibility ?? "unknown"),
        node("td", block.remembered ? "warn" : "ok", evidence),
      );
      observationsBody.append(row);
    }
    if (!blocks.length) observationsBody.append(emptyRow(5, "No blocks are available from the current observation."));
    const observationMeta = el("observation-meta");
    if (observationMeta) {
      const terrain = world.terrain;
      observationMeta.textContent = terrain
        ? `${blocks.length} shown · ${terrain.observedColumns} terrain columns · ${terrain.waterColumns} water · ${terrain.obstacleColumns} obstacles · ${terrain.unknownCells} unknown cells${terrain.truncated ? " · truncated" : ""}`
        : `${blocks.length} shown · ${world.blocks?.length ?? 0} reported · terrain model unavailable`;
    }
  }
  const threats = (world.entities ?? []).filter((entry) => entry.hostile);
  const hostiles = el("hostiles");
  clear(hostiles);
  if (threats.length) {
    for (const entity of threats.slice(0, 6)) hostiles.append(node("span", "item", `${entity.name} at ${num(entity.distance, 1)} m`));
  } else {
    hostiles.append(node("span", "item empty", (world.entities ?? []).length ? "no hostiles in view" : "no entities observed"));
  }
  drawMinimap(world, { stale: stale === true, provenance: provenance?.source ?? "world-memory" }, snapshot);
}

/** Renders one session fact as `value · evidence`; an unknown value is spelled out, never guessed. */
function factText(fact, fallback) {
  if (!fact) return fallback ? String(fallback) : "not reported";
  const shown = fact.value === null || fact.value === undefined ? "not reported" : String(fact.value);
  switch (fact.evidence) {
    case "verified":
      return `${shown} · verified (${fact.source})`;
    case "single-source":
      return `${shown} · one source (${fact.source})`;
    case "conflicting":
      return `unknown · sources disagree (${fact.note ?? fact.observed})`;
    default:
      return `unknown · ${fact.note ?? "not reported by the session"}`;
  }
}

function factTone(fact) {
  if (!fact) return "warn";
  if (fact.value === null || fact.evidence === "conflicting") return "warn";
  return null;
}

/** Says exactly which observation the panel is showing and how old it is. */
function freshnessReason(freshness, provenance, connection) {
  if (provenance?.source === "simulated") return "simulated world — not a live Minecraft observation";
  if (!freshness || freshness.reason === "no-observation") {
    return connection.adapterStatus === "connected"
      ? "no observation yet — the agent has not read the world in this session"
      : `no live observation — the adapter is ${connection.adapterStatus ?? "unknown"}`;
  }
  const age = freshness.ageMs == null ? "?" : `${Math.round(freshness.ageMs / 1000)}s`;
  if (freshness.reason === "session-changed") return `stale — observation #${freshness.sequence} came from a previous session`;
  if (freshness.stale) return `stale — observation #${freshness.sequence} is ${age} old`;
  const extra = provenance?.source === "world-memory" ? " · remembered blocks only" : "";
  return `live — observation #${freshness.sequence} (${age} old)${extra}`;
}

function renderObjective(snapshot) {
  const panel = el("objective-panel");
  if (!panel) return;
  clear(panel);
  const objective = snapshot.objective ?? null;
  if (!objective) {
    el("objective-hint").textContent = "no decision yet";
    panel.append(node("p", "note", "Autonomy has not chosen a subgoal yet."));
    return;
  }
  el("objective-hint").textContent = objective.fallback ? "fallback route" : objective.subgoal && objective.subgoal !== "none" ? "preferred route" : "waiting";
  panel.append(
    metric("Objective", objective.objective ?? "none"),
    metric("Subgoal", objective.subgoal ?? "none", { note: objective.completion ?? null }),
    metric("No-progress streak", String(objective.consecutiveNoProgress ?? 0), { tone: (objective.consecutiveNoProgress ?? 0) >= 2 ? "warn" : null }),
    metric("Decisions", String(objective.decided ?? 0), { note: `${objective.fallbacksUsed ?? 0} fallbacks used` }),
  );
  panel.append(node("p", "note", objective.reason ?? ""));
  if ((objective.cooldowns ?? []).length) {
    const list = node("ul", null);
    for (const cooldown of objective.cooldowns) {
      list.append(node("li", null, `cooling: ${cooldown.signature} until ${clock(cooldown.until)} — ${cooldown.reason}`));
    }
    panel.append(list);
  }
  if ((objective.recentOutcomes ?? []).length) {
    const list = node("ul", null);
    for (const outcome of objective.recentOutcomes.slice(0, 5)) {
      list.append(node("li", null, `${outcome.kind} · ${outcome.taskId} · ${outcome.reason}`));
    }
    panel.append(list);
  }
}

function renderWorldSeed(snapshot) {
  const seed = snapshot.worldSeed ?? null;
  const input = el("seed-input");
  if (seed && document.activeElement !== input) input.value = seed.value ?? "";
  el("seed-hint").textContent = !seed
    ? "unavailable"
    : seed.source === "manual" ? "entered by hand · unverified" : "not set";
  el("seed-note").textContent = seed ? seed.note : "";
}

/** One bar per saved episode, oldest first. Episodes with no learner reward are gaps, not zeros. */
function renderRewardTrend(values) {
  const box = el("training-reward");
  if (!box) return;
  box.replaceChildren();
  const present = values.filter((value) => typeof value === "number");
  if (values.length === 0) {
    box.append(node("span", "hint", "Reward trend: no episodes recorded yet."));
    return;
  }
  const scale = Math.max(1e-9, ...present.map((value) => Math.abs(value)));
  const bars = document.createElement("div");
  bars.className = "reward-bars";
  for (const value of values) {
    const bar = document.createElement("i");
    if (typeof value === "number") {
      bar.style.height = `${Math.max(4, Math.round((Math.abs(value) / scale) * 100))}%`;
      bar.className = value < 0 ? "neg" : "pos";
      bar.title = `reward ${num(value, 2)}`;
    } else {
      bar.className = "gap";
      bar.title = "no learner reward for this episode";
    }
    bars.append(bar);
  }
  const mean = present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
  box.append(
    bars,
    node("span", "hint", `Reward, last ${values.length} episodes${mean === null ? "" : ` · mean ${num(mean, 2)}`}`),
  );
}

function renderTraining(snapshot) {
  const training = snapshot.training ?? null;
  const metrics = el("training-metrics");
  if (!metrics) return;
  clear(metrics);
  const setEnabled = (selector, allowed) => {
    const button = document.querySelector(selector);
    if (button instanceof HTMLButtonElement) button.disabled = state.busy || !allowed;
  };
  if (!training) {
    el("training-hint").textContent = "unavailable";
    metrics.append(metric("Training", "unavailable", { note: "this host has no training support" }));
    for (const selector of ['[data-command="pauseTraining"]', '[data-command="resumeTraining"]', '[data-command="stopTraining"]', '[data-command="evaluateTraining"]', "#training-start"]) setEnabled(selector, false);
    return;
  }
  const status = training.status;
  const active = status === "running" || status === "paused" || status === "evaluating";
  const stage = training.stage;
  el("training-hint").textContent = training.updatedAt ? `updated ${ago(training.updatedAt)}` : "no run yet";
  const suspended = renderingSuspended(snapshot, state.headless);
  el("training-note").textContent = `${training.note}${training.stopReason ? ` Last stop: ${training.stopReason}` : ""}`;
  el("training-mode-note").textContent = state.headless
    ? "Headless: the offline simulator runs in a separate process. No Minecraft window and no browser 3D rendering while it runs. Live agent observation is not affected."
    : "Rendering on: the 3D world view is drawn during training. Training still runs on the offline simulator, not in the browser.";
  const errorBox = el("training-error");
  errorBox.hidden = !training.lastError;
  errorBox.textContent = training.lastError ? `Training error: ${training.lastError}` : "";
  metrics.append(
    metric("Status", status, {
      tone: status === "failed" || status === "interrupted" ? "bad" : status === "running" ? "good" : status === "paused" ? "warn" : null,
      note: training.processAlive ? `separate process · pid ${training.pid}` : "no training process",
    }),
    metric("Episodes", `${training.episodesTotal} / ${training.episodeBudget}`, { note: "trained so far / budget" }),
    metric("Stage", stage ? `${stage.index + 1} of ${stage.total} · ${stage.id}` : "complete", { note: stage ? stage.label : null }),
    metric("Stage success", stage && stage.successRate !== null ? pct(stage.successRate) : "—", {
      note: stage ? `passes at ${pct(stage.passRate)} after ${training.episodesPerStage ?? "?"}+ episodes` : null,
    }),
    metric("Recent success", pct(training.recentSuccessRate), { note: "last episodes in the saved state" }),
    metric("Recent reward", num(training.recentMeanReward, 2), { note: "mean per-task reward from the learner" }),
    metric("Checkpoints", String(training.checkpoints.length), { note: training.checkpoints[0]?.id ?? "none yet" }),
    metric("Active time", training.activeSeconds ? `${num(training.activeSeconds, 1)} s` : "0 s", {
      note: training.maxMinutes ? `of a ${training.maxMinutes} min budget · pauses excluded` : "episode time · pauses excluded",
    }),
    metric("Throughput", training.episodesPerMinute === null ? "—" : `${num(training.episodesPerMinute, 1)} / min`, {
      note: "episodes per active minute, lifetime",
    }),
    metric("3D view", suspended ? "paused" : "drawn", {
      tone: suspended ? "warn" : null,
      note: suspended ? "headless training is running" : state.headless ? "headless, idle" : "rendering on",
    }),
  );
  renderRewardTrend(training.rewardTrend ?? []);
  const bar = el("training-progress");
  const ratio = stage && stage.successRate !== null ? Math.min(1, Math.max(0, stage.successRate)) : 0;
  bar.style.width = `${Math.round(ratio * 100)}%`;
  bar.parentElement?.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  setEnabled('[data-command="pauseTraining"]', status === "running");
  setEnabled('[data-command="resumeTraining"]', status === "paused" || status === "interrupted");
  setEnabled('[data-command="stopTraining"]', status === "running" || status === "paused");
  setEnabled('[data-command="evaluateTraining"]', !active && training.checkpoints.length > 0);
  setEnabled("#training-start", !active);

  const body = el("training-episodes-table").tBodies[0];
  body.replaceChildren();
  for (const episode of training.recentEpisodes) {
    const row = document.createElement("tr");
    row.append(
      node("td", "mono", String(episode.index)),
      node("td", null, episode.stageId),
      node("td", "mono", episode.scenarioId),
      node("td", episode.success ? "ok" : "no", episode.success ? "success" : `${episode.status}${episode.failureCode ? ` · ${episode.failureCode}` : ""}`),
      node("td", null, `${episode.actions} (${episode.wastedActions} wasted)`),
      node("td", null, episode.reward === null ? "—" : num(episode.reward, 2)),
    );
    body.append(row);
  }
  if (!body.childElementCount) body.append(emptyRow(6, "No training episodes yet."));

  const checkpoints = el("training-checkpoints");
  checkpoints.replaceChildren();
  for (const checkpoint of training.checkpoints) {
    checkpoints.append(node("div", "list-item", `${checkpoint.id} · ${checkpoint.stageId} · ${checkpoint.episodes} episodes · ${checkpoint.weightedContexts} weighted contexts`));
  }

  const evaluation = el("training-evaluation");
  evaluation.replaceChildren();
  const last = training.lastEvaluation;
  if (last) {
    const deltas = last.deltas;
    evaluation.append(
      node("div", "list-item", `${last.verdict === "promotable" ? "Promotable" : "Not promotable"} · ${last.checkpointId} · ${clock(last.generatedAt)}`),
      node("div", "list-item", `Held-out success: ${pct(last.successRate.baseline)} baseline → ${pct(last.successRate.candidate)} checkpoint`
        + (deltas ? ` · median actions ${num(deltas.medianActions, 1)} · wasted actions ${num(deltas.meanWastedActions, 2)} · unsafe ${deltas.unsafeActions} · deaths ${deltas.deaths}` : "")),
    );
    for (const reason of last.reasons ?? []) evaluation.append(node("div", "list-item", reason));
  }
  if (training.lastError) evaluation.append(node("div", "list-item bad", `Last error: ${training.lastError}`));
}

function renderLoopPerformance(snapshot, container) {
  const loop = snapshot.agentLoop ?? null;
  const ms = (value) => (typeof value === "number" && Number.isFinite(value) ? `${num(value, 0)} ms` : "—");
  if (!loop) {
    container.append(metric("Observation loop", "unavailable", { note: "this host does not run the fast loop" }));
    return;
  }
  const observation = loop.observation;
  container.append(
    metric("Observation rate", observation.frequencyHz === null ? "—" : `${num(observation.frequencyHz, 2)} Hz`, {
      tone: !loop.running ? null : observation.frequencyHz !== null && observation.frequencyHz >= 0.8 ? "good" : "warn",
      note: `${observation.total} total · ${observation.errors} errors · ${observation.skippedTicks} skipped${loop.running ? "" : " · loop stopped"}`,
    }),
    metric("Observation age", ms(observation.ageMs), {
      tone: observation.stale ? "bad" : "good",
      note: observation.stale ? "stale: older than the decision bound" : "fresh",
    }),
    metric("Interval p95", ms(observation.intervalMs.p95Ms), { note: `observation duration p95 ${ms(observation.durationMs.p95Ms)}` }),
    metric("Decision p95", ms(loop.decisionMs.p95Ms), { note: `${loop.decisionMs.count} decisions` }),
    metric("Action p95", ms(loop.actionMs.p95Ms), { note: `${loop.actionMs.count} actions` }),
    metric("Reaction p95", ms(loop.reactionMs.p95Ms), { note: `urgent → dispatch · ${loop.urgent.events} urgent events` }),
    metric("Interrupts", String(loop.urgent.interruptsDispatched), { note: `${loop.urgent.interruptsSkippedProtected} skipped (protected action)` }),
    metric("Idle share", loop.idle.idleFraction === null ? "—" : `${num(loop.idle.idleFraction * 100, 0)}%`, { note: "time with no task running" }),
  );
  const body = el("loop-targets")?.tBodies[0];
  if (!body) return;
  body.replaceChildren();
  for (const target of loop.targets ?? []) {
    const row = document.createElement("tr");
    const status = target.met === null ? "no data" : target.met ? "met" : "missed";
    row.append(
      node("td", null, target.label),
      node("td", "mono", `≤ ${target.targetMs} ms`),
      node("td", "mono", ms(target.measuredMs)),
      node("td", target.met === false ? "no" : target.met ? "ok" : null, status),
    );
    body.append(row);
  }
}

function renderPerformance(snapshot) {
  const metrics = el("performance-metrics");
  if (!metrics) return;
  clear(metrics);
  renderLoopPerformance(snapshot, metrics);
  const runtime = snapshot.performance ?? null;
  const perception = snapshot.world?.perception ?? null;
  const mb = (bytes) => typeof bytes === "number" && Number.isFinite(bytes) ? `${num(bytes / (1024 * 1024), 1)} MB` : "—";
  if (runtime) {
    const hostMemoryUsed = Math.max(0, runtime.host.totalMemoryBytes - runtime.host.freeMemoryBytes);
    metrics.append(
      metric("Process CPU", `${num(runtime.process.cpuCapacityPercent, 1)}%`, { note: `of ${runtime.logicalCpus} logical CPUs · ${num(runtime.sampleWindowMs)} ms sample` }),
      metric("Event loop", `${num(runtime.process.eventLoopUtilizationPercent, 1)}%`, { note: "recent active-loop ratio" }),
      metric("Resident memory", mb(runtime.process.rssBytes), { note: `heap ${mb(runtime.process.heapUsedBytes)} / ${mb(runtime.process.heapTotalBytes)}` }),
      metric("Host memory", mb(hostMemoryUsed), { note: `${mb(runtime.host.totalMemoryBytes)} total` }),
      metric("System load", runtime.host.loadAverage1m === null ? "—" : num(runtime.host.loadAverage1m, 2), { note: "1-minute load average" }),
      metric("Runtime", `${runtime.nodeVersion} · ${runtime.architecture}`, { note: `${runtime.platform} · process uptime ${num(runtime.process.uptimeSeconds / 60, 1)} min` }),
    );
  }
  const fmtMs = (value) => `${num(value, 1)} ms`;
  if (!perception) {
    metrics.append(metric("Perception timing", "unavailable", { note: "adapter did not report a measured scan pass" }));
    el("performance-hint").textContent = "process sampling only · no adapter timing";
    return;
  }
  metrics.append(
    metric("Total scan", fmtMs(perception.totalMs), { tone: perception.totalMs > 80 ? "warn" : "good", note: "last observation" }),
    metric("Local voxel scan", fmtMs(perception.localScanMs), { note: `${perception.localBlocksReturned} returned / ${perception.localBlocksFound} found` }),
    metric("Strategic scans", fmtMs(perception.strategicScanMs), { note: `${perception.resourceSightings} resource · ${perception.minableSightings} minable` }),
    metric("Entity scan", fmtMs(perception.entityScanMs), { note: `${perception.entitiesReturned} visible entities` }),
    metric("Validation", fmtMs(perception.validationMs), { note: "observation schema" }),
    metric("Coverage sample", `${perception.sampledCells}`, { note: `${perception.unknownCells} unknown cells` }),
    metric("Client chunks", perception.loadedChunks ?? "unknown", { note: `resource radius ${num(perception.resourceScanRadius)} blocks` }),
    metric("Scan certainty", perception.resourceScanTruncated ? "truncated" : "complete", {
      tone: perception.resourceScanTruncated ? "warn" : "good",
      note: perception.minableScanTruncated === null ? "mineable scan status unknown" : perception.minableScanTruncated ? "mineable scan truncated" : "mineable scan complete",
    }),
  );
  el("performance-hint").textContent = runtime
    ? `${num(runtime.sampleWindowMs)} ms sampling window · ${clock(runtime.sampledAt)}`
    : `scan sample · ${clock(snapshot.generatedAt)}`;
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
 * WebGL geometry sourced only from current observed blocks plus wireframe, last-seen memory markers.
 * Unknown and unloaded terrain is never synthesized.
 */
function drawMinimap(world, options, snapshot = state.snapshot) {
  const canvas = el("minimap");
  const suspended = renderingSuspended(snapshot, state.headless);
  el("render-notice").hidden = !suspended;
  setWorldViewSuspended(suspended);
  if (suspended) {
    // Headless: no WebGL work at all while training runs. The last frame is kept but marked as not live.
    if (canvas) {
      canvas.dataset.live = "0";
      canvas.dataset.renderer = "suspended";
    }
    return;
  }
  drawWorldView(world, options ?? { stale: true, provenance: "world-memory" });
}

/* ------------------------------------------------------------------ improvement roadmap */

function roadmapPill(text, tone) {
  return node("span", `roadmap-pill${tone ? ` ${tone}` : ""}`, text);
}

function roadmapStatusTone(status) {
  if (status === "verified") return "good";
  if (status === "blocked") return "bad";
  if (status === "in-progress" || status === "planned") return "warn";
  return null;
}

let roadmapSignature = null;

function renderRoadmap(snapshot) {
  const roadmap = snapshot.roadmap ?? null;
  const itemsBox = el("roadmap-items");
  const next = el("roadmap-next");
  if (!roadmap) {
    itemsBox.replaceChildren();
    roadmapSignature = null;
    el("roadmap-hint").textContent = "unavailable";
    next.replaceChildren(node("span", "hint", "The roadmap is not available in this host."));
    el("roadmap-note").textContent = "";
    el("roadmap-sources").replaceChildren();
    return;
  }
  const open = roadmap.items.filter((item) => !isClosed(item)).length;
  el("roadmap-hint").textContent = roadmap.evidenceAt
    ? `evidence measured ${ago(roadmap.evidenceAt)} · ${open} open`
    : "no evidence yet";
  el("roadmap-note").textContent = roadmap.note;

  if (roadmap.next) {
    next.replaceChildren(
      node("span", "roadmap-next-label", "Next recommended task"),
      node("strong", null, roadmap.next.title),
      node("span", "hint", roadmap.next.summary),
    );
  } else {
    next.replaceChildren(node("span", "roadmap-next-label", "Next recommended task"), node("span", "hint", "Nothing open to recommend right now."));
  }

  const sources = el("roadmap-sources");
  sources.replaceChildren();
  for (const source of roadmap.sources ?? []) {
    const chip = node("span", `source-chip ${source.available ? "on" : "off"}`, `${source.available ? "✓" : "–"} ${source.name}${source.measuredAt ? ` · ${ago(source.measuredAt)}` : ""}`);
    chip.title = source.available ? `read from ${source.path}` : `not available: ${source.path}`;
    sources.append(chip);
  }

  const filters = {
    category: el("roadmap-category").value,
    kind: el("roadmap-kind").value,
    showClosed: el("roadmap-show-closed").checked,
  };
  // The item list is rebuilt only when something it shows has changed. Rebuilding every poll would close any
  // open <details> and lose focus on the controls the operator is using.
  const signature = JSON.stringify({ items: roadmap.items, filters, busy: state.busy, error: roadmap.error });
  if (signature === roadmapSignature) return;
  roadmapSignature = signature;
  itemsBox.replaceChildren();
  if (roadmap.error) itemsBox.append(node("p", "training-error", roadmap.error));
  const visible = filterRoadmap(roadmap.items, filters);
  const hiddenClosed = roadmap.items.length - roadmap.items.filter((item) => !isClosed(item)).length;
  if (roadmap.items.length === 0) {
    itemsBox.append(node("p", "empty", "No open items. The recorded evidence does not measure any problem right now. Refresh after a new run, or record the test suite with npm run test:record."));
  } else if (visible.length === 0) {
    itemsBox.append(node("p", "empty", "No items match these filters."));
  }
  for (const [category, list] of groupByCategory(visible)) {
    const heading = node("h3", "roadmap-group", `${category.replace("-", " ")} · ${list.length}`);
    itemsBox.append(heading);
    for (const item of list) itemsBox.append(roadmapItemView(item));
  }
  if (!filters.showClosed && hiddenClosed > 0) {
    itemsBox.append(node("p", "hint", `${hiddenClosed} dismissed or verified item(s) hidden. Tick “Show dismissed and verified” to see them.`));
  }
}

function roadmapItemView(item) {
  const article = document.createElement("article");
  article.className = `roadmap-item kind-${item.kind} status-${item.status}`;
  article.dataset.fingerprint = item.fingerprint;

  const head = node("div", "roadmap-head");
  head.append(
    node("strong", null, item.title),
    roadmapPill(ROADMAP_KIND_LABELS[item.kind] ?? item.kind, item.kind === "defect" ? "bad" : item.kind === "idea" ? null : "warn"),
    roadmapPill(ROADMAP_STATUS_LABELS[item.status] ?? item.status, roadmapStatusTone(item.status)),
    roadmapPill(`score ${num(item.score, 2)}`, null),
  );
  if (item.pinned) head.append(roadmapPill("pinned", "good"));
  if (item.reopenedCount > 0) head.append(roadmapPill(`reopened ×${item.reopenedCount}`, "warn"));
  article.append(head);

  article.append(node("p", "roadmap-explain", item.explanation));

  const facts = node("dl", "roadmap-facts");
  const pairs = [
    ["Impact", `${item.impact} / 5`],
    ["Urgency", `${item.urgency} / 5`],
    ["Confidence", `${Math.round(item.confidence * 100)}%`],
    ["Effort", ["", "small", "medium", "large"][item.effort] ?? String(item.effort)],
    ["Priority", item.priority === null ? "auto" : String(item.priority)],
  ];
  for (const [label, value] of pairs) facts.append(node("dt", null, label), node("dd", "mono", value));
  article.append(facts);

  article.append(node("p", "roadmap-benefit", `Expected benefit: ${item.expectedBenefit}`));
  if (item.dependencies.length) {
    article.append(node("p", "hint", `Depends on: ${item.dependencies.join("; ")}`));
  }
  if (item.verification) article.append(node("p", "hint", `Verification: ${item.verification}`));

  const evidence = document.createElement("details");
  evidence.append(node("summary", null, `Evidence (${item.evidence.length})`));
  const evidenceList = node("ul", "roadmap-evidence");
  for (const entry of item.evidence) {
    evidenceList.append(node("li", null, `${entry.metric}: ${entry.value} — ${entry.source}${entry.measuredAt ? `, ${ago(entry.measuredAt)}` : ", a fact about the code, not a measurement"}`));
  }
  evidence.append(evidenceList);
  article.append(evidence);

  const history = document.createElement("details");
  history.append(node("summary", null, `History (${item.history.length})`));
  const historyList = node("ul", "roadmap-evidence");
  for (const entry of [...item.history].reverse()) historyList.append(node("li", null, `${ago(entry.at)} · ${entry.event}`));
  history.append(historyList);
  article.append(history);

  const actions = node("div", "roadmap-actions");
  for (const action of roadmapActionsFor(item)) {
    const button = node("button", "btn", ROADMAP_ACTION_LABELS[action] ?? action);
    button.type = "button";
    button.dataset.roadmapAction = action;
    button.disabled = state.busy;
    actions.append(button);
  }
  const pinButton = node("button", "btn", item.pinned ? "Unpin" : "Pin to top");
  pinButton.type = "button";
  pinButton.dataset.roadmapAction = item.pinned ? "unpin" : "pin";
  pinButton.disabled = state.busy || isClosed(item);
  actions.append(pinButton);
  if (!isClosed(item)) {
    const priority = document.createElement("select");
    priority.dataset.roadmapPriority = "1";
    priority.setAttribute("aria-label", `Priority for ${item.title}`);
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "Priority: auto";
    priority.append(auto);
    for (let value = 1; value <= 5; value += 1) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `Priority ${value}`;
      if (item.priority === value) option.selected = true;
      priority.append(option);
    }
    priority.disabled = state.busy;
    actions.append(priority);
  }
  article.append(actions);

  for (const button of actions.querySelectorAll("button[data-roadmap-action]")) {
    button.addEventListener("click", () => {
      const action = button.dataset.roadmapAction;
      const payload = { fingerprint: item.fingerprint, action };
      if (ROADMAP_ACTIONS_WITH_NOTE.has(action)) {
        const note = window.prompt(`Optional note for “${item.title}”, saved in its history:`, "");
        if (note === null) return;
        if (note.trim()) payload.note = note.trim();
      }
      void sendCommand("roadmapAction", payload);
    });
  }
  const priority = actions.querySelector("select[data-roadmap-priority]");
  if (priority) {
    priority.addEventListener("change", () => {
      if (priority.value === "") return;
      void sendCommand("roadmapAction", { fingerprint: item.fingerprint, action: "prioritize", value: Number(priority.value) });
    });
  }
  return article;
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
  const taskKind = el("task-kind");
  const taskCount = el("task-count");
  const taskCountLabel = document.querySelector("label[for=task-count]");
  const taskResource = el("task-resource");
  const taskResourceLabel = document.querySelector("label[for=task-resource]");
  const configureTaskCount = () => {
    const secureFood = taskKind.value === "secure-food";
    const buildShelter = taskKind.value === "build-shelter";
    taskCount.max = secureFood ? "20" : "64";
    taskCount.required = !buildShelter;
    taskCount.parentElement.hidden = buildShelter;
    taskCount.value = secureFood ? "18" : buildShelter ? "" : "1";
    if (taskCountLabel) taskCountLabel.textContent = secureFood ? "Target hunger" : "Target count";
    const usesResource = !secureFood && !buildShelter;
    taskResource.disabled = !usesResource;
    taskResource.hidden = !usesResource;
    if (taskResourceLabel) taskResourceLabel.hidden = !usesResource;
    if (taskResourceLabel) taskResourceLabel.textContent = taskKind.value === "craft-wooden-pickaxe"
      ? "Craft target (optional)"
      : taskKind.value === "mine-stone"
        ? "Mineable block (optional)"
        : "Log type (optional)";
  };
  taskKind.addEventListener("change", configureTaskCount);
  configureTaskCount();
  el("task-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const buildShelter = taskKind.value === "build-shelter";
    const count = Number(taskCount.value);
    const max = taskKind.value === "secure-food" ? 20 : 64;
    if (!buildShelter && (!Number.isInteger(count) || count < 1 || count > max)) {
      toast(`startTask: target must be a whole number from 1 to ${max}.`, "bad");
      return;
    }
    const resource = taskResource.disabled ? "" : taskResource.value.trim();
    void sendCommand("startTask", {
      kind: taskKind.value,
      ...(resource ? { resource } : {}),
      ...(!buildShelter ? { count } : {}),
    });
  });
  el("chat-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = el("chat-input");
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    void sendCommand("chat", message);
  });
  el("seed-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void sendCommand("setWorldSeed", el("seed-input").value.trim());
  });
  el("training-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const episodesPerStage = Number(el("training-episodes").value);
    if (!Number.isInteger(episodesPerStage) || episodesPerStage < 1 || episodesPerStage > 200) {
      toast("startTraining: episodes per stage must be a whole number from 1 to 200.", "bad");
      return;
    }
    const payload = { episodesPerStage, fresh: el("training-fresh").checked };
    const budgets = [
      ["training-max-episodes", "maxEpisodes", "Episode budget", 1, 5000],
      ["training-minutes", "maxMinutes", "Time budget", 1, 1440],
    ];
    for (const [id, key, label, min, max] of budgets) {
      const raw = el(id).value.trim();
      if (raw === "") continue;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < min || value > max) {
        toast(`startTraining: ${label.toLowerCase()} must be a whole number from ${min} to ${max}, or empty.`, "bad");
        return;
      }
      payload[key] = value;
    }
    if (payload.fresh && !window.confirm("Start over deletes the saved training experience and checkpoints. Continue?")) return;
    void sendCommand("startTraining", payload);
  });
  el("training-headless").checked = state.headless;
  el("training-headless").addEventListener("change", (event) => {
    state.headless = event.currentTarget.checked;
    try {
      localStorage.setItem(HEADLESS_STORAGE_KEY, state.headless ? "1" : "0");
    } catch {
      /* the choice still applies for this page */
    }
    if (state.snapshot) render();
  });
  el("roadmap-refresh").addEventListener("click", () => void sendCommand("refreshRoadmap"));
  for (const id of ["roadmap-category", "roadmap-kind", "roadmap-show-closed"]) {
    el(id).addEventListener("change", () => {
      if (state.snapshot) renderRoadmap(state.snapshot);
    });
  }
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
  // Tab switching
  for (const tabBtn of document.querySelectorAll(".tab-btn")) {
    tabBtn.addEventListener("click", () => {
      const tab = tabBtn.dataset.tab;
      for (const btn of document.querySelectorAll(".tab-btn")) btn.classList.remove("active");
      for (const panel of document.querySelectorAll(".tab-panel")) panel.classList.remove("active");
      tabBtn.classList.add("active");
      const panel = el(`tab-${tab}`);
      if (panel) panel.classList.add("active");
    });
  }
  // Emergency stop button - confirmation
  const panicBtn = el("panic-btn");
  if (panicBtn) {
    panicBtn.addEventListener("click", (e) => {
      if (!panicBtn.dataset.confirmed) {
        panicBtn.dataset.confirmed = "1";
        panicBtn.textContent = "⚠ CONFIRM EMERGENCY STOP";
        panicBtn.style.background = "#b91c1c";
        setTimeout(() => {
          delete panicBtn.dataset.confirmed;
          panicBtn.textContent = "⚠ EMERGENCY STOP";
          panicBtn.style.background = "";
        }, 3000);
        e.stopImmediatePropagation();
        return;
      }
      delete panicBtn.dataset.confirmed;
      panicBtn.textContent = "⚠ EMERGENCY STOP";
      panicBtn.style.background = "";
    });
  }
}

/* ------------------------------------------------------------------ polling */

/** How hard the page should look at the agent right now. */
function desiredPollDelay(snapshot) {
  if (typeof document !== "undefined" && document.hidden) return POLL_HIDDEN_MS;
  const agent = snapshot?.agent ?? null;
  if (!agent) return POLL_IDLE_MS;
  if (agent.state === "running" || agent.state === "stopping" || state.busy) return POLL_RUNNING_MS;
  return POLL_IDLE_MS;
}

/**
 * One request in flight at a time, rescheduled after each answer. A fixed interval would stack requests on
 * a slow snapshot — and a slow snapshot is exactly what a busy agent with a large world view looks like —
 * so the loop waits for the previous one instead of overlapping it.
 */
function schedulePoll(delayMs) {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(() => {
    void (async () => {
      await loadSnapshot(state.snapshot === null);
      schedulePoll(desiredPollDelay(state.snapshot));
    })();
  }, delayMs);
}

function startPolling() {
  document.addEventListener("visibilitychange", () => {
    // Returning to a tab that was hidden must not leave a fifteen-second-old world on screen looking live.
    void loadSnapshot(true);
    schedulePoll(desiredPollDelay(state.snapshot));
  });
  schedulePoll(POLL_RUNNING_MS);
}

if (typeof boot.title === "string" && boot.title.length) {
  el("title").textContent = boot.title;
}
wireControls();
void loadSnapshot(true);
startPolling();
