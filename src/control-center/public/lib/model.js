// Pure derivations from the snapshot: labels, tones and the "what does this mean" sentences. No DOM here, so Node tests can
// exercise every state the page can be in.
import { UNKNOWN } from "./format.js";

/** How each lifecycle state reads to an operator. `tone` is one of good, info, warn, bad, neutral. */
export const SESSION_STATES = {
  none: { label: "No session", tone: "neutral", meaning: "No Minecraft session has been started in this process yet." },
  connecting: { label: "Connecting", tone: "info", meaning: "Opening the connection to the game." },
  initializing: { label: "Initializing", tone: "info", meaning: "Connected; loading world memory and starting the agent." },
  idle: { label: "Connected · idle", tone: "good", meaning: "The bot is in the world and waiting. It starts nothing unless autonomy is on or you start a task." },
  running: { label: "Running a task", tone: "good", meaning: "The bot is working on a task." },
  reconnecting: { label: "Reconnecting", tone: "warn", meaning: "The connection dropped; GameMind is retrying with increasing delays." },
  stopping: { label: "Stopping", tone: "warn", meaning: "Stopping the running task and disconnecting in order." },
  shutdown: { label: "Disconnected", tone: "bad", meaning: "The session has ended. The Control Center is still running; connect again whenever you like." },
};

export function sessionInfo(session) {
  const state = session?.state ?? "none";
  return { state, ...(SESSION_STATES[state] ?? { label: state, tone: "neutral", meaning: "" }) };
}

/** The data-provenance vocabulary. A value is exactly one of these and says so wherever it appears. */
export const SOURCES = {
  live: { label: "LIVE", tone: "good", title: "Read from a connected Minecraft server." },
  simulated: { label: "SIMULATED", tone: "info", title: "Produced by the offline simulator. No Minecraft server is involved." },
  offline: { label: "OFFLINE", tone: "info", title: "Produced offline (tests or the simulator). Not evidence about a real server." },
  historical: { label: "HISTORICAL", tone: "neutral", title: "Recorded earlier and read from disk. Not current." },
  unavailable: { label: "UNAVAILABLE", tone: "neutral", title: "Nothing has been measured, so there is nothing to show." },
};

/** Which provenance the world data in a snapshot has. */
export function worldSource(snapshot) {
  const session = snapshot?.session;
  if (!session || session.state === "none") return "unavailable";
  const provenance = snapshot?.world?.provenance?.source;
  if (provenance === "simulated" || session.source === "simulated") return "simulated";
  if (provenance === "live-observation" && session.state !== "shutdown") return "live";
  if (session.state === "shutdown") return "historical";
  return provenance === "world-memory" ? "historical" : "unavailable";
}

/** Label and tone for a task or job status. PASS/FAIL/SKIPPED come from the measured result only. */
export function statusInfo(status) {
  switch (status) {
    case "succeeded":
    case "passed":
      return { label: "PASS", tone: "good" };
    case "failed":
    case "timed_out":
    case "timed-out":
    case "max_actions":
      return { label: "FAIL", tone: "bad" };
    case "blocked":
      return { label: "BLOCKED", tone: "warn" };
    case "aborted":
    case "cancelled":
    case "disconnected":
      return { label: status === "disconnected" ? "DISCONNECTED" : "STOPPED", tone: "warn" };
    case "skipped":
    case "not-run":
      return { label: status === "skipped" ? "SKIPPED" : "NOT RUN", tone: "neutral" };
    case "running":
      return { label: "RUNNING", tone: "info" };
    case "queued":
      return { label: "QUEUED", tone: "neutral" };
    case "errored":
      return { label: "ERROR", tone: "bad" };
    default:
      return { label: typeof status === "string" ? status.toUpperCase() : UNKNOWN.toUpperCase(), tone: "neutral" };
  }
}

/** The one-line state of the bot for a card: connected-idle, running, disconnected ... */
export function botState(session, scheduler) {
  const info = sessionInfo(session);
  if (info.state === "idle" && scheduler?.active) return SESSION_STATES.running;
  return SESSION_STATES[info.state] ?? info;
}

/** Why a "start task" or "queue" action is or is not possible right now; returns null when it is. */
export function taskBlocker(snapshot) {
  const session = snapshot?.session;
  if (!session || session.state === "none") return "There is no session. Connect to a Minecraft server first (Bots tab).";
  if (session.state === "shutdown") return "The session has ended. Connect again from the Bots tab.";
  if (session.state === "connecting" || session.state === "initializing") return `The session is ${session.state}; tasks can start once it is connected.`;
  if (session.state === "reconnecting") return "The connection dropped and GameMind is reconnecting; tasks can start once it is back.";
  if (session.state === "stopping") return "The session is stopping.";
  if (snapshot?.safety?.tripped) return "The safety trip is raised; reset it before starting a task.";
  if (snapshot?.safety?.paused) return "The run is paused; resume it before starting a task.";
  if (!snapshot?.scheduler) return "This run has no task scheduler.";
  return null;
}

/** What queueing means right now, so the checkbox can explain itself instead of silently doing nothing. */
export function queueExplanation(snapshot) {
  const blocker = taskBlocker(snapshot);
  if (blocker) return { available: false, text: blocker };
  const scheduler = snapshot.scheduler;
  if (scheduler.active) {
    return {
      available: true,
      text: `A task is running (${scheduler.active.label}). A task started now is refused unless you tick “queue”, and then it runs after the current one (queue ${scheduler.queue.length}/${scheduler.limits.maxQueue}).`,
    };
  }
  return { available: true, text: "Nothing is running, so a task starts immediately. Tick “queue” only matters while another task is active." };
}

/** Progress of the active task as a measured fraction, or null when it is not measurable. */
export function activeProgress(snapshot) {
  const goal = snapshot?.goal?.progress;
  if (goal && goal.of > 0) return { have: goal.have, of: goal.of, unit: goal.unit, fraction: Math.max(0, Math.min(1, goal.have / goal.of)) };
  return null;
}

/** Every command name the page may send. A test checks each against the server's command surface. */
export const COMMANDS_USED = [
  "connectSession", "stopSession", "shutdownApp",
  "pause", "resume", "trip", "resetTrip", "enableCombat", "panic",
  "startTask", "stopTask", "cancelQueuedTask", "clearTaskQueue", "setAutonomy",
  "startTraining", "pauseTraining", "resumeTraining", "stopTraining", "evaluateTraining", "selectTrainingDirectory",
  "runUnitTests", "runOfflineEvaluation", "runLiveVerification", "cancelJob",
  "promotePolicy", "rejectPolicy", "setWorldSeed", "refreshRoadmap", "roadmapAction", "libraryExecute",
];

/**
 * One plain sentence for the top of the Session card: what the agent is doing right now, or why it is not. Reads the
 * snapshot only, so it is testable without a browser. Written in English like the rest of the Control Center.
 */
export function nowSummary(snapshot) {
  if (snapshot?.safety?.tripped) return "Safety stop raised: only read-only actions run. Reset the trip on the Bots tab to continue.";
  if (snapshot?.safety?.paused) return `Paused: ${snapshot.safety.pauseReason ?? "no reason given"}.`;
  const state = snapshot?.session?.state ?? "none";
  switch (state) {
    case "none":
    case "shutdown":
      return state === "none"
        ? "Not connected. Enter a host and port on the Bots tab and connect."
        : "Session ended. Connect again on the Bots tab to continue.";
    case "connecting":
    case "initializing":
      return "Connecting to the server.";
    case "reconnecting":
      return "The connection dropped. GameMind is trying to reconnect.";
    case "stopping":
      return "Stopping: the running task is halted and the bot disconnects in order.";
    case "idle":
      return snapshot?.autonomyEnabled
        ? "Connected and idle. Autonomy is on and will choose work when it sees something worth doing."
        : "Connected and idle. Start a task, or turn autonomy on.";
    case "running": {
      const label = snapshot?.scheduler?.active?.label ?? "a task";
      const goal = snapshot?.goal?.rationale ? ` ${snapshot.goal.rationale}` : "";
      return `Working on: ${label}.${goal}`;
    }
    default:
      return `Session state: ${state}.`;
  }
}
