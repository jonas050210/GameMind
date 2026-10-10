import * as os from "node:os";
import path from "node:path";

/**
 * Everything that leaves the process for a browser passes through here first. The Control Center is a status
 * surface: it may say *what* happened, but not the operator's home directory, an access token, or the layout of
 * their disk. Redaction is deliberately conservative (it can hide a harmless path) and is applied to free text
 * only; structured values the UI needs verbatim (host names, ports, ids) are never routed through it.
 */

export interface RedactionContext {
  /** The project root; paths inside it are shown relative to it. */
  readonly root: string;
  readonly home: string | null;
  /** Exact secret strings (for example this server's control token) that must never appear in output. */
  readonly secrets: readonly string[];
}

export function defaultRedactionContext(root: string, secrets: readonly string[] = []): RedactionContext {
  let home: string | null = null;
  try {
    home = os.homedir() || null;
  } catch {
    home = null;
  }
  return { root: path.resolve(root), home, secrets: secrets.filter((secret) => secret.length >= 6) };
}

const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b((?:(?:access|refresh|id|auth|session|api)[_-]?)?token|x-gamemind-token|authorization|password|passwd|secret|client[_-]?secret)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

const POSIX_ABSOLUTE = /(?<![\w./~-])\/(?:[A-Za-z0-9_.@+-]+\/){1,}[A-Za-z0-9_.@+ -]*[A-Za-z0-9_.@+-]/g;
const WINDOWS_ABSOLUTE = /\b[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]*/g;
const UNC_ABSOLUTE = /\\\\[A-Za-z0-9_.-]+\\[^\s"']+/g;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Redacts one string. Idempotent: running it twice gives the same text. */
export function redactText(input: string, context: RedactionContext): string {
  let text = input;
  for (const secret of context.secrets) {
    text = text.split(secret).join("[redacted]");
  }
  for (const pattern of TOKEN_PATTERNS) {
    text = text.replace(pattern, (match, label: string | undefined, separator: string | undefined) =>
      typeof label === "string" && typeof separator === "string" ? `${label}${separator}[redacted]` : label === "Bearer" || /^bearer/i.test(match) ? "Bearer [redacted]" : "[redacted]");
  }
  // Project paths become project-relative; the home directory becomes "~"; any other absolute path keeps only
  // its last two segments, which is enough to recognise a file without revealing where it lives.
  const root = context.root;
  if (root.length > 1) {
    text = text.replace(new RegExp(`${escapeForRegExp(root)}(?:[\\\\/]+)?`, "g"), "");
  }
  if (context.home && context.home.length > 1) {
    text = text.replace(new RegExp(escapeForRegExp(context.home), "g"), "~");
  }
  text = text.replace(WINDOWS_ABSOLUTE, (match) => tail(match.split(/[\\/]+/)));
  text = text.replace(UNC_ABSOLUTE, (match) => tail(match.split(/\\+/)));
  text = text.replace(POSIX_ABSOLUTE, (match) => tail(match.split("/")));
  return text;
}

function tail(segments: readonly string[]): string {
  const meaningful = segments.filter((segment) => segment.length > 0 && !/^[A-Za-z]:$/.test(segment));
  return `…/${meaningful.slice(-2).join("/")}`;
}

/** Shows a filesystem location without leaking its parents: project-relative when inside the root, else `…/last/two`. */
export function displayPath(target: string | null | undefined, context: RedactionContext): string | null {
  if (!target) return null;
  const absolute = path.resolve(target);
  const relative = path.relative(context.root, absolute);
  if (relative.length === 0) return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  return tail(absolute.split(/[\\/]+/));
}

/** Redacts every string inside a JSON-like value (used for event data and job output). */
export function redactDeep<T>(value: T, context: RedactionContext, depth = 0): T {
  if (typeof value === "string") return redactText(value, context) as unknown as T;
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, context, depth + 1)) as unknown as T;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = /token|password|secret|authorization/i.test(key) ? "[redacted]" : redactDeep(item, context, depth + 1);
  }
  return output as T;
}

/**
 * Redacts every string value inside a JSON-like structure, leaving keys and non-strings alone. This is the last gate
 * before a snapshot or a query result leaves the process: a path or a token that slipped into an error message, a report
 * location or a job's output is rewritten here even if the code that produced it did not think about it. Strings with
 * no path separator and no credential-looking text are returned untouched without running any pattern.
 */
export function redactStrings<T>(value: T, context: RedactionContext, depth = 0): T {
  if (typeof value === "string") {
    return (/[\\/]|token|bearer|secret|password/i.test(value) ? redactText(value, context) : value) as unknown as T;
  }
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, context, depth + 1)) as unknown as T;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[key] = redactStrings(item, context, depth + 1);
  return output as T;
}
