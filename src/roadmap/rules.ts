import type { EvidenceBundle } from "./evidence.js";
import type { RoadmapCandidate, RoadmapCategory, RoadmapEvidence } from "./model.js";
import { withoutCollisions } from "./proposals.js";

/** Source mix of the episode evidence, so a reader can see how much of a number is simulator data. */
function provenanceMix(episodes: { readonly total: number; readonly byProvenance?: Readonly<Record<string, number>> }): string {
  if (!episodes.byProvenance) return "source mix not recorded";
  const parts = Object.entries(episodes.byProvenance)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind} ${count}`);
  return parts.join(", ");
}


/**
 * Turns evidence into roadmap candidates. Each rule has a fixed threshold, so a finding appears only when the
 * recorded numbers cross it. Related findings share a fingerprint and are grouped into one item.
 *
 * Kinds: a measured failure is a `defect`. A measured symptom without an established cause is a `hypothesis`.
 * Documented gaps are `known-limitation`, and optional work with no measured problem is an `idea`.
 */

const REPEAT_FAILURE_MIN = 3;
const IDLE_RATIO_MIN = 0.05;
const EPISODE_FAILURE_MIN = 5;
const EPISODE_FAILURE_RATIO_MIN = 0.05;
const SKILL_MIN_ATTEMPTS = 10;
const SKILL_SUCCESS_MAX = 0.9;
const LOOP_HZ_MIN = 0.8;
const OBSERVATION_AGE_P95_MAX_MS = 2_000;
const REACTION_P95_MAX_MS = 1_000;

const BLOCKED_CODE_CATEGORY: Readonly<Record<string, RoadmapCategory>> = {
  TASK_BLOCKED_TARGETS: "observation",
  TASK_BLOCKED_HUNGER: "survival",
  TASK_BLOCKED_HEALTH: "survival",
  TASK_BLOCKED_TOOL: "autonomy",
  TASK_ACTION_BUDGET: "autonomy",
  NAVIGATION_STUCK: "navigation",
};

function baseTaskId(taskId: string): string {
  return taskId.replace(/:\d+$/, "");
}

function categoryOfSkill(skill: string): RoadmapCategory {
  if (skill.includes("navigate")) return "navigation";
  if (skill.includes("collect") || skill.includes("harvest") || skill.includes("mine") || skill.includes("craft")) return "autonomy";
  if (skill.includes("eat") || skill.includes("rest")) return "survival";
  return "reliability";
}

function newest(values: readonly (string | null | undefined)[]): string | null {
  const present = values.filter((value): value is string => typeof value === "string");
  return present.length === 0 ? null : present.sort().at(-1)!;
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export function deriveCandidates(bundle: EvidenceBundle): RoadmapCandidate[] {
  const candidates: RoadmapCandidate[] = [];

  // 1. Autonomy tasks that keep failing without progress.
  const failedByTask = new Map<string, { attempts: number; codes: Set<string>; actions: number; simulatedMs: number; profiles: Set<string>; at: string[] }>();
  for (const profile of bundle.profiles) {
    for (const task of profile.tasks) {
      if (task.status === "succeeded") continue;
      const key = baseTaskId(task.taskId);
      const entry = failedByTask.get(key) ?? { attempts: 0, codes: new Set<string>(), actions: 0, simulatedMs: 0, profiles: new Set<string>(), at: [] };
      entry.attempts += 1;
      if (task.failureCode) entry.codes.add(task.failureCode);
      entry.actions += task.actions;
      entry.simulatedMs += task.simulatedMs;
      entry.profiles.add(profile.file);
      entry.at.push(profile.measuredAt);
      failedByTask.set(key, entry);
    }
  }
  // Tasks that fail repeatedly share one cause to investigate (how the controller re-selects a failing subgoal),
  // so they are grouped into one item with a line of evidence per task.
  const repeating = [...failedByTask.entries()].filter(([, entry]) => entry.attempts >= REPEAT_FAILURE_MIN);
  if (repeating.length > 0) {
    const totalAttempts = repeating.reduce((sum, [, entry]) => sum + entry.attempts, 0);
    const measuredAt = newest(repeating.flatMap(([, entry]) => entry.at));
    const evidence: RoadmapEvidence[] = repeating
      .sort((a, b) => b[1].attempts - a[1].attempts)
      .map(([task, entry]) => ({
        source: "autonomy profile",
        metric: task,
        value: `${entry.attempts} failed attempts in ${entry.profiles.size} run(s); codes ${[...entry.codes].join(", ") || "none recorded"}; ${(entry.actions / entry.attempts).toFixed(1)} actions and ${Math.round(entry.simulatedMs)} ms simulated per attempt`,
        measuredAt,
      }));
    candidates.push({
      fingerprint: "autonomy.repeat-failure",
      title: `Autonomy tasks repeat failed attempts (${repeating.length} task${repeating.length === 1 ? "" : "s"}, ${totalAttempts} attempts)`,
      category: "autonomy",
      kind: "defect",
      explanation:
        "The autonomy controller selects these tasks again after each failed attempt, and each failed attempt ends after a few actions with no progress. The recorded evidence shows the repeat; the action that fails is not identified yet.",
      evidence,
      expectedBenefit: `Stops repeated attempts that end without progress (${totalAttempts} in the recorded runs), so the planner reaches other subgoals sooner.`,
      effort: 2,
      impact: 4,
      urgency: 4,
      confidence: 0.9,
      dependencies: ["Per-action trace of one failed attempt, to name the action that fails"],
      severity: totalAttempts,
      measuredAt,
    });
  }

  // 2. Idle virtual time in autonomy profiles. A hypothesis: it may be the same failures counted again.
  let worstIdle: { ratio: number; idle: number; virtual: number; at: string; file: string } | null = null;
  for (const profile of bundle.profiles) {
    if (profile.virtualSeconds <= 0) continue;
    const ratio = profile.idleVirtualSeconds / profile.virtualSeconds;
    if (ratio >= IDLE_RATIO_MIN && (worstIdle === null || ratio > worstIdle.ratio)) {
      worstIdle = { ratio, idle: profile.idleVirtualSeconds, virtual: profile.virtualSeconds, at: profile.measuredAt, file: profile.file };
    }
  }
  if (worstIdle) {
    candidates.push({
      fingerprint: "autonomy.idle-time",
      title: `Idle time is ${pct(worstIdle.ratio)} of a profile run`,
      category: "autonomy",
      kind: "hypothesis",
      explanation:
        "Idle time is charged when no task is ready or the controller waits for a cooldown. It may be the same failed attempts as the item above, counted again, rather than a separate problem. Not established.",
      evidence: [
        { source: worstIdle.file, metric: "idle virtual time", value: `${worstIdle.idle.toFixed(1)} s of ${worstIdle.virtual.toFixed(1)} s`, measuredAt: worstIdle.at },
      ],
      expectedBenefit: "Shows whether idle time is a separate cost. If it is the same failures, fixing those removes it too.",
      effort: 1,
      impact: 2,
      urgency: 2,
      confidence: 0.5,
      dependencies: ["Autonomy repeat-failure item"],
      severity: Math.round(worstIdle.ratio * 100),
      measuredAt: worstIdle.at,
    });
  }

  // 3. Failing tests in the latest recorded test run. Each failing test is a confirmed defect.
  if (bundle.tests) {
    for (const name of bundle.tests.failures) {
      candidates.push({
        fingerprint: `reliability.test:${name}`,
        title: `Failing test: ${name}`,
        category: "reliability",
        kind: "defect",
        explanation: "This test failed in the latest recorded test run.",
        evidence: [
          { source: "test record", metric: "result", value: `${bundle.tests.passed} passed, ${bundle.tests.failed} failed`, measuredAt: bundle.tests.measuredAt },
        ],
        expectedBenefit: "Restores a passing suite, which is the baseline for every other change.",
        effort: 1,
        impact: 4,
        urgency: 5,
        confidence: 1,
        dependencies: [],
        severity: 1,
        measuredAt: bundle.tests.measuredAt,
      });
    }
  }

  // 4. Recurring failure codes in recorded episodes.
  const episodes = bundle.episodes;
  if (episodes && episodes.total > 0) {
    for (const [code, count] of Object.entries(episodes.failureCodes)) {
      if (count < EPISODE_FAILURE_MIN || count / episodes.total < EPISODE_FAILURE_RATIO_MIN) continue;
      candidates.push({
        fingerprint: `episodes.failure:${code}`,
        title: `Recurring failure ${code} in ${count} of ${episodes.total} episodes`,
        category: BLOCKED_CODE_CATEGORY[code] ?? "reliability",
        kind: "defect",
        explanation:
          "This failure code is recorded repeatedly in episodes. The episode records hold the action and target features, but the cause is not identified from the count alone.",
        evidence: [
          { source: `episode store (${provenanceMix(episodes)})`, metric: "episodes with this code", value: `${count} of ${episodes.total} (${pct(count / episodes.total)})`, measuredAt: episodes.measuredAt },
        ],
        expectedBenefit: "Fewer episodes end in this failure, which reduces recurring failures and clarifies the policy's signal.",
        effort: 2,
        impact: 3,
        urgency: 3,
        confidence: 0.8,
        dependencies: ["Trace of the first few episodes with this code"],
        severity: count,
        measuredAt: episodes.measuredAt,
      });
    }

    // 5. Skills whose recorded success rate is low. A measured defect, with the cause left open.
    for (const [skill, stats] of Object.entries(episodes.skills)) {
      if (stats.attempts < SKILL_MIN_ATTEMPTS) continue;
      const rate = stats.successes / stats.attempts;
      if (rate >= SKILL_SUCCESS_MAX) continue;
      candidates.push({
        fingerprint: `episodes.skill-success:${skill}`,
        title: `${skill} succeeds in ${pct(rate)} of recorded attempts`,
        category: categoryOfSkill(skill),
        kind: "defect",
        explanation:
          "This skill's recorded success rate is below the threshold. The failures are real episodes, but the cause is not identified yet.",
        evidence: [
          { source: `episode store (${provenanceMix(episodes)})`, metric: "successes", value: `${stats.successes} of ${stats.attempts}`, measuredAt: episodes.measuredAt },
        ],
        expectedBenefit: "Higher skill success lowers wasted actions and makes the planner's expected outcomes more reliable.",
        effort: 2,
        impact: 3,
        urgency: 2,
        confidence: 0.7,
        dependencies: [],
        severity: stats.attempts - stats.successes,
        measuredAt: episodes.measuredAt,
      });
    }
  }

  // 6. Live runtime measurements. Present only when a live host reports them; the CLI never invents them.
  const runtime = bundle.runtime;
  if (runtime) {
    if (runtime.loopHz !== null && runtime.loopHz < LOOP_HZ_MIN) {
      candidates.push({
        fingerprint: "performance.loop-rate",
        title: `Fast loop runs at ${runtime.loopHz.toFixed(2)} Hz`,
        category: "performance",
        kind: "defect",
        explanation: "The fast observation loop is slower than its target of about 1 Hz.",
        evidence: [{ source: runtime.source, metric: "loop frequency", value: `${runtime.loopHz.toFixed(2)} Hz`, measuredAt: runtime.measuredAt }],
        expectedBenefit: "Observation and reflexes stay fresh enough to react within a second.",
        effort: 2,
        impact: 4,
        urgency: 4,
        confidence: 0.9,
        dependencies: [],
        severity: Math.round((LOOP_HZ_MIN - runtime.loopHz) * 100),
        measuredAt: runtime.measuredAt,
      });
    }
    if (runtime.observationIntervalP95Ms !== null && runtime.observationIntervalP95Ms > OBSERVATION_AGE_P95_MAX_MS) {
      candidates.push({
        fingerprint: "observation.interval-p95",
        title: `Observation interval p95 is ${Math.round(runtime.observationIntervalP95Ms)} ms`,
        category: "observation",
        kind: "defect",
        explanation: "Observations arrive less often than the one-second target, so decisions can use state that is up to this old.",
        evidence: [
          { source: runtime.source, metric: "observation interval p95", value: `${Math.round(runtime.observationIntervalP95Ms)} ms`, measuredAt: runtime.measuredAt },
        ],
        expectedBenefit: "Decisions use fresher state, so fewer actions run on stale data.",
        effort: 2,
        impact: 4,
        urgency: 4,
        confidence: 0.9,
        dependencies: [],
        severity: Math.round(runtime.observationIntervalP95Ms / 100),
        measuredAt: runtime.measuredAt,
      });
    }
    if (runtime.reactionP95Ms !== null && runtime.reactionP95Ms > REACTION_P95_MAX_MS) {
      candidates.push({
        fingerprint: "survival.reaction-p95",
        title: `Reaction time p95 is ${Math.round(runtime.reactionP95Ms)} ms`,
        category: "survival",
        kind: "defect",
        explanation: "Time from an urgent condition to the reflex dispatch is above the one-second target.",
        evidence: [{ source: runtime.source, metric: "reaction p95", value: `${Math.round(runtime.reactionP95Ms)} ms`, measuredAt: runtime.measuredAt }],
        expectedBenefit: "Urgent threats and hunger are answered within a second.",
        effort: 2,
        impact: 5,
        urgency: 5,
        confidence: 0.9,
        dependencies: [],
        severity: Math.round(runtime.reactionP95Ms / 100),
        measuredAt: runtime.measuredAt,
      });
    }
  }

  // 7. Documented gaps. These are facts about the code or the verification coverage, not measured failures.
  if (bundle.liveVerification === null) {
    candidates.push({
      fingerprint: "reliability.live-verification",
      title: "The autonomy loop has not been verified on a live Minecraft server",
      category: "reliability",
      kind: "known-limitation",
      explanation:
        "The fast loop, reflexes, planner and performance panel are tested on the simulator and with unit tests. No live run has been recorded, so live behaviour is unverified.",
      evidence: [
        { source: "data/evidence/live-verification.json", metric: "live verification record", value: "absent", measuredAt: null },
      ],
      expectedBenefit: "Turns the simulator results into live results, or shows where they differ.",
      effort: 3,
      impact: 5,
      urgency: 3,
      confidence: 1,
      dependencies: ["A disposable Minecraft server, as in docs/LIVE_VERIFICATION.md"],
      severity: 1,
      measuredAt: null,
    });
  }
  candidates.push({
    fingerprint: "world-knowledge.seed-auto-detect",
    title: "Detect the world seed automatically",
    category: "world-knowledge",
    kind: "idea",
    explanation:
      "The world seed is entered by the operator. No verified source for the seed was found in this codebase, so nothing is detected automatically.",
    evidence: [{ source: "world seed store", metric: "source", value: "manual entry only", measuredAt: null }],
    expectedBenefit: "Less manual setup, if the server exposes the seed reliably.",
    effort: 2,
    impact: 2,
    urgency: 1,
    confidence: 0.4,
    dependencies: ["A verified seed source on the server"],
    severity: 1,
    measuredAt: null,
  });

  // 8. Operator proposals. They arrive validated and already carry `measuredAt: null`, so they can never
  //    reopen a settled finding. A proposal whose fingerprint a rule above already derived is dropped: the
  //    measured finding wins, because two candidates sharing one fingerprint would produce two list entries
  //    fighting over the same saved decision.
  candidates.push(...withoutCollisions(bundle.proposals, candidates).kept);

  return candidates;
}
