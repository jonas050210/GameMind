import type { RiskLevel } from "./types.js";
import { DROWNING_ACTION_BLOCK_AIR_TICKS } from "./survival-thresholds.js";

/**
 * The Safety Broker is the single place where "may this action run at all?" is answered. It sits
 * below the decision model: a goal can be selected, validated and budgeted and still be denied here.
 * Every verdict is recorded so the trace and the Control Center show *why* an action did not run.
 *
 * The broker never mutates the world. It only approves or denies, and it fails closed: when the
 * latest observation is missing or too old, actions that touch the world are denied.
 */

export type SafetyCode =
  | "ALLOWED"
  | "POLICY_DISABLED"
  | "RUN_PAUSED"
  | "RUN_TRIPPED"
  | "CAPABILITY_DENIED"
  | "CAPABILITY_NOT_ALLOWLISTED"
  | "RISK_ABOVE_CEILING"
  | "RUN_ACTION_BUDGET"
  | "CAPABILITY_BUDGET"
  | "CAPABILITY_COOLDOWN"
  | "PROTECTED_STATE"
  | "STALE_OBSERVATION"
  | "NO_OBSERVATION"
  | "CRITICAL_STATE_NO_RECOVERY_SKILL"
  | "HAZARD_NEARBY"
  | "DROWNING_RISK"
  | "VOID";

export interface SafetyCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface SafetyVerdict {
  readonly allowed: boolean;
  readonly code: SafetyCode;
  readonly message: string;
  readonly checks: readonly SafetyCheck[];
  readonly evaluatedAt: string;
  readonly capability: string;
  readonly risk: RiskLevel;
}

export interface SafetyPolicy {
  readonly id: string;
  /** When false every non-read-only capability is denied (panic switch). */
  readonly enabled: boolean;
  /** Capabilities above this risk level are denied regardless of the allowlist. */
  readonly maxRisk: RiskLevel;
  /** When non-empty, only these capabilities may run. */
  readonly allowlist: readonly string[];
  /** Always denied, even when in the allowlist. */
  readonly denylist: readonly string[];
  /** High-risk capabilities unlocked by explicit operator opt-in (e.g. combat). */
  readonly optedInCapabilities: readonly string[];
  readonly maxActionsPerRun: number;
  readonly perCapabilityMaxPerRun: Readonly<Record<string, number>>;
  readonly cooldownMsByCapability: Readonly<Record<string, number>>;
  /** Below this health only these skills run; everything else is denied. Null disables the check. */
  readonly protectedHealthFloor: number | null;
  readonly protectedStateRecoverySkills: readonly string[];
  /** Maximum accepted age of the latest observation for world-touching actions. */
  readonly maxObservationAgeMs: number;
  readonly readOnlyCapabilities: readonly string[];
  /**
   * While a hazard block is observed closer than this, the capabilities in `hazardBlockedCapabilities`
   * are denied. Null disables the check, so a policy that does not know the game's block classes keeps
   * its previous behaviour. Escape actions are deliberately *not* blocked.
   */
  readonly hazardMaxDistance: number | null;
  readonly hazardBlockedCapabilities: readonly string[];
  /** Denied while the head is underwater and air is running out; movement to safety stays allowed. */
  readonly drowningBlockedCapabilities: readonly string[];
}

/** Air ticks below which stationary actions are refused; a normal player has 300. Shared with the reflex layer. */
export const DROWNING_AIR_TICKS = DROWNING_ACTION_BLOCK_AIR_TICKS;

export const RISK_ORDER: Readonly<Record<RiskLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export const DEFAULT_READ_ONLY_CAPABILITIES = [
  "minecraft.look",
  "minecraft.inspect_block",
] as const;

export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  id: "gamemind-default-v1",
  enabled: true,
  maxRisk: "medium",
  allowlist: [],
  denylist: [],
  optedInCapabilities: [],
  // Runaway guard only, not a task budget: tasks end by completion, timeout, stuck detection or stop.
  maxActionsPerRun: 5000,
  perCapabilityMaxPerRun: {},
  cooldownMsByCapability: {},
  protectedHealthFloor: null,
  protectedStateRecoverySkills: [],
  maxObservationAgeMs: 120_000,
  readOnlyCapabilities: DEFAULT_READ_ONLY_CAPABILITIES,
  hazardMaxDistance: null,
  hazardBlockedCapabilities: [],
  drowningBlockedCapabilities: [],
};

export interface SafetyWorldContext {
  readonly sequence: number;
  readonly observedAtMs: number;
  readonly health: number | null;
  readonly food: number | null;
  /** The game mode as the live session reported it; null when it reported nothing usable. */
  readonly gameMode: string | null;
  readonly visibleHostiles: number;
  readonly nearestHostileDistance: number | null;
  readonly isNight: boolean;
  /** Dimension id when the adapter reports one, e.g. "minecraft:the_void"; null when unreported. */
  readonly dimension?: string | null;
  /** Feet/eye height in blocks; used only for the void-floor check when the dimension is unknown. */
  readonly positionY?: number | null;
  /** Distance to the closest observed hazard block (lava, fire, magma), null when nothing was seen. */
  readonly nearestHazardDistance?: number | null;
  readonly nearestHazardName?: string | null;
  /** True while the player is on fire. */
  readonly isBurning?: boolean;
  /** Air supply in ticks when the head is submerged; null when not applicable. */
  readonly oxygenTicks?: number | null;
  readonly maxPlacementDistance?: number;
}

export interface SafetyRequest {
  readonly capability: string;
  readonly risk: RiskLevel;
  readonly skillId?: string;
  readonly source?: string;
  readonly nowMs?: number;
}

export interface SafetySnapshot {
  readonly policy: SafetyPolicy;
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly tripped: boolean;
  readonly tripReason: string | null;
  readonly runId: string | null;
  readonly actionsApproved: number;
  readonly actionsDenied: number;
  readonly approvedByCapability: Readonly<Record<string, number>>;
  readonly deniedByCode: Readonly<Record<string, number>>;
  readonly world: SafetyWorldContext | null;
  readonly recentVerdicts: readonly SafetyVerdict[];
}

export function safetyPolicyFromInput(input: Partial<SafetyPolicy> = {}): SafetyPolicy {
  const policy: SafetyPolicy = { ...DEFAULT_SAFETY_POLICY, ...input };
  if (!Number.isInteger(policy.maxActionsPerRun) || policy.maxActionsPerRun < 1) {
    throw new Error("Safety policy maxActionsPerRun must be a positive integer.");
  }
  if (!Number.isInteger(policy.maxObservationAgeMs) || policy.maxObservationAgeMs < 1_000) {
    throw new Error("Safety policy maxObservationAgeMs must be at least 1000 ms.");
  }
  if (
    policy.protectedHealthFloor !== null &&
    (!Number.isFinite(policy.protectedHealthFloor) ||
      policy.protectedHealthFloor < 0 ||
      policy.protectedHealthFloor > 20)
  ) {
    throw new Error("Safety policy protectedHealthFloor must be between 0 and 20 health or null.");
  }
  return {
    ...policy,
    allowlist: [...new Set(policy.allowlist)],
    denylist: [...new Set(policy.denylist)],
    optedInCapabilities: [...new Set(policy.optedInCapabilities)],
    protectedStateRecoverySkills: [...new Set(policy.protectedStateRecoverySkills)],
  };
}

const RECENT_VERDICT_LIMIT = 40;

export class SafetyBroker {
  private policyValue: SafetyPolicy;
  private paused = false;
  private pauseReason: string | null = null;
  private tripped = false;
  /** True while the current pause is the one `trip` imposed, so clearing a trip does not hide a pause. */
  private pausedByTrip = false;
  private tripReason: string | null = null;
  private runId: string | null = null;
  private actionsApproved = 0;
  private actionsDenied = 0;
  private worldValue: SafetyWorldContext | null = null;
  private readonly runCapabilityCount = new Map<string, number>();
  private readonly lastCapabilityRunAt = new Map<string, number>();
  private readonly approvedByCapability = new Map<string, number>();
  private readonly deniedByCode = new Map<string, number>();
  private readonly recentVerdicts: SafetyVerdict[] = [];

  constructor(policy: Partial<SafetyPolicy> = {}) {
    this.policyValue = safetyPolicyFromInput(policy);
  }

  get policy(): SafetyPolicy {
    return this.policyValue;
  }

  get world(): SafetyWorldContext | null {
    return this.worldValue;
  }

  configure(input: Partial<SafetyPolicy>): SafetyPolicy {
    this.policyValue = safetyPolicyFromInput({ ...this.policyValue, ...input });
    return this.policyValue;
  }

  /**
   * Start measuring a run without touching the operator's flags. `beginRun` is a full reset, which is
   * right for a host that owns the broker's whole lifecycle; a task runner must never be able to
   * un-pause or un-trip an agent that an operator stopped, so it calls this instead.
   */
  startRun(runId: string): void {
    this.runId = runId;
    this.runCapabilityCount.clear();
    this.lastCapabilityRunAt.clear();
  }

  beginRun(runId: string): void {
    this.runId = runId;
    this.runCapabilityCount.clear();
    this.lastCapabilityRunAt.clear();
    this.paused = false;
    this.pauseReason = null;
    this.tripped = false;
    this.tripReason = null;
    this.pausedByTrip = false;
  }

  endRun(): void {
    this.runId = null;
    this.runCapabilityCount.clear();
    this.lastCapabilityRunAt.clear();
  }

  pause(reason = "paused by operator"): void {
    this.paused = true;
    this.pauseReason = reason;
    // An explicit pause is the operator's own hold, so clearing a later trip must not release it.
    this.pausedByTrip = false;
  }

  resume(): void {
    this.paused = false;
    this.pauseReason = null;
    this.pausedByTrip = false;
  }

  /**
   * Lift a trip without touching an independent pause. Tripping sets both holds, so an operator who
   * clears the trip usually resumes right after; keeping the two effects separate means a reset can never
   * silently release a pause that somebody set on purpose.
   */
  clearTrip(): void {
    this.tripped = false;
    this.tripReason = null;
    if (this.pausedByTrip) {
      this.paused = false;
      this.pauseReason = null;
      this.pausedByTrip = false;
    }
  }

  /** Hard stop: no approval until an operator explicitly resumes. */
  trip(reason = "safety trip"): void {
    this.tripped = true;
    this.tripReason = reason;
    // A trip always pauses. If the run was already paused for an operator's own reason, that pause is
    // left alone, so resetting the trip cannot quietly release a hold somebody set deliberately.
    if (!this.paused) {
      this.paused = true;
      this.pauseReason = reason;
      this.pausedByTrip = true;
    }
  }

  updateWorld(context: SafetyWorldContext): void {
    // Sequence numbers only increase within a session; a lower sequence means a newer session.
    if (this.worldValue && context.sequence < this.worldValue.sequence && this.runId) return;
    this.worldValue = context;
  }

  /** `nowMs` is the clock the verdict was evaluated on, so cooldowns stay consistent with the check. */
  private record(verdict: SafetyVerdict, nowMs = Date.now()): SafetyVerdict {
    this.recentVerdicts.push(verdict);
    if (this.recentVerdicts.length > RECENT_VERDICT_LIMIT) this.recentVerdicts.shift();
    if (verdict.allowed) {
      this.actionsApproved += 1;
      this.approvedByCapability.set(
        verdict.capability,
        (this.approvedByCapability.get(verdict.capability) ?? 0) + 1,
      );
      this.runCapabilityCount.set(
        verdict.capability,
        (this.runCapabilityCount.get(verdict.capability) ?? 0) + 1,
      );
      this.lastCapabilityRunAt.set(verdict.capability, nowMs);
    } else {
      this.actionsDenied += 1;
      this.deniedByCode.set(verdict.code, (this.deniedByCode.get(verdict.code) ?? 0) + 1);
    }
    return verdict;
  }

  evaluate(request: SafetyRequest): SafetyVerdict {
    const checks: SafetyCheck[] = [];
    const policy = this.policyValue;
    const nowMs = request.nowMs ?? Date.now();
    const readOnly = policy.readOnlyCapabilities.includes(request.capability);

    const check = (name: string, passed: boolean, detail: string): void => {
      checks.push({ name, passed, detail });
    };
    const deny = (code: SafetyCode, message: string): SafetyVerdict =>
      this.record({
        allowed: false,
        code,
        message,
        checks,
        evaluatedAt: new Date(nowMs).toISOString(),
        capability: request.capability,
        risk: request.risk,
      }, nowMs);

    check("tripped", !this.tripped, this.tripped ? `Tripped: ${this.tripReason}` : "not tripped");
    if (this.tripped) return deny("RUN_TRIPPED", `Safety broker is tripped (${this.tripReason}); an operator must resume it.`);

    check("paused", !this.paused, this.paused ? `Paused: ${this.pauseReason}` : "not paused");
    if (this.paused && !readOnly) {
      return deny("RUN_PAUSED", `The run is paused (${this.pauseReason ?? "no reason given"}); only read-only actions are allowed.`);
    }

    if (!policy.enabled && !readOnly) {
      check("enabled", false, "policy disabled");
      return deny("POLICY_DISABLED", "The safety policy is disabled; only read-only capabilities are allowed.");
    }
    check("enabled", true, "policy enabled");

    if (policy.denylist.includes(request.capability)) {
      check("denylist", false, `${request.capability} is denied`);
      return deny("CAPABILITY_DENIED", `Capability '${request.capability}' is on the safety denylist.`);
    }
    check("denylist", true, "not denied");

    if (policy.allowlist.length > 0 && !policy.allowlist.includes(request.capability)) {
      check("allowlist", false, `${request.capability} is not allowlisted`);
      return deny(
        "CAPABILITY_NOT_ALLOWLISTED",
        `Capability '${request.capability}' is not in the active allowlist of ${policy.allowlist.length} capabilities.`,
      );
    }
    check("allowlist", true, policy.allowlist.length > 0 ? "allowlisted" : "no allowlist configured");

    const ceiling = RISK_ORDER[policy.maxRisk] ?? 0;
    const aboveCeiling = RISK_ORDER[request.risk] > ceiling;
    const optedIn = policy.optedInCapabilities.includes(request.capability);
    check(
      "risk-ceiling",
      !aboveCeiling || optedIn,
      aboveCeiling
        ? optedIn
          ? `${request.risk} risk allowed by explicit operator opt-in`
          : `${request.risk} risk exceeds ceiling '${policy.maxRisk}'`
        : `${request.risk} risk within ceiling '${policy.maxRisk}'`,
    );
    if (aboveCeiling && !optedIn) {
      return deny(
        "RISK_ABOVE_CEILING",
        `Capability '${request.capability}' is ${request.risk} risk, above the configured ceiling '${policy.maxRisk}'. Enable it explicitly if this is intended.`,
      );
    }

    const runBudget = policy.maxActionsPerRun;
    const runUsed = this.actionsApproved;
    check("run-budget", readOnly || runUsed < runBudget, `${runUsed}/${runBudget} actions used`);
    if (!readOnly && runUsed >= runBudget) {
      return deny("RUN_ACTION_BUDGET", `The run reached its safety budget of ${runBudget} actions.`);
    }

    const capLimit = policy.perCapabilityMaxPerRun[request.capability];
    if (capLimit !== undefined) {
      const used = this.runCapabilityCount.get(request.capability) ?? 0;
      check("capability-budget", used < capLimit, `${used}/${capLimit} for ${request.capability}`);
      if (used >= capLimit) {
        return deny("CAPABILITY_BUDGET", `Capability '${request.capability}' already ran ${used} times this run (limit ${capLimit}).`);
      }
    }

    const cooldown = policy.cooldownMsByCapability[request.capability];
    if (cooldown !== undefined && cooldown > 0) {
      const lastRun = this.lastCapabilityRunAt.get(request.capability);
      const elapsed = lastRun === undefined ? Number.POSITIVE_INFINITY : nowMs - lastRun;
      check("cooldown", elapsed >= cooldown, `${Math.max(0, Math.round(elapsed))} ms since the last ${request.capability} (cooldown ${cooldown} ms)`);
      if (elapsed < cooldown) {
        return deny("CAPABILITY_COOLDOWN", `Capability '${request.capability}' must wait ${Math.ceil(cooldown - elapsed)} ms before running again.`);
      }
    }

    const world = this.worldValue;
    if (readOnly) {
      check("observation", true, "read-only action does not need a fresh observation");
    } else if (!world) {
      check("observation", false, "no observation recorded");
      return deny("NO_OBSERVATION", "No world observation is available; the broker fails closed instead of acting blind.");
    } else {
      const age = nowMs - world.observedAtMs;
      const fresh = age <= policy.maxObservationAgeMs;
      check("observation", fresh, `observation sequence ${world.sequence} is ${Math.max(0, Math.round(age))} ms old`);
      if (!fresh) {
        return deny(
          "STALE_OBSERVATION",
          `The newest observation is ${Math.round(age / 1000)} s old (limit ${Math.round(policy.maxObservationAgeMs / 1000)} s); refresh the world model before acting.`,
        );
      }

      if (policy.protectedHealthFloor !== null && world.health !== null && world.health <= policy.protectedHealthFloor) {
        const recoveryAllowed =
          request.skillId !== undefined && policy.protectedStateRecoverySkills.includes(request.skillId);
        check(
          "protected-state",
          recoveryAllowed,
          `health ${world.health} is at or below the protected floor ${policy.protectedHealthFloor}`,
        );
        if (!recoveryAllowed) {
          return deny(
            "PROTECTED_STATE",
            `Health is ${world.health} (protected floor ${policy.protectedHealthFloor}); only recovery skills (${policy.protectedStateRecoverySkills.join(", ") || "none configured"}) may run.`,
          );
        }
      } else if (policy.protectedHealthFloor !== null) {
        check("protected-state", true, "health above the protected floor");
      }

      const hazardDistance = world.nearestHazardDistance ?? null;
      const hazardLimit = policy.hazardMaxDistance;
      if (hazardLimit !== null && hazardDistance !== null && hazardDistance <= hazardLimit) {
        const blocked = policy.hazardBlockedCapabilities.includes(request.capability);
        check(
          "hazard",
          !blocked,
          `${world.nearestHazardName ?? "hazard"} is ${hazardDistance.toFixed(1)} block(s) away (limit ${hazardLimit})`,
        );
        if (blocked) {
          return deny(
            "HAZARD_NEARBY",
            `A ${world.nearestHazardName ?? "hazard"} block is ${hazardDistance.toFixed(1)} blocks away; '${request.capability}' would keep the agent in place next to it. Move to safety first.`,
          );
        }
      } else if (hazardLimit !== null) {
        check("hazard", true, hazardDistance === null ? "no hazard block observed" : `nearest hazard ${hazardDistance.toFixed(1)} blocks away`);
      }

      const air = world.oxygenTicks ?? null;
      if (air !== null && air <= DROWNING_AIR_TICKS && world.isBurning !== true) {
        const blocked = policy.drowningBlockedCapabilities.includes(request.capability);
        check("drowning", !blocked, `${air} air ticks left`);
        if (blocked) {
          return deny(
            "DROWNING_RISK",
            `Only ${air} air ticks remain; '${request.capability}' is denied until the head is out of the water.`,
          );
        }
      }

      if (policy.hazardMaxDistance !== null && (world.dimension === "minecraft:the_void" || world.dimension === "the_void")) {
        check("void", false, "dimension is the void");
        return deny("VOID", "The agent is in the void dimension; only escape actions are allowed.");
      }
    }

    return this.record({
      allowed: true,
      code: "ALLOWED",
      message: `Approved '${request.capability}' (${request.risk} risk) after ${checks.length} checks.`,
      checks,
      evaluatedAt: new Date(nowMs).toISOString(),
      capability: request.capability,
      risk: request.risk,
    }, nowMs);
  }

  snapshot(): SafetySnapshot {
    return {
      policy: this.policyValue,
      paused: this.paused,
      pauseReason: this.pauseReason,
      tripped: this.tripped,
      tripReason: this.tripReason,
      runId: this.runId,
      actionsApproved: this.actionsApproved,
      actionsDenied: this.actionsDenied,
      approvedByCapability: Object.fromEntries(this.approvedByCapability),
      deniedByCode: Object.fromEntries(this.deniedByCode),
      world: this.worldValue,
      recentVerdicts: [...this.recentVerdicts].reverse(),
    };
  }
}
