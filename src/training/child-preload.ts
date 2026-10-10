import { appendFileSync } from "node:fs";

/**
 * Node cannot report which signal caused a child to stop on every Windows version. In particular,
 * process.kill(process.pid, "SIGKILL") is implemented with TerminateProcess and can arrive at the
 * parent as exit code 1 with no signal. Record the intent before that unavoidably abrupt termination
 * so the manager can distinguish it from a real process.exit(1).
 *
 * This module is loaded only for children started by TrainingManager. It is deliberately a preload rather
 * than an import in the trainer itself: the offline training import graph must stay independent of the
 * process-management compatibility shim.
 */

const marker = process.env.GAMEMIND_TERMINATION_MARKER;
if (process.platform === "win32" && marker) {
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number): true => {
    if (pid === process.pid && (signal === "SIGKILL" || signal === 9)) {
      try {
        appendFileSync(marker, "SIGKILL\n", "utf8");
      } catch {
        // The termination marker is diagnostic only; the requested kill still goes through.
      }
    }
    return signal === undefined ? originalKill.call(process, pid) : originalKill.call(process, pid, signal);
  }) as typeof process.kill;
}
