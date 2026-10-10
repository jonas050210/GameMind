/*
  Pure decisions used by the Control Center page. They have no DOM access, so the same functions are
  imported by the page (app.js) and by the Node tests.
*/

export const HEADLESS_STORAGE_KEY = "gamemind-headless-training";

/** Headless is the default: training should not cost browser rendering unless the operator asks for it. */
export function parseHeadless(stored) {
  return stored === null || stored === undefined ? true : stored !== "0";
}

export function isTrainingActive(training) {
  return !!training && (training.status === "running" || training.status === "paused" || training.status === "evaluating");
}

/**
 * True when the browser should stop drawing the 3D world. It applies only while headless training is actually
 * running: the agent's own view is unaffected otherwise, and nothing is hidden while the flag is off.
 */
export function renderingSuspended(snapshot, headless) {
  return headless === true && isTrainingActive(snapshot?.training ?? null);
}

export const ROADMAP_CATEGORY_ORDER = [
  "reliability",
  "autonomy",
  "survival",
  "navigation",
  "observation",
  "performance",
  "training",
  "world-knowledge",
  "interface",
];

export const ROADMAP_KIND_LABELS = {
  defect: "Defect",
  hypothesis: "Hypothesis",
  "known-limitation": "Known limitation",
  idea: "Idea",
};

export const ROADMAP_STATUS_LABELS = {
  proposed: "Proposed",
  planned: "Planned",
  "in-progress": "In progress",
  implemented: "Implemented",
  verified: "Verified",
  blocked: "Blocked",
  dismissed: "Dismissed",
};

/** Items the operator has set aside. They are hidden unless the operator asks to see them. */
export function isClosed(item) {
  return item.status === "dismissed" || item.status === "verified";
}

export function filterRoadmap(items, { category = "", kind = "", showClosed = false } = {}) {
  return items.filter((item) => {
    if (!showClosed && isClosed(item)) return false;
    if (category && item.category !== category) return false;
    if (kind && item.kind !== kind) return false;
    return true;
  });
}

/** Groups items by category in a fixed order, keeping the score order inside each group. */
export function groupByCategory(items) {
  const groups = new Map();
  for (const category of ROADMAP_CATEGORY_ORDER) groups.set(category, []);
  for (const item of items) {
    const list = groups.get(item.category) ?? [];
    list.push(item);
    groups.set(item.category, list);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 0);
}

/**
 * The operator actions offered for an item. Each one maps to a roadmap action on the server. Only actions
 * that make sense for the current status are offered, so a settled item cannot be "started" by mistake.
 */
export function roadmapActionsFor(item) {
  switch (item.status) {
    case "proposed":
      return ["plan", "start", "implement", "block", "dismiss"];
    case "planned":
      return ["start", "implement", "block", "dismiss"];
    case "in-progress":
      return ["implement", "block", "dismiss"];
    case "implemented":
      return ["dismiss"];
    case "blocked":
      return ["restore", "dismiss"];
    case "dismissed":
      return ["restore"];
    case "verified":
      return [];
    default:
      return [];
  }
}

export const ROADMAP_ACTION_LABELS = {
  plan: "Plan",
  start: "Start",
  implement: "Mark implemented",
  block: "Block",
  dismiss: "Dismiss",
  restore: "Restore",
};

/** Actions that ask for an optional reason, which is saved in the item's history. */
export const ROADMAP_ACTIONS_WITH_NOTE = new Set(["block", "dismiss", "implement"]);
