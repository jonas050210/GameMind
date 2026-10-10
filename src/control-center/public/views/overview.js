import { h } from "../lib/h.js";
import { badge, button, card, empty, kv, notice, progress, sourceBadge, statusBadge, unknown, value } from "../lib/ui.js";
import { fmtAgo, fmtDateTime, fmtDuration, fmtNumber, fmtPercent, fmtTime, humanise, orUnknown } from "../lib/format.js";
import { SOURCES, activeProgress, sessionInfo, taskBlocker, worldSource } from "../lib/model.js";

const LEVEL_TONE = { debug: "neutral", info: "info", warn: "warn", error: "bad" };

export function eventRow(event) {
  return h(
    "li",
    { class: `event level-${event.level}`, key: `${event.boot}-${event.seq}` },
    h("time", { class: "event-time", datetime: event.at, title: fmtDateTime(event.at) }, fmtTime(event.at)),
    badge(event.level, LEVEL_TONE[event.level] ?? "neutral"),
    h("span", { class: "event-category" }, event.category),
    h("span", { class: "event-message" }, event.message),
    event.source !== "system" ? sourceBadge(event.source) : null,
  );
}

function session(snapshot, now) {
  const view = snapshot.session;
  const info = sessionInfo(view);
  const target = view?.target;
  return card(
    { title: "Session", subtitle: "Lifecycle of the agent's connection to the game", class: `hero tone-${info.tone}` },
    h("div", { class: "hero-state" }, h("span", { class: `state-dot tone-${info.tone}`, "aria-hidden": "true" }), h("div", null, h("p", { class: "hero-label" }, info.label), h("p", { class: "muted" }, info.meaning))),
    view?.error ? notice("bad", view.error.summary, view.error.hints.length ? h("ul", null, view.error.hints.map((hint) => h("li", null, hint))) : null, h("p", { class: "small muted" }, `Error reported: ${view.error.detail || "none"}`)) : null,
    view?.reconnect ? notice("warn", `Reconnect attempt ${view.reconnect.attempt} of ${view.reconnect.maxAttempts}`, view.reconnect.nextAttemptAt ? `Next try ${fmtAgo(view.reconnect.nextAttemptAt, now).replace(" ago", "")} from the time shown: ${fmtTime(view.reconnect.nextAttemptAt)}.` : "Trying now.") : null,
    kv([
      ["State since", view?.since ? `${fmtTime(view.since)} (${fmtAgo(view.since, now)})` : null],
      ["Mode", view?.mode ? (view.mode === "persistent" ? "Persistent — stays connected until you stop it" : "One-shot — ends with its task") : null],
      ["Source", view?.source ? sourceBadge(view.source) : sourceBadge("unavailable")],
      ["Server", target ? `${target.host}:${target.port}` : view?.source === "simulated" ? "built-in simulator" : null],
      ["Minecraft version", target?.version ?? snapshot.connection?.gameVersion ?? null],
      ["Bot name", target?.username ?? null],
      ["Runtime", view?.runtimeMs !== null && view?.runtimeMs !== undefined ? fmtDuration(view.runtimeMs) : null],
      ["World", view?.worldKey ?? null, "The identity world memory is filed under."],
    ]),
  );
}

function controls(snapshot) {
  const view = snapshot.session;
  const state = view?.state ?? "none";
  const active = state !== "none" && state !== "shutdown";
  const hold = snapshot.safety;
  const blocker = taskBlocker(snapshot);
  return card(
    { title: "Controls", subtitle: "These act on the real session. Safety limits are never changed from here." },
    h(
      "div",
      { class: "button-row" },
      active
        ? button("Stop session", { command: "stopSession", payload: "stopped from the Overview", tone: "warn", data: { confirm: "Stop the session and disconnect the bot?" }, title: "Stops the running task and disconnects the bot. The Control Center stays open." })
        : button("Connect…", { action: "goto-tab", data: { tab: "bots" }, tone: "primary", title: "Opens the connection form" }),
      hold?.paused ? button("Resume", { command: "resume", tone: "primary" }) : button("Pause", { command: "pause", payload: "paused from the Overview", disabled: !active, title: "The Safety Broker refuses every world-changing action until you resume." }),
      button("Stop task", { command: "stopTask", payload: "stopped from the Overview", disabled: !snapshot.scheduler?.active }),
      button("⚠ Emergency stop", { command: "panic", tone: "danger", disabled: !active, title: "Trips safety, stops the task and disarms combat at once." }),
    ),
    hold?.tripped ? notice("bad", "Safety trip raised", hold.tripReason ?? "A trip is active; only read-only actions run.", button("Reset trip", { command: "resetTrip" })) : null,
    hold?.paused && !hold?.tripped ? notice("warn", "Paused", hold.pauseReason ?? "The Safety Broker is refusing world-changing actions.") : null,
    blocker && active ? h("p", { class: "muted small" }, blocker) : null,
    h("p", { class: "muted small" }, "Quit the whole app with the button in the footer; closing this tab changes nothing."),
  );
}

function vitals(snapshot, now) {
  const world = snapshot.world;
  const source = worldSource(snapshot);
  const live = source === "live" || source === "simulated";
  const position = world.position;
  return card(
    { title: "Player and world", subtitle: world.freshness?.observedAt ? `Observation #${orUnknown(world.freshness.sequence)} · ${fmtAgo(world.freshness.observedAt, now)}${world.freshness.stale ? " · stale" : ""}` : "No observation yet", actions: sourceBadge(source) },
    live
      ? staleNotice(world.freshness, now)
      : notice("neutral", "Nothing is being observed", world.provenance?.note ?? "Telemetry is unknown until a session is connected."),
    h(
      "div",
      { class: "meters" },
      meter("Health", world.health, 20, live),
      meter("Food", world.food, 20, live),
    ),
    kv([
      ["Position", position ? `${position.x}, ${position.y}, ${position.z}` : null],
      ["Dimension", world.dimension ?? null],
      ["Game mode", world.gameMode ?? null],
      ["Alive", world.alive === null || world.alive === undefined ? null : world.alive ? "yes" : "no — respawning"],
      ["Time of day", world.time ? `${world.time.isNight ? "night" : "day"}${world.time.day !== null && world.time.day !== undefined ? ` (day ${world.time.day})` : ""}` : null],
      ["Inventory", world.inventory?.length ? `${fmtNumber(world.inventory.reduce((sum, item) => sum + item.count, 0))} items in ${world.inventory.length} slots` : live ? "empty" : null],
    ]),
  );
}

/**
 * A live observation can go quiet (a stalled connection, a paused server). Its numbers are then the last thing the agent saw,
 * not what is happening now, and the safety policy refuses actions that change the world until a newer one arrives. The
 * subtitle already says "stale"; this makes the consequence visible instead of leaving old numbers looking current.
 */
function staleNotice(freshness, now) {
  if (!freshness?.stale || freshness.reason !== "stale") return null;
  return notice(
    "warn",
    "The latest observation is stale",
    `It was read ${freshness.observedAt ? fmtAgo(freshness.observedAt, now) : "a while ago"}. Until a newer one arrives the safety policy refuses actions that change the world (STALE_OBSERVATION); read-only actions still run. The values below may be out of date.`,
  );
}

function meter(label, valueNow, max, live) {
  return h(
    "div",
    { class: "meter" },
    h("div", { class: "meter-head" }, h("span", null, label), h("strong", null, typeof valueNow === "number" ? `${fmtNumber(valueNow, valueNow % 1 ? 1 : 0)} / ${max}` : unknown(live ? "The session has not reported this yet." : "No session.")),),
    progress(typeof valueNow === "number" ? valueNow : null, max, label),
  );
}

function currentTask(snapshot, now) {
  const active = snapshot.scheduler?.active;
  const progressInfo = activeProgress(snapshot);
  const agent = snapshot.agent;
  if (!active) {
    return card(
      { title: "Current task" },
      empty(snapshot.session?.state === "idle" ? "Idle" : "No task", snapshot.session?.state === "idle" ? `Connected and waiting${snapshot.autonomyEnabled ? "; autonomy is on and will pick work when it sees something worth doing" : ""}.` : agent?.blocker?.headline),
      snapshot.scheduler?.queue?.length ? h("p", { class: "muted" }, `${snapshot.scheduler.queue.length} queued: next is “${snapshot.scheduler.queue[0].label}”.`) : null,
      button("Open Tasks", { action: "goto-tab", data: { tab: "tasks" } }),
    );
  }
  return card(
    { title: "Current task", actions: statusBadge(agent?.state === "stopping" ? "aborted" : "running") },
    h("p", { class: "task-title" }, active.label),
    kv([
      ["Started by", active.origin],
      ["Running for", active.startedAt ? fmtDuration(Math.max(0, now - Date.parse(active.startedAt))) : null],
      ["Actions so far", agent ? fmtNumber(agent.actionsUsed) : null],
      ["Goal", snapshot.goal?.rationale ?? null],
    ]),
    progressInfo ? h("div", null, progress(progressInfo.have, progressInfo.of, `${progressInfo.unit} progress`), h("p", { class: "small muted" }, `${fmtNumber(progressInfo.have)} of ${fmtNumber(progressInfo.of)} ${progressInfo.unit}`)) : h("p", { class: "small muted" }, "Progress is not measurable for this task right now."),
    button("Stop task", { command: "stopTask", payload: "stopped from the Overview", tone: "warn" }),
  );
}

function activity(snapshot) {
  const items = (snapshot.events?.items ?? []).slice(-10).reverse();
  return card(
    { title: "Recent activity", subtitle: `${fmtNumber(snapshot.events?.total ?? 0)} events recorded`, actions: button("Open event log", { action: "goto-tab", data: { tab: "memory" } }) },
    items.length ? h("ol", { class: "event-list" }, items.map(eventRow)) : empty("No events yet", "Connections, decisions, actions, task changes and errors appear here as they happen."),
  );
}

function trainingSummary(snapshot) {
  const training = snapshot.training;
  if (!training) return card({ title: "Training" }, empty("Not available", "This run has no training support."));
  const evaluation = training.lastEvaluation;
  return card(
    { title: "Training", subtitle: "Offline simulator only", actions: sourceBadge("offline") },
    kv([
      ["State", badge(training.status, training.status === "running" ? "info" : training.status === "failed" || training.status === "interrupted" ? "bad" : "neutral")],
      ["Episodes", `${fmtNumber(training.episodesTotal)} of ${fmtNumber(training.episodeBudget)}`],
      ["Checkpoints", fmtNumber(training.checkpoints.length)],
      ["Last evaluation", evaluation ? `${evaluation.checkpointId}: ${evaluation.verdict === "promotable" ? "promotable" : "not promotable"} (${evaluation.conclusion ?? "no conclusion recorded"})` : "none yet"],
    ]),
    button("Open Training", { action: "goto-tab", data: { tab: "training" } }),
  );
}

function evaluationSummary(snapshot) {
  const jobs = snapshot.jobs?.items ?? [];
  const tests = jobs.find((job) => job.kind === "unit-tests");
  const live = jobs.find((job) => job.kind === "live-verification");
  const row = (job, none) => (job ? h("span", null, statusBadge(job.state === "succeeded" ? "passed" : job.state), " ", job.summary?.kind === "tests" && job.summary.total !== null ? `${job.summary.passed}/${job.summary.total} passed` : job.state, job.historical ? [" ", sourceBadge("historical")] : null) : unknown(none));
  return card(
    { title: "Tests and evaluation" },
    kv([
      ["Offline tests", row(tests, "Not run from this page yet")],
      ["Live verification", live ? row(live) : h("span", null, badge("NOT VERIFIED LIVE", "warn"), " no live check has been run from this page")],
    ]),
    button("Open Tests & Evaluation", { action: "goto-tab", data: { tab: "evaluation" } }),
  );
}

function legend() {
  return card(
    { title: "How to read the data", class: "legend" },
    h("ul", { class: "legend-list" }, Object.entries(SOURCES).map(([key, info]) => h("li", null, sourceBadge(key), h("span", { class: "muted small" }, info.title)))),
    h("p", { class: "muted small" }, "Unknown telemetry is shown as “unknown”, never as a default number."),
  );
}

export function renderOverview(ctx) {
  const { snapshot, now } = ctx;
  return {
    "ov-session": session(snapshot, now),
    "ov-controls": controls(snapshot),
    "ov-vitals": vitals(snapshot, now),
    "ov-task": currentTask(snapshot, now),
    "ov-activity": activity(snapshot),
    "ov-training": trainingSummary(snapshot),
    "ov-evaluation": evaluationSummary(snapshot),
    "ov-legend": legend(),
  };
}

export { fmtPercent, humanise, value };
