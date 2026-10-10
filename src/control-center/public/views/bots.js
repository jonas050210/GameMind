import { h } from "../lib/h.js";
import { badge, button, card, chips, empty, kv, notice, progress, sourceBadge, statusBadge, table, unknown } from "../lib/ui.js";
import { fmtAgo, fmtDateTime, fmtDuration, fmtNumber, fmtPercent, fmtTime, humanise, orUnknown } from "../lib/format.js";
import { botState, worldSource } from "../lib/model.js";

/** One card per bot. Today a process has at most one session, but the list is keyed by bot id so more can be added. */
export function botsFrom(snapshot) {
  const session = snapshot.session;
  if (!session || session.state === "none") return [];
  return [
    {
      id: session.id ?? "session",
      name: session.target?.username ?? (session.source === "simulated" ? "Simulierter Bot" : "Bot"),
      session,
      snapshot,
    },
  ];
}

function botCard(bot, now) {
  const { session, snapshot } = bot;
  const state = botState(session, snapshot.scheduler);
  const world = snapshot.world;
  const active = session.state !== "shutdown";
  const task = snapshot.scheduler?.active;
  const source = worldSource(snapshot);
  const lastTask = snapshot.scheduler?.history?.[0];
  return h(
    "article",
    { class: `bot tone-${state.tone}`, key: bot.id, "aria-label": `Bot ${bot.name}` },
    h(
      "header",
      { class: "bot-head" },
      h("div", null, h("h3", null, bot.name), h("p", { class: "muted small" }, session.target ? `${session.target.host}:${session.target.port} · Minecraft ${session.target.version}` : "Eingebauter Offline-Simulator")),
      h("div", { class: "bot-badges" }, badge(state.label, state.tone), sourceBadge(session.source ?? "unavailable")),
    ),
    kv([
      ["Verbindung", snapshot.connection?.adapterStatus ?? null],
      ["Welt", session.worldKey ?? null],
      ["Aufgabe", task ? task.label : active ? "keine (untätig)" : null],
      ["Gesundheit", typeof world.health === "number" ? `${fmtNumber(world.health, 1)} / 20` : null],
      ["Nahrung", typeof world.food === "number" ? `${fmtNumber(world.food)} / 20` : null],
      ["Laufzeit", session.runtimeMs !== null && session.runtimeMs !== undefined ? fmtDuration(session.runtimeMs) : null],
      ["Modus", session.mode ?? null],
      ["Autonomie", session.autonomy === null || session.autonomy === undefined ? null : session.autonomy ? "an" : "aus"],
      ["Letzte Aufgabe", lastTask ? h("span", null, statusBadge(lastTask.status ?? lastTask.state), " ", lastTask.label) : null],
    ]),
    source === "historical" ? h("p", { class: "muted small" }, "Diese Werte stammen von der letzten Beobachtung, bevor die Sitzung endete.") : null,
    // Exact coordinates are for debugging, not for watching the agent: they stay one click away.
    world.position ? h("details", { class: "small" }, h("summary", null, "Genaue Position"), kv([["Position", `${world.position.x}, ${world.position.y}, ${world.position.z}`]])) : null,
    h(
      "footer",
      { class: "button-row" },
      active ? button("Sitzung beenden", { command: "stopSession", payload: "von der Bots-Seite beendet", tone: "warn", data: { confirm: "Diese Sitzung beenden und den Bot trennen?" } }) : null,
      active ? button(session.autonomy ? "Autonomie aus" : "Autonomie an", { command: "setAutonomy", payload: { enabled: !session.autonomy }, title: "Die Autonomie startet im Leerlauf Überlebens- und Fortschrittsziele. Die Sicherheitsgrenzen gelten in beiden Fällen gleich." }) : null,
      button("Aufgabe starten …", { action: "goto-tab", data: { tab: "tasks" }, tone: "primary", disabled: !active }),
      button("Aufgabe stoppen", { command: "stopTask", payload: "von der Bots-Seite gestoppt", disabled: !task }),
    ),
  );
}

function diagnostics(snapshot, now) {
  const session = snapshot.session;
  const platform = snapshot.app?.platform;
  const parts = [];
  if (session?.error) {
    parts.push(
      notice("bad", session.error.summary, h("p", { class: "small" }, "Das solltest du prüfen:"), h("ul", null, session.error.hints.map((hint) => h("li", null, hint))), h("p", { class: "small muted" }, `Error reported by the game connection: ${session.error.detail || "none"}`), h("p", { class: "small muted" }, session.error.retryable ? "Trying again can help once the cause is fixed." : "Retrying will not help until the cause is fixed.")),
    );
  }
  if (session?.reconnect) {
    parts.push(notice("warn", `Wiederverbindung: Versuch ${session.reconnect.attempt} von ${session.reconnect.maxAttempts}`, session.reconnect.lastError ? `Letztes Problem: ${session.reconnect.lastError}` : null));
  }
  if (platform?.wsl) {
    parts.push(
      notice("info", `Running inside WSL${platform.wslVersion ? ` ${platform.wslVersion}` : ""}${platform.distro ? ` (${platform.distro})` : ""}`, "If Minecraft runs on Windows, “localhost” from here is the Linux VM, not Windows. Use the Windows host address (the launcher detects it when it can), or enable mirrored networking. A world opened to LAN gets a new random port each time."),
    );
  }
  if (!parts.length) {
    parts.push(h("p", { class: "muted" }, session?.state === "idle" || session?.state === "running" ? "Keine Verbindungsprobleme." : "Verbindungsdiagnosen erscheinen hier, wenn eine Verbindung fehlschlägt oder abbricht."));
  }
  const history = (session?.history ?? []).slice(-8).reverse();
  return card(
    { title: "Verbindungsdiagnose", subtitle: "Warum eine Verbindung fehlschlug und was du prüfen kannst" },
    ...parts,
    history.length ? h("details", null, h("summary", null, "Zeitleiste der Sitzung"), h("ol", { class: "timeline" }, history.map((entry) => h("li", null, h("time", { datetime: entry.at }, fmtTime(entry.at)), " ", badge(entry.state, "neutral"), entry.reason ? ` ${entry.reason}` : "")))) : null,
  );
}

function safety(snapshot) {
  const safetyState = snapshot.safety;
  if (!safetyState) return card({ title: "Sicherheit und Laufsteuerung" }, empty("Keine Sicherheitsbremse angeschlossen", "Ohne Sitzung gibt es nichts zu pausieren oder auszulösen."));
  return card(
    { title: "Sicherheit und Laufsteuerung", subtitle: "Die Sicherheitsbremse prüft jede Aktion, die die Welt verändert" },
    kv([
      ["Richtlinie", safetyState.policyId],
      ["State", safetyState.tripped ? badge("AUSGELÖST", "bad") : safetyState.paused ? badge("PAUSIERT", "warn") : badge("BEREIT", "good")],
      ["Erlaubt / abgelehnt", `${fmtNumber(safetyState.actionsApproved)} / ${fmtNumber(safetyState.actionsDenied)}`],
      ["Kampf", snapshot.combatAllowed === null || snapshot.combatAllowed === undefined ? null : snapshot.combatAllowed ? badge("erlaubt", "warn") : badge("aus (Standard)", "good")],
    ]),
    h(
      "div",
      { class: "button-row" },
      safetyState.paused ? button("Fortsetzen", { command: "resume", tone: "primary" }) : button("Pausieren", { command: "pause", payload: "von der Bots-Seite pausiert" }),
      button("Bremse auslösen", { command: "trip", payload: "manuell von der Bots-Seite ausgelöst", tone: "danger", data: { confirm: "Sicherheitsbremse auslösen? Bis du sie zurücksetzt, laufen nur lesende Aktionen." } }),
      button("Bremse zurücksetzen", { command: "resetTrip", disabled: !safetyState.tripped }),
      snapshot.combatAllowed === null || snapshot.combatAllowed === undefined
        ? null
        : button(snapshot.combatAllowed ? "Kampf erlaubt: ausschalten" : "Kampf aus: erlauben", { command: "enableCombat", payload: { enabled: !snapshot.combatAllowed }, tone: snapshot.combatAllowed ? "" : "warn", data: snapshot.combatAllowed ? {} : { confirm: "Allow the bot to fight back against hostile mobs that threaten it? It attacks only with a weapon, enough health, and one enemy at a time, and it withdraws when health gets low." } }),
    ),
    (safetyState.recentVerdicts ?? []).length
      ? h("details", null, h("summary", null, "Letzte Sicherheitsurteile"), table({ dense: true, columns: [{ label: "Time", cell: (v) => fmtTime(v.evaluatedAt) }, { label: "Capability", cell: (v) => v.capability }, { label: "Verdict", cell: (v) => (v.allowed ? badge("allowed", "good") : badge("denied", "warn")) }, { label: "Why", cell: (v) => v.message }], rows: safetyState.recentVerdicts.map((v, index) => ({ key: index, value: v })) }))
      : null,
  );
}

function loop(snapshot) {
  const loopState = snapshot.agentLoop;
  if (!loopState) return card({ title: "Agentenschleife" }, empty("Nicht gemessen", "Die Beobachtungsschleife wird während einer laufenden Sitzung gemessen."));
  const sample = (summary) => (summary && summary.p95Ms !== null ? `${fmtNumber(summary.p95Ms, 0)} ms` : null);
  return card(
    { title: "Agentenschleife", subtitle: "Gemessene Zeiten der schnellen Beobachtungsschleife" },
    kv([
      ["Beobachtungsrate", loopState.observation.frequencyHz !== null ? `${fmtNumber(loopState.observation.frequencyHz, 1)} pro Sekunde` : null],
      ["Alter der Beobachtung", loopState.observation.ageMs !== null ? `${fmtNumber(loopState.observation.ageMs, 0)} ms${loopState.observation.stale ? " (veraltet)" : ""}` : null],
      ["Reaktion p95", sample(loopState.reactionMs)],
      ["Entscheidung p95", sample(loopState.decisionMs)],
      ["Aktion p95", sample(loopState.actionMs)],
      ["Beobachtungsfehler", `${fmtNumber(loopState.observation.errors)} of ${fmtNumber(loopState.observation.total)}`],
      ["Leerlaufzeit", loopState.idle.idleFraction !== null ? fmtPercent(loopState.idle.idleFraction, 0) : null],
    ]),
    h("div", null, loopState.targets.length ? h("ul", { class: "targets" }, loopState.targets.map((target) => h("li", null, target.met === null ? badge("not measured", "neutral") : target.met ? badge("met", "good") : badge("missed", "warn"), ` ${target.label}: ${target.measuredMs === null ? "unknown" : `${fmtNumber(target.measuredMs, 0)} ms`} (target ${fmtNumber(target.targetMs, 0)} ms)`))) : null),
  );
}

function history(snapshot) {
  const entries = snapshot.scheduler?.history ?? [];
  return card(
    { title: "Aufgabenverlauf und Fehlererklärungen", subtitle: "Neueste zuerst. Ein Fehler nennt, was die Aufgabe gestoppt hat, und was du dagegen tun kannst." },
    table({
      caption: "Letzte Aufgaben",
      empty: { title: "Noch keine Aufgaben", detail: "Aufgaben, die du, die Kommandozeile, die Bibliothek oder die Autonomie gestartet hat, erscheinen hier mit ihrem Ergebnis." },
      columns: [
        { label: "Beendet", cell: (t) => (t.finishedAt ? fmtTime(t.finishedAt) : "—") },
        { label: "Aufgabe", cell: (t) => t.label },
        { label: "Gestartet von", cell: (t) => t.origin },
        { label: "Ergebnis", cell: (t) => statusBadge(t.status ?? t.state) },
        { label: "Aktionen", align: "right", cell: (t) => orUnknown(t.actions, fmtNumber) },
        { label: "Warum es endete", cell: (t) => failureCell(t) },
      ],
      rows: entries.slice(0, 15).map((t) => ({ key: t.ticketId, value: t })),
    }),
  );
}

export function failureCell(ticket) {
  if (ticket.failure) {
    const classified = ticket.classification;
    return h(
      "div",
      { class: "failure" },
      h("div", null, badge(classified?.label ?? ticket.failure.code, classified?.kind === "safety" ? "warn" : "bad"), " ", h("code", null, ticket.failure.code)),
      h("p", { class: "small" }, ticket.failure.message),
      classified?.hint ? h("p", { class: "small muted" }, classified.hint) : null,
      classified ? h("p", { class: "small muted" }, `${classified.kind} · owner: ${classified.owner} · ${classified.retryable ? "the agent can retry on its own" : "needs a change before it can succeed"}`) : null,
    );
  }
  if (ticket.note) return h("span", { class: "small" }, ticket.note);
  return ticket.status === "succeeded" ? h("span", { class: "muted small" }, "completed") : unknown();
}

/** One control per Library parameter. Built once per entry (`h.stat`), so a refresh never clears what is being typed. */
function libraryParamInput(entryId, param) {
  const common = {
    id: `lib-${entryId}-${param.name}`,
    name: param.name,
    "data-param": param.name,
    "data-type": param.type,
    "aria-label": param.label,
    title: param.help ?? param.label,
    ...(param.required ? { required: true } : {}),
  };
  if (param.type === "boolean") return h("label", { class: "choice" }, h("input", { ...common, type: "checkbox", ...(param.def === true ? { checked: true } : {}) }), param.label);
  if (param.type === "select") {
    return h("select", common, (param.options ?? []).map((option) => h("option", { value: option.value, ...(String(param.def ?? "") === option.value ? { selected: true } : {}) }, option.label)));
  }
  if (param.type === "integer" || param.type === "number") {
    return h("input", { ...common, type: "number", step: param.type === "integer" ? 1 : "any", placeholder: param.label, ...(typeof param.min === "number" ? { min: param.min } : {}), ...(typeof param.max === "number" ? { max: param.max } : {}), ...(param.def !== undefined && param.def !== null ? { value: param.def } : {}) });
  }
  return h("input", { ...common, type: "text", placeholder: param.label, ...(typeof param.maxLength === "number" ? { maxlength: param.maxLength } : {}), ...(param.pattern ? { pattern: param.pattern } : {}), ...(typeof param.def === "string" ? { value: param.def } : {}) });
}

function libraryRunControl(entry) {
  if (entry.status === "unavailable") return null;
  if (entry.params.length === 0) return button("Ausführen", { command: "libraryExecute", payload: { id: entry.id, params: {} } });
  return h.stat(`library-form-${entry.id}`, h("form", { class: "inline-form", "data-library-id": entry.id }, entry.params.map((param) => libraryParamInput(entry.id, param)), button("Ausführen", { type: "submit" })));
}

function library(snapshot) {
  const catalog = snapshot.library?.catalog ?? [];
  if (!catalog.length) return card({ title: "Bibliotheksaktionen (fortgeschritten)" }, empty("Nicht verfügbar", "Die Bibliothek braucht eine verbundene Sitzung."));
  const categories = [...new Set(catalog.map((entry) => entry.category))];
  const operations = (snapshot.library?.operations ?? []).slice(0, 6);
  return card(
    { title: "Bibliotheksaktionen (fortgeschritten)", subtitle: `${catalog.length} typisierte Aktionen, die der Agent umsetzt; jede läuft durch dieselben Sicherheitsprüfungen` },
    h(
      "details",
      null,
      h("summary", null, "Aktionen anzeigen"),
      categories.map((category) =>
        h(
          "div",
          { class: "library-category" },
          h("h4", null, category),
          h(
            "ul",
            { class: "library-list" },
            catalog
              .filter((entry) => entry.category === category)
              .map((entry) => h("li", { key: entry.id }, h("div", null, h("strong", null, entry.title), " ", badge(entry.status, entry.status === "implemented" ? "good" : entry.status === "experimental" ? "warn" : "neutral"), h("p", { class: "small muted" }, entry.status === "unavailable" ? (entry.statusReason ?? entry.description) : entry.description)), libraryRunControl(entry))),
          ),
        ),
      ),
    ),
    operations.length ? h("div", null, h("h4", null, "Letzte Bibliotheksvorgänge"), table({ dense: true, columns: [{ label: "Started", cell: (o) => fmtTime(o.startedAt) }, { label: "Action", cell: (o) => o.title }, { label: "State", cell: (o) => statusBadge(o.state === "succeeded" ? "passed" : o.state === "refused" ? "blocked" : o.state) }, { label: "Message", cell: (o) => o.message }], rows: operations.map((o) => ({ key: o.id, value: o })) })) : null,
  );
}

const TEST_SERVER_LABELS = {
  unknown: ["Noch nicht geprüft", "neutral"],
  "docker-missing": ["Docker fehlt", "bad"],
  "docker-stopped": ["Docker läuft nicht", "bad"],
  stopped: ["Gestoppt", "neutral"],
  starting: ["Startet…", "neutral"],
  running: ["Läuft", "good"],
  stopping: ["Stoppt…", "neutral"],
  failed: ["Fehlgeschlagen", "bad"],
};

/** The offline test server (Docker, vanilla 1.20.4) with the three things an operator needs: state, connection details, and the buttons. */
export function testServerCard(status) {
  if (!status) return card({ title: "Offline-Testserver" }, empty("Noch nicht geprüft", "Der Zustand des Docker-Testservers erscheint gleich hier."));
  const [label, tone] = TEST_SERVER_LABELS[status.state] ?? ["Unknown", "neutral"];
  const running = status.state === "running";
  const docker = status.state !== "docker-missing" && status.state !== "docker-stopped";
  const busy = Boolean(status.busy);
  return card(
    { title: "Offline-Testserver", subtitle: "Vanilla Minecraft 1.20.4 in Docker auf diesem Rechner. Anmeldung offline, nichts verlässt diesen PC.", actions: badge(label, tone) },
    notice(tone === "bad" ? "warn" : "neutral", status.message),
    kv([
      ["Verbinden mit", `${status.connection.host}:${status.connection.port}`],
      ["Version", status.connection.version],
      ["Anmeldung", status.connection.auth],
    ]),
    h(
      "footer",
      { class: "button-row" },
      button("Testserver starten", { command: "startTestServer", tone: "primary", disabled: running || busy || !docker }),
      button("Testserver stoppen", { command: "stopTestServer", tone: "warn", disabled: !running || busy, data: { confirm: "Testserver stoppen? Die Welt bleibt im Docker-Volume erhalten." } }),
      button("Verbindung übernehmen", { action: "use-test-server", title: "Füllt Host, Port, Version und Anmeldung im Formular unten aus" }),
    ),
  );
}

export function renderBots(ctx) {
  const { snapshot, now } = ctx;
  const bots = botsFrom(snapshot);
  return {
    "bots-testserver": testServerCard(ctx.data?.testServer?.value ?? null),
    "bots-list": h(
      "div",
      { class: "bot-list" },
      bots.length
        ? bots.map((bot) => botCard(bot, now))
        : card({ title: "Noch kein Bot" }, empty("Keine Sitzung", "Verbinde dich unten mit einem Minecraft-Server oder dem Offline-Simulator. Heute läuft ein Bot pro Prozess.")),
    ),
    "bots-diagnostics": diagnostics(snapshot, now),
    "bots-safety": safety(snapshot),
    "loop-targets": loop(snapshot),
    "bots-history": history(snapshot),
    "bots-library": library(snapshot),
  };
}

export { chips, progress, humanise, fmtDateTime, fmtAgo };
