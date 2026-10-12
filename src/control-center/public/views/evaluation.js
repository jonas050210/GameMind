import { h } from "../lib/h.js";
import { badge, button, card, empty, kv, notice, sourceBadge, statusBadge, table, unknown } from "../lib/ui.js";
import { fmtAgo, fmtDateTime, fmtDuration, fmtNumber, fmtPercent, fmtTime, orUnknown } from "../lib/format.js";
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
    { title: "Offline tests and evaluation", subtitle: "Run on this machine in the simulator", actions: sourceBadge("offline") },
    jobCard(tests, "Unit and integration tests"),
    jobCard(run, "Offline evaluation run"),
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
    "eval-offline-report": offlineReport(ctx),
    "eval-live": live(ctx),
    "roadmap-items": roadmap(ctx),
  };
}

export { ROADMAP_CATEGORY_ORDER, fmtTime, unknown };
