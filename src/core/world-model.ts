import type { GameObservation, GameSession, WorldState } from "./types.js";

export interface Position {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export class WorldModel<TState = unknown> {
  private currentValue: WorldState<TState> | null = null;
  private sessionValue: GameSession | null = null;
  private currentPosition: Position | null = null;

  get current(): WorldState<TState> | null {
    return this.currentValue;
  }

  /** The player's current position, or null if no observation has been applied yet. */
  get position(): Position | null {
    return this.currentPosition;
  }

  beginSession(session: GameSession): void {
    this.sessionValue = session;
    this.currentValue = null;
  }

  clear(): void {
    this.sessionValue = null;
    this.currentValue = null;
  }

  apply(observation: GameObservation<TState>): WorldState<TState> {
    const session = this.sessionValue;
    if (!session) {
      throw new Error("Cannot apply an observation before a session has started.");
    }
    if (observation.schemaVersion !== 1) {
      throw new Error(`Unsupported observation schema version: ${observation.schemaVersion}.`);
    }
    if (observation.gameId !== session.gameId) {
      throw new Error(
        `Observation game '${observation.gameId}' does not match session game '${session.gameId}'.`,
      );
    }
    if (observation.sessionId !== session.id) {
      throw new Error("Observation belongs to a different or expired session.");
    }
    if (!Number.isInteger(observation.sequence) || observation.sequence < 0) {
      throw new Error("Observation sequence must be a non-negative integer.");
    }
    if (!Number.isFinite(Date.parse(observation.observedAt))) {
      throw new Error("Observation timestamp is invalid.");
    }
    if (observation.gameVersion !== session.gameVersion) {
      throw new Error("Observation game version changed during an active session.");
    }
    if (
      this.currentValue &&
      observation.sequence <= this.currentValue.sequence
    ) {
      throw new Error(
        `Stale observation sequence ${observation.sequence}; current sequence is ${this.currentValue.sequence}.`,
      );
    }

    // Extract position from observation if available (Minecraft observations have player.position)
    const obsState = observation.state as { player?: { position?: { x: number; y: number; z: number } } };
    if (obsState?.player?.position) {
      this.currentPosition = {
        x: obsState.player.position.x,
        y: obsState.player.position.y,
        z: obsState.player.position.z,
      };
    }

    const state: WorldState<TState> = {
      ...observation,
      receivedAt: new Date().toISOString(),
    };
    this.currentValue = state;
    return state;
  }
}
