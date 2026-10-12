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
  "TASK_ACTION_BUDGET",
  "TASK_DEADLINE",
  "MAX_ACTIONS",
  "OPERATOR_STOP",
  "UNKNOWN_LIBRARY_ENTRY",
  "INVALID_LIBRARY_PARAMS",
  "PLAYER_REQUIRED",
  "INVALID_HOMEPOINT_NAME",
  "INVALID_TASK_REQUEST",
  "UNKNOWN_RESOURCE",
  "INVALID_COUNT",
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
  "SESSION_MISMATCH",
  "CRITICAL_STATE_NO_RECOVERY_SKILL",
  "COMBAT_DISABLED",
  "OBSERVATION_STALE",
  // Bounded construction/farming runners stop immediately when player position, health, mobs, or consent makes an action unsafe.
  "EXCAVATION_UNSAFE_POSITION",
  "EXCAVATION_THREAT_NEARBY",
  "EXCAVATION_SESSION_UNSAFE",
  "EXCAVATION_VITALS_FLOOR",
  "EXCAVATION_HEALTH_FLOOR",
  "EXCAVATION_UNSTABLE_BLOCK",
  "EXCAVATION_NO_SAFE_APPROACH",
  "EXCAVATION_NO_SAFE_EXIT",
  "PLAYER_DEAD",
  "PLAYER_OVER_EXCAVATION",
  "UNSAFE_BUILD_POSITION",
  "HOUSE_BUILD_THREAT",
  "HOUSE_SITE_HAS_ENTITY",
  "HOUSE_FOUNDATION_UNSAFE",
  "HOUSE_MATERIAL_GATHERING_NOT_APPROVED",
  "HOUSE_GATHERING_UNSAFE",
  "HOUSE_SESSION_UNSAFE",
  "HOUSE_HEALTH_FLOOR",
  "HOUSE_CELL_OCCUPIED_BY_ENTITY",
  "PLAYER_OVER_BUILD_SITE",
  "PLAYER_LEFT_HOUSE_INTERIOR",
  "HOUSE_NO_SAFE_EXIT",
  "FARM_VITALS_FLOOR",
  "FARM_PLAYER_IN_WATER",
  "FARM_HEALTH_DROP",
  "FARM_THREAT_NEARBY",
  "FARM_CELL_HAS_ENTITY",
  "WHEAT_TARGET_THREATENED",
  "WHEAT_PLANT_INTERSECTS_PLAYER",
  "TRANSFER_TARGET_NOT_AUTHORIZED",
  "TRANSFER_TARGET_THREATENED",
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
  "UNKNOWN_LIBRARY_ENTRY",
  "LIBRARY_UNAVAILABLE",
  "NO_SKILL_RUNTIME",
  "NO_COMPANION",
  "TASK_RUNNER_MISSING",
  "HOST_COMMANDS_MISSING",
  "COMBAT_SWITCH_MISSING",
  "PROMOTE_MISSING",
  "REJECT_MISSING",
  "SEED_MISSING",
]);

/** Anything about the session with the game, or the socket underneath it. */
const CONNECTION_CODES = new Set([
  "NOT_CONNECTED",
  "ADAPTER_NOT_CONNECTED",
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
  "PLAYER_LIFE_UNCONFIRMED",
  "NO_ACTIVE_OBSERVATION",
  "INSPECT_EXCEPTION",
]);

/** The decision model stopped the run on purpose and said why. */
const PLANNER_CODES = new Set([
  "NO_FEASIBLE_GOAL",
  "INVALID_LIBRARY_PARAMS",
  "PLAYER_REQUIRED",
  "INVALID_HOMEPOINT_NAME",
  "INVALID_TASK_REQUEST",
  "UNKNOWN_RESOURCE",
  "INVALID_COUNT",
  "GATHER_REFUSED",
  "SHELTER_REFUSED",
  "TASK_BLOCKED_MODE",
  "TASK_BLOCKED_DIMENSION",
  "TASK_BLOCKED_THREAT",
  "TASK_BLOCKED_HEALTH",
  "TASK_BLOCKED_HUNGER",
  "TASK_BLOCKED_TARGETS",
  "TASK_BLOCKED_SHELTER",
  "TASK_BLOCKED_TOOL",
  "TASK_BLOCKED_INVENTORY",
  "EXCAVATION_REQUIRES_OVERWORLD",
  "EXCAVATION_REQUIRES_SURVIVAL",
  "EXCAVATION_VITALS_TOO_LOW",
  "EXCAVATION_TOO_FAR",
  "EXCAVATION_UNSUPPORTED_BLOCK",
  "HOUSE_REQUIRES_OVERWORLD",
  "HOUSE_REQUIRES_SURVIVAL",
  "HOUSE_HEALTH_TOO_LOW",
  "HOUSE_HUNGER_TOO_LOW",
  "HOUSE_SITE_TOO_FAR",
  "HOUSE_SITE_OCCUPIED",
  "HOUSE_MATERIALS_MISSING",
  "HOUSE_LOG_OUT_OF_RANGE",
  "HOUSE_LOGS_INSUFFICIENT",
  "HOUSE_CANNOT_REACH_CELL",
  "HOUSE_INTERIOR_UNREACHABLE",
  "FARM_REQUIRES_OVERWORLD",
  "FARM_REQUIRES_SURVIVAL",
  "FARM_VITALS_TOO_LOW",
  "FARM_PLOT_TOO_FAR",
  "FARM_SOIL_NOT_HYDRATED",
  "FARM_CROP_CELL_OCCUPIED",
  "FARM_SEEDS_MISSING",
  "FARM_ROUTE_INVALID",
  "WHEAT_SEEDS_MISSING",
  "WHEAT_FARMLAND_DRY",
  "WHEAT_CROP_CELL_OCCUPIED",
  "WHEAT_TARGET_TOO_FAR",
  "TRANSFER_TARGET_TOO_FAR",
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
  "TASK_RESULT_MISSING",
  "TASK_ALREADY_RUNNING",
  "EXCAVATION_INCOMPLETE",
  "EXCAVATION_RUNTIME_ERROR",
  "HOUSE_INCOMPLETE",
  "HOUSE_RUNTIME_ERROR",
  "FARM_INCOMPLETE",
  "FARM_RUNTIME_ERROR",
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
  "LIBRARY_HANDLER_FAILED",
  "SKILL_THREW",
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
  "GAME_MODE_BLOCKS_PLANTING",
  "GAME_MODE_BLOCKS_REST",
  "UNSUPPORTED_DIMENSION",
  "RESOURCE_TARGET_NOT_VISIBLE",
  "NAVIGATION_EXCEPTION",
  "EXCAVATION_NAVIGATION_EXCEPTION",
  "EXCAVATION_PATH_BLOCKED",
  "HOUSE_LOG_COLLECTION_EXCEPTION",
  "HOUSE_CRAFTING_EXCEPTION",
  "HOUSE_PLACEMENT_EXCEPTION",
  "HOUSE_TARGET_CHANGED",
  "FARM_NAVIGATION_EXCEPTION",
  "WHEAT_PLANTING_EXCEPTION",
  "WHEAT_FARMLAND_CHANGED",
  "WHEAT_CROP_CELL_CHANGED",
  "WHEAT_TARGET_OUT_OF_REACH",
  "TRANSFER_TARGET_NOT_VISIBLE",
  "TRANSFER_ITEM_UNKNOWN",
  "TRANSFER_INVENTORY_DELTA_UNCONFIRMED",
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

const CODE_HINTS: Readonly<Record<string, string>> = {
  PLAYER_DEAD: "Respawn in Minecraft, then wait for a fresh same-session observation before retrying.",
  GAME_MODE_BLOCKS_PLANTING: "Switch to survival or hardcore mode before asking GameMind to plant wheat.",
  UNSUPPORTED_DIMENSION: "Move the task to the overworld and wait for a fresh observation before retrying.",
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
  TASK_RESULT_MISSING: "task ended without a recorded result",
  UNKNOWN_LIBRARY_ENTRY: "unknown Library entry",
  LIBRARY_UNAVAILABLE: "Library entry unavailable in this run",
  ADAPTER_NOT_CONNECTED: "Minecraft adapter is not connected",
  INVALID_LIBRARY_PARAMS: "invalid Library parameters",
  LIBRARY_HANDLER_FAILED: "Library handler failed",
  NO_SKILL_RUNTIME: "skill runtime unavailable",
  NO_COMPANION: "companion coordinator unavailable",
  SKILL_THREW: "skill failed before adapter response",
  PLAYER_REQUIRED: "player name is required",
  INVALID_HOMEPOINT_NAME: "invalid homepoint name",
  TASK_RUNNER_MISSING: "task runner unavailable",
  TASK_ALREADY_RUNNING: "another task is already running",
  INVALID_TASK_REQUEST: "invalid task request",
  UNKNOWN_RESOURCE: "unknown resource",
  INVALID_COUNT: "invalid requested amount",
  GATHER_REFUSED: "gather request refused",
  SHELTER_REFUSED: "shelter request refused",
  HOST_COMMANDS_MISSING: "host commands unavailable",
  COMBAT_SWITCH_MISSING: "combat control unavailable",
  PROMOTE_MISSING: "policy promotion unavailable",
  REJECT_MISSING: "policy rollback unavailable",
  SEED_MISSING: "world-seed storage unavailable",
  RUN_PAUSED: "paused by an operator",
  RUN_TRIPPED: "safety tripped",
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
  GAME_MODE_BLOCKS_PLANTING: "game mode blocks wheat planting",
  GAME_MODE_BLOCKS_REST: "game mode blocks resting",
  HEALTH_UNKNOWN: "player health unavailable",
  PLAYER_DEAD: "player is dead",
  PLAYER_LIFE_UNCONFIRMED: "player living state not confirmed",
  DIMENSION_UNKNOWN: "dimension not reported by the session",
  GAME_MODE_UNKNOWN: "game mode not reported by the session",
  NO_ACTIVE_OBSERVATION: "no observation from the current session yet",
  SESSION_MISMATCH: "observation belongs to a different session",
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
    hint: (normalized ? CODE_HINTS[normalized] : undefined) ?? HINTS[kind] ?? null,
    message: text,
    retryable: RETRYABLE_KINDS.has(kind) && !(normalized !== null && NOT_RETRYABLE_CODES.has(normalized)),
  };
}

/** One line an operator can read: `safety refusal · RUN_PAUSED: paused from the Control Center`. */
export function formatFailure(failure: ClassifiedFailure): string {
  const head = failure.code ? `${failure.label} · ${failure.code}` : failure.label;
  return failure.message ? `${head}: ${failure.message}` : head;
}

/**
 * Kinds that say something about the world, the session or the plan's preconditions — never about the
 * choice that was made. The learner uses this set to leave such outcomes out of a skill's statistics, so
 * it is defined once here; it used to be listed a second time in the learning layer, and the two copies
 * already disagreed about planner refusals.
 */
const EXTERNAL_FAILURE_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "safety",
  "capability",
  "connection",
  "perception",
  "planner",
]);

/** True when a failure of this kind means "the world or the session is wrong", not "the code is wrong". */
export function isExternalFailureKind(kind: FailureKind): boolean {
  return EXTERNAL_FAILURE_KINDS.has(kind);
}

/** True when the failure means "the world, the session or the plan is wrong", not "the code is wrong". */
export function failureIsExternal(failure: ClassifiedFailure): boolean {
  return isExternalFailureKind(failure.kind);
}
