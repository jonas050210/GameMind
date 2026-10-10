/**
 * One place that decides *what kind of thing* stopped the agent.
 *
 * Before this existed, a refusal from the Safety Broker, an unadvertised capability, a dropped Minecraft
 * connection and a task that simply could not make progress all reached the dashboard as the same bare
 * status word. They need different operator actions, so they are classified here from the stable failure
 * code (and, when there is no code, from the message) and every surface — the Control Center, the task
 * report and the CLI summary — uses the same answer.
 */

export type FailureKind =
  /** The Safety Broker refused an action that was otherwise possible. */
  | "safety"
  /** The capability or skill the plan needed is not available in this run. */
  | "capability"
  /** The session with the game is missing, expired or broke mid-action. */
  | "connection"
  /** The agent could not obtain a usable observation of the world. */
  | "perception"
  /** The decision model deliberately declined to act, with a reason. */
  | "planner"
  /** The task as a whole ended without its goal (budget, deadline, operator stop, repeated failure). */
  | "task"
  /** A single action was attempted and failed, was refused by the adapter, or was not verified. */
  | "action"
  /** Nothing matched; the raw code and message are still shown. */
  | "unknown";

export interface ClassifiedFailure {
  readonly code: string | null;
  readonly kind: FailureKind;
  /** Short label shown as a chip in the UI. */
  readonly label: string;
  /** Which component produced the failure. */
  readonly owner: string;
  /** What an operator can actually do about it; null when there is nothing to do. */
  readonly hint: string | null;
  /** The exact message the component reported, verbatim. Never replaced by a generic phrase. */
  readonly message: string | null;
  /**
   * Whether the agent can clear this on its own by re-deciding or retrying. False means a person, the
   * server or the configuration has to change first — which is the difference between watching a run
   * recover and watching it spin.
   */
  readonly retryable: boolean;
}

/** Kinds the agent can work around by acting again. */
const RETRYABLE_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>(["perception", "planner", "action"]);

/** Codes inside an otherwise retryable kind that a retry cannot fix. */
const NOT_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "TASK_BLOCKED_MODE",
  "TASK_BLOCKED_DIMENSION",
  "TASK_BLOCKED_CAPABILITY",
  "TASK_BLOCKED_TOOL",
  "RUN_ACTION_BUDGET",
  "TASK_ACTION_BUDGET",
  "TASK_DEADLINE",
  "MAX_ACTIONS",
  "OPERATOR_STOP",
]);

export const FAILURE_KIND_LABELS: Readonly<Record<FailureKind, string>> = {
  safety: "safety refusal",
  capability: "missing capability",
  connection: "connection error",
  perception: "no usable observation",
  planner: "planner declined",
  task: "task failure",
  action: "action failure",
  unknown: "unclassified",
};

/** Codes owned by the Safety Broker, including the `SAFETY_` prefix the executor adds. */
const SAFETY_CODES = new Set([
  "RUN_PAUSED",
  "RUN_TRIPPED",
  "RUN_ACTION_BUDGET",
  "PROTECTED_STATE",
  "POLICY_DISABLED",
  "CAPABILITY_BUDGET",
  "CAPABILITY_COOLDOWN",
  "CAPABILITY_DENIED",
  "CAPABILITY_NOT_ALLOWLISTED",
  "RISK_ABOVE_CEILING",
  "HAZARD_NEARBY",
  "DROWNING_RISK",
  "VOID",
  "STALE_OBSERVATION",
  "CRITICAL_STATE_NO_RECOVERY_SKILL",
  "COMBAT_DISABLED",
  "OBSERVATION_STALE",
]);

/** The plan needed a capability/skill this run does not have. */
const CAPABILITY_CODES = new Set([
  "CAPABILITY_NOT_AVAILABLE",
  "UNSUPPORTED_CAPABILITY",
  "SKILL_NOT_REGISTERED",
  "TASK_BLOCKED_CAPABILITY",
  "MINECRAFT_PLUGIN_UNAVAILABLE",
  "PATHFINDER_UNAVAILABLE",
  "COLLECTOR_UNAVAILABLE",
]);

/** Anything about the session with the game, or the socket underneath it. */
const CONNECTION_CODES = new Set([
  "NOT_CONNECTED",
  "NO_ACTIVE_SESSION",
  "STALE_SESSION",
  "SESSION_CHANGED_BEFORE_ACTION",
  "SESSION_ENDED_AFTER_ACTION",
  "ADAPTER_DISCONNECTED",
  "ADAPTER_DISCONNECTED_DURING_RESPAWN",
  "ADAPTER_QUARANTINED",
  "RUNTIME_STOPPING",
  "PLAYER_NOT_SPAWNED",
  "MINECRAFT_LOGIN_FAILED",
  "MINECRAFT_CONNECT_FAILED",
  "MINECRAFT_KICKED",
]);

/** The agent could not read the world well enough to act on it. */
const PERCEPTION_CODES = new Set([
  "WORLD_STATE_UNAVAILABLE",
  "NO_OBSERVATION",
  "OBSERVATION_SCHEMA_INVALID",
  "OBSERVATION_FAILED",
  "PRE_ACTION_OBSERVATION_FAILED",
  "POST_ACTION_OBSERVATION_FAILED",
  "HEALTH_UNKNOWN",
  "DIMENSION_UNKNOWN",
  "GAME_MODE_UNKNOWN",
  "NO_ACTIVE_OBSERVATION",
]);

/** The decision model stopped the run on purpose and said why. */
const PLANNER_CODES = new Set([
  "NO_FEASIBLE_GOAL",
  "TASK_BLOCKED_MODE",
  "TASK_BLOCKED_DIMENSION",
  "TASK_BLOCKED_THREAT",
  "TASK_BLOCKED_HEALTH",
  "TASK_BLOCKED_HUNGER",
  "TASK_BLOCKED_TARGETS",
  "TASK_BLOCKED_SHELTER",
  "TASK_BLOCKED_TOOL",
  "TASK_BLOCKED_INVENTORY",
]);

/** The run as a whole ended without its goal. */
const TASK_CODES = new Set([
  "TASK_DEADLINE",
  "TASK_ACTION_BUDGET",
  "MAX_ACTIONS",
  "OPERATOR_STOP",
  "RESPAWN_TIMEOUT",
  "CONSECUTIVE_ACTION_FAILURES",
  "NO_PROGRESS",
  "TASK_RUNTIME_ERROR",
  "SKILL_RUNTIME_EXCEPTION",
  "TASK_SETUP_FAILED",
]);

/** Everything else that describes one attempted action. */
const ACTION_CODES = new Set([
  // A reflex (safety reaction to an urgent condition) cut the action short. It is a replan, not a failure of
  // the action itself, so it is retryable and the runner does not count it against the target.
  "REFLEX_INTERRUPT",
  "ACTION_TIMEOUT",
  "ACTION_NOT_CONFIRMED",
  "ACTION_ABORTED",
  "ACTION_BUSY",
  "ACTION_IN_PROGRESS",
  "ADAPTER_ACTION_FAILED",
  "INVALID_ACTION_INPUT",
  "INVALID_ACTION_TIMEOUT",
  "UNVERIFIED_POSTCONDITION",
  "PATH_NOT_FOUND",
  "PATH_PLANNING_TIMEOUT",
  "PATH_STOPPED",
  "PATH_GOAL_CHANGED",
  "PATH_FAILED",
  "NAVIGATION_STUCK",
  "NAVIGATION_TARGET_TOO_FAR",
  "RESOURCE_TARGET_CHANGED",
  "RESOURCE_TARGET_TOO_FAR",
  "RESOURCE_TARGET_THREATENED",
  "BLOCK_NOT_HARVESTABLE",
  "BLOCK_NOT_DIGGABLE",
  "BLOCK_NOT_MINEABLE_CLASS",
  "BLOCK_UNKNOWN",
  "BLOCK_OUT_OF_RANGE",
  "BLOCK_OUT_OF_REACH",
  "ITEM_NOT_IN_INVENTORY",
  "ITEM_DROP_NOT_FOUND",
  "INVENTORY_FULL",
  "CRAFT_ITEM_UNAVAILABLE",
  "CRAFTING_PREREQUISITES_UNAVAILABLE",
  "CRAFTING_TABLE_CHANGED",
  "CRAFTING_TABLE_NOT_IN_INVENTORY",
  "CRAFTING_TABLE_NOT_VISIBLE",
  "CRAFTING_TABLE_TOO_FAR",
  "PLACEMENT_BLOCK_NOT_IN_INVENTORY",
  "PLACEMENT_CELL_NOT_EMPTY",
  "PLACEMENT_INTERSECTS_ENTITY",
  "PLACEMENT_INTERSECTS_PLAYER",
  "PLACEMENT_SUPPORT_UNSAFE",
  "PLACEMENT_TARGET_THREATENED",
  "PLACEMENT_TARGET_TOO_FAR",
  "BERRY_NOT_RIPE",
  "BERRY_OUT_OF_REACH",
  "TOOL_REQUIRED",
  "TOOL_TIER_INSUFFICIENT",
  "DIG_FAILED",
  "DIG_TIMEOUT",
  "REST_INTERRUPTED_BY_DAMAGE",
  "REST_INTERRUPTED_BY_THREAT",
  "FOOD_NOT_IN_INVENTORY",
  "FOOD_NOT_NEEDED",
  "PICKUP_TARGET_THREATENED",
  "PICKUP_TARGET_TOO_FAR",
  "SHELTER_NO_PLACEMENTS",
  "COMBAT_ATTACK_FAILED",
  "COMBAT_EXHAUSTED",
  "COMBAT_HEALTH_TOO_LOW",
  "COMBAT_HIT_BUDGET",
  "COMBAT_NO_WEAPON",
  "COMBAT_OUTNUMBERED",
  "COMBAT_OUT_OF_RANGE",
  "COMBAT_NOT_IN_REACH",
  "COMBAT_NO_LINE_OF_SIGHT",
  "COMBAT_TARGET_GONE",
  "COMBAT_TARGET_INVALID",
  "COMBAT_TARGET_OUT_OF_RANGE",
  "COMBAT_WITHDRAWN",
  "GAME_MODE_BLOCKS_COLLECTION",
  "GAME_MODE_BLOCKS_CRAFTING",
  "GAME_MODE_BLOCKS_EATING",
  "GAME_MODE_BLOCKS_HARVEST",
  "GAME_MODE_BLOCKS_MINING",
  "GAME_MODE_BLOCKS_PICKUP",
  "GAME_MODE_BLOCKS_PLACEMENT",
  "GAME_MODE_BLOCKS_REST",
  "UNSUPPORTED_DIMENSION",
]);

const HINTS: Readonly<Partial<Record<FailureKind, string>>> = {
  safety: "Lift the hold from Run control (Resume or Reset trip), or change the policy — the action itself was possible.",
  capability: "The plan needed something this run does not advertise. Check the adapter's capability list and any plugin the run failed to load.",
  connection: "No usable game session. Check that the server is up, the port and version match, and the account is allowed to join; then reconnect.",
  perception: "The agent will not act on a world it cannot read. Wait for a fresh observation, or check the adapter's perception path.",
  planner: "The planner refused to act and said why. Read the reason; the fix is usually the world state or the task parameters, not the code.",
  task: "The run ended before the goal was met. Read the metrics to see whether more budget, a different target or a different start position is needed.",
  action: "A single action was attempted and did not land. The reason names the world condition that changed or was never true.",
};

const OWNERS: Readonly<Record<FailureKind, string>> = {
  safety: "Safety Broker",
  capability: "capability registry",
  connection: "Minecraft session",
  perception: "observation path",
  planner: "decision model",
  task: "task runner",
  action: "game adapter",
  unknown: "unattributed",
};

const LABELS: Readonly<Record<string, string>> = {
  RUN_PAUSED: "paused by an operator",
  RUN_TRIPPED: "safety tripped",
  RUN_ACTION_BUDGET: "per-run action budget spent",
  STALE_OBSERVATION: "observation too old to act on",
  PRE_ACTION_OBSERVATION_FAILED: "no observation before the action",
  POST_ACTION_OBSERVATION_FAILED: "no observation after the action",
  UNVERIFIED_POSTCONDITION: "action confirmed but the world did not change",
  ACTION_NOT_CONFIRMED: "adapter could not confirm the action",
  NO_FEASIBLE_GOAL: "no feasible goal",
  TASK_BLOCKED_MODE: "the live session reported a game mode this run will not act in",
  TASK_BLOCKED_DIMENSION: "the live session reported a dimension this run will not work in",
  TASK_BLOCKED_CAPABILITY: "no skill can carry this task",
  TASK_BLOCKED_THREAT: "a hostile left no safe move",
  TASK_BLOCKED_HEALTH: "health too low to continue",
  TASK_BLOCKED_HUNGER: "hunger too low and no food is reachable",
  TASK_BLOCKED_TARGETS: "no safe, reachable target remains",
  TASK_BLOCKED_SHELTER: "the shelter cannot be closed here",
  TASK_BLOCKED_TOOL: "the required tool is not carried",
  OBSERVATION_SCHEMA_INVALID: "the observation did not match its contract",
  CAPABILITY_NOT_AVAILABLE: "capability not advertised",
  UNSUPPORTED_CAPABILITY: "capability not implemented by the adapter",
  SKILL_NOT_REGISTERED: "skill not registered",
  TASK_DEADLINE: "task time budget exceeded",
  TASK_ACTION_BUDGET: "task action budget exceeded",
  REFLEX_INTERRUPT: "urgent condition interrupted the action; replanning",
  OPERATOR_STOP: "stopped by the operator",
  ADAPTER_DISCONNECTED: "Minecraft session disconnected",
  NOT_CONNECTED: "adapter is not connected",
  UNSUPPORTED_DIMENSION: "dimension not supported by this skill",
  GAME_MODE_BLOCKS_COLLECTION: "game mode blocks collection",
  GAME_MODE_BLOCKS_CRAFTING: "game mode blocks crafting",
  GAME_MODE_BLOCKS_EATING: "game mode blocks eating",
  GAME_MODE_BLOCKS_HARVEST: "game mode blocks harvesting",
  GAME_MODE_BLOCKS_MINING: "game mode blocks mining",
  GAME_MODE_BLOCKS_PICKUP: "game mode blocks item pickup",
  GAME_MODE_BLOCKS_PLACEMENT: "game mode blocks placement",
  GAME_MODE_BLOCKS_REST: "game mode blocks resting",
  HEALTH_UNKNOWN: "player health unavailable",
  DIMENSION_UNKNOWN: "dimension not reported by the session",
  GAME_MODE_UNKNOWN: "game mode not reported by the session",
  NO_ACTIVE_OBSERVATION: "no observation from the current session yet",
};

/**
 * Message fragments used only when a failure arrived without a code — a thrown Error from a plugin, a
 * socket error, a login rejection. Matching is conservative: an unrecognised message stays `unknown`
 * with its message shown verbatim rather than being forced into a category.
 */
const MESSAGE_PATTERNS: readonly { readonly pattern: RegExp; readonly kind: FailureKind }[] = [
  { pattern: /\b(ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|EPIPE|socket hang up)\b/i, kind: "connection" },
  { pattern: /\b(timed out .*spawn|could not connect|login failed|failed to authenticate|invalid session|bad login)\b/i, kind: "connection" },
  { pattern: /kicked|disconnected/i, kind: "connection" },
  { pattern: /paused|tripped|safety|denied/i, kind: "safety" },
  { pattern: /not advertised|unavailable capability|plugin .* (was not|not) installed/i, kind: "capability" },
  { pattern: /observation|world state|schema|validation failed|expected (string|number)/i, kind: "perception" },
  { pattern: /no feasible goal|nothing (left )?to try|restricted to the overworld|limited to survival mode/i, kind: "planner" },
];

function safeCode(code: string | null | undefined): string | null {
  if (typeof code !== "string") return null;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length > 0 && /^[A-Z0-9_.-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Classifies one failure. `code` is the stable identifier the component produced; `message` is the exact
 * text, which is always carried through unmodified so no surface can accidentally soften it.
 */
export function classifyFailure(code: string | null | undefined, message?: string | null): ClassifiedFailure {
  const normalized = safeCode(code);
  const text = typeof message === "string" && message.trim().length > 0 ? message.trim() : null;
  let kind: FailureKind = "unknown";
  if (normalized) {
    if (normalized.startsWith("SAFETY_") || SAFETY_CODES.has(normalized)) kind = "safety";
    else if (CAPABILITY_CODES.has(normalized)) kind = "capability";
    else if (CONNECTION_CODES.has(normalized)) kind = "connection";
    else if (PERCEPTION_CODES.has(normalized)) kind = "perception";
    else if (PLANNER_CODES.has(normalized)) kind = "planner";
    else if (TASK_CODES.has(normalized)) kind = "task";
    else if (ACTION_CODES.has(normalized)) kind = "action";
  }
  if (kind === "unknown" && text) {
    for (const entry of MESSAGE_PATTERNS) {
      if (entry.pattern.test(text)) {
        kind = entry.kind;
        break;
      }
    }
  }
  const label = (normalized ? LABELS[normalized] : undefined) ?? FAILURE_KIND_LABELS[kind];
  return {
    code: normalized,
    kind,
    label,
    owner: OWNERS[kind],
    hint: HINTS[kind] ?? null,
    message: text,
    retryable: RETRYABLE_KINDS.has(kind) && !(normalized !== null && NOT_RETRYABLE_CODES.has(normalized)),
  };
}

/** One line an operator can read: `safety refusal · RUN_PAUSED: paused from the Control Center`. */
export function formatFailure(failure: ClassifiedFailure): string {
  const head = failure.code ? `${failure.label} · ${failure.code}` : failure.label;
  return failure.message ? `${head}: ${failure.message}` : head;
}

/** True when the failure means "the world or the session is wrong", not "the code is wrong". */
export function failureIsExternal(failure: ClassifiedFailure): boolean {
  return failure.kind === "safety"
    || failure.kind === "connection"
    || failure.kind === "perception"
    || failure.kind === "planner"
    || failure.kind === "capability";
}
