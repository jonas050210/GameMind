import type { CapabilityDefinition } from "./types.js";

export class CapabilityRegistry {
  private readonly definitions = new Map<string, CapabilityDefinition>();

  constructor(definitions: readonly CapabilityDefinition[]) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: CapabilityDefinition): void {
    if (!definition.name.trim()) {
      throw new Error("Capability names must not be empty.");
    }
    if (this.definitions.has(definition.name)) {
      throw new Error(`Capability '${definition.name}' is already registered.`);
    }
    if (
      !Number.isInteger(definition.defaultTimeoutMs) ||
      definition.defaultTimeoutMs <= 0 ||
      !Number.isInteger(definition.maxTimeoutMs) ||
      definition.maxTimeoutMs < definition.defaultTimeoutMs
    ) {
      throw new Error(`Capability '${definition.name}' has invalid timeout limits.`);
    }
    this.definitions.set(definition.name, definition);
  }

  get(name: string): CapabilityDefinition | undefined {
    return this.definitions.get(name);
  }

  list(): readonly CapabilityDefinition[] {
    return [...this.definitions.values()];
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }
}
