/**
 * Companion modes and homepoint naming shared by the controller and its persistent memory.
 *
 * This module intentionally contains no chat parsing. All companion control reaches the
 * controller through the structured Library API (see library.ts) and the Control Center.
 */

export const companionModes = [
  "idle",
  "follow",
  "come",
  "hold",
  "combat",
  "afk",
  "guard",
  "return",
  "explore",
  "unstuck",
  "task",
] as const;

export type CompanionMode = (typeof companionModes)[number];

/** Homepoint names: lowercase, start with a letter, 1-32 chars of letters/numbers/_/-. */
export const homepointNamePattern = /^[a-z][a-z0-9_-]{0,31}$/;

export function normalizeHomepointName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const name = raw.trim().toLowerCase();
  return homepointNamePattern.test(name) ? name : null;
}
