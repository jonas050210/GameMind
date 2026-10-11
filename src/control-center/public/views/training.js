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
  const jobs = ctx.snapshot.jobs?.items ?? [];
  const benchmarkJob = jobs.find((job) => job.kind === "benchmark");
  if (!training) {
    return { "training-notice": notice("neutral", "Training is not available in this run"), "training-metrics": empty("Not available"), "training-reward": null, "training-preflight": null, "training-checkpoints": null, "training-episodes-table": null, "training-eval": null, "training-benchmarks": benchmarksCard(ctx.data?.benchmarks?.value ?? null, null, jobs) };
  }
  return {
    "training-notice": notice("info", "Offline simulator training — not real-world training", "Training runs the agent's decision loop on the built-in simulator in a separate process, without rendering. What it learns is measured on held-out simulator seeds. It says nothing about a real Minecraft world until a live run is verified separately."),
    "training-metrics": metrics(training, ctx.now),
    "training-reward": reward(training),
    "training-preflight": preflight(ctx),
    "training-checkpoints": checkpoints(training),
    "training-episodes-table": episodes(training),
    "training-eval": lastEvaluation(training),
    "training-benchmarks": benchmarksCard(ctx.data?.benchmarks?.value ?? null, training, jobs),
  };
}

const GATE_TEXT = { promotable: "promotable", "not-promotable": "not promotable" };

/** Headless worker/environment/exploration benchmark. It is only started by the operator's explicit submit. */
export function benchmarksCard(listing, training, jobs) {
  const stages = training?.availableStages ?? [];
  const savedStageIds = listing?.savedDefault?.stageIds ?? training?.defaultStageIds ?? null;
  const selectedStageIds = savedStageIds?.length ? savedStageIds : stages.map((stage) => stage.id);
  const stageKey = JSON.stringify({ ids: stages.map((stage) => stage.id), selected: selectedStageIds });
  const runningBenchmark = jobs?.find((job) => job.kind === "benchmark" && job.state === "running");
  
  // Show running benchmark job status
  const benchmarkJobStatus = runningBenchmark 
    ? notice("info", "Benchmark is running", 
        `Job ${runningBenchmark.id} started at ${fmtDateTime(runningBenchmark.startedAt)}. ` +
        `Output: ${runningBenchmark.outputTail.length > 0 ? runningBenchmark.outputTail.join(" ") : "waiting for output..."}`)
    : null;
  
  const benchmarkForm = stages.length
    ? h.stat(`benchmark-form-${stageKey}`, h("form", { id: "benchmark-form", class: "form benchmark-controls" },
        h("fieldset", null,
          h("legend", null, "Environment stages"),
          h("div", { class: "check-grid benchmark-stage-grid" }, stages.map((stage) =>
            h("label", { class: "choice", key: stage.id },
              h("input", { type: "checkbox", id: `benchmark-stage-${stage.id}`, value: stage.id, checked: selectedStageIds.includes(stage.id) }),
              h("span", null, `${stage.label} (${fmtNumber(stage.scenarioCount)} environments)`),
            ),
          )),
        ),
        h("div", { class: "field-row" },
          h("div", null, h("label", { for: "benchmark-environment-cases" }, "Environment cases (1–256)"), h("input", { id: "benchmark-environment-cases", name: "environmentCases", type: "number", min: "1", max: "256", step: "1", value: String(stages.reduce((sum, stage) => sum + stage.scenarioCount, 0) || 13) })),
          h("div", null, h("label", { for: "benchmark-environment-seconds" }, "Seconds per environment"), h("input", { id: "benchmark-environment-seconds", name: "environmentSecondsPerCase", type: "number", min: "1", max: "600", step: "1", value: "20" })),
          h("div", null, h("label", { for: "benchmark-worker-limit" }, "Probe workers up to"), h("select", { id: "benchmark-worker-limit", name: "workerLimit" }, Array.from({ length: 8 }, (_, index) => h("option", { value: String(index + 1), selected: index + 1 === 4 }, `${index + 1} worker${index === 0 ? "" : "s"}`)))),
        ),
        h("p", { id: "benchmark-estimate", class: "hint" }, "Environment and worker-sweep estimates appear here."),
        h("p", { class: "hint" }, "Each environment probe is isolated, headless and uses training-only seeds. The final held-out comparison—not this early/late reward signal—is the quality gate. This benchmark never starts automatically after training."),
        h("div", { class: "button-row" }, h("button", { type: "submit", class: "btn primary", id: "benchmark-start" }, "Start headless benchmark")),
        h("p", { id: "benchmark-start-hint", class: "hint" }, "No Minecraft server is used; the built-in simulator runs without rendering."),
      ))
    : notice("neutral", "Training benchmark unavailable", "This run does not expose the offline curriculum required for a worker/environment benchmark.");

  const saved = listing?.savedDefault
    ? notice(
        "info",
        `Current defaults: ${listing.savedDefault.workers} worker${listing.savedDefault.workers === 1 ? "" : "s"}, exploration ${fmtNumber(listing.savedDefault.explorationRate, 2)}${listing.savedDefault.stageIds?.length ? `, stages ${listing.savedDefault.stageIds.join(", ")}` : ""}`,
        `Saved ${fmtDateTime(listing.savedDefault.savedAt)}${listing.savedDefault.benchmark ? ` by benchmark ${listing.savedDefault.benchmark}` : ""}. New training runs use these unless the operator explicitly chooses otherwise.`,
      )
    : notice("neutral", "No benchmark defaults saved", "Training uses one worker and the standard exploration rate until a benchmark produces a measured recommendation.");
  const subtitle = "Choose worker range and curriculum environments. The benchmark probes learning signals, then compares exploration rates with held-out evaluation.";
  
  // Build reports list
  const reports = !listing || !listing.reports?.length
    ? [empty("No benchmark yet", "Run the headless sweep explicitly to measure worker throughput, environment learning signals and held-out policy quality.")]
    : listing.reports.map((report) =>
        h(
          "section",
          { class: "benchmark", key: report.file },
          h("h4", null, report.name, " ", report.createdAt ? h("span", { class: "muted small" }, fmtDateTime(report.createdAt)) : null),
          report.unreadable
            ? notice("warn", "This report could not be read", report.file)
            : h(
                "div",
                null,
                report.environmentScores.length
                  ? table({
                      dense: true,
                      caption: `Environment learning signal (${report.environmentCases ?? "?"} cases × ${report.environmentSecondsPerCase ?? "?"} s; recommended: ${report.recommendedStageIds.join(", ") || "none"})`,
                      columns: [
                        { label: "Stage", cell: (r) => r.stageId },
                        { label: "Cases", align: "right", cell: (r) => `${r.completedCases}/${r.cases}` },
                        { label: "Episodes", align: "right", cell: (r) => fmtNumber(r.episodes) },
                        { label: "Learning signal", align: "right", cell: (r) => (r.meanLearningSignal === null ? unknown() : fmtNumber(r.meanLearningSignal, 3)) },
                        {
                          label: "Selection",
                          cell: (r) => r.recommended
                            ? r.meanLearningSignal === null
                              ? badge("retained · unmeasured", "neutral")
                              : badge("recommended", "info")
                            : "not selected",
                        },
                      ],
                      rows: report.environmentScores.map((value, index) => ({ key: `${report.file}-environment-${index}`, value })),
                    })
                  : null,
                report.probe
                  ? table({
                      dense: true,
                      caption: `Worker throughput (chosen: ${report.workers ?? "?"})`,
                      columns: [
                        { label: "Workers", align: "right", cell: (r) => r.workers },
                        { label: "Episodes / min", align: "right", cell: (r) => (r.episodesPerMinute === null ? unknown() : fmtNumber(r.episodesPerMinute, 0)) },
                        { label: "CPU", align: "right", cell: (r) => (r.cpuPercent === null ? unknown() : fmtPercent(r.cpuPercent / 100, 0)) },
                        { label: "Peak RAM", align: "right", cell: (r) => (r.peakRssMb === null ? unknown() : `${fmtNumber(r.peakRssMb, 0)} MB`) },
                        { label: "Result", cell: (r) => (r.eligible ? (r.workers === report.workers ? "chosen" : "ok") : r.reason ?? "not used") },
                      ],
                      rows: report.probe.map((value, index) => ({ key: `${report.file}-probe-${index}`, value })),
                      empty: { title: "No probe" },
                    })
                  : null,
                report.winner
                  ? notice("info", `Winner: exploration rate ${report.winner}`, report.decision ?? null)
                  : notice("neutral", "No winner", report.decision ?? "No candidate passed the gate and the margin."),
                table({
                  dense: true,
                  caption: "Held-out results per exploration candidate",
                  columns: [
                    { label: "Candidate", cell: (r) => r.id },
                    { label: "Exploration rate", align: "right", cell: (r) => (r.explorationRate === null ? unknown() : fmtNumber(r.explorationRate, 2)) },
                    { label: "Status", cell: (r) => statusBadge(r.status) },
                    { label: "Baseline", align: "right", cell: (r) => (r.baselineSuccess === null ? unknown() : fmtPercent(r.baselineSuccess, 0)) },
                    { label: "Trained", align: "right", cell: (r) => (r.trainedSuccess === null ? unknown() : fmtPercent(r.trainedSuccess, 0)) },
                    { label: "Gain", align: "right", cell: (r) => (r.deltaPoints === null ? unknown() : fmtSigned(r.deltaPoints * 100, 1, " pts")) },
                    { label: "Gate", cell: (r) => (r.gateVerdict ? GATE_TEXT[r.gateVerdict] ?? r.gateVerdict : unknown()) },
                    { label: "Error", cell: (r) => r.error ?? "—" },
                  ],
                  rows: report.rows.map((value, index) => ({ key: `${report.file}-${index}`, value })),
                  empty: { title: "No results" },
                }),
              ),
        ),
      );
  return card({ title: "Headless learning benchmark", subtitle }, benchmarkJobStatus, saved, benchmarkForm, ...reports);
}

export { fmtSigned, unknown };
