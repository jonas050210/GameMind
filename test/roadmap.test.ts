import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEvidence, runtimeEvidenceOf, type EvidenceBundle } from "../src/roadmap/evidence.js";
import { deriveCandidates } from "../src/roadmap/rules.js";
import {
  applyAction,
  nextRecommendedTask,
  reconcile,
  scoreCandidate,
  type RoadmapCandidate,
  type RoadmapDecision,
} from "../src/roadmap/model.js";
import { RoadmapService } from "../src/roadmap/service.js";
import { filterRoadmap, groupByCategory, renderingSuspended, roadmapActionsFor, parseHeadless } from "../src/control-center/public/policy.js";

const T0 = "2026-10-10T08:00:00.000Z";
const T1 = "2026-10-10T09:00:00.000Z";
const T2 = "2026-10-10T10:00:00.000Z";

function candidate(overrides: Partial<RoadmapCandidate> & { fingerprint: string }): RoadmapCandidate {
  return {
    title: `Finding ${overrides.fingerprint}`,
    category: "autonomy",
    kind: "defect",
    explanation: "measured",
    evidence: [],
    expectedBenefit: "benefit",
    effort: 1,
    impact: 4,
    urgency: 4,
    confidence: 0.9,
    dependencies: [],
    severity: 5,
    measuredAt: T0,
    ...overrides,
  };
}

function bundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    profiles: [],
    tests: null,
    training: null,
    episodes: null,
    liveVerification: null,
    runtime: null,
    ...overrides,
  };
}

function taskRecord(taskId: string, status: string, actions = 2) {
  return { taskId, status, failureCode: status === "succeeded" ? null : "CONSECUTIVE_ACTION_FAILURES", actions, simulatedMs: 0 };
}

test("scoring: a measured defect outranks an idea with the same numbers, and an operator priority rescales it", () => {
  const defect = scoreCandidate({ impact: 4, urgency: 4, confidence: 0.9, effort: 2 }, null, false);
  const idea = scoreCandidate({ impact: 4, urgency: 4, confidence: 0.3, effort: 2 }, null, false);
  assert.ok(defect > idea, "confidence lowers a speculative item below a measured one");
  assert.equal(scoreCandidate({ impact: 4, urgency: 4, confidence: 0.9, effort: 2 }, 5, false), Math.round(defect * (5 / 3) * 100) / 100);
  assert.ok(scoreCandidate({ impact: 1, urgency: 1, confidence: 0.1, effort: 3 }, null, true) > defect, "a pin puts the item first");
});

test("reconcile: a new finding is proposed and carries its first-seen history", () => {
  const result = reconcile({ candidates: [candidate({ fingerprint: "a" })], decisions: {}, now: T1, evidenceAt: T0 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.status, "proposed");
  assert.equal(result.decisions.a!.firstSeenAt, T1);
  assert.match(result.items[0]!.history[0]!.event, /first observed/);
});

test("reconcile: a dismissed finding stays dismissed unless newer evidence shows at least 1.5x the severity", () => {
  const decisions: Record<string, RoadmapDecision> = {};
  let r = reconcile({ candidates: [candidate({ fingerprint: "a", severity: 10 })], decisions, now: T0, evidenceAt: T0 });
  applyAction(r.decisions.a!, "dismiss", null, T0, 10, null);
  // Same severity on newer evidence: stays dismissed.
  r = reconcile({ candidates: [candidate({ fingerprint: "a", severity: 10, measuredAt: T1 })], decisions: r.decisions, now: T1, evidenceAt: T1 });
  assert.equal(r.items[0]!.status, "dismissed");
  // Severity rose to 14 (under 1.5x): still dismissed.
  r = reconcile({ candidates: [candidate({ fingerprint: "a", severity: 14, measuredAt: T2 })], decisions: r.decisions, now: T2, evidenceAt: T2 });
  assert.equal(r.items[0]!.status, "dismissed");
  // The same timestamp is not new evidence: a re-read of T2 at severity 15 does not reopen it.
  const reread = reconcile({ candidates: [candidate({ fingerprint: "a", severity: 15, measuredAt: T2 })], decisions: r.decisions, now: T2, evidenceAt: T2 });
  assert.equal(reread.items[0]!.status, "dismissed");
  // Severity reached 15 (1.5x) on evidence measured after the last applied reading: reopened, reason recorded.
  r = reconcile({ candidates: [candidate({ fingerprint: "a", severity: 15, measuredAt: "2026-10-10T11:00:00.000Z" })], decisions: r.decisions, now: "2026-10-10T11:00:00.000Z", evidenceAt: "2026-10-10T11:00:00.000Z" });
  assert.equal(r.items[0]!.status, "proposed");
  assert.equal(r.items[0]!.reopenedCount, 1);
  assert.match(r.items[0]!.history.at(-1)!.event, /reopened: severity 10 → 15/);
});

test("reconcile: an implemented finding is verified only when newer evidence no longer shows it", () => {
  let r = reconcile({ candidates: [candidate({ fingerprint: "a", measuredAt: T0 })], decisions: {}, now: T0, evidenceAt: T0 });
  applyAction(r.decisions.a!, "implement", null, T1, 5, "changed the retry rule");
  // Evidence measured after the change, and the finding is gone: verified.
  const verified = reconcile({ candidates: [], decisions: r.decisions, now: T2, evidenceAt: T2 });
  assert.equal(verified.decisions.a!.status, "verified");
  assert.match(verified.decisions.a!.verification ?? "", /not observed in evidence measured/);
  assert.equal(verified.items.length, 0, "a verified finding that is no longer measured is not shown as open");
});

test("reconcile: an implemented finding still present on newer evidence is reopened, not verified", () => {
  let r = reconcile({ candidates: [candidate({ fingerprint: "a", measuredAt: T0 })], decisions: {}, now: T0, evidenceAt: T0 });
  applyAction(r.decisions.a!, "implement", null, T1, 5, null);
  r = reconcile({ candidates: [candidate({ fingerprint: "a", measuredAt: T2 })], decisions: r.decisions, now: T2, evidenceAt: T2 });
  assert.equal(r.items[0]!.status, "proposed");
  assert.equal(r.items[0]!.reopenedCount, 1);
  assert.match(r.items[0]!.history.at(-1)!.event, /still observed after implementation/);
});

test("reconcile: an implemented finding is not verified on the same evidence it was marked from", () => {
  let r = reconcile({ candidates: [candidate({ fingerprint: "a", measuredAt: T0 })], decisions: {}, now: T0, evidenceAt: T0 });
  applyAction(r.decisions.a!, "implement", null, T1, 5, null);
  // Evidence is older than the implementation, so absence proves nothing yet.
  const stillWaiting = reconcile({ candidates: [], decisions: r.decisions, now: T2, evidenceAt: T0 });
  assert.equal(stillWaiting.decisions.a!.status, "implemented");
});

test("reconcile: an open finding that disappears is hidden and counted as resolved, not deleted", () => {
  const r = reconcile({ candidates: [candidate({ fingerprint: "a" })], decisions: {}, now: T0, evidenceAt: T0 });
  const gone = reconcile({ candidates: [], decisions: r.decisions, now: T1, evidenceAt: T1 });
  assert.equal(gone.items.length, 0);
  assert.equal(gone.resolved, 1);
  assert.ok(gone.decisions.a, "the decision is kept so the finding reappears with its history");
});

test("applyAction: invalid transitions and priorities are refused with a reason", () => {
  const decision: RoadmapDecision = {
    status: "dismissed",
    pinned: false,
    priority: null,
    severity: 1,
    dismissedSeverity: 1,
    implementedAt: null,
    lastEvidenceAt: null,
    firstSeenAt: T0,
    lastSeenAt: null,
    reopenedCount: 0,
    verification: null,
    history: [],
  };
  assert.equal(applyAction(decision, "start", null, T1, null, null).ok, false);
  assert.equal(applyAction(decision, "implement", null, T1, null, null).ok, false);
  assert.equal(applyAction(decision, "prioritize", 9, T1, null, null).ok, false);
  assert.equal(applyAction(decision, "restore", null, T1, null, null).ok, true);
  assert.equal(decision.status, "proposed");
});

test("next recommended task: the highest-scoring open item, never an idea and never a settled one", () => {
  const items = reconcile({
    candidates: [
      candidate({ fingerprint: "idea", kind: "idea", impact: 5, urgency: 5, confidence: 1, effort: 1 }),
      candidate({ fingerprint: "low", impact: 2, urgency: 2, confidence: 0.5, effort: 2 }),
      candidate({ fingerprint: "top", impact: 5, urgency: 4, confidence: 0.9, effort: 2 }),
    ],
    decisions: {},
    now: T0,
    evidenceAt: T0,
  }).items;
  assert.equal(nextRecommendedTask(items)?.fingerprint, "top");
  const topOnly = items.filter((item) => item.fingerprint !== "top");
  assert.equal(nextRecommendedTask(topOnly)?.fingerprint, "low", "with the top item gone, the next open defect is chosen");
  assert.equal(nextRecommendedTask(items.filter((item) => item.kind === "idea")), null, "an idea is never suggested");
});

test("rules: repeated autonomy failures become one grouped defect with a line per task", () => {
  const candidates = deriveCandidates(
    bundle({
      profiles: [
        {
          file: "p1.json",
          measuredAt: T0,
          scenario: "berries",
          seed: 101,
          virtualSeconds: 900,
          idleVirtualSeconds: 65,
          tasks: [
            taskRecord("autonomous:mine-iron-ore", "failed"),
            taskRecord("autonomous:mine-iron-ore", "failed"),
            taskRecord("autonomous:mine-iron-ore", "failed"),
            taskRecord("fallback:gather-logs:0", "failed"),
            taskRecord("fallback:gather-logs:0", "failed"),
            taskRecord("fallback:gather-logs:0", "failed"),
            taskRecord("autonomous:gather-logs", "succeeded", 4),
          ],
        },
      ],
    }),
  );
  const repeat = candidates.filter((item) => item.fingerprint.startsWith("autonomy.repeat-failure"));
  assert.equal(repeat.length, 1, "related tasks share one item");
  assert.equal(repeat[0]!.kind, "defect");
  assert.equal(repeat[0]!.severity, 6);
  assert.equal(repeat[0]!.evidence.length, 2);
  assert.match(repeat[0]!.title, /2 tasks, 6 attempts/);
  const idle = candidates.find((item) => item.fingerprint === "autonomy.idle-time");
  assert.equal(idle?.kind, "hypothesis", "idle time is a hypothesis, not a confirmed defect");
});

test("rules: a single failed attempt is below the threshold, and a passing suite produces no defect", () => {
  const candidates = deriveCandidates(
    bundle({
      profiles: [{ file: "p.json", measuredAt: T0, scenario: "s", seed: 1, virtualSeconds: 100, idleVirtualSeconds: 0, tasks: [taskRecord("autonomous:x", "failed"), taskRecord("autonomous:x", "succeeded")] }],
      tests: { measuredAt: T0, passed: 468, failed: 0, failures: [], command: "npm test" },
    }),
  );
  assert.equal(candidates.filter((item) => item.kind === "defect").length, 0);
});

test("rules: a failing test becomes a defect, and no live verification record keeps the documented gap open", () => {
  const candidates = deriveCandidates(
    bundle({ tests: { measuredAt: T0, passed: 467, failed: 1, failures: ["control center: broken panel"], command: "npm test" } }),
  );
  const failing = candidates.find((item) => item.fingerprint === "reliability.test:control center: broken panel");
  assert.equal(failing?.kind, "defect");
  assert.equal(failing?.urgency, 5);
  const gap = candidates.find((item) => item.fingerprint === "reliability.live-verification");
  assert.equal(gap?.kind, "known-limitation");
  assert.equal(gap?.measuredAt, null, "a documented gap is not a measurement");
});

test("rules: training without a measured gain becomes a hypothesis that states its cause is open", () => {
  const candidates = deriveCandidates(
    bundle({
      training: {
        measuredAt: T0,
        status: "completed",
        episodes: 24,
        evaluation: {
          checkpointId: "ckpt-000024",
          measuredAt: T0,
          verdict: "not-promotable",
          baselineSuccess: 0.73,
          candidateSuccess: 0.73,
          successDelta: 0,
          baselineFailureCodes: { TASK_BLOCKED_TARGETS: 30, TASK_BLOCKED_HUNGER: 16, TASK_BLOCKED_HEALTH: 10, TASK_BLOCKED_TOOL: 10 },
          candidateFailureCodes: {},
        },
      },
    }),
  );
  const gain = candidates.find((item) => item.fingerprint === "training.no-measured-gain");
  assert.equal(gain?.kind, "hypothesis");
  assert.match(gain!.explanation, /does not show why/);
  const blocked = candidates.find((item) => item.fingerprint === "training.eval-blocked");
  assert.equal(blocked?.kind, "hypothesis");
  assert.equal(blocked?.evidence.length, 4, "four blocked codes are grouped into one item");
  assert.match(blocked!.title, /66 runs/);
});

test("rules: recurring episode failures and low skill success are defects only above their thresholds", () => {
  const candidates = deriveCandidates(
    bundle({
      episodes: {
        measuredAt: T0,
        total: 114,
        failureCodes: { NAVIGATION_STUCK: 6, ACTION_NOT_CONFIRMED: 2 },
        skills: { "minecraft.collect-log": { attempts: 30, successes: 22 }, "minecraft.navigate": { attempts: 30, successes: 30 } },
        sources: [],
      },
    }),
  );
  assert.ok(candidates.find((item) => item.fingerprint === "episodes.failure:NAVIGATION_STUCK"));
  assert.equal(candidates.find((item) => item.fingerprint === "episodes.failure:ACTION_NOT_CONFIRMED"), undefined, "two occurrences is noise");
  assert.equal(candidates.find((item) => item.fingerprint === "episodes.skill-success:minecraft.navigate"), undefined);
  assert.equal(candidates.find((item) => item.fingerprint === "episodes.skill-success:minecraft.collect-log")?.kind, "defect");
});

test("runtime rules: a slow loop or a slow reaction is a measured defect; no runtime means no runtime finding", () => {
  const slow = deriveCandidates(
    bundle({ runtime: { measuredAt: T0, observationIntervalP95Ms: 3_500, loopHz: 0.4, reactionP95Ms: 1_800, source: "live runtime (fast loop)" } }),
  );
  assert.equal(slow.find((item) => item.fingerprint === "performance.loop-rate")?.kind, "defect");
  assert.equal(slow.find((item) => item.fingerprint === "observation.interval-p95")?.kind, "defect");
  assert.equal(slow.find((item) => item.fingerprint === "survival.reaction-p95")?.impact, 5);
  const none = deriveCandidates(bundle());
  assert.equal(none.find((item) => item.fingerprint.startsWith("performance.")), undefined);
});

test("runtimeEvidenceOf: null until the loop has observed, so an empty loop is never read as healthy", () => {
  assert.equal(runtimeEvidenceOf(null), null);
  const empty = { sampledAt: T0, observation: { total: 0 } } as unknown as Parameters<typeof runtimeEvidenceOf>[0];
  assert.equal(runtimeEvidenceOf(empty), null);
});

test("evidence: reads real report files, and marks absent sources unavailable instead of inventing them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-roadmap-evidence-"));
  try {
    await mkdir(path.join(directory, "profile"), { recursive: true });
    await writeFile(
      path.join(directory, "profile", "autonomy-berries-101.json"),
      JSON.stringify({ generatedAt: T0, scenario: "berries", seed: 101, virtualSeconds: 900, idleVirtualSeconds: 10, tasks: [taskRecord("autonomous:x", "failed")] }),
    );
    await writeFile(path.join(directory, "tests.json"), JSON.stringify({ measuredAt: T1, passed: 468, failed: 0, failures: [] }));
    const loaded = await loadEvidence({
      profileDirectory: path.join(directory, "profile"),
      testRecordPath: path.join(directory, "tests.json"),
      trainingRoot: path.join(directory, "no-training"),
      episodeFiles: [path.join(directory, "no-episodes.jsonl")],
      liveVerificationPath: path.join(directory, "no-live.json"),
      runtime: null,
    });
    assert.equal(loaded.bundle.profiles.length, 1);
    assert.equal(loaded.bundle.profiles[0]!.measuredAt, T0);
    assert.equal(loaded.bundle.tests?.failed, 0);
    assert.equal(loaded.bundle.training, null);
    assert.equal(loaded.bundle.episodes, null);
    assert.equal(loaded.sources.find((source) => source.name === "live runtime")?.available, false);
    assert.equal(loaded.evidenceAt, T1, "the evidence timestamp is the newest measurement read");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("service: decisions survive a restart, concurrent refreshes share one run, and an unreadable file is kept as a backup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-roadmap-service-"));
  try {
    const options = {
      root: path.join(directory, "roadmap"),
      profileDirectory: path.join(directory, "profile"),
      testRecordPath: path.join(directory, "tests.json"),
      trainingRoot: path.join(directory, "training"),
      episodeFiles: [],
      liveVerificationPath: path.join(directory, "live.json"),
    };
    await writeFile(options.testRecordPath, JSON.stringify({ measuredAt: T0, passed: 467, failed: 1, failures: ["flaky: thing"] }));
    const first = new RoadmapService(options);
    const [a, b] = await Promise.all([first.refresh(), first.refresh()]);
    assert.ok(Date.parse(b.generatedAt ?? "") >= Date.parse(a.generatedAt ?? ""), "an overlapping request is answered by a run that starts after it");
    // A request made while a run is in progress reads evidence after the request, not the earlier run.
    await writeFile(options.testRecordPath, JSON.stringify({ measuredAt: T1, passed: 466, failed: 2, failures: ["flaky: thing", "second: check"] }));
    const during = first.refresh();
    const later = first.refresh();
    const sharedQueue = first.refresh();
    assert.equal(later, sharedQueue, "requests made while one run is queued share the queued run");
    await during;
    const laterSnap = await later;
    assert.ok(laterSnap.items.some((item) => item.fingerprint === "reliability.test:second: check"), "the queued run sees the new record");
    await first.idle();
    const target = a.items.find((item) => item.fingerprint === "reliability.test:flaky: thing");
    assert.ok(target);
    const result = await first.act({ fingerprint: target.fingerprint, action: "plan", note: "investigate" });
    assert.equal(result.ok, true);

    const second = new RoadmapService(options);
    const reloaded = await second.refresh();
    assert.equal(reloaded.items.find((item) => item.fingerprint === target.fingerprint)?.status, "planned", "the plan survives a restart");

    const refused = await second.act({ fingerprint: "nope", action: "dismiss" });
    assert.equal(refused.ok, false);

    await writeFile(path.join(options.root, "state.json"), "{ not json");
    const third = new RoadmapService(options);
    const recovered = await third.refresh();
    assert.match(recovered.error ?? "", /kept at/);
    const names = await readdir(options.root);
    assert.ok(names.some((name) => name.startsWith("state.json.unreadable-")), "the unreadable file is kept, not overwritten");
    assert.equal(JSON.parse(await readFile(path.join(options.root, "state.json"), "utf8")).schemaVersion, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("UI policy: rendering is suspended only while headless training runs, and headless defaults on", () => {
  const running = { training: { status: "running" } };
  const paused = { training: { status: "paused" } };
  const idle = { training: { status: "idle" } };
  const interrupted = { training: { status: "interrupted" } };
  assert.equal(renderingSuspended(running, true), true);
  assert.equal(renderingSuspended(paused, true), true);
  assert.equal(renderingSuspended(running, false), false, "with headless off, the 3D view keeps drawing");
  assert.equal(renderingSuspended(idle, true), false, "no active training, nothing to suspend");
  assert.equal(renderingSuspended(interrupted, true), false, "an interrupted run has no live process");
  assert.equal(renderingSuspended(null, true), false);
  assert.equal(parseHeadless(null), true, "headless is the default");
  assert.equal(parseHeadless("0"), false);
  assert.equal(parseHeadless("1"), true);
});

test("UI policy: filters hide closed items by default and actions match the status", () => {
  const items = [
    { fingerprint: "a", status: "proposed", kind: "defect", category: "autonomy" },
    { fingerprint: "b", status: "dismissed", kind: "idea", category: "interface" },
    { fingerprint: "c", status: "verified", kind: "defect", category: "autonomy" },
  ] as const;
  assert.deepEqual(filterRoadmap([...items]).map((item) => item.fingerprint), ["a"]);
  assert.deepEqual(filterRoadmap([...items], { showClosed: true }).map((item) => item.fingerprint), ["a", "b", "c"]);
  assert.deepEqual(filterRoadmap([...items], { showClosed: true, kind: "idea" }).map((item) => item.fingerprint), ["b"]);
  assert.deepEqual(groupByCategory([...items]).map(([category]) => category), ["autonomy", "interface"]);
  assert.deepEqual(roadmapActionsFor({ status: "dismissed" } as never), ["restore"]);
  assert.deepEqual(roadmapActionsFor({ status: "verified" } as never), []);
  assert.ok(roadmapActionsFor({ status: "proposed" } as never).includes("start"));
  assert.ok(!roadmapActionsFor({ status: "implemented" } as never).includes("start"), "a settled item cannot be started");
});
