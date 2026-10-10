import { h } from "../lib/h.js";
import { badge, button, card, empty, kv, notice, progress, sourceBadge, statusBadge, unknown, value } from "../lib/ui.js";
import { fmtAgo, fmtDateTime, fmtDuration, fmtNumber, fmtPercent, fmtTime, humanise, orUnknown } from "../lib/format.js";
import { SOURCES, activeProgress, nowSummary, sessionInfo, taskBlocker, worldSource } from "../lib/model.js";

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
    { title: "Sitzung", subtitle: "Lebenszyklus der Verbindung des Agenten zum Spiel", class: `hero tone-${info.tone}` },
    h("div", { class: "hero-state" }, h("span", { class: `state-dot tone-${info.tone}`, "aria-hidden": "true" }), h("div", null, h("p", { class: "hero-label" }, info.label), h("p", { class: "muted" }, info.meaning))),
    h("p", { class: "hero-now" }, nowSummary(snapshot)),
    view?.error ? notice("bad", view.error.summary, view.error.hints.length ? h("ul", null, view.error.hints.map((hint) => h("li", null, hint))) : null, h("p", { class: "small muted" }, `Gemeldeter Fehler: ${view.error.detail || "keiner"}`)) : null,
    view?.reconnect ? notice("warn", `Wiederverbindung, Versuch ${view.reconnect.attempt} von ${view.reconnect.maxAttempts}`, view.reconnect.nextAttemptAt ? `Next try ${fmtAgo(view.reconnect.nextAttemptAt, now).replace(" ago", "")} from the time shown: ${fmtTime(view.reconnect.nextAttemptAt)}.` : "Trying now.") : null,
    kv([
      ["Status seit", view?.since ? `${fmtTime(view.since)} (${fmtAgo(view.since, now)})` : null],
      ["Modus", view?.mode ? (view.mode === "persistent" ? "Dauerhaft — bleibt verbunden, bis du es beendest" : "Einmalig — endet mit der Aufgabe") : null],
      ["Source", view?.source ? sourceBadge(view.source) : sourceBadge("unavailable")],
      ["Server", target ? `${target.host}:${target.port}` : view?.source === "simulated" ? "eingebauter Simulator" : null],
      ["Minecraft-Version", target?.version ?? snapshot.connection?.gameVersion ?? null],
      ["Bot-Name", target?.username ?? null],
      ["Runtime", view?.runtimeMs !== null && view?.runtimeMs !== undefined ? fmtDuration(view.runtimeMs) : null],
      ["Welt", view?.worldKey ?? null, "Die Kennung, unter der das Weltgedächtnis abgelegt wird."],
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
    { title: "Steuerung", subtitle: "Diese Knöpfe wirken auf die echte Sitzung. Sicherheitsgrenzen werden von hier nie verändert." },
    h(
      "div",
      { class: "button-row" },
      active
        ? button("Sitzung beenden", { command: "stopSession", payload: "von der Übersicht beendet", tone: "warn", data: { confirm: "Sitzung beenden und den Bot trennen?" }, title: "Stops the running task and disconnects the bot. The Control Center stays open." })
        : button("Verbinden …", { action: "goto-tab", data: { tab: "bots" }, tone: "primary", title: "Öffnet das Verbindungsformular" }),
      hold?.paused ? button("Fortsetzen", { command: "resume", tone: "primary" }) : button("Pausieren", { command: "pause", payload: "von der Übersicht pausiert", disabled: !active, title: "Die Sicherheitsbremse lehnt jede Aktion ab, die die Welt verändert, bis du fortsetzt." }),
      button("Aufgabe stoppen", { command: "stopTask", payload: "von der Übersicht gestoppt", disabled: !snapshot.scheduler?.active }),
      button("⚠ Not-Halt", { command: "panic", tone: "danger", disabled: !active, title: "Löst die Sicherheitsbremse aus, stoppt die Aufgabe und schaltet den Kampf sofort ab." }),
    ),
    hold?.tripped ? notice("bad", "Sicherheitsbremse ausgelöst", hold.tripReason ?? "Die Bremse ist aktiv; es laufen nur lesende Aktionen.", button("Bremse zurücksetzen", { command: "resetTrip" })) : null,
    hold?.paused && !hold?.tripped ? notice("warn", "Pausiert", hold.pauseReason ?? "Die Sicherheitsbremse lehnt Aktionen ab, die die Welt verändern.") : null,
    blocker && active ? h("p", { class: "muted small" }, blocker) : null,
    h("p", { class: "muted small" }, "Beendet wird die ganze Anwendung über den Knopf unten; dieses Fenster zu schließen ändert nichts."),
  );
}

function vitals(snapshot, now) {
  const world = snapshot.world;
  const source = worldSource(snapshot);
  const live = source === "live" || source === "simulated";
  const position = world.position;
  return card(
    { title: "Spieler und Welt", subtitle: world.freshness?.observedAt ? `Beobachtung #${orUnknown(world.freshness.sequence)} · ${fmtAgo(world.freshness.observedAt, now)}${world.freshness.stale ? " · veraltet" : ""}` : "Noch keine Beobachtung", actions: sourceBadge(source) },
    live
      ? staleNotice(world.freshness, now)
      : notice("neutral", "Es wird nichts beobachtet", world.provenance?.note ?? "Die Messwerte sind unbekannt, bis eine Sitzung verbunden ist."),
    h(
      "div",
      { class: "meters" },
      meter("Gesundheit", world.health, 20, live),
      meter("Nahrung", world.food, 20, live),
    ),
    kv([
      ["Dimension", world.dimension ?? null],
      ["Spielmodus", world.gameMode ?? null],
      ["Lebendig", world.alive === null || world.alive === undefined ? null : world.alive ? "ja" : "nein — wird neu gespawnt"],
      ["Tageszeit", world.time ? `${world.time.isNight ? "Nacht" : "Tag"}${world.time.day !== null && world.time.day !== undefined ? ` (Tag ${world.time.day})` : ""}` : null],
      ["Inventar", world.inventory?.length ? `${fmtNumber(world.inventory.reduce((sum, item) => sum + item.count, 0))} Gegenstände in ${world.inventory.length} Feldern` : live ? "leer" : null],
    ]),
    // Exact coordinates are for debugging, not for watching the agent: they stay one click away.
    h("details", { class: "small" }, h("summary", null, "Genaue Position"), kv([["Position", position ? `${position.x}, ${position.y}, ${position.z}` : null]])),
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
    "Die letzte Beobachtung ist veraltet",
    `Gelesen ${freshness.observedAt ? fmtAgo(freshness.observedAt, now) : "vor einiger Zeit"}. Bis eine neuere eintrifft, lehnt die Sicherheitsbremse Aktionen ab, die die Welt verändern (STALE_OBSERVATION); lesende Aktionen laufen weiter. The values below may be out of date.`,
  );
}

function meter(label, valueNow, max, live) {
  return h(
    "div",
    { class: "meter" },
    h("div", { class: "meter-head" }, h("span", null, label), h("strong", null, typeof valueNow === "number" ? `${fmtNumber(valueNow, valueNow % 1 ? 1 : 0)} / ${max}` : unknown(live ? "Die Sitzung hat das noch nicht gemeldet." : "Keine Sitzung.")),),
    progress(typeof valueNow === "number" ? valueNow : null, max, label),
  );
}

function currentTask(snapshot, now) {
  const active = snapshot.scheduler?.active;
  const progressInfo = activeProgress(snapshot);
  const agent = snapshot.agent;
  if (!active) {
    return card(
      { title: "Aktuelle Aufgabe" },
      empty(snapshot.session?.state === "idle" ? "Untätig" : "Keine Aufgabe", snapshot.session?.state === "idle" ? `Verbunden und wartend${snapshot.autonomyEnabled ? "; Autonomie ist an und nimmt Arbeit auf, sobald sich etwas lohnt" : ""}.` : agent?.blocker?.headline),
      snapshot.scheduler?.queue?.length ? h("p", { class: "muted" }, `${snapshot.scheduler.queue.length} queued: next is “${snapshot.scheduler.queue[0].label}”.`) : null,
      button("Aufgaben öffnen", { action: "goto-tab", data: { tab: "tasks" } }),
    );
  }
  return card(
    { title: "Aktuelle Aufgabe", actions: statusBadge(agent?.state === "stopping" ? "aborted" : "running") },
    h("p", { class: "task-title" }, active.label),
    kv([
      ["Gestartet von", active.origin],
      ["Laufzeit", active.startedAt ? fmtDuration(Math.max(0, now - Date.parse(active.startedAt))) : null],
      ["Aktionen bisher", agent ? fmtNumber(agent.actionsUsed) : null],
      ["Ziel", snapshot.goal?.rationale ?? null],
    ]),
    progressInfo ? h("div", null, progress(progressInfo.have, progressInfo.of, `Fortschritt ${progressInfo.unit}`), h("p", { class: "small muted" }, `${fmtNumber(progressInfo.have)} von ${fmtNumber(progressInfo.of)} ${progressInfo.unit}`)) : h("p", { class: "small muted" }, "Progress is not measurable for this task right now."),
    button("Aufgabe stoppen", { command: "stopTask", payload: "von der Übersicht gestoppt", tone: "warn" }),
  );
}

function activity(snapshot) {
  const items = (snapshot.events?.items ?? []).slice(-10).reverse();
  return card(
    { title: "Letzte Aktivität", subtitle: `${fmtNumber(snapshot.events?.total ?? 0)} Ereignisse aufgezeichnet`, actions: button("Ereignisprotokoll öffnen", { action: "goto-tab", data: { tab: "memory" } }) },
    items.length ? h("ol", { class: "event-list" }, items.map(eventRow)) : empty("Noch keine Ereignisse", "Verbindungen, Entscheidungen, Aktionen, Aufgabenwechsel und Fehler erscheinen hier, sobald sie passieren."),
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
    { title: "So liest du die Daten", class: "legend" },
    h("ul", { class: "legend-list" }, Object.entries(SOURCES).map(([key, info]) => h("li", null, sourceBadge(key), h("span", { class: "muted small" }, info.title)))),
    h("p", { class: "muted small" }, "Unbekannte Messwerte werden als „unbekannt“ angezeigt, nie als Standardzahl."),
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
