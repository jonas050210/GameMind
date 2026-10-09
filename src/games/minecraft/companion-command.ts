import { minecraftLogNames } from "./capabilities.js";

export const companionModes = ["idle", "follow", "come", "hold", "combat", "afk", "guard", "return", "explore", "unstuck", "task"] as const;
export type CompanionMode = (typeof companionModes)[number];

export type CompanionCommand =
  | { readonly type: "set-mode"; readonly mode: Exclude<CompanionMode, "task" | "idle">; readonly targetPlayer: string | null }
  | { readonly type: "gather"; readonly resource: (typeof minecraftLogNames)[number]; readonly count: number }
  | { readonly type: "build-shelter" }
  | { readonly type: "save-home"; readonly name: string }
  | { readonly type: "go-home"; readonly name: string }
  | { readonly type: "list-homes" }
  | { readonly type: "delete-home"; readonly name: string }
  | { readonly type: "status" }
  | { readonly type: "stop" }
  | { readonly type: "help" };

export interface ParsedCompanionCommand {
  readonly command: CompanionCommand | null;
  readonly normalized: string;
  readonly error: string | null;
  readonly interpretedFromNaturalLanguage: boolean;
}

const logAliases: Readonly<Record<string, (typeof minecraftLogNames)[number]>> = {
  wood: "oak_log",
  log: "oak_log",
  logs: "oak_log",
  oak: "oak_log",
  oak_log: "oak_log",
  birch: "birch_log",
  birch_log: "birch_log",
  spruce: "spruce_log",
  spruce_log: "spruce_log",
  jungle: "jungle_log",
  jungle_log: "jungle_log",
  acacia: "acacia_log",
  acacia_log: "acacia_log",
  dark_oak: "dark_oak_log",
  dark_oak_log: "dark_oak_log",
  mangrove: "mangrove_log",
  mangrove_log: "mangrove_log",
  cherry: "cherry_log",
  cherry_log: "cherry_log",
};

export const homepointNamePattern = /^[a-z][a-z0-9_-]{0,31}$/;

function homepointName(raw: string | undefined): string | null {
  if (!raw) return null;
  const name = raw.toLowerCase();
  return homepointNamePattern.test(name) ? name : null;
}

function failure(normalized: string, error: string): ParsedCompanionCommand {
  return { command: null, normalized, error, interpretedFromNaturalLanguage: false };
}

/** Deterministic, bounded command parsing. It never sends free-form text to an action API. */
export function parseCompanionCommand(input: string, speaker: string | null = null): ParsedCompanionCommand {
  const normalized = input.trim().replace(/\s+/g, " ");
  if (!normalized) return failure(normalized, "Enter a command or request.");
  const lower = normalized.toLowerCase();
  const explicit = lower.startsWith("#");

  if (!explicit) {
    if (/\b(come with me|follow me|stay with me)\b/.test(lower)) {
      return { command: { type: "set-mode", mode: "follow", targetPlayer: speaker }, normalized, error: null, interpretedFromNaturalLanguage: true };
    }
    if (/\b(we need|need|get|gather|find)\b.*\b(wood|logs?)\b/.test(lower)) {
      const countMatch = lower.match(/\b(\d{1,2})\b/);
      const count = countMatch ? Number(countMatch[1]) : 8;
      if (count < 1 || count > 64) return failure(normalized, "Requested wood count must be from 1 through 64.");
      return { command: { type: "gather", resource: "oak_log", count }, normalized, error: null, interpretedFromNaturalLanguage: true };
    }
    if (/\b(help|assist)\b.*\b(build|make)\b.*\b(house|home|shelter)\b|\b(build|make)\b.*\b(house|shelter)\b/.test(lower)) {
      return { command: { type: "build-shelter" }, normalized, error: null, interpretedFromNaturalLanguage: true };
    }
    if (/\b(come here|come to me)\b/.test(lower)) {
      return { command: { type: "set-mode", mode: "come", targetPlayer: speaker }, normalized, error: null, interpretedFromNaturalLanguage: true };
    }
    return failure(normalized, "I could not map that request to a safe capability. Try #help or a more specific request.");
  }

  const [rawVerb = "", ...rawArgs] = normalized.slice(1).split(" ");
  const verb = rawVerb.toLowerCase();
  const args = rawArgs;
  switch (verb) {
    case "follow":
      return { command: { type: "set-mode", mode: "follow", targetPlayer: args[0] ?? speaker }, normalized, error: null, interpretedFromNaturalLanguage: false };
    case "come":
      return { command: { type: "set-mode", mode: "come", targetPlayer: args[0] ?? speaker }, normalized, error: null, interpretedFromNaturalLanguage: false };
    case "hold":
    case "combat":
    case "afk":
    case "guard":
    case "explore":
    case "unstuck":
      return { command: { type: "set-mode", mode: verb, targetPlayer: verb === "afk" ? (args[0] ?? speaker) : null }, normalized, error: null, interpretedFromNaturalLanguage: false };
    case "sethome": {
      const name = homepointName(args[0]);
      if (!name || args.length !== 1) return failure(normalized, "Usage: #sethome <name>. Names must start with a letter and contain only 1–32 lowercase letters, numbers, '_' or '-'.");
      return { command: { type: "save-home", name }, normalized, error: null, interpretedFromNaturalLanguage: false };
    }
    case "home": {
      // Compatibility: the original argument-free #home saves the default homepoint.
      if (!args.length) return { command: { type: "save-home", name: "default" }, normalized, error: null, interpretedFromNaturalLanguage: false };
      const name = homepointName(args[0]);
      if (!name || args.length !== 1) return failure(normalized, "Usage: #home <name>. Use #homes to list saved destinations.");
      return { command: { type: "go-home", name }, normalized, error: null, interpretedFromNaturalLanguage: false };
    }
    case "homes":
      if (args.length) return failure(normalized, "Usage: #homes");
      return { command: { type: "list-homes" }, normalized, error: null, interpretedFromNaturalLanguage: false };
    case "delhome": {
      const name = homepointName(args[0]);
      if (!name || args.length !== 1) return failure(normalized, "Usage: #delhome <name>.");
      return { command: { type: "delete-home", name }, normalized, error: null, interpretedFromNaturalLanguage: false };
    }
    case "return":
      return { command: { type: "set-mode", mode: "return", targetPlayer: null }, normalized, error: null, interpretedFromNaturalLanguage: false };
    case "gather": {
      const alias = (args[0] ?? "").toLowerCase();
      const resource = logAliases[alias];
      if (!resource) return failure(normalized, `Unknown gather resource '${alias || "(missing)"}'. Supported log aliases: ${Object.keys(logAliases).join(", ")}.`);
      const count = args[1] === undefined ? 1 : Number(args[1]);
      if (!Number.isInteger(count) || count < 1 || count > 64) return failure(normalized, "Gather count must be a whole number from 1 through 64.");
      return { command: { type: "gather", resource, count }, normalized, error: null, interpretedFromNaturalLanguage: false };
    }
    case "status":
      return { command: { type: "status" }, normalized, error: null, interpretedFromNaturalLanguage: false };
    case "stop":
      return { command: { type: "stop" }, normalized, error: null, interpretedFromNaturalLanguage: false };
    case "help":
      return { command: { type: "help" }, normalized, error: null, interpretedFromNaturalLanguage: false };
    default:
      return failure(normalized, `Unknown command '#${verb}'. Try #help.`);
  }
}
