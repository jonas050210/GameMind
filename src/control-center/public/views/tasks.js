import { h } from "../lib/h.js";
import { badge, button, card, empty, kv, notice, progress, statusBadge, table, unknown } from "../lib/ui.js";
import { fmtAgo, fmtDuration, fmtNumber, fmtPercent, fmtTime, humanise, orUnknown } from "../lib/format.js";
import { activeProgress, queueExplanation, taskBlocker } from "../lib/model.js";
import { failureCell } from "./bots.js";

function active(snapshot, now) {
  const task = snapshot.scheduler?.active;
  if (!task) {
    const blocker = taskBlocker(snapshot);
    return card({ title: "Aktive Aufgabe" }, empty("Keine Aufgabe läuft", blocker ?? "Starte unten eine Aufgabe, oder lass die Autonomie Arbeit wählen."));
  }
  const measured = activeProgress(snapshot);
  const agent = snapshot.agent;
  return card(
    { title: "Aktive Aufgabe", actions: statusBadge(agent?.state === "stopping" ? "aborted" : "running") },
    h("p", { class: "task-title" }, task.label),
    kv([
      ["Gestartet von", task.origin],
      ["Gestartet", task.startedAt ? `${fmtTime(task.startedAt)} (${fmtAgo(task.startedAt, now)})` : null],
      ["Entscheidung", snapshot.goal ? `${snapshot.goal.rationale}` : null],
      ["Skill", snapshot.goal?.skillId ?? null],
      ["Genutzte Aktionen", agent ? fmtNumber(agent.actionsUsed) : null],
      ["Stopp angefordert", agent?.stoppingRequestedAt ? fmtTime(agent.stoppingRequestedAt) : "nein"],
    ]),
    measured ? h("div", null, progress(measured.have, measured.of, `Fortschritt in ${measured.unit}`), h("p", { class: "small" }, `${fmtNumber(measured.have)} of ${fmtNumber(measured.of)} ${measured.unit} (${fmtPercent(measured.fraction, 0)})`)) : h("p", { class: "muted small" }, "Progress is not measurable for this task right now; it is shown only when the world reports it."),
    snapshot.recentActions?.length ? h("details", { open: true }, h("summary", null, "Letzte Aktionen"), table({ dense: true, columns: [{ label: "Time", cell: (a) => fmtTime(a.at) }, { label: "Skill", cell: (a) => humanise(a.skillId) }, { label: "Result", cell: (a) => statusBadge(a.status === "succeeded" ? (a.confirmed === false ? "failed" : "passed") : a.status) }, { label: "Verified", cell: (a) => (a.verification ? humanise(a.verification) : unknown()) }, { label: "Note", cell: (a) => a.note ?? "" }], rows: snapshot.recentActions.slice(0, 6).map((a, index) => ({ key: index, value: a })) })) : null,
    button("Aufgabe stoppen", { command: "stopTask", payload: "von der Aufgaben-Seite gestoppt", tone: "warn" }),
  );
}

const BAND_NAMES = ["Sicherheit", "Überleben", "Fortschritt"];

function bandText(band) {
  return typeof band === "number" ? `${BAND_NAMES[band] ?? "Stufe"} (Stufe ${band})` : null;
}

/** What the session reported about one fact when the decision was made, with the evidence behind it. */
function factText(fact) {
  if (!fact || typeof fact !== "object") return null;
  return `${fact.value ?? "unknown"} · ${fact.evidence ?? "no evidence recorded"}`;
}

/**
 * The newest decision the agent recorded, with what it weighed and why it dropped the rest. The fields are the decision
 * record itself (the one written to the trace), not a summary made for this page. A candidate's `input` and `targetKey` are
 * left out on purpose: they hold block coordinates, and the page does not publish those.
 */
function decision(snapshot, now) {
  const latest = Array.isArray(snapshot.recentDecisions) ? snapshot.recentDecisions[0] : null;
  const data = latest?.data;
  if (!data || typeof data !== "object") {
    return card(
      { title: "Letzte Entscheidung" },
      empty("Noch keine Entscheidung aufgezeichnet", "Jedes Mal, wenn der Agent seinen nächsten Schritt wählt, wird die Wahl hier mit den abgewogenen Alternativen festgehalten. Es erscheint nichts, bis eine Aufgabe oder die Autonomie etwas entschieden hatne."),
    );
  }
  const selected = data.selected ?? null;
  const alternatives = Array.isArray(data.alternatives) ? data.alternatives : [];
  const rejected = Array.isArray(data.rejected) ? data.rejected : [];
  const when = latest.timestamp ? fmtAgo(latest.timestamp, now) : null;
  return card(
    {
      title: "Letzte Entscheidung",
      subtitle: [data.modelId, data.observationSequence !== undefined && data.observationSequence !== null ? `observation #${fmtNumber(data.observationSequence)}` : null, when].filter(Boolean).join(" · "),
      actions: data.blockingCode ? badge(data.blockingCode, "warn") : null,
    },
    h("p", { class: "task-title" }, data.summary ?? "Für diese Entscheidung wurde keine Zusammenfassung aufgezeichnet."),
    kv([
      ["Gewähltes Ziel", selected ? selected.goalId : "Keines: das Modell hat ohne Wahl angehalten"],
      ["Skill", selected?.skillId ?? null],
      ["Prioritätsstufe", bandText(selected?.priorityBand ?? data.band)],
      ["Warum", selected?.rationale ?? null],
      ["Plan", Array.isArray(data.plan) && data.plan.length ? data.plan.join(" → ") : null],
      ["Sicherheitsurteil", data.safety ? `${data.safety.allowed ? "erlaubt" : "abgelehnt"} · ${data.safety.code}: ${data.safety.message}` : null],
      ["Gesehener Spielmodus", factText(data.session?.gameMode)],
      ["Gesehene Dimension", factText(data.session?.dimension)],
      // Only a decision that was a training switch has this row; for every other decision "unknown" would be wrong.
      ...(data.exploration ? [["Erkundungswechsel", "Diese Wahl war ein aufgezeichneter Erkundungswechsel für das Training, nicht die erste Wahl des Modells"]] : []),
    ]),
    alternatives.length
      ? h(
          "details",
          null,
          h("summary", null, `Alternatives considered (${fmtNumber(alternatives.length)})`),
          table({
            dense: true,
            columns: [
              { label: "Ziel", cell: (a) => a.goalId },
              { label: "Band", cell: (a) => bandText(a.priorityBand) ?? unknown("Not recorded.") },
              { label: "Score", align: "right", cell: (a) => (typeof a.score === "number" ? fmtNumber(a.score, 2) : unknown("Not recorded.")) },
              { label: "Warum es ein Kandidat war", cell: (a) => a.rationale ?? unknown("Not recorded.") },
            ],
            rows: alternatives.map((entry, index) => ({ key: `alt-${index}`, value: entry })),
          }),
        )
      : h("p", { class: "muted small" }, "No other candidate was left to weigh."),
    rejected.length
      ? h(
          "details",
          null,
          h("summary", null, `Verworfene Kandidaten (${fmtNumber(rejected.length)})`),
          table({
            dense: true,
            columns: [
              { label: "Goal", cell: (r) => r.goalId },
              { label: "Grund", cell: (r) => humanise(r.reason) },
              { label: "Details", cell: (r) => r.detail ?? unknown("Nicht aufgezeichnet.") },
            ],
            rows: rejected.map((entry, index) => ({ key: `rej-${index}`, value: entry })),
          }),
        )
      : null,
  );
}

function queue(snapshot) {
  const scheduler = snapshot.scheduler;
  const explanation = queueExplanation(snapshot);
  if (!scheduler) return card({ title: "Queue" }, empty("Warteschlange nicht verfügbar", explanation.text));
  return card(
    { title: "Warteschlange", subtitle: "Aufgaben laufen nacheinander, in dieser Reihenfolge", actions: scheduler.queue.length ? button("Warteschlange leeren", { command: "clearTaskQueue", tone: "warn" }) : null },
    h("p", { class: explanation.available ? "muted small" : "small" }, explanation.text),
    scheduler.queue.length
      ? h("ol", { class: "queue" }, scheduler.queue.map((ticket) => h("li", { key: ticket.ticketId }, h("div", null, h("strong", null, ticket.label), h("p", { class: "small muted" }, `${ticket.origin} · position ${ticket.position}`)), button("Cancel", { command: "cancelQueuedTask", payload: { ticketId: ticket.ticketId } }))))
      : h("p", { class: "muted" }, "Nichts wartet."),
    scheduler.reservation ? notice("info", `Der nächste Platz ist für die Aufgabe „${scheduler.reservation.label}“ von ${scheduler.reservation.owner} reserviert`, "Autonomie und andere Quellen warten, bis sie startet.") : null,
    scheduler.lastRefusal ? h("p", { class: "small muted" }, `Last refusal (${scheduler.lastRefusal.origin}, ${fmtTime(scheduler.lastRefusal.at)}): ${scheduler.lastRefusal.message}`) : null,
    h("p", { class: "small muted" }, "No overlap: a second task is refused or queued, never run alongside the first. An identical task cannot be queued twice. An operator task asks autonomy to stop at its next action boundary and then starts."),
  );
}

function objective(snapshot, now) {
  const objectiveState = snapshot.objective;
  return card(
    { title: "Ziel & Teilziel", subtitle: "Worauf die Autonomie hinarbeitet, wenn du nichts angefordert hast", actions: button(snapshot.autonomyEnabled ? "Turn autonomy off" : "Turn autonomy on", { command: "setAutonomy", payload: { enabled: !snapshot.autonomyEnabled }, disabled: snapshot.autonomyEnabled === null || snapshot.autonomyEnabled === undefined, title: "Safety limits, budgets and combat restrictions are identical either way." }) },
    h(
      "div",
      null,
      snapshot.autonomyEnabled === null || snapshot.autonomyEnabled === undefined
        ? empty("Nicht verfügbar", "Die Autonomie existiert nur während einer Sitzung.")
        : [
            kv([
              ["Autonomie", snapshot.autonomyEnabled ? badge("an", "good") : badge("aus", "neutral")],
              ["Ziel", objectiveState?.objective ?? null],
              ["Aktuelles Teilziel", objectiveState?.subgoal ?? null],
              ["Abschlusstest", objectiveState?.completion ?? null],
              ["Warum dieses Teilziel", objectiveState?.reason ?? null],
              ["Entschiedene Teilziele", objectiveState ? fmtNumber(objectiveState.decided) : null],
            ]),
            objectiveState?.cooldowns?.length ? h("details", null, h("summary", null, `${objectiveState.cooldowns.length} subgoal(s) cooling down after repeated no-progress attempts`), h("ul", null, objectiveState.cooldowns.map((entry) => h("li", null, h("code", null, entry.signature), ` until ${fmtTime(entry.until)} — ${entry.reason}`)))) : null,
          ],
    ),
  );
}

function historyCard(snapshot) {
  const entries = snapshot.scheduler?.history ?? [];
  return card(
    { title: "Aufgabenergebnisse", subtitle: "Gemessene Ergebnisse; eine Aufgabe gilt nur als „PASS“, wenn der Lauf ihr Ziel geprüft hat" },
    table({
      caption: "Aufgabenergebnisse",
      empty: { title: "Noch keine beendeten Aufgaben" },
      columns: [
        { label: "Beendet", cell: (t) => (t.finishedAt ? fmtTime(t.finishedAt) : "—") },
        { label: "Aufgabe", cell: (t) => t.label },
        { label: "Ergebnis", cell: (t) => statusBadge(t.status ?? t.state) },
        { label: "Fortschritt", align: "right", cell: (t) => (typeof t.progressRatio === "number" ? fmtPercent(t.progressRatio, 0) : unknown()) },
        { label: "Aktionen", align: "right", cell: (t) => orUnknown(t.actions, fmtNumber) },
        { label: "Dauer", align: "right", cell: (t) => orUnknown(t.elapsedMs, fmtDuration) },
        { label: "Warum es endete", cell: (t) => failureCell(t) },
      ],
      rows: entries.slice(0, 20).map((t) => ({ key: t.ticketId, value: t })),
    }),
  );
}

function progression(snapshot) {
  const progressionState = snapshot.progression;
  if (!progressionState) return card({ title: "Autonomer Fortschritt" }, empty("Nicht verfügbar", "Meilensteine werden während einer Sitzung verfolgt."));
  return card(
    { title: "Autonomer Fortschritt", subtitle: `Aktueller Meilenstein: ${progressionState.currentMilestoneName}` },
    h("ol", { class: "milestones" }, progressionState.milestones.map((milestone) => h("li", { class: milestone.completed ? "done" : "", key: milestone.id }, badge(milestone.completed ? "done" : "open", milestone.completed ? "good" : "neutral"), h("div", null, h("strong", null, milestone.name), h("p", { class: "small muted" }, milestone.description))))),
  );
}

export function renderTasks(ctx) {
  const { snapshot, now } = ctx;
  return {
    "tasks-active": active(snapshot, now),
    "tasks-queue": queue(snapshot),
    "objective-panel": objective(snapshot, now),
    "tasks-decision": decision(snapshot, now),
    "tasks-history": historyCard(snapshot),
    "tasks-progression": progression(snapshot),
  };
}
