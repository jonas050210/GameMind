// Pure formatting helpers. Every one of them accepts "no value" and answers with a visible "unknown" marker, because a missing
// measurement must never be shown as a zero.

export const UNKNOWN = "unknown";

/** @param {any} value @returns {boolean} */
export function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {any} value @param {(value: any) => any} [format] @returns {any} */
export function orUnknown(value, format = String) {
  return value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value)) ? UNKNOWN : format(value);
}

/** @param {any} value @param {number} [digits] @returns {any} */
export function fmtNumber(value, digits = 0) {
  return isNumber(value) ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : UNKNOWN;
}

/** @param {any} rate @param {number} [digits] @returns {any} */
export function fmtPercent(rate, digits = 1) {
  return isNumber(rate) ? `${(rate * 100).toFixed(digits)}%` : UNKNOWN;
}

/** @param {any} value @param {number} [digits] @param {string} [suffix] @returns {any} */
export function fmtSigned(value, digits = 1, suffix = "") {
  if (!isNumber(value)) return UNKNOWN;
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${sign}${Math.abs(value).toFixed(digits)}${suffix}`;
}

/** @param {any} ms @returns {any} */
export function fmtDuration(ms) {
  if (!isNumber(ms) || ms < 0) return UNKNOWN;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return `${Math.round(ms)} ms`;
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** @param {any} bytes @returns {any} */
export function fmtBytes(bytes) {
  if (!isNumber(bytes) || bytes < 0) return UNKNOWN;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** @param {any} iso @returns {number | null} */
function parse(iso) {
  const ms = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** @param {any} iso @returns {any} */
export function fmtTime(iso) {
  const ms = parse(iso);
  if (ms === null) return UNKNOWN;
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

/** @param {any} iso @returns {any} */
export function fmtDateTime(iso) {
  const ms = parse(iso);
  if (ms === null) return UNKNOWN;
  const date = new Date(ms);
  return `${date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} ${date.toLocaleTimeString("en-GB", { hour12: false })}`;
}

/** @param {any} iso @param {number} [now] @returns {any} */
export function fmtAgo(iso, now = Date.now()) {
  const ms = parse(iso);
  if (ms === null) return UNKNOWN;
  const delta = Math.max(0, now - ms);
  if (delta < 5_000) return "just now";
  return `${fmtDuration(delta)} ago`;
}

/** @param {any} count @param {string} one @param {string} [many] @returns {any} */
export function plural(count, one, many = `${one}s`) {
  return `${fmtNumber(count)} ${count === 1 ? one : many}`;
}

/** "oak_log" -> "oak log": names as people say them. */
/** @param {any} name @returns {any} */
export function humanise(name) {
  return typeof name === "string" && name.length > 0 ? name.replace(/[_-]+/g, " ") : UNKNOWN;
}

/** @param {any} value @param {any} max @returns {number | null} */
export function clampPercent(value, max) {
  if (!isNumber(value) || !isNumber(max) || max <= 0) return null;
  return Math.max(0, Math.min(100, (value / max) * 100));
}
