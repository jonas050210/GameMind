/**
 * Default in-game operator for live play on this project's own server. `MINECRAFT_OPERATOR` always wins when it is
 * set to a non-blank value, so other players can still configure their own name. The name must match the in-game
 * username exactly, case-sensitively, like every other operator check in the codebase.
 */
export const DEFAULT_MINECRAFT_OPERATOR = "JonasBubi";

/** Fills in the default operator in place when the environment does not name one. Returns the operator in effect. */
export function applyDefaultMinecraftOperator(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.MINECRAFT_OPERATOR?.trim();
  if (configured) return configured;
  env.MINECRAFT_OPERATOR = DEFAULT_MINECRAFT_OPERATOR;
  return DEFAULT_MINECRAFT_OPERATOR;
}
