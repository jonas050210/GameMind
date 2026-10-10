import { h } from "../lib/h.js";
import { badge, button, card, empty, kv, notice, progress, statusBadge, table, unknown } from "../lib/ui.js";
import { fmtAgo, fmtDuration, fmtNumber, fmtPercent, fmtTime, humanise, orUnknown } from "../lib/format.js";
import { activeProgress, queueExplanation, taskBlocker } from "../lib/model.js";
import { failureCell } from "./bots.js";

function active(snapshot, now) {
  const task = snapshot.scheduler?.active;
  if (!task) {
    const blocker = taskBlocker(snapshot);
    return card({ title: "Active task" }, empty("No task is running", blocker ?? "Start one below, or let autonomy pick work."));
  }
  const measured = activeProgress(snapshot);
  const agent = snapshot.agent;
  return card(
    { title: "Active task", actions: statusBadge(agent?.state === "stopping" ? "aborted" : "running") },
    h("p", { class: "task-title" }, task.label),
    kv([
      ["Started by", task.origin],
      ["Started", task.startedAt ? `${fmtTime(task.startedAt)} (${fmtAgo(task.startedAt, now)})` : null],
      ["Decision", snapshot.goal ? `${snapshot.goal.rationale}` : null],
      ["Skill", snapshot.goal?.skillId ?? null],
      ["Actions used", agent ? fmtNumber(agent.actionsUsed) : null],
      ["Stop requested", agent?.stoppingRequestedAt ? fmtTime(agent.stoppingRequestedAt) : "no"],
    ]),
    measured ? h("div", null, progress(measured.have, measured.of, `Progress in ${measured.unit}`), h("p", { class: "small" }, `${fmtNumber(measured.have)} of ${fmtNumber(measured.of)} ${measured.unit} (${fmtPercent(measured.fraction, 0)})`)) : h("p", { class: "muted small" }, "Progress is not measurable for this task right now; it is shown only when the world reports it."),
    snapshot.recentActions?.length ? h("details", { open: true }, h("summary", null, "Latest actions"), table({ dense: true, columns: [{ label: "Time", cell: (a) => fmtTime(a.at) }, { label: "Skill", cell: (a) => humanise(a.skillId) }, { label: "Result", cell: (a) => statusBadge(a.status === "succeeded" ? (a.confirmed === false ? "failed" : "passed") : a.status) }, { label: "Verified", cell: (a) => (a.verification ? humanise(a.verification) : unknown()) }, { label: "Note", cell: (a) => a.note ?? "" }], rows: snapshot.recentActions.slice(0, 6).map((a, index) => ({ key: index, value: a })) })) : null,
    button("Stop task", { command: "stopTask", payload: "stopped from the Tasks tab", tone: "warn" }),
  );
}

const BAND_NAMES = ["Safety", "Survival", "Progress"];

function bandText(band) {
  return typeof band === "number" ? `${BAND_NAMES[band] ?? "Band"} (band ${band})` : null;
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
      { title: "Latest decision" },
      empty("No decision recorded yet", "Each time the agent chooses its next step the choice is recorded here with the alternatives it weighed. Nothing is shown until a task or autonomy has made one."),
    );
  }
  const selected = data.selected ?? null;
  const alternatives = Array.isArray(data.alternatives) ? data.alternatives : [];
  const rejected = Array.isArray(data.rejected) ? data.rejected : [];
  const when = latest.timestamp ? fmtAgo(latest.timestamp, now) : null;
  return card(
    {
      title: "Latest decision",
      subtitle: [data.modelId, data.observationSequence !== undefined && data.observationSequence !== null ? `observation #${fmtNumber(data.observationSequence)}` : null, when].filter(Boolean).join(" · "),
      actions: data.blockingCode ? badge(data.blockingCode, "warn") : null,
    },
    h("p", { class: "task-title" }, data.summary ?? "No summary was recorded for this decision."),
    kv([
      ["Chosen goal", selected ? selected.goalId : "None: the model stopped without choosing"],
      ["Skill", selected?.skillId ?? null],
      ["Priority band", bandText(selected?.priorityBand ?? data.band)],
      ["Why", selected?.rationale ?? null],
      ["Plan", Array.isArray(data.plan) && data.plan.length ? data.plan.join(" → ") : null],
      ["Safety verdict", data.safety ? `${data.safety.allowed ? "allowed" : "refused"} · ${data.safety.code}: ${data.safety.message}` : null],
      ["Game mode seen", factText(data.session?.gameMode)],
      ["Dimension seen", factText(data.session?.dimension)],
      // Only a decision that was a training switch has this row; for every other decision "unknown" would be wrong.
      ...(data.exploration ? [["Exploration switch", "This choice was a recorded exploration switch made for training, not the model's first choice"]] : []),
    ]),
    alternatives.length
      ? h(
          "details",
          null,
          h("summary", null, `Alternatives considered (${fmtNumber(alternatives.length)})`),
          table({
            dense: true,
            columns: [
              { label: "Goal", cell: (a) => a.goalId },
              { label: "Band", cell: (a) => bandText(a.priorityBand) ?? unknown("Not recorded.") },
              { label: "Score", align: "right", cell: (a) => (typeof a.score === "number" ? fmtNumber(a.score, 2) : unknown("Not recorded.")) },
              { label: "Why it was a candidate", cell: (a) => a.rationale ?? unknown("Not recorded.") },
            ],
            rows: alternatives.map((entry, index) => ({ key: `alt-${index}`, value: entry })),
          }),
        )
      : h("p", { class: "muted small" }, "No other candidate was left to weigh."),
    rejected.length
      ? h(
          "details",
          null,
          h("summary", null, `Rejected candidates (${fmtNumber(rejected.length)})`),
          table({
            dense: true,
            columns: [
              { label: "Goal", cell: (r) => r.goalId },
              { label: "Reason", cell: (r) => humanise(r.reason) },
              { label: "Detail", cell: (r) => r.detail ?? unknown("Not recorded.") },
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
  if (!scheduler) return card({ title: "Queue" }, empty("Queueing is unavailable", explanation.text));
  return card(
    { title: "Queue", subtitle: "Tasks run one at a time, in this order", actions: scheduler.queue.length ? button("Clear queue", { command: "clearTaskQueue", tone: "warn" }) : null },
    h("p", { class: explanation.available ? "muted small" : "small" }, explanation.text),
    scheduler.queue.length
      ? h("ol", { class: "queue" }, scheduler.queue.map((ticket) => h("li", { key: ticket.ticketId }, h("div", null, h("strong", null, ticket.label), h("p", { class: "small muted" }, `${ticket.origin} · position ${ticket.position}`)), button("Cancel", { command: "cancelQueuedTask", payload: { ticketId: ticket.ticketId } }))))
      : h("p", { class: "muted" }, "Nothing is waiting."),
    scheduler.reservation ? notice("info", `Next slot reserved for the ${scheduler.reservation.owner} task “${scheduler.reservation.label}”`, "Autonomy and other origins wait until it starts.") : null,
    scheduler.lastRefusal ? h("p", { class: "small muted" }, `Last refusal (${scheduler.lastRefusal.origin}, ${fmtTime(scheduler.lastRefusal.at)}): ${scheduler.lastRefusal.message}`) : null,
    h("p", { class: "small muted" }, "No overlap: a second task is refused or queued, never run alongside the first. An identical task cannot be queued twice. An operator task asks autonomy to stop at its next action boundary and then starts."),
  );
}

function objective(snapshot, now) {
  const objectiveState = snapshot.objective;
  return card(
    { title: "Objective & subgoal", subtitle: "What autonomy is working towards when you have not asked for anything", actions: button(snapshot.autonomyEnabled ? "Turn autonomy off" : "Turn autonomy on", { command: "setAutonomy", payload: { enabled: !snapshot.autonomyEnabled }, disabled: snapshot.autonomyEnabled === null || snapshot.autonomyEnabled === undefined, title: "Safety limits, budgets and combat restrictions are identical either way." }) },
    h(
      "div",
      null,
      snapshot.autonomyEnabled === null || snapshot.autonomyEnabled === undefined
        ? empty("Not available", "Autonomy exists only while a session does.")
        : [
            kv([
              ["Autonomy", snapshot.autonomyEnabled ? badge("on", "good") : badge("off", "neutral")],
              ["Objective", objectiveState?.objective ?? null],
              ["Current subgoal", objectiveState?.subgoal ?? null],
              ["Completion test", objectiveState?.completion ?? null],
              ["Why this subgoal", objectiveState?.reason ?? null],
              ["Subgoals decided", objectiveState ? fmtNumber(objectiveState.decided) : null],
            ]),
            objectiveState?.cooldowns?.length ? h("details", null, h("summary", null, `${objectiveState.cooldowns.length} subgoal(s) cooling down after repeated no-progress attempts`), h("ul", null, objectiveState.cooldowns.map((entry) => h("li", null, h("code", null, entry.signature), ` until ${fmtTime(entry.until)} — ${entry.reason}`)))) : null,
          ],
    ),
  );
}

function historyCard(snapshot) {
  const entries = snapshot.scheduler?.history ?? [];
  return card(
    { title: "Task outcomes", subtitle: "Measured results; a task is only 'PASS' when the runner verified its goal" },
    table({
      caption: "Task outcomes",
      empty: { title: "No finished tasks yet" },
      columns: [
        { label: "Finished", cell: (t) => (t.finishedAt ? fmtTime(t.finishedAt) : "—") },
        { label: "Task", cell: (t) => t.label },
        { label: "Outcome", cell: (t) => statusBadge(t.status ?? t.state) },
        { label: "Progress", align: "right", cell: (t) => (typeof t.progressRatio === "number" ? fmtPercent(t.progressRatio, 0) : unknown()) },
        { label: "Actions", align: "right", cell: (t) => orUnknown(t.actions, fmtNumber) },
        { label: "Time", align: "right", cell: (t) => orUnknown(t.elapsedMs, fmtDuration) },
        { label: "Why it ended", cell: (t) => failureCell(t) },
      ],
      rows: entries.slice(0, 20).map((t) => ({ key: t.ticketId, value: t })),
    }),
  );
}

function progression(snapshot) {
  const progressionState = snapshot.progression;
  if (!progressionState) return card({ title: "Autonomous progression" }, empty("Not available", "Milestones are tracked while a session runs."));
  return card(
    { title: "Autonomous progression", subtitle: `Current milestone: ${progressionState.currentMilestoneName}` },
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
