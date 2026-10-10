import { h } from "../lib/h.js";
import { badge, button, card, empty, kv, notice, sourceBadge, statusBadge, table, unknown } from "../lib/ui.js";
import { fmtDateTime, fmtNumber, fmtPercent, fmtTime, humanise, orUnknown } from "../lib/format.js";
import { conclusionNotice } from "./training.js";

const PROVENANCE_LABELS = {
  live: "Live Minecraft session",
  "simulator-demo": "Simulator demo",
  "simulator-eval": "Simulator evaluation",
  "simulator-unlabelled": "Simulator (older, unlabelled)",
  training: "Offline training",
  unlabelled: "Unlabelled (older)",
};

function unavailable(resource, title) {
  if (!resource || resource.status === "idle" || resource.status === "loading") return card({ title }, h("p", { class: "muted" }, "Loading…"));
  if (resource.status === "error") return card({ title }, notice("bad", "Could not load this", resource.error));
  return null;
}

function store(data) {
  if (!data.enabled) return card({ title: "Experience store" }, notice("warn", "Learning is off", data.reason));
  const rows = Object.entries(data.store.byProvenance).map(([key, entry]) => ({ key, value: { key, ...entry } }));
  return card(
    { title: "Experience store", subtitle: data.store.directory ? `Folder: ${data.store.directory}` : "In memory only", actions: [button("Live", { action: "learning-store", data: { store: "live" }, tone: data.store_kind === "live" ? "primary" : "" }), button("Simulated", { action: "learning-store", data: { store: "simulated" }, tone: data.store_kind === "simulated" ? "primary" : "" })] },
    data.store_kind === "simulated" ? notice("info", "Simulated store", "Offline sessions record here. It is separate from the live store and never feeds a live policy.") : null,
    kv([
      ["Runs recorded", fmtNumber(data.store.runs)],
      ["Episodes recorded", fmtNumber(data.store.episodes)],
      ["Counted as evidence", data.store.evidenceProvenance ? data.store.evidenceProvenance.map((entry) => PROVENANCE_LABELS[entry] ?? entry).join(", ") : "every provenance"],
    ]),
    table({
      caption: "Episodes by where they came from",
      empty: { title: "No episodes yet", detail: "Experience is recorded one episode per attempted action while a task runs." },
      dense: true,
      columns: [
        { label: "Provenance", cell: (r) => PROVENANCE_LABELS[r.key] ?? r.key },
        { label: "Episodes", align: "right", cell: (r) => fmtNumber(r.episodes) },
        { label: "Runs", align: "right", cell: (r) => fmtNumber(r.runs) },
        { label: "Verified successes", align: "right", cell: (r) => fmtNumber(r.successes) },
        { label: "Failures", align: "right", cell: (r) => fmtNumber(r.failures) },
        { label: "Excluded", align: "right", cell: (r) => fmtNumber(r.excluded) },
        { label: "Used as evidence", cell: (r) => (r.usedAsEvidence ? badge("yes", "good") : badge("no — kept, not learned from", "neutral")) },
      ],
      rows,
    }),
    h("p", { class: "small muted" }, "A success is an action the adapter confirmed and the next observation did not contradict. A failure counts against the choice only when it says something about the choice; connection, safety and game-mode outcomes are “excluded”."),
  );
}

function policy(data) {
  if (!data.enabled) return card({ title: "Policy" }, empty("No policy store", "Learning is off."));
  const p = data.policy;
  const promotion = p.promotion;
  return card(
    { title: "Policy status" },
    notice(p.status === "active-policy" ? "info" : "neutral", p.status === "active-policy" ? "A promoted policy is active" : "No active policy", p.statement),
    kv([
      ["Active policy", p.activeId ? `${p.activeId} (${p.activeContexts} weighted contexts)` : "none"],
      ["Candidate", `${p.candidateId} (${p.candidateContexts} weighted contexts, from ${p.candidateSource})`],
      ["Currently steers decisions", p.influencesDecisions === "none" ? badge("nothing — baseline in force", "neutral") : badge(p.influencesDecisions, "info")],
      ["Weighting rule", `a context needs ${p.minSamples} verified attempts; weights stay within ${p.weightRange[0]}–${p.weightRange[1]}`],
      ["Promotion", promotion.allowed ? badge("every gate criterion is met", "good") : badge("refused by the gate", "warn")],
    ]),
    promotion.refusalReasons.length ? h("div", null, h("h4", null, "Why promotion is refused"), h("ul", null, promotion.refusalReasons.map((reason) => h("li", null, reason)))) : null,
    h(
      "div",
      { class: "button-row" },
      button("Promote candidate", { command: "promotePolicy", disabled: !promotion.allowed, title: promotion.allowed ? "Runs the existing promotion gate again before anything changes." : "Disabled: the gate's criteria are not met." , data: { confirm: "Promote the candidate policy? The gate is checked again first." } }),
      button("Roll back to baseline", { command: "rejectPolicy", disabled: !p.activeId, data: { confirm: "Roll back to the baseline policy?" } }),
    ),
    h("p", { class: "small muted" }, "Promotion and rollback go through the existing gates only. Nothing is promoted automatically, and no checkpoint is called improved unless a measured comparison says so."),
  );
}

function contexts(data) {
  if (!data.enabled) return null;
  return card(
    { title: "Learned contexts and evidence", subtitle: "One row per (skill, goal, distance, threat, vitality) context" },
    table({
      caption: "Learned contexts",
      empty: { title: "No contexts yet", detail: "A context appears after the agent attempts that kind of action." },
      dense: true,
      columns: [
        { label: "Skill", cell: (c) => humanise(c.skillId.replace(/^minecraft\./, "")) },
        { label: "Goal", cell: (c) => c.goalClass },
        { label: "Distance", cell: (c) => c.distanceBand },
        { label: "Threat · vitality", cell: (c) => `${c.threat} · ${c.vitality}` },
        { label: "Evidence", align: "right", cell: (c) => `${fmtNumber(c.successes)}/${fmtNumber(c.attempts)}` },
        { label: "Success", align: "right", cell: (c) => (c.successRate === null ? unknown() : h("span", { title: `conservative estimate ${fmtPercent(c.conservativeSuccessRate, 0)}` }, fmtPercent(c.successRate, 0))) },
        { label: "Weight", align: "right", cell: (c) => (c.weight === null ? h("span", { class: "muted small" }, c.weightStatus === "insufficient-evidence" ? `needs ${c.minSamples} (has ${c.attempts})` : "neutral (×1)") : h("strong", null, `×${c.weight.toFixed(2)}`)) },
        { label: "Contradicted", align: "right", cell: (c) => fmtNumber(c.contradictedConfirmations) },
        { label: "Excluded", align: "right", cell: (c) => fmtNumber(c.excluded) },
        { label: "Top failures", cell: (c) => (c.topFailures.length ? c.topFailures.map((f) => `${f.code} ×${f.count}`).join(", ") : "") },
      ],
      rows: data.contexts.map((value) => ({ key: value.key, value })),
    }),
    h("p", { class: "small muted" }, "A weight multiplies a candidate's score only when it is promoted, and only matters where a decision has competing candidates."),
  );
}

function failures(data) {
  if (!data.enabled) return null;
  return card(
    { title: "Failure codes behind the numbers" },
    table({
      caption: "Failure codes",
      empty: { title: "No failures recorded" },
      dense: true,
      columns: [
        { label: "Code", cell: (f) => h("code", null, f.code) },
        { label: "Count", align: "right", cell: (f) => fmtNumber(f.count) },
        { label: "Kind", cell: (f) => badge(f.kind, "neutral") },
        { label: "Meaning", cell: (f) => f.label },
        { label: "What to do", cell: (f) => h("span", { class: "small muted" }, f.hint ?? "") },
      ],
      rows: data.failures.map((value) => ({ key: value.code, value })),
    }),
    Object.keys(data.excluded.reasons).length
      ? h("div", null, h("h4", null, `Excluded from evidence (${fmtNumber(data.excluded.total)})`), h("ul", null, Object.entries(data.excluded.reasons).map(([reason, count]) => h("li", null, `${reason} — ${fmtNumber(count)}`))), h("p", { class: "small muted" }, "These outcomes stopped an action for reasons outside the choice, so they are shown but never held against a skill or a target."))
      : null,
    data.contradictions.total ? notice("warn", `${fmtNumber(data.contradictions.total)} confirmation(s) contradicted by the world`, "The adapter said an action worked but the next observation did not change. Any contradiction blocks promotion.") : null,
  );
}

function explain(data) {
  return card(
    { title: "Why runs end the way they do" },
    h(
      "div",
      { class: "explanations" },
      data.explanations.map((entry) =>
        h(
          "details",
          { key: entry.code, open: entry.occurrences !== null && entry.occurrences > 0 },
          h("summary", null, h("code", null, entry.code), " ", badge(entry.kind, "neutral"), entry.occurrences !== null ? ` seen ${fmtNumber(entry.occurrences)}×` : "", " — ", entry.label),
          entry.meaning ? h("p", null, entry.meaning) : null,
          entry.whatToCheck.length ? h("ul", null, entry.whatToCheck.map((line) => h("li", null, line))) : null,
          entry.hint ? h("p", { class: "small muted" }, entry.hint) : null,
          h("p", { class: "small muted" }, `Owner: ${entry.owner} · ${entry.retryable ? "the agent can retry on its own" : "needs a change before it can succeed"}`),
        ),
      ),
    ),
  );
}

function runs(data) {
  if (!data.enabled) return null;
  return card(
    { title: "Recent runs", subtitle: "Historical: read from the episode log" },
    table({
      caption: "Recent runs",
      empty: { title: "No runs recorded" },
      dense: true,
      columns: [
        { label: "Run", cell: (r) => h("code", null, r.runId) },
        { label: "Last action", cell: (r) => fmtDateTime(r.at) },
        { label: "From", cell: (r) => badge(PROVENANCE_LABELS[r.provenance] ?? r.provenance, r.provenance === "live" ? "good" : "info") },
        { label: "Actions", align: "right", cell: (r) => fmtNumber(r.episodes) },
        { label: "Verified ✓", align: "right", cell: (r) => fmtNumber(r.successes) },
        { label: "Failed", align: "right", cell: (r) => fmtNumber(r.failures) },
        { label: "Excluded", align: "right", cell: (r) => fmtNumber(r.excluded) },
        { label: "Last failure", cell: (r) => (r.lastFailureCode ? h("code", null, r.lastFailureCode) : "") },
      ],
      rows: data.recentRuns.map((value) => ({ key: value.runId, value })),
    }),
    data.history.length ? h("details", null, h("summary", null, "Policy history (promotions and rollbacks)"), h("ul", null, data.history.slice(0, 12).map((entry) => h("li", null, `${fmtDateTime(entry.at)} — ${entry.promoted ? "promoted" : "recorded"}: ${entry.note}`)))) : null,
    data.blockedTargets?.length ? h("details", null, h("summary", null, `Failure memory (${data.blockedTargets.length} remembered targets)`), h("ul", null, data.blockedTargets.map((entry) => h("li", null, h("code", null, entry.targetKey), ` — ${entry.attempts} failed attempt(s)${entry.blocked ? ", blocked" : ""} (${entry.failureCode})`)))) : null,
  );
}

function checkpointEvaluations(data) {
  const reports = data.trainingReports ?? [];
  return card(
    { title: "Checkpoint evaluations", subtitle: `Offline training folder: ${data.trainingDirectory}`, actions: sourceBadge("offline") },
    reports.length
      ? table({
          dense: true,
          columns: [
            { label: "Checkpoint", cell: (r) => h("code", null, r.checkpointId) },
            { label: "Learned contexts", align: "right", cell: (r) => orUnknown(r.learnedContexts, fmtNumber) },
            { label: "Success baseline → candidate", cell: (r) => `${fmtPercent(r.baseline.successRate)} → ${fmtPercent(r.candidate.successRate)}` },
            { label: "Differed in", align: "right", cell: (r) => (r.behaviour ? `${fmtNumber(r.behaviour.runsWithDifferentChoices)}/${fmtNumber(r.behaviour.pairedRuns)} runs` : unknown()) },
            { label: "Conclusion", cell: (r) => r.conclusion ?? "not recorded" },
            { label: "Gate", cell: (r) => (r.verdict === "promotable" ? badge("promotable", "good") : badge("not promotable", "neutral")) },
          ],
          rows: reports.map((value) => ({ key: value.checkpointId + value.generatedAt, value })),
        })
      : empty("No checkpoint has been evaluated", "Evaluate a checkpoint from the Training tab."),
    reports[0] ? conclusionNotice(reports[0].conclusion) : null,
  );
}

export function renderLearning(ctx) {
  const resource = ctx.data.learning;
  const blocked = unavailable(resource, "Learning and policy");
  if (blocked) {
    return { "learn-store": blocked, "learn-policy": null, "learn-contexts": null, "learn-failures": null, "learn-explain": null, "learn-runs": null, "learn-checkpoints": null };
  }
  const data = resource.value;
  return {
    "learn-store": store(data),
    "learn-policy": policy(data),
    "learn-contexts": contexts(data),
    "learn-failures": failures(data),
    "learn-explain": explain(data),
    "learn-runs": runs(data),
    "learn-checkpoints": checkpointEvaluations(data),
  };
}

export { fmtTime, statusBadge };
