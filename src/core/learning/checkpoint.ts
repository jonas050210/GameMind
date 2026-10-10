/**
 * Policy checkpoint and versioning system. Tracks policy versions, their provenance, and allows
 * comparison and rollback. Never replaces a reliable policy solely because a candidate performs
 * better on training data.
 *
 * Key design decisions:
 *  1. Every policy version is immutable once written.
 *  2. A new candidate must beat the current active policy on held-out scenarios, not training data.
 *  3. Rollback always returns to the last known-good active policy, or the baseline.
 *  4. Checkpoints include enough provenance to reproduce the policy (episode count, run count,
 *     context count, reward statistics).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PolicyWeights } from "./policy-weights.js";
import type { RewardAggregate } from "./reward.js";

export const CHECKPOINT_VERSION = 1 as const;

export interface PolicyCheckpoint {
  readonly version: typeof CHECKPOINT_VERSION;
  readonly policyId: string;
  readonly createdAt: string;
  readonly policy: PolicyWeights;
  readonly provenance: {
    readonly episodes: number;
    readonly runs: number;
    readonly contexts: number;
    readonly successes: number;
    readonly failures: number;
    readonly rewardStats: {
      readonly meanReward: number;
      readonly ewmaReward: number;
      readonly positiveRate: number;
    } | null;
  };
  /** Why this policy was created (e.g. "promoted after gate pass", "initial baseline"). */
  readonly reason: string;
  /** Hash of the weight table for quick equality checks. */
  readonly fingerprint: string;
}

export interface PolicyHistory {
  readonly checkpoints: readonly PolicyCheckpoint[];
  readonly activeId: string | null;
  readonly baselineId: string;
}

export interface PolicyVersionRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly source: "baseline" | "experience" | "imported";
  readonly contexts: number;
  readonly episodes: number;
  readonly runs: number;
  readonly fingerprint: string;
  readonly reason: string;
  /** Whether this version was ever the active policy. */
  readonly wasActive: boolean;
  /** Whether this version passed the policy gate. */
  readonly passedGate: boolean;
  /** Evaluation results if this version was tested. */
  readonly evalResults: {
    readonly scenarioId: string;
    readonly seeds: number;
    readonly successRate: number;
    readonly safeRate: number;
    readonly meanReward: number;
  }[] | null;
}

export class PolicyCheckpointStore {
  private checkpoints: PolicyCheckpoint[] = [];
  private activeId: string | null = null;
  private history: PolicyVersionRecord[] = [];
  private readonly checkpointDir: string | null;

  constructor(options: { readonly directory?: string } = {}) {
    this.checkpointDir = options.directory ?? null;
  }

  get active(): PolicyCheckpoint | null {
    if (!this.activeId) return null;
    return this.checkpoints.find((c) => c.policyId === this.activeId) ?? null;
  }

  get all(): readonly PolicyCheckpoint[] {
    return this.checkpoints;
  }

  get versions(): readonly PolicyVersionRecord[] {
    return this.history;
  }

  /**
   * Save a new checkpoint. Returns the checkpoint. Does NOT make it active — call activate() for that.
   */
  save(
    policy: PolicyWeights,
    provenance: PolicyCheckpoint["provenance"],
    reason: string,
  ): PolicyCheckpoint {
    const fingerprint = computeFingerprint(policy);
    const checkpoint: PolicyCheckpoint = {
      version: CHECKPOINT_VERSION,
      policyId: policy.id,
      createdAt: new Date().toISOString(),
      policy,
      provenance,
      reason,
      fingerprint,
    };
    // Check for duplicate fingerprint — don't save the same policy twice
    const existing = this.checkpoints.find((c) => c.fingerprint === fingerprint);
    if (existing) return existing;

    this.checkpoints.push(checkpoint);
    // Keep only last 50 checkpoints
    if (this.checkpoints.length > 50) {
      this.checkpoints = this.checkpoints.slice(-50);
    }
    // Record in version history
    this.history.push({
      id: policy.id,
      createdAt: checkpoint.createdAt,
      source: policy.source === "baseline" ? "baseline" : "experience",
      contexts: Object.keys(policy.entries).length,
      episodes: provenance.episodes,
      runs: provenance.runs,
      fingerprint,
      reason,
      wasActive: false,
      passedGate: false,
      evalResults: null,
    });
    return checkpoint;
  }

  /** Make a checkpoint the active policy. */
  activate(policyId: string): boolean {
    const checkpoint = this.checkpoints.find((c) => c.policyId === policyId);
    if (!checkpoint) return false;
    this.activeId = policyId;
    // Update history record
    const record = this.history.find((h) => h.id === policyId);
    if (record) {
      (record as { wasActive: boolean }).wasActive = true;
    }
    return true;
  }

  /** Mark a version as having passed the policy gate. */
  markGatePass(policyId: string, evalResults?: PolicyVersionRecord["evalResults"]): void {
    const record = this.history.find((h) => h.id === policyId);
    if (record) {
      (record as { passedGate: boolean }).passedGate = true;
      if (evalResults) {
        (record as { evalResults: PolicyVersionRecord["evalResults"] }).evalResults = evalResults;
      }
    }
  }

  /** Rollback to the previous active policy, or baseline. */
  rollback(): PolicyCheckpoint | null {
    if (this.checkpoints.length < 2) return null;
    // Find the last checkpoint that was active (before the current)
    const currentIndex = this.checkpoints.findIndex((c) => c.policyId === this.activeId);
    if (currentIndex > 0) {
      const previous = this.checkpoints[currentIndex - 1]!;
      this.activeId = previous.policyId;
      return previous;
    }
    // No previous active — revert to baseline
    this.activeId = null;
    return null;
  }

  /** Compare two checkpoints. Returns a summary of differences. */
  compare(
    leftId: string,
    rightId: string,
  ): { leftOnly: number; rightOnly: number; shared: number; weightDifferences: number } | null {
    const left = this.checkpoints.find((c) => c.policyId === leftId);
    const right = this.checkpoints.find((c) => c.policyId === rightId);
    if (!left || !right) return null;
    const leftKeys = new Set(Object.keys(left.policy.entries));
    const rightKeys = new Set(Object.keys(right.policy.entries));
    let shared = 0;
    let weightDifferences = 0;
    for (const key of leftKeys) {
      if (rightKeys.has(key)) {
        shared++;
        if (left.policy.entries[key]?.weight !== right.policy.entries[key]?.weight) {
          weightDifferences++;
        }
      }
    }
    return {
      leftOnly: leftKeys.size - shared,
      rightOnly: rightKeys.size - shared,
      shared,
      weightDifferences,
    };
  }

  snapshot(): PolicyHistory {
    return {
      checkpoints: [...this.checkpoints],
      activeId: this.activeId,
      baselineId: "baseline-v1",
    };
  }

  restore(snapshot: unknown): void {
    if (typeof snapshot !== "object" || snapshot === null) return;
    const raw = snapshot as Partial<PolicyHistory>;
    if (Array.isArray(raw.checkpoints)) {
      this.checkpoints = raw.checkpoints
        .filter((c): c is PolicyCheckpoint =>
          typeof c === "object" && c !== null && typeof c.policyId === "string" && c.version === CHECKPOINT_VERSION,
        )
        .slice(-50);
    }
    if (typeof raw.activeId === "string") {
      this.activeId = this.checkpoints.some((c) => c.policyId === raw.activeId) ? raw.activeId : null;
    }
  }

  async persist(): Promise<void> {
    if (!this.checkpointDir) return;
    const data = JSON.stringify(this.snapshot(), null, 2);
    await mkdir(this.checkpointDir, { recursive: true });
    const filePath = path.join(this.checkpointDir, "policy-checkpoints.json");
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, `${data}\n`, "utf8");
    await rename(tmp, filePath);
  }

  async load(): Promise<void> {
    if (!this.checkpointDir) return;
    const filePath = path.join(this.checkpointDir, "policy-checkpoints.json");
    try {
      const data = JSON.parse(await readFile(filePath, "utf8"));
      this.restore(data);
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }
}

function computeFingerprint(policy: PolicyWeights): string {
  const keys = Object.keys(policy.entries).sort();
  const parts = keys.map((k) => `${k}:${policy.entries[k]?.weight ?? 1}`);
  let hash = 2_166_136_261;
  const str = parts.join(";");
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(hash ^ str.charCodeAt(i), 16_645_25) >>> 0;
  }
  return (hash >>> 0).toString(16);
}

/**
 * Experiment record: tracks a training or evaluation experiment.
 */
export interface ExperimentRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly config: {
    readonly weightConfig?: Record<string, number>;
    readonly scenarioIds?: readonly string[];
    readonly seeds?: number;
    readonly note?: string;
  };
  readonly result: {
    readonly baselinePolicyId: string;
    readonly candidatePolicyId: string;
    readonly promoted: boolean;
    readonly scenarios: {
      readonly id: string;
      readonly baselineSuccessRate: number;
      readonly candidateSuccessRate: number;
      readonly baselineReward: number;
      readonly candidateReward: number;
      readonly passed: boolean;
    }[];
    readonly overallBaselineSuccessRate: number;
    readonly overallCandidateSuccessRate: number;
    readonly overallBaselineReward: number;
    readonly overallCandidateReward: number;
  } | null;
}

export class ExperimentStore {
  private experiments: ExperimentRecord[] = [];
  private readonly maxRecords = 100;

  create(
    name: string,
    config: ExperimentRecord["config"],
    baselineId: string,
    candidateId: string,
  ): ExperimentRecord {
    const record: ExperimentRecord = {
      id: `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      createdAt: new Date().toISOString(),
      completedAt: null,
      status: "running",
      config,
      result: {
        baselinePolicyId: baselineId,
        candidatePolicyId: candidateId,
        promoted: false,
        scenarios: [],
        overallBaselineSuccessRate: 0,
        overallCandidateSuccessRate: 0,
        overallBaselineReward: 0,
        overallCandidateReward: 0,
      },
    };
    this.experiments.push(record);
    if (this.experiments.length > this.maxRecords) {
      this.experiments = this.experiments.slice(-this.maxRecords);
    }
    return record;
  }

  complete(id: string, result: ExperimentRecord["result"]): void {
    const exp = this.experiments.find((e) => e.id === id);
    if (!exp || !exp.result) return;
    (exp as { completedAt: string }).completedAt = new Date().toISOString();
    (exp as { status: ExperimentRecord["status"] }).status = "completed";
    (exp as { result: ExperimentRecord["result"] }).result = result;
  }

  fail(id: string, reason: string): void {
    const exp = this.experiments.find((e) => e.id === id);
    if (!exp) return;
    (exp as { completedAt: string }).completedAt = new Date().toISOString();
    (exp as { status: ExperimentRecord["status"] }).status = "failed";
    (exp as { config: ExperimentRecord["config"] & { note?: string } }).config = {
      ...exp.config,
      note: `${exp.config.note ?? ""} FAILED: ${reason}`.trim(),
    };
  }

  get(id: string): ExperimentRecord | null {
    return this.experiments.find((e) => e.id === id) ?? null;
  }

  get all(): readonly ExperimentRecord[] {
    return this.experiments;
  }

  get recent(): readonly ExperimentRecord[] {
    return this.experiments.slice(-10).reverse();
  }

  snapshot(): readonly ExperimentRecord[] {
    return [...this.experiments];
  }

  restore(records: readonly ExperimentRecord[]): void {
    this.experiments = records.slice(-this.maxRecords);
  }
}
