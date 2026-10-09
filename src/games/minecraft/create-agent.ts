import type { Logger } from "pino";
import { GameMindRuntime } from "../../core/game-mind-runtime.js";
import type { GameAdapter } from "../../core/types.js";
import { SkillRuntime } from "../../core/skill-runtime.js";
import { TraceRecorder } from "../../core/trace.js";
import type { MinecraftObservation } from "./observation.js";
import { minecraftSkills } from "./skills.js";

export function createMinecraftAgent(
  adapter: GameAdapter<MinecraftObservation>,
  trace: TraceRecorder,
  logger: Logger,
) {
  const runtime = new GameMindRuntime(adapter, trace, logger);
  const skills = new SkillRuntime(
    minecraftSkills,
    runtime.actionExecutor,
    trace,
    logger,
    () => runtime.session,
    () => runtime.observe(),
  );
  return { runtime, skills };
}
