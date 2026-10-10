/**
 * Central Library: the single structured interface for all agent capabilities.
 *
 * The Library replaces the removed chat-command system (`#follow`, `#gather`, ... and the
 * MINECRAFT_COMMANDER Minecraft-chat path). Every entry maps to the real execution pipeline
 * (SkillRuntime, CompanionController, task runner, SafetyBroker, learner) and reports the
 * measured outcome -- never "success" for a request that was only accepted.
 *
 * Extensibility: new capabilities register via `LibraryRegistry.register` with metadata +
 * handler. The Control Center renders `snapshot.library.catalog` dynamically, so no second
 * command interface is needed.
 */
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { SkillRuntime } from "../../core/skill-runtime.js";
import type { GameMindRuntime } from "../../core/game-mind-runtime.js";
import type { SafetyBroker } from "../../core/safety-broker.js";
import type { ExperienceLearner } from "../../core/learning/learner.js";
import type { TrainingManager } from "../../training/manager.js";
import type { WorldSeedStore } from "./world-seed.js";
import type { ControlCenterCommands } from "../../control-center/types.js";
import type { MinecraftObservation } from "./observation.js";
import type { MinecraftTask } from "./task.js";
import {
  minecraftCraftableItemNames,
  minecraftCraftTaskItemNames,
  minecraftFoodNames,
  minecraftLogNames,
  minecraftPickupNames,
  MINECRAFT_ATTACK_HOSTILE_CAPABILITY,
} from "./capabilities.js";
import {
  minecraftDroppableJunkNames,
  minecraftMineableBlockNames,
  minecraftPlaceableBlockNames,
} from "./mining.js";
import { verifySkillPostcondition } from "./skill-contracts.js";
import { normalizeHomepointName } from "./companion-modes.js";

// ---------------------------------------------------------------------------
// Public shapes (serialized into snapshot.library)
// ---------------------------------------------------------------------------

export type LibraryCategory =
  | "Movement & Navigation"
  | "Following & Companionship"
  | "Gathering & Food"
  | "Mining & Resources"
  | "Building & Crafting"
  | "Combat & Protection"
  | "Homepoints & Places"
  | "Tasks"
  | "Safety & Control"
  | "Learning & Memory";

export const libraryCategories: readonly LibraryCategory[] = [
  "Movement & Navigation",
  "Following & Companionship",
  "Gathering & Food",
  "Mining & Resources",
  "Building & Crafting",
  "Combat & Protection",
  "Homepoints & Places",
  "Tasks",
  "Safety & Control",
  "Learning & Memory",
];

/** Honest availability. Unavailable entries are shown disabled with their reason. */
export type LibraryEntryStatus = "implemented" | "experimental" | "unavailable";

export type LibraryParamType = "string" | "integer" | "number" | "boolean" | "select";

export interface LibraryParamOption {
  readonly value: string;
  readonly label: string;
}

export interface LibraryParamField {
  readonly name: string;
  readonly label: string;
  readonly type: LibraryParamType;
  readonly required: boolean;
  readonly def?: unknown;
  readonly options?: readonly LibraryParamOption[];
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly help?: string;
}

export interface LibraryEntryMeta {
  readonly id: string;
  readonly category: LibraryCategory;
  readonly title: string;
  readonly description: string;
  readonly status: LibraryEntryStatus;
  readonly statusReason: string | null;
  readonly requiresConnection: boolean;
  readonly params: readonly LibraryParamField[];
}

export type LibraryOperationState = "running" | "succeeded" | "failed" | "refused";

export interface LibraryOperationView {
  readonly id: string;
  readonly entryId: string;
  readonly title: string;
  readonly category: LibraryCategory;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly state: LibraryOperationState;
  readonly message: string;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly confirmed: boolean | null;
  readonly durationMs: number | null;
}

// ---------------------------------------------------------------------------
// Handler context (structural: run-control passes the live objects)
// ---------------------------------------------------------------------------

/** Structured companion API. Implemented by CompanionController; no text parsing. */
export interface LibraryCompanion {
  setMode(
    mode: "follow" | "come" | "hold" | "combat" | "afk" | "guard" | "explore" | "unstuck" | "return",
    options?: { readonly targetPlayer?: string | null },
  ): Promise<{ readonly ok: boolean; readonly message: string }>;
  halt(reason: string): Promise<{ readonly ok: boolean; readonly message: string }>;
  saveHomepoint(name: string): Promise<{ readonly ok: boolean; readonly message: string }>;
  goHomepoint(name: string): Promise<{ readonly ok: boolean; readonly message: string }>;
  listHomepoints(): Promise<{ readonly ok: boolean; readonly message: string }>;
  deleteHomepoint(name: string): Promise<{ readonly ok: boolean; readonly message: string }>;
  startGather(
    resource: (typeof minecraftLogNames)[number],
    count: number,
  ): Promise<{ readonly ok: boolean; readonly message: string; readonly taskId?: string }>;
  startBuildShelter(): Promise<{ readonly ok: boolean; readonly message: string; readonly taskId?: string }>;
  getStatus(): Promise<{ readonly ok: boolean; readonly message: string }>;
}

export interface LibraryRunControl {
  readonly task: { readonly id: string; readonly kind: string } | null;
  readonly result: {
    readonly taskId: string;
    readonly status: string;
    readonly failure: { readonly code: string; readonly message: string } | null;
  } | null;
}

/**
 * Reads the live run-control fields through a call boundary. The host mutates this object while
 * a task starts, so task handlers must never let an early busy check narrow the later post-start
 * read to null; calls return the declared type and carry no narrowing with them.
 */
function liveTask(control: LibraryRunControl): LibraryRunControl["task"] {
  return control.task;
}

function liveResult(control: LibraryRunControl): LibraryRunControl["result"] {
  return control.result;
}

export interface LibraryHandlerContext {
  readonly skills: SkillRuntime | null;
  readonly companion: LibraryCompanion | null;
  readonly runtime: GameMindRuntime<MinecraftObservation> | null;
  readonly safety: SafetyBroker | null;
  readonly control: LibraryRunControl;
  readonly learner: ExperienceLearner | null;
  readonly training: TrainingManager | null;
  readonly worldSeed: WorldSeedStore | null;
  readonly advertisedCapabilities: readonly string[];
  readonly combatSwitchAvailable: boolean;
  readonly taskFor?: (request: { readonly kind: string; readonly resource?: string; readonly count?: number }) => MinecraftTask;
  readonly onStart?: (task: MinecraftTask, request?: { readonly origin?: "library"; readonly whenBusy?: "queue" | "reject" }) => Promise<void>;
  /** Existing host commands, reused so Library safety/learning entries share one code path. */
  readonly hostCommands?: ControlCenterCommands;
  readonly logger: Logger;
}

export interface LibraryHandlerResult {
  readonly ok: boolean;
  readonly message: string;
  readonly failureCode?: string | null;
  readonly failureMessage?: string | null;
  readonly confirmed?: boolean | null;
  readonly durationMs?: number | null;
  /** When true the operation stays "running" and is resolved live from control.task/result. */
  readonly running?: boolean;
  readonly taskId?: string;
}

export type LibraryHandler = (
  params: Readonly<Record<string, unknown>>,
  ctx: LibraryHandlerContext,
) => Promise<LibraryHandlerResult>;

export interface LibraryEntry {
  readonly meta: LibraryEntryMeta;
  readonly handler: LibraryHandler;
  /** Capability names (adapter) this entry needs; missing => unavailable in snapshot. */
  readonly requiresCapabilities?: readonly string[];
  readonly requiresCompanion?: boolean;
  readonly requiresLearner?: boolean;
  readonly requiresTraining?: boolean;
  readonly requiresSafety?: boolean;
  readonly requiresCombatSwitch?: boolean;
  readonly requiresTaskRunner?: boolean;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class LibraryRegistry {
  private readonly entries = new Map<string, LibraryEntry>();

  register(entry: LibraryEntry): void {
    if (!entry.meta.id.trim()) throw new Error("Library entry ids must not be empty.");
    if (this.entries.has(entry.meta.id)) {
      throw new Error(`Library entry '${entry.meta.id}' is already registered.`);
    }
    if (!libraryCategories.includes(entry.meta.category)) {
      throw new Error(`Library entry '${entry.meta.id}' has unknown category '${entry.meta.category}'.`);
    }
    this.entries.set(entry.meta.id, entry);
  }

  get(id: string): LibraryEntry | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): readonly LibraryEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// Parameter validation (shared by every entry; specific reasons, never silent)
// ---------------------------------------------------------------------------

function fieldError(field: LibraryParamField, reason: string): string {
  return `Parameter '${field.name}' (${field.label}): ${reason}.`;
}

export function validateLibraryParams(
  fields: readonly LibraryParamField[],
  raw: Readonly<Record<string, unknown>>,
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  const params: Record<string, unknown> = {};
  for (const field of fields) {
    const value = (raw as Record<string, unknown>)[field.name];
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
      if (field.required && field.def === undefined) {
        return { ok: false, message: fieldError(field, "is required") };
      }
      if (field.def !== undefined) params[field.name] = field.def;
      continue;
    }
    switch (field.type) {
      case "string": {
        if (typeof value !== "string") return { ok: false, message: fieldError(field, "must be a string") };
        if (field.maxLength !== undefined && value.length > field.maxLength) {
          return { ok: false, message: fieldError(field, `must be at most ${field.maxLength} characters`) };
        }
        if (field.pattern !== undefined) {
          const re = new RegExp(field.pattern);
          if (!re.test(value)) return { ok: false, message: fieldError(field, "has an invalid format") };
        }
        params[field.name] = value;
        break;
      }
      case "select": {
        if (typeof value !== "string") return { ok: false, message: fieldError(field, "must be a string option") };
        const allowed = (field.options ?? []).map((o) => o.value);
        if (!allowed.includes(value)) {
          return { ok: false, message: fieldError(field, `must be one of: ${allowed.join(", ") || "(none)"}`) };
        }
        params[field.name] = value;
        break;
      }
      case "integer": {
        const num = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
        if (!Number.isInteger(num)) return { ok: false, message: fieldError(field, "must be a whole number") };
        if (field.min !== undefined && num < field.min) return { ok: false, message: fieldError(field, `must be >= ${field.min}`) };
        if (field.max !== undefined && num > field.max) return { ok: false, message: fieldError(field, `must be <= ${field.max}`) };
        params[field.name] = num;
        break;
      }
      case "number": {
        const num = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
        if (!Number.isFinite(num)) return { ok: false, message: fieldError(field, "must be a finite number") };
        if (field.min !== undefined && num < field.min) return { ok: false, message: fieldError(field, `must be >= ${field.min}`) };
        if (field.max !== undefined && num > field.max) return { ok: false, message: fieldError(field, `must be <= ${field.max}`) };
        params[field.name] = num;
        break;
      }
      case "boolean": {
        if (typeof value === "boolean") params[field.name] = value;
        else if (value === "true") params[field.name] = true;
        else if (value === "false") params[field.name] = false;
        else return { ok: false, message: fieldError(field, "must be true or false") };
        break;
      }
    }
  }
  return { ok: true, params };
}

// ---------------------------------------------------------------------------
// Availability resolution (snapshot-time; honest per-run status)
// ---------------------------------------------------------------------------

export function resolveEntryAvailability(
  entry: LibraryEntry,
  ctx: LibraryHandlerContext,
): { status: LibraryEntryStatus; reason: string | null } {
  if (entry.meta.status === "experimental") return { status: "experimental", reason: entry.meta.statusReason };
  const missing = (entry.requiresCapabilities ?? []).filter((name) => !ctx.advertisedCapabilities.includes(name));
  if (missing.length > 0) {
    return {
      status: "unavailable",
      reason: `Not advertised by this run's adapter: ${missing.join(", ")}. The legacy offline fixture exposes only the original 8 capabilities.`,
    };
  }
  if (entry.requiresCompanion && !ctx.companion) {
    return { status: "unavailable", reason: "No companion coordinator is attached to this run." };
  }
  if (entry.requiresLearner && !ctx.learner) {
    return { status: "unavailable", reason: "No experience learner is attached to this run (started with --no-learning?)." };
  }
  if (entry.requiresTraining && !ctx.training) {
    return { status: "unavailable", reason: "Training is not available in this host." };
  }
  if (entry.requiresSafety && !ctx.safety) {
    return { status: "unavailable", reason: "This run has no Safety Broker attached." };
  }
  if (entry.requiresCombatSwitch && !ctx.combatSwitchAvailable) {
    return { status: "unavailable", reason: "This adapter has no runtime combat switch; restart with --allow-combat." };
  }
  if (entry.requiresTaskRunner && (!ctx.taskFor || !ctx.onStart)) {
    return { status: "unavailable", reason: "This run does not accept new tasks." };
  }
  if (!ctx.skills && (entry.requiresCapabilities ?? []).length > 0) {
    return { status: "unavailable", reason: "No skill runtime is attached to this run." };
  }
  return { status: entry.meta.status, reason: entry.meta.statusReason };
}

export function resolveCatalog(registry: LibraryRegistry, ctx: LibraryHandlerContext): LibraryEntryMeta[] {
  return registry.list().map((entry) => {
    const availability = resolveEntryAvailability(entry, ctx);
    if (availability.status === entry.meta.status && availability.reason === entry.meta.statusReason) return entry.meta;
    return { ...entry.meta, status: availability.status, statusReason: availability.reason };
  });
}

// ---------------------------------------------------------------------------
// Executor with operation tracking
// ---------------------------------------------------------------------------

interface StoredOperation extends LibraryOperationView {
  readonly taskId: string | null;
}

const MAX_OPERATIONS = 40;

export class LibraryExecutor {
  private readonly operations: StoredOperation[] = [];

  constructor(
    private readonly registry: LibraryRegistry,
    private readonly context: LibraryHandlerContext,
  ) {}

  get catalog(): LibraryEntryMeta[] {
    return resolveCatalog(this.registry, this.context);
  }

  /** Operations with task-backed running states resolved live from control.task/result. */
  listOperations(): LibraryOperationView[] {
    const control = this.context.control;
    return this.operations
      .map((op) => {
        if (op.state !== "running" || !op.taskId) return stripTask(op);
        if (control.task && control.task.id === op.taskId) return stripTask(op);
        const result = control.result && control.result.taskId === op.taskId ? control.result : null;
        if (!result) {
          // Task record gone without a result (host restarted the bookkeeping): report honestly.
          return {
            ...stripTask(op),
            state: "failed" as const,
            finishedAt: new Date().toISOString(),
            message: `${op.message} Ended without a recorded task result; see the Tasks panel and trace.`,
            failureCode: "TASK_RESULT_MISSING",
            failureMessage: "The task is no longer running and no result was recorded.",
          };
        }
        const succeeded = result.status === "succeeded";
        return {
          ...stripTask(op),
          state: succeeded ? ("succeeded" as const) : ("failed" as const),
          finishedAt: new Date().toISOString(),
          message: succeeded
            ? `Task '${result.taskId}' completed with status '${result.status}' (verified by the task runner).`
            : `Task '${result.taskId}' ended '${result.status}': ${result.failure?.code ?? "no code"} — ${result.failure?.message ?? "no reason reported"}.`,
          failureCode: succeeded ? null : (result.failure?.code ?? "TASK_FAILED"),
          failureMessage: succeeded ? null : (result.failure?.message ?? null),
        };
      })
      .slice()
      .reverse();
  }

  async execute(entryId: string, rawParams: Readonly<Record<string, unknown>> = {}): Promise<LibraryOperationView> {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const entry = this.registry.get(entryId);
    if (!entry) {
      return this.record({
        id: randomUUID(),
        entryId,
        title: entryId,
        category: "Tasks",
        startedAt,
        finishedAt: new Date().toISOString(),
        state: "refused",
        message: `Unknown Library entry '${entryId}'.`,
        failureCode: "UNKNOWN_LIBRARY_ENTRY",
        failureMessage: `Unknown Library entry '${entryId}'.`,
        confirmed: null,
        durationMs: Date.now() - startedMs,
        taskId: null,
      });
    }
    const availability = resolveEntryAvailability(entry, this.context);
    if (availability.status === "unavailable") {
      return this.record({
        id: randomUUID(),
        entryId,
        title: entry.meta.title,
        category: entry.meta.category,
        startedAt,
        finishedAt: new Date().toISOString(),
        state: "refused",
        message: `Unavailable: ${availability.reason ?? "not available in this run"}`,
        failureCode: "LIBRARY_UNAVAILABLE",
        failureMessage: availability.reason ?? "not available in this run",
        confirmed: null,
        durationMs: Date.now() - startedMs,
        taskId: null,
      });
    }
    if (entry.meta.requiresConnection && this.context.runtime) {
      const status = this.context.runtime.status();
      if (status.adapterStatus !== "connected") {
        return this.record({
          id: randomUUID(),
          entryId,
          title: entry.meta.title,
          category: entry.meta.category,
          startedAt,
          finishedAt: new Date().toISOString(),
          state: "refused",
          message: `Refused: adapter is '${status.adapterStatus}' (${status.statusReason ?? "no reason reported"}). Connect before running world actions.`,
          failureCode: "ADAPTER_NOT_CONNECTED",
          failureMessage: status.statusReason ?? `adapter is ${status.adapterStatus}`,
          confirmed: null,
          durationMs: Date.now() - startedMs,
          taskId: null,
        });
      }
    }
    const validated = validateLibraryParams(entry.meta.params, rawParams);
    if (!validated.ok) {
      return this.record({
        id: randomUUID(),
        entryId,
        title: entry.meta.title,
        category: entry.meta.category,
        startedAt,
        finishedAt: new Date().toISOString(),
        state: "refused",
        message: `Invalid parameters: ${validated.message}`,
        failureCode: "INVALID_LIBRARY_PARAMS",
        failureMessage: validated.message,
        confirmed: null,
        durationMs: Date.now() - startedMs,
        taskId: null,
      });
    }
    let result: LibraryHandlerResult;
    try {
      result = await entry.handler(validated.params, this.context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.logger.warn({ err: error, entryId }, "Library entry handler threw");
      return this.record({
        id: randomUUID(),
        entryId,
        title: entry.meta.title,
        category: entry.meta.category,
        startedAt,
        finishedAt: new Date().toISOString(),
        state: "failed",
        message: `Handler failed: ${message}`,
        failureCode: "LIBRARY_HANDLER_FAILED",
        failureMessage: message,
        confirmed: false,
        durationMs: Date.now() - startedMs,
        taskId: null,
      });
    }
    if (result.running) {
      return this.record({
        id: randomUUID(),
        entryId,
        title: entry.meta.title,
        category: entry.meta.category,
        startedAt,
        finishedAt: null,
        state: "running",
        message: result.message,
        failureCode: null,
        failureMessage: null,
        confirmed: null,
        durationMs: null,
        taskId: result.taskId ?? null,
      });
    }
    return this.record({
      id: randomUUID(),
      entryId,
      title: entry.meta.title,
      category: entry.meta.category,
      startedAt,
      finishedAt: new Date().toISOString(),
      state: result.ok ? "succeeded" : "failed",
      message: result.message,
      failureCode: result.ok ? null : (result.failureCode ?? "LIBRARY_EXECUTION_FAILED"),
      failureMessage: result.ok ? null : (result.failureMessage ?? result.message),
      confirmed: result.confirmed ?? null,
      durationMs: result.durationMs ?? Date.now() - startedMs,
      taskId: null,
    });
  }

  private record(op: StoredOperation): LibraryOperationView {
    this.operations.push(op);
    if (this.operations.length > MAX_OPERATIONS) this.operations.splice(0, this.operations.length - MAX_OPERATIONS);
    return stripTask(op);
  }
}

function stripTask(op: StoredOperation): LibraryOperationView {
  const { taskId: _taskId, ...view } = op;
  void _taskId;
  return view;
}

// ---------------------------------------------------------------------------
// Shared handler helpers (real pipeline, honest reporting)
// ---------------------------------------------------------------------------

function needSkills(ctx: LibraryHandlerContext): SkillRuntime | LibraryHandlerResult {
  if (!ctx.skills) {
    return { ok: false, message: "No skill runtime is attached to this run.", failureCode: "NO_SKILL_RUNTIME" };
  }
  return ctx.skills;
}

function needCompanion(ctx: LibraryHandlerContext): LibraryCompanion | LibraryHandlerResult {
  if (!ctx.companion) {
    return { ok: false, message: "No companion coordinator is attached to this run.", failureCode: "NO_COMPANION" };
  }
  return ctx.companion;
}

function isHandlerResult(value: unknown): value is LibraryHandlerResult {
  return typeof value === "object" && value !== null && "ok" in (value as object) && "message" in (value as object);
}

/** Runs one skill and verifies the observed effect. Never claims success without evidence. */
async function runSkillVerified(
  skillId: string,
  input: unknown,
  entryId: string,
  ctx: LibraryHandlerContext,
): Promise<LibraryHandlerResult> {
  const skills = needSkills(ctx);
  if (isHandlerResult(skills)) return skills;
  const started = Date.now();
  let executed;
  try {
    executed = await skills.run(skillId, input, { source: `library:${entryId}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Skill '${skillId}' threw before the adapter answered: ${message}.`,
      failureCode: "SKILL_THREW",
      failureMessage: message,
      confirmed: false,
      durationMs: Date.now() - started,
    };
  }
  const action = executed.action;
  const durationMs = action.durationMs ?? Date.now() - started;
  if (action.status !== "succeeded") {
    return {
      ok: false,
      message: `Skill '${skillId}' ended '${action.status}': ${action.failure?.code ?? "no code"} — ${action.failure?.message ?? "no reason reported"}.`,
      failureCode: action.failure?.code ?? `SKILL_${action.status.toUpperCase()}`,
      failureMessage: action.failure?.message ?? null,
      confirmed: action.confirmed,
      durationMs,
    };
  }
  if (action.confirmed !== true) {
    return {
      ok: false,
      message: `Skill '${skillId}' was not confirmed by the adapter; no world change is claimed.`,
      failureCode: "ACTION_NOT_CONFIRMED",
      failureMessage: action.failure?.message ?? "adapter did not confirm",
      confirmed: false,
      durationMs,
    };
  }
  const before = (executed.observationBefore?.state ?? null) as MinecraftObservation | null;
  const after = (executed.observationAfter?.state ?? null) as MinecraftObservation | null;
  const verification = verifySkillPostcondition(skillId, input, before, after);
  if (verification.verified === false) {
    return {
      ok: false,
      message: `Skill '${skillId}' was confirmed by the adapter but the next observation contradicts it (UNVERIFIED_POSTCONDITION): ${verification.evidence}`,
      failureCode: "UNVERIFIED_POSTCONDITION",
      failureMessage: verification.evidence,
      confirmed: true,
      durationMs,
    };
  }
  const evidence = verification.verified === true
    ? ` Verified: ${verification.evidence}`
    : ` Postcondition check unavailable: ${verification.evidence}`;
  return {
    ok: true,
    message: `Skill '${skillId}' succeeded and was confirmed.${evidence} ${action.confirmation ?? ""}`.trim(),
    confirmed: true,
    durationMs,
  };
}

function playerNameField(requiredHelp: string): LibraryParamField {
  return {
    name: "player",
    label: "Player name",
    type: "string",
    required: true,
    maxLength: 16,
    pattern: "^[A-Za-z0-9_]{1,16}$",
    help: requiredHelp,
  };
}

const xyzFields: readonly LibraryParamField[] = [
  { name: "x", label: "X", type: "integer", required: true, min: -30000000, max: 30000000 },
  { name: "y", label: "Y", type: "integer", required: true, min: -64, max: 512 },
  { name: "z", label: "Z", type: "integer", required: true, min: -30000000, max: 30000000 },
];

const dangerField: LibraryParamField = {
  name: "dangerRadius",
  label: "Danger radius",
  type: "number",
  required: false,
  def: 6,
  min: 2,
  max: 16,
  help: "Work is refused while a visible hostile is within this radius of the target.",
};

function selectField(
  name: string,
  label: string,
  values: readonly string[],
  def?: string,
  help?: string,
): LibraryParamField {
  return {
    name,
    label,
    type: "select",
    required: def === undefined,
    options: values.map((value) => ({ value, label: value })),
    ...(def === undefined ? {} : { def }),
    ...(help === undefined ? {} : { help }),
  };
}

// ---------------------------------------------------------------------------
// Catalog construction (all entries; availability resolved per snapshot)
// ---------------------------------------------------------------------------

export function createMinecraftLibraryRegistry(): LibraryRegistry {
  const registry = new LibraryRegistry();

  const skill = (
    id: string,
    category: LibraryCategory,
    title: string,
    description: string,
    skillId: string,
    capability: string,
    params: readonly LibraryParamField[],
    toInput: (params: Readonly<Record<string, unknown>>) => unknown,
  ): void => {
    registry.register({
      meta: {
        id,
        category,
        title,
        description,
        status: "implemented",
        statusReason: null,
        requiresConnection: true,
        params,
      },
      requiresCapabilities: [capability],
      handler: async (params, ctx) => runSkillVerified(skillId, toInput(params), id, ctx),
    });
  };

  // -- Movement & Navigation -------------------------------------------------
  skill(
    "move.navigate",
    "Movement & Navigation",
    "Navigate to coordinates",
    "Conservative pathfinding to a nearby coordinate. Never digs, builds, parkours, sprints, or drops more than one block. Verified against the next observation.",
    "minecraft.navigate",
    "minecraft.navigate",
    [...xyzFields, { name: "range", label: "Arrive within (blocks)", type: "number", required: false, def: 1, min: 1, max: 3 }],
    (p) => ({ x: p["x"], y: p["y"], z: p["z"], range: p["range"] ?? 1 }),
  );
  skill(
    "move.look",
    "Movement & Navigation",
    "Look (orient view)",
    "Sets yaw/pitch only. Changes orientation, never moves or interacts. Read-only orientation with adapter confirmation.",
    "minecraft.orient",
    "minecraft.look",
    [
      { name: "yaw", label: "Yaw (radians, -π..π)", type: "number", required: true, min: -Math.PI, max: Math.PI },
      { name: "pitch", label: "Pitch (radians, -π/2..π/2)", type: "number", required: true, min: -Math.PI / 2, max: Math.PI / 2 },
    ],
    (p) => ({ yaw: p["yaw"], pitch: p["pitch"] }),
  );
  skill(
    "move.inspect",
    "Movement & Navigation",
    "Inspect block",
    "Reads one locally loaded block without changing the world. Fails honestly when the cell is unloaded or unknown.",
    "minecraft.inspect-block",
    "minecraft.inspect_block",
    [...xyzFields],
    (p) => ({ x: p["x"], y: p["y"], z: p["z"] }),
  );
  registry.register({
    meta: {
      id: "move.unstuck",
      category: "Movement & Navigation",
      title: "Unstick (bounded sidestep)",
      description: "Tries one safe 4-block axis-aligned sidestep chosen from observed terrain. Single attempt; reports which destination was tried and why it was safe.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [],
    },
    requiresCompanion: true,
    requiresCapabilities: ["minecraft.navigate"],
    handler: async (_params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const result = await companion.setMode("unstuck");
      return {
        ok: result.ok,
        message: result.ok
          ? `${result.message} The sidestep runs once on the next observation tick; watch Companion status for the measured outcome.`
          : result.message,
        failureCode: result.ok ? null : "UNSTUCK_REFUSED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });
  registry.register({
    meta: {
      id: "move.explore",
      category: "Movement & Navigation",
      title: "Explore frontier (12 legs)",
      description: "Bounded exploration: up to 12 legs within 64 blocks of the start anchor, preferring unexplored frontiers and avoiding remembered hostiles. Stops honestly when no frontier remains.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [],
    },
    requiresCompanion: true,
    requiresCapabilities: ["minecraft.navigate"],
    handler: async (_params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const result = await companion.setMode("explore");
      return {
        ok: result.ok,
        message: result.ok
          ? `${result.message} Legs execute on observation ticks; progress and the stop reason appear in Companion status.`
          : result.message,
        failureCode: result.ok ? null : "EXPLORE_REFUSED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });

  // -- Following & Companionship ---------------------------------------------
  const followHandler = (mode: "follow" | "come" | "afk", extra: string): LibraryHandler => async (params, ctx) => {
    const companion = needCompanion(ctx);
    if (isHandlerResult(companion)) return companion;
    const player = params["player"];
    if (typeof player !== "string" || !player) {
      return { ok: false, message: "Player name is required.", failureCode: "PLAYER_REQUIRED" };
    }
    const result = await companion.setMode(mode, { targetPlayer: player });
    return {
      ok: result.ok,
      message: result.ok ? `${result.message} ${extra}` : result.message,
      failureCode: result.ok ? null : "FOLLOW_REFUSED",
      failureMessage: result.ok ? null : result.message,
    };
  };
  registry.register({
    meta: {
      id: "follow.player",
      category: "Following & Companionship",
      title: "Follow player",
      description: "Continuously follows the named player: 4-block preference, holds inside 5 blocks, catches up from 24+, refuses to move on stale observations (>3s) or when the target is missing. Holds in place after 5 missed observations.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [playerNameField("Exact in-game username. Movement follows only fresh observations of this player.")],
    },
    requiresCompanion: true,
    requiresCapabilities: ["minecraft.navigate"],
    handler: followHandler("follow", "Separation, follow state, and each navigation outcome are tracked live in Companion status."),
  });
  registry.register({
    meta: {
      id: "follow.come",
      category: "Following & Companionship",
      title: "Come here (one approach)",
      description: "Approaches the named player once, then holds the verified arrival position. Same staleness and missing-target guards as Follow.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [playerNameField("Exact in-game username to approach.")],
    },
    requiresCompanion: true,
    requiresCapabilities: ["minecraft.navigate"],
    handler: followHandler("come", "Arrival within measurement is revalidated from a fresh observation before holding."),
  });
  registry.register({
    meta: {
      id: "follow.afk",
      category: "Following & Companionship",
      title: "AFK accompany",
      description: "Follows the named player while also defending (up to 4 swings) against hostiles within 4 blocks when health is ≥10. Combat must be armed; otherwise follow-only with flee-on-threat.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [playerNameField("Exact in-game username to accompany.")],
    },
    requiresCompanion: true,
    requiresCapabilities: ["minecraft.navigate"],
    handler: followHandler("afk", "Defence outcomes and follow separation are tracked in Companion status."),
  });
  registry.register({
    meta: {
      id: "follow.hold",
      category: "Following & Companionship",
      title: "Hold position",
      description: "Stops companion movement and anchors at the current observed position. Interrupts a running task cooperatively (between actions, never mid-action).",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [],
    },
    requiresCompanion: true,
    handler: async (_params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const result = await companion.setMode("hold");
      return {
        ok: result.ok,
        message: result.message,
        failureCode: result.ok ? null : "HOLD_REFUSED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });
  registry.register({
    meta: {
      id: "follow.stop",
      category: "Following & Companionship",
      title: "Stop companion",
      description: "Requests the running task to stop and returns the companion to idle. The run ends as aborted/OPERATOR_STOP after the action in flight.",
      status: "implemented",
      statusReason: null,
      requiresConnection: false,
      params: [],
    },
    requiresCompanion: true,
    handler: async (_params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const result = await companion.halt("stopped from the Library");
      return {
        ok: result.ok,
        message: result.message,
        failureCode: result.ok ? null : "STOP_REFUSED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });
  registry.register({
    meta: {
      id: "follow.status",
      category: "Following & Companionship",
      title: "Companion status report",
      description: "Returns the current mode, health/hunger, position, inventory summary, and last outcome from the live observation. Read-only; the same state is always visible in the Companion panel.",
      status: "implemented",
      statusReason: null,
      requiresConnection: false,
      params: [],
    },
    requiresCompanion: true,
    handler: async (_params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const result = await companion.getStatus();
      return { ok: result.ok, message: result.message, failureCode: result.ok ? null : "STATUS_FAILED" };
    },
  });

  // -- Gathering & Food -------------------------------------------------------
  skill(
    "gather.collect-log",
    "Gathering & Food",
    "Collect one log",
    "Pathfinds to one observed log block, rechecks identity/survival/range/harvestability and hostile proximity, then verifies the item entered inventory. Other block types are refused.",
    "minecraft.collect-log",
    "minecraft.collect_block",
    [...xyzFields, selectField("blockName", "Log type", minecraftLogNames), dangerField],
    (p) => ({ x: p["x"], y: p["y"], z: p["z"], blockName: p["blockName"], dangerRadius: p["dangerRadius"] ?? 6 }),
  );
  skill(
    "gather.pickup",
    "Gathering & Food",
    "Pick up dropped item",
    "Walks to one observed dropped food/log item and confirms it entered inventory. Only allowlisted food and logs; never arbitrary items.",
    "minecraft.pickup-item",
    "minecraft.pickup_item",
    [...xyzFields, selectField("itemName", "Item", minecraftPickupNames), dangerField],
    (p) => ({ x: p["x"], y: p["y"], z: p["z"], itemName: p["itemName"], dangerRadius: p["dangerRadius"] ?? 6 }),
  );
  skill(
    "gather.berries",
    "Gathering & Food",
    "Harvest ripe berries",
    "Right-clicks one observed sweet berry bush at age 2-3 and confirms berries entered inventory. Unripe bushes are refused.",
    "minecraft.harvest-berries",
    "minecraft.harvest_berries",
    [...xyzFields, dangerField],
    (p) => ({ x: p["x"], y: p["y"], z: p["z"], dangerRadius: p["dangerRadius"] ?? 6 }),
  );
  skill(
    "gather.eat",
    "Gathering & Food",
    "Eat food",
    "Eats one allowlisted food from inventory when hunger is not full. Verified by hunger increase plus inventory decrease.",
    "minecraft.eat-food",
    "minecraft.eat_food",
    [selectField("item", "Food", minecraftFoodNames)],
    (p) => ({ item: p["item"] }),
  );
  skill(
    "gather.rest",
    "Gathering & Food",
    "Rest (bounded regeneration)",
    "Stands still up to 30s for natural regeneration. Stops early on visible hostiles or damage; confirmed only by observed health increase. Correctly reports not-confirmed when the server disables regeneration.",
    "minecraft.rest",
    "minecraft.rest",
    [
      { name: "durationMs", label: "Duration (ms)", type: "integer", required: false, def: 10000, min: 1000, max: 30000 },
      { name: "targetHealth", label: "Target health", type: "integer", required: false, def: 16, min: 1, max: 20 },
      dangerField,
    ],
    (p) => ({ durationMs: p["durationMs"] ?? 10000, targetHealth: p["targetHealth"] ?? 16, dangerRadius: p["dangerRadius"] ?? 6 }),
  );

  // -- Mining & Resources -----------------------------------------------------
  skill(
    "mine.block",
    "Mining & Resources",
    "Mine one block",
    "Pathfinds to one allowlisted stone-class/ore block, checks the pickaxe tier the drop requires against the held item, digs, and verifies the drop entered inventory. Tier failures name the required tool.",
    "minecraft.mine-block",
    "minecraft.mine_block",
    [...xyzFields, selectField("blockName", "Block", minecraftMineableBlockNames), dangerField],
    (p) => ({ x: p["x"], y: p["y"], z: p["z"], blockName: p["blockName"], dangerRadius: p["dangerRadius"] ?? 6 }),
  );
  skill(
    "mine.equip",
    "Mining & Resources",
    "Equip item",
    "Equips an inventory item into a named slot and verifies it. Used to hold the required pickaxe before mining or a weapon before defence.",
    "minecraft.equip-item",
    "minecraft.equip_item",
    [
      { name: "item", label: "Item name", type: "string", required: true, maxLength: 96, pattern: "^[a-z0-9_.:-]+$", help: "Must already be in inventory, e.g. stone_pickaxe." },
      selectField("destination", "Slot", ["hand", "off-hand", "head", "torso", "legs", "feet"], "hand"),
    ],
    (p) => ({ item: p["item"], destination: p["destination"] ?? "hand" }),
  );
  skill(
    "mine.drop",
    "Mining & Resources",
    "Drop junk (free space)",
    "Drops 1-64 of allowlisted terrain (dirt/sand/gravel/stone-family) to free slots. Tools, resources, and food are refused.",
    "minecraft.drop-item",
    "minecraft.drop_item",
    [
      selectField("itemName", "Junk item", minecraftDroppableJunkNames),
      { name: "count", label: "Count", type: "integer", required: false, def: 1, min: 1, max: 64 },
    ],
    (p) => ({ itemName: p["itemName"], count: p["count"] ?? 1 }),
  );

  // -- Building & Crafting ----------------------------------------------------
  skill(
    "build.place",
    "Building & Crafting",
    "Place one block",
    "Places one allowlisted block from inventory onto an observed solid support in an observed air cell. Rechecks reach, player collision, and hostile proximity; confirms by reading the block back.",
    "minecraft.place-block",
    "minecraft.place_block",
    [...xyzFields, selectField("blockName", "Block", minecraftPlaceableBlockNames), dangerField],
    (p) => ({ x: p["x"], y: p["y"], z: p["z"], blockName: p["blockName"], dangerRadius: p["dangerRadius"] ?? 6 }),
  );
  skill(
    "build.table",
    "Building & Crafting",
    "Place crafting table",
    "Places exactly one crafting table on a validated visible solid support in a nearby air cell, after player/entity collision and hostile checks.",
    "minecraft.place-crafting-table",
    "minecraft.place_crafting_table",
    [...xyzFields, dangerField],
    (p) => ({ x: p["x"], y: p["y"], z: p["z"], dangerRadius: p["dangerRadius"] ?? 6 }),
  );
  skill(
    "build.craft",
    "Building & Crafting",
    "Craft item",
    "Crafts only the allowlisted wood/plank/stick/table/tool set from verified inventory, optionally at a nearby observed crafting table. Verified by inventory delta.",
    "minecraft.craft-item",
    "minecraft.craft_item",
    [
      selectField("item", "Item", minecraftCraftableItemNames),
      { name: "count", label: "Count", type: "integer", required: true, min: 1, max: 64 },
    ],
    (p) => ({ item: p["item"], count: p["count"] }),
  );
  skill(
    "build.shelter-once",
    "Building & Crafting",
    "Build shelter (single skill)",
    "Closes observed open sides around the player with allowlisted inventory blocks, one validated placement at a time. Reports no-support vs unknown per side; stops on threats. A closed shell only: no roof, lighting, or defensibility judgement.",
    "minecraft.build-shelter",
    "minecraft.build_shelter",
    [
      selectField("mode", "Mode", ["cardinal", "full"], "cardinal", "cardinal closes 4 sides; full closes all 8."),
      { name: "maxBlocks", label: "Max blocks", type: "integer", required: false, def: 4, min: 1, max: 16 },
      dangerField,
    ],
    (p) => ({ mode: p["mode"] ?? "cardinal", maxBlocks: p["maxBlocks"] ?? 4, dangerRadius: p["dangerRadius"] ?? 6 }),
  );

  // -- Combat & Protection ----------------------------------------------------
  skill(
    "combat.attack",
    "Combat & Protection",
    "Attack hostile (bounded)",
    "Attacks one identified hostile for at most 6 swings. Triple opt-in: adapter switch + safety policy + task context. Also requires held weapon, health above floor, and a single target in range. Every refusal names its gate.",
    "minecraft.attack-hostile",
    MINECRAFT_ATTACK_HOSTILE_CAPABILITY,
    [
      { name: "entityId", label: "Entity id", type: "string", required: true, maxLength: 48, help: "From the Visible entities panel." },
      { name: "maxHits", label: "Max swings", type: "integer", required: false, def: 4, min: 1, max: 6 },
      dangerField,
      { name: "minHealth", label: "Min health to engage", type: "number", required: false, def: 10, min: 1, max: 20 },
      { name: "retreatHealth", label: "Retreat below", type: "number", required: false, def: 6, min: 0.5, max: 20 },
      { name: "requiredDamage", label: "Required weapon damage", type: "number", required: false, def: 4, min: 1, max: 20 },
    ],
    (p) => ({
      entityId: p["entityId"],
      maxHits: p["maxHits"] ?? 4,
      dangerRadius: p["dangerRadius"] ?? 6,
      minHealth: p["minHealth"] ?? 10,
      retreatHealth: p["retreatHealth"] ?? 6,
      requiredDamage: p["requiredDamage"] ?? 4,
    }),
  );
  registry.register({
    meta: {
      id: "combat.mode",
      category: "Combat & Protection",
      title: "Combat mode (armed defence)",
      description: "Arms combat (adapter + safety policy together) and defends: up to 4 swings at hostiles within 4 blocks when health is ≥10, otherwise survival retreat. Disarm from Safety & Control when done.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [],
    },
    requiresCompanion: true,
    requiresCombatSwitch: true,
    handler: async (_params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const result = await companion.setMode("combat");
      return {
        ok: result.ok,
        message: result.ok
          ? `${result.message} Defence runs on observation ticks against actually visible hostiles; each outcome is recorded in Companion status.`
          : result.message,
        failureCode: result.ok ? null : "COMBAT_REFUSED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });
  registry.register({
    meta: {
      id: "combat.guard",
      category: "Combat & Protection",
      title: "Guard position",
      description: "Anchors at the current position and defends it (same bounded defence as Combat mode) without following anyone.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [],
    },
    requiresCompanion: true,
    requiresCapabilities: ["minecraft.navigate"],
    handler: async (_params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const result = await companion.setMode("guard");
      return {
        ok: result.ok,
        message: result.message,
        failureCode: result.ok ? null : "GUARD_REFUSED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });

  // -- Homepoints & Places ----------------------------------------------------
  registry.register({
    meta: {
      id: "home.save",
      category: "Homepoints & Places",
      title: "Save homepoint",
      description: "Saves the current observed position under a name. World-scoped and dimension-aware; never overwrites without explicit delete. Names: 1-32 lowercase letters/numbers/_/-, starting with a letter.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [
        { name: "name", label: "Name", type: "string", required: true, maxLength: 32, pattern: "^[a-z][a-z0-9_-]{0,31}$" },
      ],
    },
    requiresCompanion: true,
    handler: async (params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const name = normalizeHomepointName(typeof params["name"] === "string" ? (params["name"] as string) : null);
      if (!name) {
        return {
          ok: false,
          message: "Invalid homepoint name. Use 1–32 lowercase letters, numbers, '_' or '-', starting with a letter.",
          failureCode: "INVALID_HOMEPOINT_NAME",
        };
      }
      const result = await companion.saveHomepoint(name);
      return {
        ok: result.ok,
        message: result.message,
        failureCode: result.ok ? null : "HOMEPOINT_SAVE_FAILED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });
  registry.register({
    meta: {
      id: "home.save-default",
      category: "Homepoints & Places",
      title: "Save default home",
      description: "Saves the current observed position as 'default' (the Return destination). Replaces the removed argument-free #home with an explicit action.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [],
    },
    requiresCompanion: true,
    handler: async (_params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const result = await companion.saveHomepoint("default");
      return {
        ok: result.ok,
        message: result.message,
        failureCode: result.ok ? null : "HOMEPOINT_SAVE_FAILED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });
  registry.register({
    meta: {
      id: "home.goto",
      category: "Homepoints & Places",
      title: "Go to homepoint",
      description: "Navigates to a saved homepoint in the current dimension. Cross-dimension routes are refused (no verified route). Arrival is revalidated from a fresh observation; stale coordinates are labelled.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [
        { name: "name", label: "Name", type: "string", required: true, maxLength: 32, pattern: "^[a-z][a-z0-9_-]{0,31}$" },
      ],
    },
    requiresCompanion: true,
    requiresCapabilities: ["minecraft.navigate"],
    handler: async (params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const name = normalizeHomepointName(typeof params["name"] === "string" ? (params["name"] as string) : null);
      if (!name) {
        return { ok: false, message: "Invalid homepoint name.", failureCode: "INVALID_HOMEPOINT_NAME" };
      }
      const result = await companion.goHomepoint(name);
      return {
        ok: result.ok,
        message: result.ok
          ? `${result.message} Navigation runs on observation ticks; arrival is revalidated before holding.`
          : result.message,
        failureCode: result.ok ? null : "HOMEPOINT_GOTO_FAILED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });
  registry.register({
    meta: {
      id: "home.return",
      category: "Homepoints & Places",
      title: "Return to default home",
      description: "Navigates to the saved 'default' homepoint in the current dimension. Refuses honestly when none is saved or dimensions differ.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [],
    },
    requiresCompanion: true,
    requiresCapabilities: ["minecraft.navigate"],
    handler: async (_params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const result = await companion.setMode("return");
      return {
        ok: result.ok,
        message: result.ok
          ? `${result.message} Navigation runs on observation ticks; arrival is revalidated before holding.`
          : result.message,
        failureCode: result.ok ? null : "RETURN_REFUSED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });
  registry.register({
    meta: {
      id: "home.list",
      category: "Homepoints & Places",
      title: "List homepoints",
      description: "Lists saved homepoints with dimension, coordinates, and availability (available / stale / different-dimension / dimension-unknown). Read-only; the same list is in the Companion panel.",
      status: "implemented",
      statusReason: null,
      requiresConnection: false,
      params: [],
    },
    requiresCompanion: true,
    handler: async (_params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const result = await companion.listHomepoints();
      return { ok: result.ok, message: result.message };
    },
  });
  registry.register({
    meta: {
      id: "home.delete",
      category: "Homepoints & Places",
      title: "Delete homepoint",
      description: "Deletes one named homepoint explicitly. Active navigation to it stops. There is no undo; re-save to recreate.",
      status: "implemented",
      statusReason: null,
      requiresConnection: false,
      params: [
        { name: "name", label: "Name", type: "string", required: true, maxLength: 32, pattern: "^[a-z][a-z0-9_-]{0,31}$" },
      ],
    },
    requiresCompanion: true,
    handler: async (params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const name = normalizeHomepointName(typeof params["name"] === "string" ? (params["name"] as string) : null);
      if (!name) {
        return { ok: false, message: "Invalid homepoint name.", failureCode: "INVALID_HOMEPOINT_NAME" };
      }
      const result = await companion.deleteHomepoint(name);
      return {
        ok: result.ok,
        message: result.message,
        failureCode: result.ok ? null : "HOMEPOINT_DELETE_FAILED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });

  // -- Tasks (verified multi-step objectives through the same runner as the CLI)
  const taskEntry = (
    id: string,
    title: string,
    description: string,
    kind: string,
    params: readonly LibraryParamField[],
  ): void => {
    registry.register({
      meta: { id, category: "Tasks", title, description, status: "implemented", statusReason: null, requiresConnection: true, params },
      requiresTaskRunner: true,
      handler: async (params, ctx) => {
        if (!ctx.taskFor || !ctx.onStart) {
          return { ok: false, message: "This run does not accept new tasks.", failureCode: "TASK_RUNNER_MISSING" };
        }
        const busy = liveTask(ctx.control);
        if (busy) {
          return {
            ok: false,
            message: `A task ('${busy.id}') is already running; stop it first.`,
            failureCode: "TASK_ALREADY_RUNNING",
          };
        }
        let built: MinecraftTask | null = null;
        try {
          const resource = typeof params["resource"] === "string" && params["resource"] ? (params["resource"] as string) : undefined;
          const count = typeof params["count"] === "number" ? (params["count"] as number) : undefined;
          built = ctx.taskFor({
            kind,
            ...(resource !== undefined ? { resource } : {}),
            ...(count !== undefined ? { count } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, message, failureCode: "INVALID_TASK_REQUEST", failureMessage: message };
        }
        const task: MinecraftTask = built;
        // Fire-and-forget start; the operation stays running and resolves live from control.task/result.
        ctx.onStart(task, { origin: "library" }).catch((error: unknown) => {
          ctx.logger.error({ err: error, taskId: task.id }, "Library task failed");
        });
        // The synchronous prefix of onStart sets control.task before this microtask yields; if the host
        // refused (paused/tripped), control.task stays null and we report the refusal instead of "running".
        await Promise.resolve();
        const runningTask = liveTask(ctx.control);
        if (!runningTask || runningTask.id !== task.id) {
          const lastResult = liveResult(ctx.control);
          const lastFailure = lastResult && lastResult.taskId === task.id ? lastResult.failure : null;
          return {
            ok: false,
            message: lastFailure
              ? `Task '${task.id}' was refused: ${lastFailure.code} — ${lastFailure.message}.`
              : `Task '${task.id}' did not start (the run may be paused, tripped, or already busy). See the Status panel.`,
            failureCode: lastFailure?.code ?? "TASK_NOT_STARTED",
            failureMessage: lastFailure?.message ?? null,
          };
        }
        return {
          ok: true,
          running: true,
          taskId: task.id,
          message: `Task '${task.id}' (${task.kind}) started. Completion, verification, and any failure code appear here and in the Tasks panel when it ends.`,
        };
      },
    });
  };

  taskEntry(
    "task.gather-logs",
    "Gather logs (task)",
    "Verified objective: finds, approaches, and collects logs with exploration (8 legs / 48 blocks by default), safety gating, and per-action postcondition verification. Ends with a measured task result.",
    "gather-logs",
    [
      selectField("resource", "Log type", minecraftLogNames, "oak_log"),
      { name: "count", label: "Count", type: "integer", required: false, def: 1, min: 1, max: 64 },
    ],
  );
  taskEntry(
    "task.mine-resource",
    "Mine resource (task)",
    "Verified objective: equips the required pickaxe tier, digs the block, and verifies the drop. Refuses by name when no tool or tier is insufficient.",
    "mine-stone",
    [
      selectField("resource", "Block", minecraftMineableBlockNames, "stone"),
      { name: "count", label: "Count", type: "integer", required: false, def: 4, min: 1, max: 64 },
    ],
  );
  taskEntry(
    "task.craft-item",
    "Craft item (task)",
    "Verified objective: expands the recipe chain (logs → planks → sticks → table → tools), gathers prerequisites, places a table when needed, and verifies each craft.",
    "craft-wooden-pickaxe",
    [
      selectField("resource", "Target", minecraftCraftTaskItemNames, "wooden_pickaxe"),
      { name: "count", label: "Count", type: "integer", required: false, def: 1, min: 1, max: 64 },
    ],
  );
  taskEntry(
    "task.secure-food",
    "Secure food (task)",
    "Verified objective: eats from inventory, picks up dropped food, harvests ripe berries, explores for them, and rests when hurt. Ends with measured hunger progress.",
    "secure-food",
    [{ name: "count", label: "Target hunger", type: "integer", required: false, def: 18, min: 1, max: 20 }],
  );
  taskEntry(
    "task.build-shelter",
    "Build shelter (task)",
    "Verified objective: closes the 4 cardinal sides around the player with inventory blocks. Reports no-support vs unknown per side against the next observation.",
    "build-shelter",
    [],
  );
  registry.register({
    meta: {
      id: "task.gather-companion",
      category: "Tasks",
      title: "Gather logs via companion",
      description: "Same verified gather objective as the task above, started through the companion coordinator (which records the evidence-based outcome in companion memory). Refused while far-target follow catch-up has priority.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [
        selectField("resource", "Log type", minecraftLogNames, "oak_log"),
        { name: "count", label: "Count", type: "integer", required: false, def: 8, min: 1, max: 64 },
      ],
    },
    requiresCompanion: true,
    requiresTaskRunner: true,
    handler: async (params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const resource = params["resource"];
      const count = params["count"];
      if (typeof resource !== "string" || !(minecraftLogNames as readonly string[]).includes(resource)) {
        return { ok: false, message: "Unknown gather resource.", failureCode: "UNKNOWN_RESOURCE" };
      }
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 64) {
        return { ok: false, message: "Gather count must be 1 through 64.", failureCode: "INVALID_COUNT" };
      }
      const result = await companion.startGather(resource as (typeof minecraftLogNames)[number], count);
      if (!result.ok) {
        return { ok: false, message: result.message, failureCode: "GATHER_REFUSED", failureMessage: result.message };
      }
      return {
        ok: true,
        running: true,
        ...(result.taskId !== undefined ? { taskId: result.taskId } : {}),
        message: `${result.message} Completion and its evidence appear here and in Companion status when the task ends.`,
      };
    },
  });
  registry.register({
    meta: {
      id: "task.shelter-companion",
      category: "Tasks",
      title: "Build shelter via companion",
      description: "Same verified shelter objective, started through the companion coordinator with its outcome recorded in companion memory.",
      status: "implemented",
      statusReason: null,
      requiresConnection: true,
      params: [],
    },
    requiresCompanion: true,
    requiresTaskRunner: true,
    handler: async (_params, ctx) => {
      const companion = needCompanion(ctx);
      if (isHandlerResult(companion)) return companion;
      const result = await companion.startBuildShelter();
      if (!result.ok) {
        return { ok: false, message: result.message, failureCode: "SHELTER_REFUSED", failureMessage: result.message };
      }
      return {
        ok: true,
        running: true,
        ...(result.taskId !== undefined ? { taskId: result.taskId } : {}),
        message: `${result.message} Completion and its evidence appear here and in Companion status when the task ends.`,
      };
    },
  });

  // -- Safety & Control (delegated to the same host commands as Run control) --
  const delegate = (
    id: string,
    title: string,
    description: string,
    params: readonly LibraryParamField[],
    call: (commands: ControlCenterCommands, params: Readonly<Record<string, unknown>>) => Promise<{ ok: boolean; message: string }> | { ok: boolean; message: string },
    requiresSafety = true,
  ): void => {
    registry.register({
      meta: { id, category: "Safety & Control", title, description, status: "implemented", statusReason: null, requiresConnection: false, params },
      ...(requiresSafety ? { requiresSafety: true as const } : {}),
      handler: async (params, ctx) => {
        const commands = ctx.hostCommands;
        if (!commands) {
          return { ok: false, message: "Host commands are not wired for this entry.", failureCode: "HOST_COMMANDS_MISSING" };
        }
        const result = await call(commands, params);
        return {
          ok: result.ok,
          message: result.message,
          failureCode: result.ok ? null : "HOST_COMMAND_REFUSED",
          failureMessage: result.ok ? null : result.message,
        };
      },
    });
  };

  delegate(
    "safety.pause",
    "Pause run",
    "SafetyBroker.pause(): every world-changing action is denied with RUN_PAUSED until resumed. Observing continues.",
    [{ name: "reason", label: "Reason", type: "string", required: false, maxLength: 140 }],
    (commands, params) =>
      commands.pause?.(typeof params["reason"] === "string" && params["reason"] ? (params["reason"] as string) : "paused from the Library") ??
      { ok: false, message: "Pause is not available in this host." },
  );
  delegate(
    "safety.resume",
    "Resume run",
    "SafetyBroker.resume(): lifts an operator pause. Refuses while a trip is still raised.",
    [],
    (commands) => commands.resume?.() ?? { ok: false, message: "Resume is not available in this host." },
  );
  delegate(
    "safety.trip",
    "Trip (deny everything)",
    "SafetyBroker.trip(): denies everything, including read-only actions, until an operator resets the trip.",
    [{ name: "reason", label: "Reason", type: "string", required: false, maxLength: 140 }],
    (commands, params) =>
      commands.trip?.(typeof params["reason"] === "string" && params["reason"] ? (params["reason"] as string) : "tripped from the Library") ??
      { ok: false, message: "Trip is not available in this host." },
  );
  delegate(
    "safety.reset-trip",
    "Reset trip",
    "Clears a trip. Never lifts an independent operator pause; the message says which state remains.",
    [],
    (commands) => commands.resetTrip?.() ?? { ok: false, message: "Reset trip is not available in this host." },
  );
  delegate(
    "safety.stop-task",
    "Stop task",
    "Cooperative stop checked between actions; the run ends as aborted/OPERATOR_STOP with the given reason.",
    [{ name: "reason", label: "Reason", type: "string", required: false, maxLength: 140 }],
    (commands, params) =>
      commands.stopTask?.(typeof params["reason"] === "string" && params["reason"] ? (params["reason"] as string) : "stopped from the Library") ??
      { ok: false, message: "Stop task is not available in this host." },
    false,
  );
  delegate(
    "safety.panic",
    "Emergency stop",
    "Trips safety, requests task stop, and disarms combat together. Reset the trip and resume when safe.",
    [],
    (commands) => commands.panic?.() ?? { ok: false, message: "Emergency stop is not available in this host." },
    false,
  );
  registry.register({
    meta: {
      id: "safety.combat",
      category: "Safety & Control",
      title: "Arm / disarm combat",
      description: "Moves both enforcement layers together: the adapter switch and the safety policy opt-in. Hidden/unavailable when the adapter has no switch. Attacking additionally needs a weapon, health, and a single target.",
      status: "implemented",
      statusReason: null,
      requiresConnection: false,
      params: [{ name: "enabled", label: "Armed", type: "boolean", required: true }],
    },
    requiresCombatSwitch: true,
    handler: async (params, ctx) => {
      const commands = ctx.hostCommands;
      if (!commands?.enableCombat) {
        return { ok: false, message: "Combat switching is not available in this host.", failureCode: "COMBAT_SWITCH_MISSING" };
      }
      const result = await commands.enableCombat(params["enabled"] === true);
      return {
        ok: result.ok,
        message: result.message,
        failureCode: result.ok ? null : "COMBAT_SWITCH_REFUSED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });

  // -- Learning & Memory (delegated to the same host commands as Learning) ----
  registry.register({
    meta: {
      id: "learn.promote",
      category: "Learning & Memory",
      title: "Promote policy",
      description: "Promotes the derived candidate weights after the full gate: passing offline report for this exact candidate, all scenarios at 20+ seeds, supported contexts, promotable comparison, zero contradicted confirmations. Refusals name every unmet condition.",
      status: "implemented",
      statusReason: null,
      requiresConnection: false,
      params: [],
    },
    requiresLearner: true,
    handler: async (_params, ctx) => {
      const commands = ctx.hostCommands;
      if (!commands?.promotePolicy) {
        return { ok: false, message: "Policy promotion is not available in this host.", failureCode: "PROMOTE_MISSING" };
      }
      const result = await commands.promotePolicy();
      return {
        ok: result.ok,
        message: result.message,
        failureCode: result.ok ? null : "PROMOTE_REFUSED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });
  registry.register({
    meta: {
      id: "learn.reject",
      category: "Learning & Memory",
      title: "Roll back policy",
      description: "Drops the promoted policy entirely; decisions return to hand-tuned baseline weights. Records the reason in state history.",
      status: "implemented",
      statusReason: null,
      requiresConnection: false,
      params: [],
    },
    requiresLearner: true,
    handler: async (_params, ctx) => {
      const commands = ctx.hostCommands;
      if (!commands?.rejectPolicy) {
        return { ok: false, message: "Policy rollback is not available in this host.", failureCode: "REJECT_MISSING" };
      }
      const result = await commands.rejectPolicy();
      return {
        ok: result.ok,
        message: result.message,
        failureCode: result.ok ? null : "REJECT_REFUSED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });
  registry.register({
    meta: {
      id: "learn.world-seed",
      category: "Learning & Memory",
      title: "Set world seed (manual)",
      description: "Stores an operator-entered world seed. Never auto-detected or checked against the server; anything derived from it is a prediction until verified. Blank clears.",
      status: "implemented",
      statusReason: null,
      requiresConnection: false,
      params: [{ name: "seed", label: "Seed (blank clears)", type: "string", required: false, maxLength: 64 }],
    },
    handler: async (params, ctx) => {
      const commands = ctx.hostCommands;
      if (!commands?.setWorldSeed) {
        return { ok: false, message: "World-seed storage is not available in this host.", failureCode: "SEED_MISSING" };
      }
      const raw = typeof params["seed"] === "string" ? (params["seed"] as string).trim() : "";
      const result = await commands.setWorldSeed(raw === "" ? null : raw);
      return {
        ok: result.ok,
        message: result.message,
        failureCode: result.ok ? null : "SEED_REFUSED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });

  // Training runs on the offline simulator in a separate process (never live, never in-browser).
  registry.register({
    meta: {
      id: "learn.training-start",
      category: "Learning & Memory",
      title: "Start / resume training",
      description: "Starts or resumes curriculum training in a separate process on the offline simulator. Same control as the Training panel; progress appears there.",
      status: "implemented",
      statusReason: null,
      requiresConnection: false,
      params: [
        { name: "episodesPerStage", label: "Episodes per stage", type: "integer", required: false, def: 8, min: 1, max: 200 },
        { name: "maxEpisodes", label: "Episode budget (blank = from stages)", type: "integer", required: false, min: 1, max: 5000 },
        { name: "maxMinutes", label: "Time budget minutes (blank = none)", type: "integer", required: false, min: 1, max: 1440 },
        { name: "fresh", label: "Start over (deletes saved experience)", type: "boolean", required: false, def: false },
      ],
    },
    requiresTraining: true,
    handler: async (params, ctx) => {
      const commands = ctx.hostCommands;
      if (!commands?.startTraining) {
        return { ok: false, message: "Training is not available in this host.", failureCode: "TRAINING_MISSING" };
      }
      const options: { episodesPerStage?: number; maxEpisodes?: number; maxMinutes?: number; fresh?: boolean } = {};
      if (typeof params["episodesPerStage"] === "number") options.episodesPerStage = params["episodesPerStage"] as number;
      if (typeof params["maxEpisodes"] === "number") options.maxEpisodes = params["maxEpisodes"] as number;
      if (typeof params["maxMinutes"] === "number") options.maxMinutes = params["maxMinutes"] as number;
      if (typeof params["fresh"] === "boolean") options.fresh = params["fresh"] as boolean;
      const result = await commands.startTraining(options);
      return {
        ok: result.ok,
        message: result.message,
        failureCode: result.ok ? null : "TRAINING_START_REFUSED",
        failureMessage: result.ok ? null : result.message,
      };
    },
  });
  const trainingDelegate = (
    id: string,
    title: string,
    description: string,
    call: (commands: ControlCenterCommands) => Promise<{ ok: boolean; message: string }> | { ok: boolean; message: string },
  ): void => {
    registry.register({
      meta: { id, category: "Learning & Memory", title, description, status: "implemented", statusReason: null, requiresConnection: false, params: [] },
      requiresTraining: true,
      handler: async (_params, ctx) => {
        const commands = ctx.hostCommands;
        if (!commands) {
          return { ok: false, message: "Training is not available in this host.", failureCode: "TRAINING_MISSING" };
        }
        const result = await call(commands);
        return {
          ok: result.ok,
          message: result.message,
          failureCode: result.ok ? null : "TRAINING_REFUSED",
          failureMessage: result.ok ? null : result.message,
        };
      },
    });
  };
  trainingDelegate(
    "learn.training-pause",
    "Pause training",
    "Pauses training after the current episode. Same control as the Training panel.",
    (commands) => commands.pauseTraining?.() ?? { ok: false, message: "Training is not available in this host." },
  );
  trainingDelegate(
    "learn.training-resume",
    "Resume training",
    "Resumes paused or interrupted training. Same control as the Training panel.",
    (commands) => commands.resumeTraining?.() ?? { ok: false, message: "Training is not available in this host." },
  );
  trainingDelegate(
    "learn.training-stop",
    "Stop training",
    "Stops training after the current episode. Same control as the Training panel.",
    (commands) => commands.stopTraining?.() ?? { ok: false, message: "Training is not available in this host." },
  );
  trainingDelegate(
    "learn.training-evaluate",
    "Evaluate latest checkpoint",
    "Evaluates the latest training checkpoint on held-out seeds. Same control as the Training panel.",
    (commands) => commands.evaluateTraining?.() ?? { ok: false, message: "Training is not available in this host." },
  );

  return registry;
}
