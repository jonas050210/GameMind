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
      name: session.target?.username ?? (session.source === "simulated" ? "Simulated bot" : "Bot"),
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
      h("div", null, h("h3", null, bot.name), h("p", { class: "muted small" }, session.target ? `${session.target.host}:${session.target.port} · Minecraft ${session.target.version}` : "Built-in offline simulator")),
      h("div", { class: "bot-badges" }, badge(state.label, state.tone), sourceBadge(session.source ?? "unavailable")),
    ),
    kv([
      ["Connection", snapshot.connection?.adapterStatus ?? null],
      ["World", session.worldKey ?? null],
      ["Task", task ? task.label : active ? "none (idle)" : null],
      ["Position", world.position ? `${world.position.x}, ${world.position.y}, ${world.position.z}` : null],
      ["Health", typeof world.health === "number" ? `${fmtNumber(world.health, 1)} / 20` : null],
      ["Food", typeof world.food === "number" ? `${fmtNumber(world.food)} / 20` : null],
      ["Runtime", session.runtimeMs !== null && session.runtimeMs !== undefined ? fmtDuration(session.runtimeMs) : null],
      ["Mode", session.mode ?? null],
      ["Autonomy", session.autonomy === null || session.autonomy === undefined ? null : session.autonomy ? "on" : "off"],
      ["Last task", lastTask ? h("span", null, statusBadge(lastTask.status ?? lastTask.state), " ", lastTask.label) : null],
    ]),
    source === "historical" ? h("p", { class: "muted small" }, "These values are from the last observation before the session ended.") : null,
    h(
      "footer",
      { class: "button-row" },
      active ? button("Stop session", { command: "stopSession", payload: "stopped from the Bots tab", tone: "warn", data: { confirm: "Stop this session and disconnect the bot?" } }) : null,
      active ? button(session.autonomy ? "Turn autonomy off" : "Turn autonomy on", { command: "setAutonomy", payload: { enabled: !session.autonomy }, title: "Autonomy starts survival and progress subgoals when the bot is idle. Safety limits are the same either way." }) : null,
      button("Start a task…", { action: "goto-tab", data: { tab: "tasks" }, tone: "primary", disabled: !active }),
      button("Stop task", { command: "stopTask", payload: "stopped from the Bots tab", disabled: !task }),
    ),
  );
}

function diagnostics(snapshot, now) {
  const session = snapshot.session;
  const platform = snapshot.app?.platform;
  const parts = [];
  if (session?.error) {
    parts.push(
      notice("bad", session.error.summary, h("p", { class: "small" }, "Things to check:"), h("ul", null, session.error.hints.map((hint) => h("li", null, hint))), h("p", { class: "small muted" }, `Error reported by the game connection: ${session.error.detail || "none"}`), h("p", { class: "small muted" }, session.error.retryable ? "Trying again can help once the cause is fixed." : "Retrying will not help until the cause is fixed.")),
    );
  }
  if (session?.reconnect) {
    parts.push(notice("warn", `Reconnecting: attempt ${session.reconnect.attempt} of ${session.reconnect.maxAttempts}`, session.reconnect.lastError ? `Last problem: ${session.reconnect.lastError}` : null));
  }
  if (platform?.wsl) {
    parts.push(
      notice("info", `Running inside WSL${platform.wslVersion ? ` ${platform.wslVersion}` : ""}${platform.distro ? ` (${platform.distro})` : ""}`, "If Minecraft runs on Windows, “localhost” from here is the Linux VM, not Windows. Use the Windows host address (the launcher detects it when it can), or enable mirrored networking. A world opened to LAN gets a new random port each time."),
    );
  }
  if (!parts.length) {
    parts.push(h("p", { class: "muted" }, session?.state === "idle" || session?.state === "running" ? "No connection problems." : "Connection diagnostics appear here when a connection fails or drops."));
  }
  const history = (session?.history ?? []).slice(-8).reverse();
  return card(
    { title: "Connection diagnostics", subtitle: "Why a connection failed, and what to check" },
    ...parts,
    history.length ? h("details", null, h("summary", null, "Session timeline"), h("ol", { class: "timeline" }, history.map((entry) => h("li", null, h("time", { datetime: entry.at }, fmtTime(entry.at)), " ", badge(entry.state, "neutral"), entry.reason ? ` ${entry.reason}` : "")))) : null,
  );
}

function safety(snapshot) {
  const safetyState = snapshot.safety;
  if (!safetyState) return card({ title: "Safety and run control" }, empty("No Safety Broker attached", "Without a session there is nothing to pause or trip."));
  return card(
    { title: "Safety and run control", subtitle: "The Safety Broker gates every world-changing action" },
    kv([
      ["Policy", safetyState.policyId],
      ["State", safetyState.tripped ? badge("TRIPPED", "bad") : safetyState.paused ? badge("PAUSED", "warn") : badge("ARMED", "good")],
      ["Approved / denied actions", `${fmtNumber(safetyState.actionsApproved)} / ${fmtNumber(safetyState.actionsDenied)}`],
      ["Combat", snapshot.combatAllowed === null || snapshot.combatAllowed === undefined ? null : snapshot.combatAllowed ? badge("armed", "warn") : badge("off (default)", "good")],
    ]),
    h(
      "div",
      { class: "button-row" },
      safetyState.paused ? button("Resume", { command: "resume", tone: "primary" }) : button("Pause", { command: "pause", payload: "paused from the Bots tab" }),
      button("Trip", { command: "trip", payload: "manual trip from the Bots tab", tone: "danger", data: { confirm: "Raise a safety trip? Only read-only actions run until you reset it." } }),
      button("Reset trip", { command: "resetTrip", disabled: !safetyState.tripped }),
      snapshot.combatAllowed === null || snapshot.combatAllowed === undefined
        ? null
        : button(snapshot.combatAllowed ? "Fighting allowed: turn off" : "Fighting off: allow", { command: "enableCombat", payload: { enabled: !snapshot.combatAllowed }, tone: snapshot.combatAllowed ? "" : "warn", data: snapshot.combatAllowed ? {} : { confirm: "Allow the bot to fight back against hostile mobs that threaten it? It attacks only with a weapon, enough health, and one enemy at a time, and it withdraws when health gets low." } }),
    ),
    (safetyState.recentVerdicts ?? []).length
      ? h("details", null, h("summary", null, "Recent safety verdicts"), table({ dense: true, columns: [{ label: "Time", cell: (v) => fmtTime(v.evaluatedAt) }, { label: "Capability", cell: (v) => v.capability }, { label: "Verdict", cell: (v) => (v.allowed ? badge("allowed", "good") : badge("denied", "warn")) }, { label: "Why", cell: (v) => v.message }], rows: safetyState.recentVerdicts.map((v, index) => ({ key: index, value: v })) }))
      : null,
  );
}

function loop(snapshot) {
  const loopState = snapshot.agentLoop;
  if (!loopState) return card({ title: "Agent loop" }, empty("Not measured", "The observation loop is measured while a session runs."));
  const sample = (summary) => (summary && summary.p95Ms !== null ? `${fmtNumber(summary.p95Ms, 0)} ms` : null);
  return card(
    { title: "Agent loop", subtitle: "Measured timing of the fast observation loop" },
    kv([
      ["Observation rate", loopState.observation.frequencyHz !== null ? `${fmtNumber(loopState.observation.frequencyHz, 1)} per second` : null],
      ["Observation age", loopState.observation.ageMs !== null ? `${fmtNumber(loopState.observation.ageMs, 0)} ms${loopState.observation.stale ? " (stale)" : ""}` : null],
      ["Reaction p95", sample(loopState.reactionMs)],
      ["Decision p95", sample(loopState.decisionMs)],
      ["Action p95", sample(loopState.actionMs)],
      ["Observation errors", `${fmtNumber(loopState.observation.errors)} of ${fmtNumber(loopState.observation.total)}`],
      ["Time idle", loopState.idle.idleFraction !== null ? fmtPercent(loopState.idle.idleFraction, 0) : null],
    ]),
    h("div", null, loopState.targets.length ? h("ul", { class: "targets" }, loopState.targets.map((target) => h("li", null, target.met === null ? badge("not measured", "neutral") : target.met ? badge("met", "good") : badge("missed", "warn"), ` ${target.label}: ${target.measuredMs === null ? "unknown" : `${fmtNumber(target.measuredMs, 0)} ms`} (target ${fmtNumber(target.targetMs, 0)} ms)`))) : null),
  );
}

function history(snapshot) {
  const entries = snapshot.scheduler?.history ?? [];
  return card(
    { title: "Task history and failure explanations", subtitle: "Newest first. A failure names what stopped the task and what you can do about it." },
    table({
      caption: "Recent tasks",
      empty: { title: "No tasks yet", detail: "Tasks started by you, the command line, the Library or autonomy appear here with their outcome." },
      columns: [
        { label: "Finished", cell: (t) => (t.finishedAt ? fmtTime(t.finishedAt) : "—") },
        { label: "Task", cell: (t) => t.label },
        { label: "Started by", cell: (t) => t.origin },
        { label: "Outcome", cell: (t) => statusBadge(t.status ?? t.state) },
        { label: "Actions", align: "right", cell: (t) => orUnknown(t.actions, fmtNumber) },
        { label: "Why it ended", cell: (t) => failureCell(t) },
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
  if (entry.params.length === 0) return button("Run", { command: "libraryExecute", payload: { id: entry.id, params: {} } });
  return h.stat(`library-form-${entry.id}`, h("form", { class: "inline-form", "data-library-id": entry.id }, entry.params.map((param) => libraryParamInput(entry.id, param)), button("Run", { type: "submit" })));
}

function library(snapshot) {
  const catalog = snapshot.library?.catalog ?? [];
  if (!catalog.length) return card({ title: "Library actions (advanced)" }, empty("Not available", "The Library needs a connected session."));
  const categories = [...new Set(catalog.map((entry) => entry.category))];
  const operations = (snapshot.library?.operations ?? []).slice(0, 6);
  return card(
    { title: "Library actions (advanced)", subtitle: `${catalog.length} typed actions the agent implements; each runs through the same safety gates` },
    h(
      "details",
      null,
      h("summary", null, "Show actions"),
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
    operations.length ? h("div", null, h("h4", null, "Recent Library operations"), table({ dense: true, columns: [{ label: "Started", cell: (o) => fmtTime(o.startedAt) }, { label: "Action", cell: (o) => o.title }, { label: "State", cell: (o) => statusBadge(o.state === "succeeded" ? "passed" : o.state === "refused" ? "blocked" : o.state) }, { label: "Message", cell: (o) => o.message }], rows: operations.map((o) => ({ key: o.id, value: o })) })) : null,
  );
}

export function renderBots(ctx) {
  const { snapshot, now } = ctx;
  const bots = botsFrom(snapshot);
  return {
    "bots-list": h(
      "div",
      { class: "bot-list" },
      bots.length
        ? bots.map((bot) => botCard(bot, now))
        : card({ title: "No bot yet" }, empty("No session", "Connect to a Minecraft server or to the offline simulator below. One bot runs per process today; this list is built per bot so more can be added later.")),
    ),
    "bots-diagnostics": diagnostics(snapshot, now),
    "bots-safety": safety(snapshot),
    "loop-targets": loop(snapshot),
    "bots-history": history(snapshot),
    "bots-library": library(snapshot),
  };
}

export { chips, progress, humanise, fmtDateTime, fmtAgo };
