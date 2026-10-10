import { SessionStartError, type MinecraftSession } from "./session.js";

/**
 * A probe is the shortest possible live run: connect, do one small step, print one JSON report, disconnect. It exists for
 * "can this machine reach that server, and what does the agent see there?", which a persistent session (the default)
 * answers only through the Control Center. It never starts a server, a scheduler task or autonomy.
 */
export type ProbeRequest =
  | { readonly kind: "observe" }
  | { readonly kind: "look"; readonly yaw: number; readonly pitch: number };

export interface ProbeOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const CONSOLE_OUTPUT: ProbeOutput = { out: (text) => console.log(text), err: (text) => console.error(text) };

/**
 * Starts `session`, performs the probe, prints its report and always stops the session. Resolves with a process exit code:
 * 0 when the step happened and the world confirmed it, 1 otherwise (with the reason printed to the error stream).
 */
export async function runProbe(session: MinecraftSession, request: ProbeRequest, io: ProbeOutput = CONSOLE_OUTPUT): Promise<number> {
  try {
    await session.start();
    if (request.kind === "look") {
      const result = await session.skills.run("minecraft.orient", { yaw: request.yaw, pitch: request.pitch });
      io.out(JSON.stringify({ type: "skill-result", ...result }, null, 2));
      return result.action.status === "succeeded" ? 0 : 1;
    }
    const world = session.runtime.currentWorldState;
    io.out(
      JSON.stringify(
        {
          type: "initial-observation",
          sessionId: world?.sessionId ?? null,
          observation: world,
          availableSkills: session.skills.list().map(({ id, description }) => ({ id, description })),
        },
        null,
        2,
      ),
    );
    if (!world) {
      io.err("The session connected but reported no observation, so there is nothing to show.");
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof SessionStartError) {
      io.err(`Connection failed: ${error.diagnosis.summary}`);
      for (const hint of error.diagnosis.hints) io.err(`  - ${hint}`);
      io.err(`  Error reported: ${error.diagnosis.detail}`);
    } else {
      io.err(error instanceof Error ? error.message : String(error));
    }
    return 1;
  } finally {
    await session.stop(request.kind === "look" ? "orientation complete" : "observation complete");
  }
}
