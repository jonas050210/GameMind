import { h } from "../lib/h.js";
import { badge, button, card, empty, kv, notice, sourceBadge, statusBadge, table, unknown } from "../lib/ui.js";
import { fmtAgo, fmtDateTime, fmtDuration, fmtNumber, fmtPercent, fmtSigned, fmtTime, orUnknown } from "../lib/format.js";
import { conclusionNotice } from "./training.js";
import { ROADMAP_ACTION_LABELS, ROADMAP_ACTIONS_WITH_NOTE, ROADMAP_CATEGORY_ORDER, ROADMAP_KIND_LABELS, ROADMAP_STATUS_LABELS, filterRoadmap, groupByCategory, roadmapActionsFor } from "../policy.js";

function jobCard(job, title) {
  if (!job) return h("div", { class: "job" }, h("h4", null, title), h("p", { class: "muted" }, "Not run from this page yet."));
  const summary = job.summary;
  return h(
    "div",
    { class: "job", key: job.id },
    h("h4", null, title, " ", sourceBadge(job.historical ? "historical" : job.source), " ", statusBadge(job.state === "succeeded" ? "passed" : job.state)),
    kv([
      ["Command", h("code", null, job.display)],
      ["Started", `${fmtDateTime(job.startedAt)}${job.finishedAt ? "" : " (running)"}`],
      ["Duration", orUnknown(job.durationMs, fmtDuration)],
      ["Exit code", job.exitCode === null || job.exitCode === undefined ? (job.state === "running" ? "still running" : null) : String(job.exitCode)],
    ]),
    job.error ? notice("bad", "Job problem", job.error) : null,
    summary?.kind === "tests" ? testSummary(summary) : null,
    summary?.kind === "eval" ? h("p", { class: "small" }, `Report written to ${summary.reportPath ?? "the data folder"}; its numbers are in the offline evaluation card below.`) : null,
    summary?.kind === "live" ? liveSummary(summary) : null,
    job.outputTail.length ? h("details", { open: job.state === "running" }, h("summary", null, `Output (last ${job.outputTail.length} lines)`), h("pre", { class: "log" }, job.outputTail.join("\n"))) : null,
    job.state === "running" ? button("Cancel job", { command: "cancelJob", payload: job.id, tone: "warn" }) : null,
  );
}

function testSummary(summary) {
  const total = summary.total;
  return h(
    "div",
    { class: "result-counts" },
    h("div", { class: "counts" }, badge(`PASS ${orUnknown(summary.passed, fmtNumber)}`, "good"), badge(`FAIL ${orUnknown(summary.failed, fmtNumber)}`, summary.failed ? "bad" : "neutral"), badge(`SKIPPED ${orUnknown(summary.skipped, fmtNumber)}`, summary.skipped ? "warn" : "neutral"), h("span", { class: "muted small" }, total === null ? "totals unavailable (the run did not finish)" : `of ${fmtNumber(total)} tests`)),
    summary.failedTests.length ? h("div", null, h("h5", null, "Failed"), h("ul", null, summary.failedTests.map((name) => h("li", null, name)))) : null,
    summary.skippedTests.length ? h("div", null, h("h5", null, "Skipped, with the reason given"), h("ul", null, summary.skippedTests.map((entry) => h("li", null, entry.name, " — ", entry.reason ?? "no reason given")))) : null,
  );
}

function liveSummary(summary) {
  return h(
    "div",
    { class: "result-counts" },
    summary.reachedServer === false ? notice("warn", "The server was never reached", "Nothing below was verified against Minecraft.") : null,
    table({
      dense: true,
      columns: [{ label: "Phase", cell: (p) => p.phase }, { label: "Result", cell: (p) => statusBadge(p.outcome === "passed" ? "passed" : p.outcome) }, { label: "Reason", cell: (p) => p.reason ?? "" }],
      rows: summary.phases.map((phase) => ({ key: phase.phase, value: phase })),
    }),
  );
}

function offlineJobs(ctx) {
  const jobs = ctx.snapshot.jobs?.items ?? [];
  const tests = jobs.find((job) => job.kind === "unit-tests") ?? null;
  const run = jobs.find((job) => job.kind === "offline-eval") ?? null;
  return card(
    { title: "Offline tests and evaluation", subtitle: "Run on this machine in the simulator and the unit-test suite", actions: sourceBadge("offline") },
    jobCard(tests, "Unit and integration tests"),
    jobCard(run, "Offline evaluation run"),
  );
}

function deltaTone(value, goodWhenNegative = false) {
  if (value === 0 || value === null || value === undefined) return "neutral";
  return (value < 0) === goodWhenNegative ? "good" : "bad";
}

function compare(ctx) {
  const resource = ctx.data.evaluation;
  const reports = resource?.value?.offline?.checkpointReports ?? [];
  if (!reports.length) {
    return card({ title: "Baseline versus candidate", actions: sourceBadge("offline") }, empty("No checkpoint has been evaluated yet", "Train in the Training tab, then evaluate a checkpoint. The comparison runs both policies on the same held-out seeds."));
  }
  const index = Math.min(ctx.ui.evalReportIndex ?? 0, reports.length - 1);
  const report = reports[index];
  const rows = [
    ["Success rate", fmtPercent(report.baseline.successRate), fmtPercent(report.candidate.successRate), `${fmtSigned(report.deltas.successRate * 100, 1, " pts")}`, deltaTone(report.deltas.successRate), report.baseline.interval ? `95% interval ${fmtPercent(report.baseline.interval.low, 0)}–${fmtPercent(report.baseline.interval.high, 0)} → ${fmtPercent(report.candidate.interval.low, 0)}–${fmtPercent(report.candidate.interval.high, 0)}` : ""],
    ["Median actions per run (efficiency)", fmtNumber(report.baseline.medianActions, 1), fmtNumber(report.candidate.medianActions, 1), fmtSigned(report.deltas.medianActions, 1), deltaTone(report.deltas.medianActions, true), "fewer is better"],
    ["Mean wasted actions", fmtNumber(report.baseline.meanWastedActions, 2), fmtNumber(report.candidate.meanWastedActions, 2), fmtSigned(report.deltas.meanWastedActions, 2), deltaTone(report.deltas.meanWastedActions, true), "actions whose result the next observation does not show helping: no item or food gained, no new ground explored, not closer to the target, no healing, no retreat"],
    ["Unsafe actions", "—", "—", fmtSigned(report.deltas.unsafeActions, 0), deltaTone(report.deltas.unsafeActions, true), "any increase blocks promotion"],
    ["Deaths", "—", "—", fmtSigned(report.deltas.deaths, 0), deltaTone(report.deltas.deaths, true), "any increase blocks promotion"],
  ];
  const changed = report.scenarios.filter((entry) => entry.successDelta !== 0 || entry.actionsDelta !== 0 || entry.unsafeDelta !== 0 || entry.deathsDelta !== 0);
  return card(
    { title: "Baseline versus candidate", subtitle: `${report.checkpointId} · evaluated ${fmtDateTime(report.generatedAt)}`, actions: sourceBadge("offline") },
    reports.length > 1 ? h("p", { class: "small" }, "Report: ", reports.map((entry, i) => button(entry.checkpointId, { action: "pick-report", data: { index: i }, tone: i === index ? "primary" : "" }))) : null,
    conclusionNotice(report.conclusion),
    kv([
      ["Verdict from the existing gate", report.verdict === "promotable" ? badge("PROMOTABLE", "good") : badge("NOT PROMOTABLE", "neutral"), "The label comes only from the gate's criteria; nothing here promotes anything."],
      ["Evaluation set", report.evaluationSet ? `${report.evaluationSet.scenarios} scenarios × ${report.evaluationSet.seedsPerScenario} seeds = ${report.evaluationSet.runs} runs (id ${report.evaluationSet.id})` : null],
      ["Progress definition", report.evaluationSet ? (report.evaluationSet.progressDefinition ?? "v1 · item and food gains only (this report was written before the current definition, so its wasted-action figures are not comparable with newer reports)") : null],
      ["Held-out seeds", `${report.heldOut.seeds} seeds, disjoint from training: ${report.heldOut.disjointFromTraining ? "yes" : "no"}`],
      ["Learned contexts in candidate", orUnknown(report.learnedContexts, fmtNumber)],
      ["Runs where the candidate chose differently", report.behaviour ? `${fmtNumber(report.behaviour.runsWithDifferentChoices)} of ${fmtNumber(report.behaviour.pairedRuns)} (${fmtNumber(report.behaviour.scenariosWithDifferentChoices)} scenarios)` : null],
      ["Paired outcomes on identical worlds", report.paired ? `candidate better ${fmtNumber(report.paired.candidateBetter)} · baseline better ${fmtNumber(report.paired.baselineBetter)} · tied ${fmtNumber(report.paired.tied)}` : null],
      ["Baseline stable", report.baselineStability ? h("span", null, report.baselineStability.stable ? badge("reproduced", "good") : badge("changed", "warn"), " ", report.baselineStability.note) : null],
    ]),
    table({
      caption: "Baseline versus candidate metrics",
      columns: [{ label: "Metric", cell: (r) => r[0] }, { label: "Baseline", align: "right", cell: (r) => r[1] }, { label: "Candidate", align: "right", cell: (r) => r[2] }, { label: "Change", align: "right", cell: (r) => badge(r[3], r[4]) }, { label: "Note", cell: (r) => h("span", { class: "small muted" }, r[5]) }],
      rows: rows.map((value, i) => ({ key: i, value })),
    }),
    h("h4", null, "Scenario deltas"),
    changed.length
      ? table({
          dense: true,
          columns: [{ label: "Scenario", cell: (e) => e.scenarioId }, { label: "Success", align: "right", cell: (e) => `${fmtPercent(e.baselineSuccess, 0)} → ${fmtPercent(e.candidateSuccess, 0)}` }, { label: "Median actions", align: "right", cell: (e) => `${fmtNumber(e.baselineMedianActions, 1)} → ${fmtNumber(e.candidateMedianActions, 1)}` }, { label: "Unsafe Δ", align: "right", cell: (e) => fmtSigned(e.unsafeDelta, 0) }, { label: "Deaths Δ", align: "right", cell: (e) => fmtSigned(e.deathsDelta, 0) }],
          rows: changed.map((value) => ({ key: value.scenarioId, value })),
        })
      : h("p", { class: "muted" }, `No scenario differs from the baseline (${report.scenarios.length} compared). ${report.conclusion === "no-learned-contexts" ? "That is because the checkpoint is the baseline." : "See the conclusion above for what that means."}`),
    report.reasons.length ? h("details", null, h("summary", null, "Reasons the gate gave"), h("ul", null, report.reasons.map((reason) => h("li", null, reason)))) : null,
    h("p", { class: "small muted" }, report.heldOut.note),
  );
}

function offlineReport(ctx) {
  const report = ctx.data.evaluation?.value?.offline?.report ?? ctx.snapshot.learning?.evaluation ?? null;
  if (!report || !report.generatedAt) {
    return card({ title: "Offline evaluation report", actions: sourceBadge("unavailable") }, empty("No offline evaluation report", "Run the offline evaluation above; it writes the report the promotion gate reads."));
  }
  return card(
    { title: "Offline evaluation report", subtitle: `Written ${fmtDateTime(report.generatedAt)}`, actions: sourceBadge("historical") },
    kv([
      ["Scenarios × seeds", `${fmtNumber(report.scenarios)} × ${orUnknown(report.seedsPerScenario, fmtNumber)} = ${fmtNumber(report.runs)} runs`],
      ["Overall success", orUnknown(report.successRate, (v) => fmtPercent(v))],
      ["Unsafe actions", orUnknown(report.unsafeActions, fmtNumber)],
      ["Every gate passed", report.passed === null ? null : report.passed ? badge("PASS", "good") : badge("FAIL", "bad")],
      ["Policy candidate in the report", report.policyCandidateId ?? "none (no learned candidate existed)"],
      ["Candidate promotable", report.policyPromotable === null ? null : report.policyPromotable ? badge("promotable", "good") : badge("not promotable", "neutral")],
    ]),
    (report.policyGateReasons ?? []).length ? h("ul", null, report.policyGateReasons.map((reason) => h("li", null, reason))) : null,
  );
}

function live(ctx) {
  const resource = ctx.data.evaluation;
  const job = (ctx.snapshot.jobs?.items ?? []).find((entry) => entry.kind === "live-verification") ?? resource?.value?.live?.latest ?? null;
  return card(
    { title: "Live verification", subtitle: "Connects a verification bot to a real Minecraft server. Separate from everything above.", class: "live-card", actions: sourceBadge("live") },
    notice("warn", "Read before running", "This connects a second bot to the server you name. The read-only checks only observe. Digging and combat change the world and need their own confirmation. Nothing here has been verified live unless a result below says so."),
    job ? jobCard(job, "Latest live verification") : h("div", null, badge("NOT VERIFIED LIVE", "warn"), h("p", { class: "muted" }, "No live verification has been run from this page. Offline results do not stand in for it.")),
  );
}

function roadmap(ctx) {
  const roadmapState = ctx.snapshot.roadmap;
  if (!roadmapState) return card({ title: "Evidence-based roadmap" }, empty("Not available", "The roadmap is built from recorded evidence while a session or the app runs."));
  const items = filterRoadmap(roadmapState.items, { showClosed: ctx.ui.roadmapShowClosed === true });
  const groups = groupByCategory(items);
  const itemRow = (item) =>
    h(
      "li",
      { key: item.fingerprint },
      h("div", null, h("strong", null, item.title), " ", badge(ROADMAP_STATUS_LABELS[item.status] ?? item.status, "neutral"), " ", badge(ROADMAP_KIND_LABELS[item.kind] ?? item.kind, "info"), h("p", { class: "small" }, item.summary)),
      h(
        "div",
        { class: "button-row" },
        roadmapActionsFor(item).map((action) =>
          button(ROADMAP_ACTION_LABELS[action] ?? action, {
            command: "roadmapAction",
            payload: { fingerprint: item.fingerprint, action },
            data: ROADMAP_ACTIONS_WITH_NOTE.has(action) ? { confirm: `${ROADMAP_ACTION_LABELS[action] ?? action} this item?` } : {},
          }),
        ),
      ),
    );
  return card(
    { title: "Evidence-based roadmap", subtitle: roadmapState.evidenceAt ? `Newest evidence ${fmtAgo(roadmapState.evidenceAt, ctx.now)}` : "No evidence recorded yet" },
    h("p", { class: "muted small" }, roadmapState.note),
    roadmapState.error ? notice("bad", "Roadmap problem", roadmapState.error) : null,
    groups.length
      ? groups.map(([category, entries]) => h("div", { key: category, class: "roadmap-group" }, h("h4", null, category), h("ul", { class: "roadmap" }, entries.map(itemRow))))
      : empty("No open items", "Everything the evidence flags has been handled or resolved."),
  );
}

export function renderEvaluation(ctx) {
  return {
    "eval-notice": notice("info", "Offline and live results are kept apart", "Everything under “offline” ran in the simulator or in unit tests. A result counts as live only if it came from the live verification section, with a server that was actually reached."),
    "eval-jobs": offlineJobs(ctx),
    "eval-compare": compare(ctx),
    "eval-offline-report": offlineReport(ctx),
    "eval-live": live(ctx),
    "roadmap-items": roadmap(ctx),
  };
}

export { ROADMAP_CATEGORY_ORDER, fmtTime, unknown };
