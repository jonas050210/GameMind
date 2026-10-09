/**
 * Reading the *live* Minecraft session facts the Control Center and the planner depend on: dimension,
 * game mode, vitals and the day cycle.
 *
 * Why this exists as its own module: every one of these facts comes out of Mineflayer in a shape that
 * depends on the protocol version, on the server implementation (vanilla, Paper, a proxy) and on which
 * packet last touched the field. Reading `bot.game.gameMode` directly and comparing it with `"survival"`
 * is what made a survival world look like Creative and an overworld look like "not the overworld", which
 * in turn blocked every task skill. The functions here accept every shape Mineflayer is known to
 * produce, say explicitly when nothing was observed, and never invent a value.
 *
 * The module is deliberately independent of the `mineflayer` types: it takes a structural description of
 * a bot, so it can be tested against the shapes a real 1.20.4 session produces as well as against
 * degenerate ones (missing fields, numeric ids, namespaced identifiers, disagreeing sources).
 */

/** The Java Edition game modes the agent distinguishes. `hardcore` is survival with permadeath. */
export type MinecraftGameMode = "survival" | "hardcore" | "creative" | "adventure" | "spectator";

/** How a value relates to the live session that produced it. */
export type SessionEvidence =
  /** Two or more independent live sources reported the same value. */
  | "verified"
  /** Exactly one live source reported a value; nothing contradicts it. */
  | "single-source"
  /** The live session reported nothing usable for this field. */
  | "unreported"
  /** The live sources disagree, so no single value can be claimed. */
  | "conflicting";

export interface SessionField<T> {
  readonly value: T | null;
  readonly evidence: SessionEvidence;
  /** Short, human-readable account of where the value came from (or why there is none). */
  readonly source: string;
  /** The raw values that were read, formatted for a log line or a dashboard tooltip. */
  readonly observed: string;
  /** Extra explanation for a conflict or an unmapped value; null when nothing needs explaining. */
  readonly note: string | null;
}

/** A bot-like object: only the fields this module reads are required. */
export interface LiveBotLike {
  readonly game?: unknown;
  readonly player?: unknown;
  readonly health?: unknown;
  readonly food?: unknown;
  readonly foodSaturation?: unknown;
  readonly oxygenLevel?: unknown;
  readonly isAlive?: unknown;
  readonly time?: unknown;
  readonly entity?: unknown;
  readonly registry?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Compact rendering of a raw value for logs and tooltips, without leaking whole objects. */
function describeRaw(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return String(value);
  }
  return Array.isArray(value) ? "array" : typeof value;
}

const DIMENSION_BY_ID: Readonly<Record<number, string>> = {
  [-1]: "the_nether",
  0: "overworld",
  1: "the_end",
};

/**
 * Dimension names as the vanilla registry spells them, plus the level names a Bukkit/Spigot/Paper
 * server (or a proxy) can report instead. Matching is on the lowercased, `minecraft:`-stripped name.
 * Anything not listed here is *not* guessed at: it is reported as a named dimension the agent does not
 * recognise, which is a different statement from "this is not the overworld".
 */
const DIMENSION_ALIASES: Readonly<Record<string, string>> = {
  overworld: "overworld",
  world: "overworld",
  minecraft_overworld: "overworld",
  the_nether: "the_nether",
  nether: "the_nether",
  dim_minus_1: "the_nether",
  dim_1_minus: "the_nether",
  the_end: "the_end",
  end: "the_end",
  dim_1: "the_end",
  the_void: "the_void",
};

function canonicalizeDimensionToken(token: string): string | null {
  const cleaned = token.trim().toLowerCase().replace(/^minecraft:/, "");
  if (cleaned.length === 0) return null;
  const alias = DIMENSION_ALIASES[cleaned.replace(/[^a-z0-9]+/g, "_")];
  if (alias) return alias;
  // A custom world name is still a name the server actually reported; keep it, unrecognised.
  // A namespaced custom dimension (`custom:lobby`, a Bukkit level name) is a real answer: keep it
  // verbatim instead of reporting nothing.
  return /^[a-z0-9_.:/-]+$/.test(cleaned) ? cleaned : null;
}

/**
 * Normalizes whatever the live session reports as a dimension.
 *
 * Accepted shapes: a numeric dimension id (Mineflayer's pre-1.16 mapping and some proxies), an
 * identifier string with or without the `minecraft:` namespace, a world/level name, or nothing at all.
 */
export function normalizeDimension(raw: unknown): SessionField<string> {
  const observed = describeRaw(raw);
  if (typeof raw === "number") {
    const mapped = DIMENSION_BY_ID[raw];
    if (mapped) {
      return {
        value: mapped,
        evidence: "single-source",
        source: "numeric dimension id from the live session",
        observed,
        note: null,
      };
    }
    return {
      value: null,
      evidence: "unreported",
      source: "no usable dimension",
      observed,
      note: `the session reported dimension id ${raw}, which this build does not map to a known dimension`,
    };
  }
  if (typeof raw === "string") {
    const canonical = canonicalizeDimensionToken(raw);
    if (canonical) {
      const known = canonical === "overworld" || canonical === "the_nether" || canonical === "the_end" || canonical === "the_void";
      return {
        value: canonical,
        evidence: "single-source",
        source: known ? "dimension name from the live session" : "unrecognised dimension name from the live session",
        observed,
        note: known ? null : `'${raw}' is not a dimension this agent knows; it is reported as-is, never as the overworld`,
      };
    }
    return {
      value: null,
      evidence: "unreported",
      source: "no usable dimension",
      observed,
      note: `the session reported an empty or unparsable dimension ('${raw}')`,
    };
  }
  return {
    value: null,
    evidence: "unreported",
    source: "no usable dimension",
    observed,
    note: raw === undefined || raw === null
      ? "the live session has not reported a dimension yet"
      : `the live session reported a dimension of an unusable type (${describeRaw(raw)})`,
  };
}

const GAME_MODE_BY_ID: Readonly<Record<number, MinecraftGameMode>> = {
  0: "survival",
  1: "creative",
  2: "adventure",
  3: "spectator",
  4: "hardcore",
};

const GAME_MODE_NAMES: readonly MinecraftGameMode[] = ["survival", "hardcore", "creative", "adventure", "spectator"];

function normalizeGameModeToken(raw: unknown): MinecraftGameMode | null {
  if (typeof raw === "number") {
    const mapped = GAME_MODE_BY_ID[Math.trunc(raw)];
    if (mapped) return mapped;
    // Mineflayer's own `parseGameMode` reads the lower two bits; mirror that only when the extra bits
    // are exactly the hardcore flag, so a garbage number stays unknown instead of becoming Creative.
    if (Number.isInteger(raw) && (raw & 0b100) !== 0) {
      const base = GAME_MODE_BY_ID[raw & 0b11];
      return base === "survival" ? "hardcore" : base ?? null;
    }
    return null;
  }
  if (typeof raw === "string") {
    const cleaned = raw.trim().toLowerCase().replace(/^minecraft:/, "");
    if (cleaned === "survival" || cleaned === "creative" || cleaned === "adventure" || cleaned === "spectator") {
      return cleaned;
    }
    if (cleaned === "hardcore") return "hardcore";
    const numeric = Number(cleaned);
    return Number.isFinite(numeric) ? normalizeGameModeToken(numeric) : null;
  }
  return null;
}

interface GameModeCandidate {
  readonly label: string;
  readonly raw: unknown;
  readonly value: MinecraftGameMode | null;
}

/**
 * Reads the game mode from the live session and cross-checks the sources.
 *
 * Mineflayer keeps the mode in more than one place: `bot.game.gameMode` (set from the login/respawn
 * packet and from `game_state_change`) and `bot.player.gamemode` (a raw id from `player_info`, updated
 * by `update_gamemode`). Either can lag the other after a `/gamemode` change, and on some servers
 * `bot.game.gameMode` never becomes a string at all. Reporting the first one blindly is how a survival
 * world got labelled Creative — so a value is only `verified` when two sources agree, and a conflict is
 * reported as a conflict.
 */
export function readGameMode(bot: LiveBotLike): SessionField<MinecraftGameMode> {
  const game = asRecord(bot.game);
  const player = asRecord(bot.player);
  const candidates: GameModeCandidate[] = [
    { label: "bot.game.gameMode", raw: game?.gameMode, value: normalizeGameModeToken(game?.gameMode) },
    { label: "bot.player.gamemode", raw: player?.gamemode, value: normalizeGameModeToken(player?.gamemode) },
  ];
  const observed = candidates.map((candidate) => `${candidate.label}=${candidate.raw === undefined ? "absent" : describeRaw(candidate.raw)}`).join(", ");
  const resolved = candidates.filter((candidate): candidate is GameModeCandidate & { value: MinecraftGameMode } => candidate.value !== null);
  const hardcore = typeof game?.hardcore === "boolean" ? game.hardcore : null;

  const first = resolved[0]?.value ?? null;
  const agree = resolved.length > 0 && first !== null && resolved.every((candidate) => candidate.value === first);
  if (resolved.length === 0) {
    return {
      value: null,
      evidence: "unreported",
      source: "no usable game mode",
      observed,
      note: "the live session has not reported a game mode this build understands",
    };
  }
  if (!agree) {
    return {
      value: null,
      evidence: "conflicting",
      source: "the live sources disagree",
      observed,
      note: `the session reported ${resolved.map((candidate) => `${candidate.value} (${candidate.label})`).join(" and ")}; no single game mode can be claimed`,
    };
  }
  let value = first as MinecraftGameMode;
  let note: string | null = null;
  if (value === "survival" && hardcore === true) {
    value = "hardcore";
    note = "the session flagged the world as hardcore, so survival is treated as hardcore";
  }
  const extraDisagreement = candidates.length - resolved.length;
  return {
    value,
    evidence: resolved.length > 1 ? "verified" : "single-source",
    source: resolved.map((candidate) => candidate.label).join(" + "),
    observed,
    note: note ?? (extraDisagreement > 0 && resolved.length === 1
      ? `only one live source reported a game mode (${extraDisagreement} reported nothing usable)`
      : null),
  };
}

/** Reads the dimension from the live session, including the world-name fallback some servers need. */
export function readDimension(bot: LiveBotLike): SessionField<string> {
  const game = asRecord(bot.game);
  const primary = normalizeDimension(game?.dimension);
  if (primary.value !== null) return primary;
  const observed = `bot.game.dimension=${describeRaw(game?.dimension)}`;
  return { ...primary, observed, source: primary.source };
}

export interface LiveVitals {
  readonly health: number | null;
  readonly food: number | null;
  readonly foodSaturation: number | null;
  /** Null when the session cannot prove it; never inferred from a default. */
  readonly alive: boolean | null;
  /** Air in ticks (0-300). Null when the session has not reported an air supply at all. */
  readonly airTicks: number | null;
  /** How the air value was obtained, so the dashboard can say "unreported" instead of "full lungs". */
  readonly airEvidence: SessionEvidence;
  readonly healthObserved: string;
}

/**
 * Vitals as the live session reports them.
 *
 * Mineflayer only assigns `bot.health`, `bot.food` and `bot.foodSaturation` from an `update_health`
 * packet, so before the first one they are `undefined`; `bot.oxygenLevel` is `air_supply / 15`, i.e. a
 * 0-20 gauge in 1.20.4 (not 0-10 as Mineflayer's docs still claim), and it stays `undefined` until the
 * player's entity metadata carries an air supply. Each of these is reported as null when absent — a
 * default that reads as a real value is how a drowning agent gets told its lungs are full.
 */
export function readVitals(bot: LiveBotLike): LiveVitals {
  const health = numberOrNull(bot.health);
  const food = numberOrNull(bot.food);
  const saturation = numberOrNull(bot.foodSaturation);
  const isAlive = typeof bot.isAlive === "boolean" ? bot.isAlive : null;
  const airTicks = airTicksFromSession(bot.oxygenLevel);
  return {
    health,
    food,
    foodSaturation: saturation,
    // Alive is proven by the session's own life flag; otherwise it follows from an *observed* health
    // value. With neither, it is unknown rather than "dead".
    alive: isAlive ?? (health === null ? null : health > 0),
    airTicks: airTicks.value,
    airEvidence: airTicks.evidence,
    healthObserved: `health=${describeRaw(bot.health)}, food=${describeRaw(bot.food)}, saturation=${describeRaw(bot.foodSaturation)}, isAlive=${describeRaw(bot.isAlive)}, oxygenLevel=${describeRaw(bot.oxygenLevel)}`,
  };
}

/**
 * Converts Mineflayer's air gauge into the air ticks the observation contract speaks.
 *
 * `bot.oxygenLevel` is `Math.round(air_supply / 15)` — a 0..20 gauge, *not* the 0..10 the older docs
 * describe, and not a tick count. Treating it as ticks (which the adapter used to do by multiplying by 30
 * and clamping) made the gauge read "full lungs" for every value at or above 10, so the drowning guard
 * never fired while the player was actually losing air.
 */
export function airTicksFromSession(level: unknown): { value: number | null; evidence: SessionEvidence } {
  const value = numberOrNull(level);
  // Negative is how Mineflayer reports "head not submerged / no air metadata at all", not a partial gauge.
  if (value === null || value < 0) return { value: null, evidence: "unreported" };
  return { value: Math.max(0, Math.min(300, Math.round(value * 15))), evidence: "single-source" };
}

/** Day-cycle facts, or null when the session has not sent any time packet yet. */
/**
 * Reads the day cycle from the live session, or null when the session has not sent an `update_time`.
 *
 * Mineflayer sets `bot.time.timeOfDay = time % 24000`, which is already a **tick** count; it is not the
 * 0..1 fraction its documentation sometimes implies. Scaling it by 24000 — which the adapter used to do —
 * pins every day value to the top of the range, so the run believed it was permanently just before
 * sunset. A value that is genuinely a fraction (below 1 and non-zero) is still recognised.
 */
export function readTimeInfo(bot: LiveBotLike): { dayTicks: number | null; day: number | null; isNight: boolean; source: string } | null {
  const time = asRecord(bot.time);
  if (!time) return null;
  const rawTicks = numberOrNull(time.timeOfDay);
  const dayTicks = rawTicks === null
    ? null
    : rawTicks > 0 && rawTicks < 1
      ? Math.round(rawTicks * 24_000)
      : Math.min(23_999, Math.max(0, Math.round(rawTicks)));
  const day = numberOrNull(time.day);
  const isDay = typeof time.isDay === "boolean" ? time.isDay : null;
  if (dayTicks === null && isDay === null) return null;
  const derivedNight = dayTicks === null ? false : dayTicks >= 13_000 && dayTicks < 23_000;
  return {
    dayTicks,
    day: day === null ? null : Math.max(0, Math.trunc(day)),
    isNight: isDay === null ? derivedNight : !isDay,
    source: dayTicks === null ? "time.isDay" : isDay === null ? "time.timeOfDay" : "time.timeOfDay + time.isDay",
  };
}

export function isSurvivalLike(mode: string | null): boolean {
  return mode === "survival" || mode === "hardcore";
}

/**
 * True only when the session positively reported a dimension other than the overworld. An unreported or
 * unrecognised dimension is not evidence of "not the overworld", and must not block overworld work.
 */
export function dimensionDefinitelyNotOverworld(field: SessionField<string>): boolean {
  return field.value !== null && field.value !== "overworld";
}

/** True only when the session positively reported a non-survival mode. */
export function gameModeDefinitelyNotSurvival(field: SessionField<MinecraftGameMode>): boolean {
  return field.value !== null && !isSurvivalLike(field.value);
}

/** The parts of a session field that a description needs, independent of what the value actually is. */
export interface SessionFieldInfo {
  readonly value: unknown;
  readonly evidence: SessionEvidence;
  readonly source: string;
  readonly observed: string;
  readonly note: string | null;
}

/** One-line account of a session field, for traces, log lines and the dashboard. */
export function describeSessionField(field: SessionFieldInfo): string {
  const value = field.value === null ? "unknown" : String(field.value);
  switch (field.evidence) {
    case "verified":
      return `${value} (verified: ${field.source})`;
    case "single-source":
      return `${value} (from ${field.source})`;
    case "conflicting":
      return `unknown (${field.note ?? "the live sources disagree"}; ${field.observed})`;
    case "unreported":
    default:
      return `unknown (${field.note ?? "not reported by the session"}; ${field.observed})`;
  }
}

/** The names this module knows, exported so the UI can validate what it is being shown. */
export const knownMinecraftGameModes = GAME_MODE_NAMES;
