/**
 * The canonical live-test protocol for an operator sitting in Minecraft.
 *
 * `live-verifier.ts` checks what a machine can check by connecting to a server. Most of what the agent is
 * supposed to do for its operator cannot be checked that way: it needs a person in the game typing the
 * commands and watching what happens. This module is the fixed list of those steps, the format their results
 * are written in, and the rules that decide whether a written result counts.
 *
 * The rule that matters most: a step is `verified` only when the expected thing was *observed*, and every
 * value the step asks for was written down. "I sent the command" is not a result - that is how LIVE_FINDINGS.md
 * §5 ended up reporting a flying-squid stand-in as live evidence.
 */
import { z } from "zod";

export type ProtocolGroup = "chat" | "combat" | "survival" | "shelter" | "metrics";

export interface ProtocolStep {
  readonly id: string;
  readonly group: ProtocolGroup;
  readonly title: string;
  /** What has to be true before the step means anything. */
  readonly precondition: string;
  /** The exact chat line or command. Empty when the step is only an observation. */
  readonly input: string;
  /** What the operator has to see for this to count. */
  readonly expected: string;
  /** Values that must be written down. A `verified` step without them is a claim without evidence. */
  readonly evidence: readonly string[];
  /** True when the step changes the world, so it belongs on a disposable server. */
  readonly destructive: boolean;
  /** True when the step needs combat armed (`--allow-combat` or the Control Center switch). */
  readonly requiresCombat: boolean;
}

export const OPERATOR_PROTOCOL_STEPS: readonly ProtocolStep[] = [
  {
    id: "chat-help",
    group: "chat",
    title: "Help answers at once",
    precondition: "The bot is connected and you are the configured operator (MINECRAFT_OPERATOR, exact name).",
    input: "hilfe",
    expected: "One readable chat line per command group, within about a second.",
    evidence: ["secondsToReply"],
    destructive: false,
    requiresCombat: false,
  },
  {
    id: "chat-suggestion",
    group: "chat",
    title: "A typo asks instead of acting",
    precondition: "No task is running.",
    input: "sttaus",
    expected: "The bot asks 'Meintest du „status“?' and runs nothing. No mode change, no task.",
    evidence: [],
    destructive: false,
    requiresCombat: false,
  },
  {
    id: "chat-status-while-busy",
    group: "chat",
    title: "Status is not queued behind work",
    precondition: "Send 'hol noch 5 diamanten' first and do not wait for it to finish.",
    input: "status",
    expected: "The answer arrives immediately, while the order is still running, and names the active order.",
    evidence: ["secondsToReply"],
    destructive: false,
    requiresCombat: false,
  },
  {
    id: "chat-come-while-busy",
    group: "chat",
    title: "'komm' beats an order that is already queued",
    precondition: "Send 'hol noch 5 diamanten' first; the bot is still preparing or gathering.",
    input: "komm",
    expected:
      "The bot starts coming to you at once. If its order was not started yet it says so ('nicht gestartet') instead of quietly walking off to gather afterwards.",
    evidence: ["secondsToCome", "saidOrderNotStarted"],
    destructive: false,
    requiresCombat: false,
  },
  {
    id: "chat-follow-distance",
    group: "chat",
    title: "Follow keeps a measured distance",
    precondition: "You are within about 30 blocks and visible to the bot.",
    input: "folge mir",
    expected: "It follows while you walk about 20 blocks, stays near its preferred distance and does not drift away.",
    evidence: ["maxDistanceBlocks"],
    destructive: false,
    requiresCombat: false,
  },
  {
    id: "chat-stop-holds",
    group: "chat",
    title: "Stop means stop",
    precondition: "A task is running.",
    input: "stopp",
    expected: "The task ends, the bot holds its position and starts nothing new on its own.",
    evidence: ["secondsToStop", "newTaskStarted"],
    destructive: false,
    requiresCombat: false,
  },
  {
    id: "chat-latency-panel",
    group: "chat",
    title: "Response times are measured, not guessed",
    precondition: "The Control Center is running and at least ten chat messages have been answered.",
    input: "",
    expected:
      "Bots tab, 'Chat response' card: queue wait, handling, first reply and helper model as p95 against their targets, plus answered/dropped/abandoned counts. The log has one 'Minecraft chat latency' line per answer.",
    evidence: ["firstReplyP95Ms", "queueWaitP95Ms", "messagesAnswered"],
    destructive: false,
    requiresCombat: false,
  },
  {
    id: "chat-still-answers-later",
    group: "chat",
    title: "The chat does not stop answering",
    precondition: "A normal session of at least ten minutes with mixed commands, tasks and questions.",
    input: "status",
    expected:
      "The last message of the session is answered. If it is not, write down the last command before the silence and how long you waited - that is the recording the chat-hang hypothesis still needs.",
    evidence: ["commandsSent", "secondsToReply", "silenceObserved"],
    destructive: false,
    requiresCombat: false,
  },
  {
    id: "food-raw-meat",
    group: "survival",
    title: "Raw meat is food",
    precondition: "Hunger at 14 or below, raw beef/chicken/porkchop/mutton/rabbit in the inventory or on the ground nearby, no hostile close.",
    input: "",
    expected:
      "The bot eats the raw meat and hunger rises. Rotten flesh is never eaten. Raw chicken is eaten only when nothing else is available.",
    evidence: ["hungerBefore", "hungerAfter", "itemEaten"],
    destructive: false,
    requiresCombat: false,
  },
  {
    id: "combat-opt-in-kills",
    group: "combat",
    title: "An armed fight is finished",
    precondition: "Combat armed (--allow-combat or the Control Center switch), a sword in the inventory, one zombie within about 8 blocks, health above 14.",
    input: "",
    expected:
      "The bot equips the carried sword, fights within the weapon's cooldown and the zombie dies. It does not start a fight at health 14 or below, and never attacks a second hostile while one is engaged.",
    evidence: ["combatArmed", "healthBefore", "healthAfter", "hostileDied", "secondsToKill"],
    destructive: true,
    requiresCombat: true,
  },
  {
    id: "combat-denied-by-default",
    group: "combat",
    title: "Without the opt-in it never swings",
    precondition: "Combat NOT armed, a hostile within about 8 blocks, a sword in the inventory.",
    input: "",
    expected: "No attack at all. It keeps away or shelters; the decision ledger says combat is not enabled.",
    evidence: ["attacksObserved"],
    destructive: false,
    requiresCombat: false,
  },
  {
    id: "combat-creeper-avoided",
    group: "combat",
    title: "A creeper is never engaged",
    precondition: "Combat armed, a sword carried, a creeper within about 6 blocks and no other hostile.",
    input: "",
    expected: "No swing at the creeper; the bot puts distance between you and it. Enderman behave the same way.",
    evidence: ["combatArmed", "attacksObserved", "minDistanceBlocks"],
    destructive: false,
    requiresCombat: true,
  },
  {
    id: "shelter-seals-at-night",
    group: "shelter",
    title: "Shelter is closed before night",
    precondition: "Short of dusk, enough blocks in the inventory, flat ground.",
    input: "baue ein shelter",
    expected:
      "It builds and closes the sides before full dark, and reports honestly when it runs out of blocks or time instead of claiming a sealed shelter.",
    evidence: ["sidesClosed", "blocksPlaced", "sealedBeforeDark"],
    destructive: true,
    requiresCombat: false,
  },
  {
    id: "shelter-breaks-out",
    group: "shelter",
    title: "A sealed shelter can be left",
    precondition: "The bot is inside a shelter it sealed itself, so every exit is blocked by its own blocks.",
    input: "komm",
    expected:
      "It digs its own blocks out and reaches you, rather than standing in a sealed box. Write down how many blocks it broke and how long it took.",
    evidence: ["blocksBroken", "secondsToExit", "reachedOperator"],
    destructive: true,
    requiresCombat: false,
  },
  {
    id: "metrics-loop-targets",
    group: "metrics",
    title: "The loop meets its timing targets",
    precondition: "The Control Center is running and the session has been active for at least two minutes.",
    input: "",
    expected:
      "Bots tab, 'Agent loop' card: observation rate, observation age and the p95 targets, each marked met or missed. A missed target is a result to write down, not something to retry until it passes.",
    evidence: ["observationAgeMs", "decisionP95Ms", "reactionP95Ms"],
    destructive: false,
    requiresCombat: false,
  },
] as const;

export const PROTOCOL_OUTCOMES = ["pending", "verified", "failed", "skipped"] as const;

export const protocolStepResultSchema = z.object({
  id: z.string(),
  outcome: z.enum(PROTOCOL_OUTCOMES),
  /** What the operator actually saw. Required for every outcome except pending. */
  observed: z.string().default(""),
  /** The values this step asks for, by the names in `evidence`. */
  values: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  skippedReason: z.string().optional(),
});

export const protocolResultSchema = z.object({
  schemaVersion: z.literal(1),
  /** Which server this was, so a result is never read as 'live' in general. */
  server: z.string().min(1),
  serverVersion: z.string().min(1),
  /** The in-game name that issued the commands. */
  operator: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  steps: z.array(protocolStepResultSchema),
});

export type ProtocolResult = z.infer<typeof protocolResultSchema>;
export type ProtocolStepResult = z.infer<typeof protocolStepResultSchema>;

export interface ProtocolProblem {
  readonly stepId: string | null;
  readonly problem: string;
}

export interface ProtocolVerdict {
  readonly ok: boolean;
  readonly steps: number;
  readonly verified: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pending: number;
  readonly problems: readonly ProtocolProblem[];
}

/** An empty result file with every step listed, ready to be filled in during the session. */
export function protocolTemplate(server: string, operator: string, at = new Date()): ProtocolResult {
  const iso = at.toISOString();
  return {
    schemaVersion: 1,
    server,
    serverVersion: "1.20.4",
    operator,
    startedAt: iso,
    finishedAt: iso,
    steps: OPERATOR_PROTOCOL_STEPS.map((step) => ({ id: step.id, outcome: "pending" as const, observed: "", values: {} })),
  };
}

function valueIsMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (typeof value === "number") return !Number.isFinite(value);
  return false;
}

/**
 * Judges a filled-in result file. It is deliberately strict about one thing: a step may not claim `verified`
 * without the observation and the values it asks for. Everything else is reported, not enforced - a session
 * where half the steps failed is a useful result, a session where they are all 'verified' with nothing written
 * down is not.
 */
export function judgeProtocolResult(result: ProtocolResult): ProtocolVerdict {
  const problems: ProtocolProblem[] = [];
  const byId = new Map(result.steps.map((step) => [step.id, step]));

  for (const step of OPERATOR_PROTOCOL_STEPS) {
    if (!byId.has(step.id)) problems.push({ stepId: step.id, problem: "missing from the result file" });
  }
  for (const step of result.steps) {
    if (!OPERATOR_PROTOCOL_STEPS.some((known) => known.id === step.id)) {
      problems.push({ stepId: step.id, problem: "is not a step of this protocol" });
    }
  }

  let verified = 0;
  let failed = 0;
  let skipped = 0;
  let pending = 0;

  for (const step of result.steps) {
    const catalog = OPERATOR_PROTOCOL_STEPS.find((known) => known.id === step.id);
    if (!catalog) continue;
    if (step.outcome === "verified") verified += 1;
    else if (step.outcome === "failed") failed += 1;
    else if (step.outcome === "skipped") skipped += 1;
    else pending += 1;

    if (step.outcome === "pending") {
      problems.push({ stepId: step.id, problem: "is still pending: no outcome was recorded" });
      continue;
    }
    if (step.observed.trim().length === 0) {
      problems.push({ stepId: step.id, problem: `is '${step.outcome}' but nothing was written down as observed` });
    }
    if (step.outcome === "skipped" && (step.skippedReason ?? "").trim().length === 0) {
      problems.push({ stepId: step.id, problem: "was skipped without a reason" });
    }
    if (step.outcome === "verified") {
      for (const field of catalog.evidence) {
        if (valueIsMissing(step.values[field])) {
          problems.push({ stepId: step.id, problem: `is verified without the value '${field}'` });
        }
      }
    }
  }

  return {
    ok: problems.length === 0,
    steps: OPERATOR_PROTOCOL_STEPS.length,
    verified,
    failed,
    skipped,
    pending,
    problems,
  };
}

/** Parses a file's content, reporting why it is not a protocol result instead of throwing. */
export function parseProtocolResult(text: string): { result: ProtocolResult | null; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { result: null, error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const checked = protocolResultSchema.safeParse(parsed);
  if (!checked.success) {
    const first = checked.error.issues[0];
    return { result: null, error: `not a protocol result: ${first?.path.join(".") ?? "?"} ${first?.message ?? "is wrong"}` };
  }
  return { result: checked.data, error: null };
}

/** The checklist an operator reads before starting, grouped the way the session runs. */
export function describeProtocol(): string[] {
  const lines: string[] = [
    "GameMind live protocol - 15 steps, one operator, one session.",
    "",
    "Write every result into the file as you go: npm run protocol -- template data/live/protocol.json",
    "A step counts as verified only with what you saw and the values it asks for.",
    "",
  ];
  const groups: ProtocolGroup[] = ["chat", "combat", "survival", "shelter", "metrics"];
  for (const group of groups) {
    const steps = OPERATOR_PROTOCOL_STEPS.filter((step) => step.group === group);
    if (steps.length === 0) continue;
    lines.push(`## ${group.toUpperCase()}`);
    for (const step of steps) {
      const flags = [step.destructive ? "changes the world" : null, step.requiresCombat ? "needs combat armed" : null]
        .filter((flag): flag is string => flag !== null);
      lines.push(`- ${step.id}: ${step.title}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`);
      lines.push(`  before: ${step.precondition}`);
      if (step.input.length > 0) lines.push(`  say: ${step.input}`);
      lines.push(`  expect: ${step.expected}`);
      lines.push(`  write down: ${step.evidence.length > 0 ? step.evidence.join(", ") : "what you saw"}`);
    }
    lines.push("");
  }
  return lines;
}
