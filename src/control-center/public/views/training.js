import { h } from "../lib/h.js";
import { badge, button, card, empty, kv, notice, sourceBadge, sparkline, statusBadge, table, unknown } from "../lib/ui.js";
import { fmtAgo, fmtDateTime, fmtDuration, fmtNumber, fmtPercent, fmtSigned, fmtTime, orUnknown } from "../lib/format.js";

const STATE_TONE = { idle: "neutral", running: "info", paused: "warn", stopped: "neutral", completed: "good", failed: "bad", interrupted: "bad", evaluating: "info" };

const CONCLUSIONS = {
  "no-learned-contexts": { tone: "warn", title: "This checkpoint is the baseline policy", text: "It holds no learned weights (a context needs 8 verified attempts before it is weighted), so comparing it with the baseline measures nothing. Train for more episodes." },
  "identical-behaviour": { tone: "warn", title: "The learned weights never changed a decision", text: "Identical results are expected here and are not a measured tie: the policy was never actually different from the baseline." },
  improved: { tone: "good", title: "Measured improvement", text: "The candidate chose differently and the gate measured an improvement without a safety regression. Promotion is still a separate, gated step." },
  regressed: { tone: "bad", title: "Measured regression", text: "The candidate chose differently and did worse." },
  "behaviour-changed-no-gain": { tone: "warn", title: "Behaviour changed, no measurable gain", text: "The candidate chose differently, but the outcome is not measurably better." },
};

export function conclusionNotice(conclusion, extra) {
  const info = CONCLUSIONS[conclusion];
  if (!info) return conclusion ? notice("neutral", `Conclusion: ${conclusion}`, extra) : notice("neutral", "No conclusion recorded", "This report was written before evaluations said what they established.");
  return notice(info.tone, info.title, info.text, extra);
}

function metrics(training, now) {
  const stateTone = STATE_TONE[training.status] ?? "neutral";
  return card(
    { title: "Run status", actions: sourceBadge("offline") },
    h("div", { class: "hero-state" }, h("span", { class: `state-dot tone-${stateTone}` }), h("div", null, h("p", { class: "hero-label" }, training.status), training.stopReason ? h("p", { class: "muted" }, training.stopReason) : null)),
    training.lastError ? notice("bad", "The last run reported an error", training.lastError) : null,
    kv([
      ["Directory", training.root],
      ["Episodes", `${fmtNumber(training.episodesTotal)} of ${fmtNumber(training.episodeBudget)}`],
      ["Stage", training.stage ? `${training.stage.index + 1} of ${training.stage.total}: ${training.stage.id} (${fmtNumber(training.stage.episodes)} episodes${training.stage.successRate !== null ? `, ${fmtPercent(training.stage.successRate, 0)} success; pass at ${fmtPercent(training.stage.passRate, 0)}` : ""})` : null],
      ["Active time", training.activeSeconds ? fmtDuration(training.activeSeconds * 1000) : training.status === "idle" ? null : "0 s"],
      ["Speed", training.episodesPerMinute !== null ? `${fmtNumber(training.episodesPerMinute, 1)} episodes per minute` : null],
      ["Time budget", training.maxMinutes ? `${fmtNumber(training.maxMinutes)} min` : "none (episode budget only)"],
      ["Exploration", training.explorationRate !== null ? fmtPercent(training.explorationRate, 0) : null, "Share of eligible decisions where training tries an alternative, so the learner sees how it would have gone."],
      ["Process", training.processAlive ? `running (pid ${training.pid})` : "not running"],
      ["Folder lock", training.lock ? `held by process ${training.lock.pid} (${training.lock.kind})` : "free"],
      ["Last update", training.updatedAt ? fmtAgo(training.updatedAt, now) : null],
    ]),
  );
}

function reward(training) {
  const successes = training.recentSuccessRate;
  return card(
    { title: "Learning signal", subtitle: "Per-episode reward the learner computed, oldest to newest" },
    kv([
      ["Recent success rate", successes !== null ? fmtPercent(successes, 0) : null],
      ["Mean reward", training.recentMeanReward !== null ? fmtNumber(training.recentMeanReward, 3) : null],
    ]),
    sparkline(training.rewardTrend, { label: "Reward per training episode" }),
    h("p", { class: "small muted" }, "Training data, not held-out evaluation. A rising line shows the learner collecting evidence; only the evaluation below can say whether a policy is better."),
  );
}

function preflight(ctx) {
  const resource = ctx.data.preflight;
  const mode = ctx.ui.trainingMode ?? "resume";
  if (!resource || resource.status === "idle" || resource.status === "loading") return card({ title: "What will happen" }, h("p", { class: "muted" }, "Checking the folder…"));
  if (resource.status === "error") return card({ title: "What will happen" }, notice("bad", "Could not inspect the folder", resource.error));
  const info = resource.value;
  const parts = [
    kv([
      ["Folder", info.directory],
      ["Saved run", info.existing.hasRun ? `${info.existing.status}, ${fmtNumber(info.existing.episodes)} episodes${info.existing.stageId ? `, stage ${info.existing.stageId}` : ""}` : "none"],
      ["Checkpoints", fmtNumber(info.existing.checkpoints)],
      ["Experience files", fmtNumber(info.existing.experienceFiles)],
      ["Evaluations", fmtNumber(info.existing.evaluations)],
      ["In use", info.busy ? badge("busy", "warn") : badge("free", "good")],
    ]),
  ];
  for (const warning of info.warnings) parts.push(notice("warn", "Note", warning));
  if (mode === "resume") {
    parts.push(notice(info.resume.possible || !info.existing.hasRun ? "info" : "neutral", "Resume (default)", info.resume.summary, h("p", { class: "small muted" }, "Nothing is overwritten: experience and checkpoints are added to.")));
  } else {
    parts.push(
      notice(
        "warn",
        "Fresh run: read this before you confirm",
        info.fresh.summary,
        info.fresh.wouldArchive.length ? h("ul", null, info.fresh.wouldArchive.map((line) => h("li", null, line))) : null,
        h("ul", null, info.fresh.consequences.map((line) => h("li", null, line))),
      ),
    );
  }
  return card({ title: "What will happen", subtitle: `If you press Start in ${mode === "resume" ? "resume" : "fresh"} mode` }, ...parts);
}

function checkpoints(training) {
  return card(
    { title: "Checkpoints", subtitle: "Snapshots of what was learned. None is promoted automatically." },
    table({
      caption: "Checkpoints",
      empty: { title: "No checkpoints yet", detail: "A checkpoint is written when a stage passes, and when a run stops or finishes." },
      columns: [
        { label: "Checkpoint", cell: (c) => h("code", null, c.id) },
        { label: "Stage", cell: (c) => c.stageId },
        { label: "Episodes", align: "right", cell: (c) => fmtNumber(c.episodes) },
        { label: "Learned contexts", align: "right", cell: (c) => fmtNumber(c.weightedContexts) },
        { label: "Can show learning", cell: (c) => (c.evaluable ? badge("yes", "good") : badge("no — baseline policy", "warn", "No context has enough verified attempts to be weighted; this checkpoint behaves exactly like the baseline.")) },
        { label: "Written", cell: (c) => fmtDateTime(c.createdAt) },
        { label: "", cell: (c) => button("Evaluate", { command: "evaluateTraining", payload: c.id, disabled: false }) },
      ],
      rows: training.checkpoints.map((c) => ({ key: c.id, value: c })),
    }),
  );
}

function episodes(training) {
  return card(
    { title: "Recent episodes", subtitle: "Newest first; every row is one simulated task on a training seed" },
    table({
      caption: "Recent training episodes",
      empty: { title: "No episodes yet" },
      dense: true,
      columns: [
        { label: "#", align: "right", cell: (e) => fmtNumber(e.index) },
        { label: "Scenario", cell: (e) => e.scenarioId },
        { label: "Outcome", cell: (e) => statusBadge(e.success ? "passed" : e.status) },
        { label: "Why", cell: (e) => (e.failureCode ? h("code", null, e.failureCode) : "") },
        { label: "Actions", align: "right", cell: (e) => fmtNumber(e.actions) },
        { label: "Wasted", align: "right", cell: (e) => fmtNumber(e.wastedActions) },
        { label: "Reward", align: "right", cell: (e) => orUnknown(e.reward, (v) => fmtNumber(v, 2)) },
        { label: "At", cell: (e) => fmtTime(e.at) },
      ],
      rows: training.recentEpisodes.map((e) => ({ key: e.index, value: e })),
    }),
  );
}

function lastEvaluation(training) {
  const evaluation = training.lastEvaluation;
  if (!evaluation) return card({ title: "Last evaluation" }, empty("Not evaluated yet", "Evaluate a checkpoint to compare it with the baseline on held-out seeds."));
  return card(
    { title: "Last evaluation", subtitle: `${evaluation.checkpointId} · ${fmtDateTime(evaluation.generatedAt)}`, actions: sourceBadge("offline") },
    conclusionNotice(evaluation.conclusion),
    kv([
      ["Verdict from the gate", evaluation.verdict === "promotable" ? badge("promotable", "good") : badge("not promotable", "neutral")],
      ["Success: baseline → candidate", `${fmtPercent(evaluation.successRate.baseline)} → ${fmtPercent(evaluation.successRate.candidate)}`],
      ["Learned contexts in candidate", evaluation.learnedContexts !== null ? fmtNumber(evaluation.learnedContexts) : null],
      ["Runs where choices differed", evaluation.pairedRuns ? `${fmtNumber(evaluation.behaviourChangedRuns)} of ${fmtNumber(evaluation.pairedRuns)}` : null],
    ]),
    evaluation.reasons.length ? h("details", null, h("summary", null, "Reasons the gate gave"), h("ul", null, evaluation.reasons.map((reason) => h("li", null, reason)))) : null,
    button("Open full comparison", { action: "goto-tab", data: { tab: "evaluation" } }),
  );
}

export function renderTraining(ctx) {
  const training = ctx.snapshot.training;
  if (!training) {
    return { "training-notice": notice("neutral", "Training is not available in this run"), "training-metrics": empty("Not available"), "training-reward": null, "training-preflight": null, "training-checkpoints": null, "training-episodes-table": null, "training-eval": null, "training-benchmarks": benchmarksCard(ctx.data?.benchmarks?.value ?? null) };
  }
  return {
    "training-notice": notice("info", "Offline simulator training — not real-world training", "Training runs the agent's decision loop on the built-in simulator in a separate process, without rendering. What it learns is measured on held-out simulator seeds. It says nothing about a real Minecraft world until a live run is verified separately."),
    "training-metrics": metrics(training, ctx.now),
    "training-reward": reward(training),
    "training-preflight": preflight(ctx),
    "training-checkpoints": checkpoints(training),
    "training-episodes-table": episodes(training),
    "training-eval": lastEvaluation(training),
    "training-benchmarks": benchmarksCard(ctx.data?.benchmarks?.value ?? null),
  };
}

const GATE_TEXT = { promotable: "übernahmefähig", "not-promotable": "nicht übernahmefähig" };

/** The exploration-rate benchmarks from `npm run train:benchmark`: one table per report, newest first, no raw file contents. */
export function benchmarksCard(listing) {
  const subtitle = "Vergleicht Explorationsraten im Offline-Simulator (npm run train:benchmark -- --name NAME). Gewinner: übernahmefähig und mindestens die Schwelle besser als die Baseline.";
  if (!listing || !listing.reports?.length) {
    return card({ title: "Benchmarks der Explorationsrate", subtitle }, empty("Noch kein Benchmark", "Ein Lauf startet mehrere Trainings nacheinander und zeigt hier den Vergleich."));
  }
  return card(
    { title: "Benchmarks der Explorationsrate", subtitle },
    ...listing.reports.map((report) =>
      h(
        "section",
        { class: "benchmark", key: report.file },
        h("h4", null, report.name, " ", report.createdAt ? h("span", { class: "muted small" }, fmtDateTime(report.createdAt)) : null),
        report.unreadable
          ? notice("warn", "Dieser Bericht konnte nicht gelesen werden", report.file)
          : h(
              "div",
              null,
              report.winner
                ? notice("info", `Gewinner: Explorationsrate ${report.winner}`, report.decision ?? null)
                : notice("neutral", "Kein Gewinner", report.decision ?? "Kein Kandidat hat die Schwelle geschafft."),
              table({
                dense: true,
                caption: "Ergebnisse je Kandidat",
                columns: [
                  { label: "Kandidat", cell: (r) => r.id },
                  { label: "Explorationsrate", align: "right", cell: (r) => (r.explorationRate === null ? unknown() : fmtNumber(r.explorationRate, 2)) },
                  { label: "Status", cell: (r) => statusBadge(r.status) },
                  { label: "Baseline", align: "right", cell: (r) => (r.baselineSuccess === null ? unknown() : fmtPercent(r.baselineSuccess, 0)) },
                  { label: "Mit Training", align: "right", cell: (r) => (r.trainedSuccess === null ? unknown() : fmtPercent(r.trainedSuccess, 0)) },
                  { label: "Gewinn", align: "right", cell: (r) => (r.deltaPoints === null ? unknown() : fmtSigned(r.deltaPoints * 100, 1, " Pkt")) },
                  { label: "Gate", cell: (r) => (r.gateVerdict ? GATE_TEXT[r.gateVerdict] ?? r.gateVerdict : unknown()) },
                  { label: "Fehler", cell: (r) => r.error ?? "—" },
                ],
                rows: report.rows.map((value, index) => ({ key: `${report.file}-${index}`, value })),
                empty: { title: "Keine Ergebnisse" },
              }),
            ),
      ),
    ),
  );
}

export { fmtSigned, unknown };
