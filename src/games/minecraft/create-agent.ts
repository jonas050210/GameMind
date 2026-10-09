import type { Logger } from "pino";
import { GameMindRuntime } from "../../core/game-mind-runtime.js";
import type { GameAdapter } from "../../core/types.js";
import { SkillRuntime } from "../../core/skill-runtime.js";
import { TraceRecorder } from "../../core/trace.js";
import type { MinecraftObservation } from "./observation.js";
import { minecraftSkills } from "./skills.js";
import { MINECRAFT_SAFETY_POLICY, minecraftSafetyContext } from "./safety-context.js";
import { SafetyBroker, type SafetyPolicy } from "../../core/safety-broker.js";

export interface CreateMinecraftAgentOptions {
  /**
   * Capabilities the operator explicitly enabled (e.g. `"minecraft.attack-hostile"`). High-risk
   * capabilities stay denied without this, independently of what the decision model proposes.
   */
  readonly optedInCapabilities?: readonly string[];
  /** Replaces the Minecraft safety policy; `null` removes the pre-action gate (isolated tests only). */
  readonly safety?: SafetyBroker | Partial<SafetyPolicy> | null;
}

/**
 * Single composition root for a Minecraft agent: runtime, gated action executor, skill runtime and the
 * safety broker. Everything that runs a task — CLI, evaluation harness, Control Center — goes through
 * here, so there is exactly one place where the safety policy and the world-context extractor are wired.
 */
export function createMinecraftAgent(
  adapter: GameAdapter<MinecraftObservation>,
  trace: TraceRecorder,
  logger: Logger,
  options: CreateMinecraftAgentOptions = {},
) {
  const safety =
    options.safety === null
      ? null
      : options.safety instanceof SafetyBroker
        ? options.safety
        : new SafetyBroker({
            ...MINECRAFT_SAFETY_POLICY,
            ...(options.safety ?? {}),
            ...(options.optedInCapabilities ? { optedInCapabilities: options.optedInCapabilities } : {}),
          });
  const runtime = new GameMindRuntime(adapter, trace, logger, {
    ...(safety ? { safety } : {}),
    safetyContext: minecraftSafetyContext,
  });
  // Only skills whose capability the adapter advertises are registered; decisions never see the rest.
  const advertised = new Set(adapter.capabilities.map((capability) => capability.name));
  const skills = new SkillRuntime(
    minecraftSkills.filter((skill) => advertised.has(skill.capability)),
    runtime.actionExecutor,
    trace,
    logger,
    () => runtime.session,
    () => runtime.observe(),
  );
  return { runtime, skills, safety };
}

