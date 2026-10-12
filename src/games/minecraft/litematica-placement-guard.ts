import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { LitematicBlueprint } from "./litematic-importer.js";

export const LITEMATICA_BRIDGE_PROTOCOL_VERSION = 1;
export const LITEMATICA_PLACEMENT_MAX_AGE_MS = 5_000;
export const LITEMATICA_PLACEMENT_MAX_FUTURE_SKEW_MS = 10_000;
export const LITEMATICA_BRIDGE_MAX_BODY_BYTES = 16 * 1024;

export interface LitematicVector3i {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface LitematicPlacementReport {
  readonly protocolVersion: 1;
  /** Random identifier regenerated whenever the Fabric client starts. */
  readonly clientInstanceId: string;
  /** Strictly increasing within one clientInstanceId. */
  readonly sequence: number;
  /** Unix epoch milliseconds from the Fabric client. */
  readonly sentAtMs: number;
  readonly placementId: string;
  readonly blueprintSha256: string;
  /** Stable identity for one saved world/server; never use a display name alone. */
  readonly worldId: string;
  readonly dimension: string;
  readonly origin: LitematicVector3i;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly mirror: "none" | "left_right" | "front_back";
  readonly enabledRegions: readonly string[];
  readonly bounds: {
    /** Inclusive world-space minimum corner; equals origin in protocol v1. */
    readonly min: LitematicVector3i;
    /** Inclusive world-space maximum corner. */
    readonly max: LitematicVector3i;
  };
}

export interface LitematicPlacementSnapshot {
  readonly report: LitematicPlacementReport;
  readonly fingerprint: string;
  readonly receivedAtMs: number;
  readonly expiresAtMs: number;
  readonly approved: boolean;
}

export interface LitematicPlacementApproval {
  readonly fingerprint: string;
  readonly blueprintSha256: string;
  readonly worldId: string;
  readonly dimension: string;
  readonly placementId: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
}

export class LitematicPlacementError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LitematicPlacementError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) {
    throw new LitematicPlacementError(`Litematica bridge field '${name}' is missing or invalid.`);
  }
  return value;
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new LitematicPlacementError(`Litematica bridge field '${name}' must be a safe integer.`);
  }
  return value;
}

function vector(value: unknown, name: string): LitematicVector3i {
  if (!isRecord(value)) throw new LitematicPlacementError(`Litematica bridge field '${name}' must be an integer vector.`);
  return {
    x: safeInteger(value.x, `${name}.x`),
    y: safeInteger(value.y, `${name}.y`),
    z: safeInteger(value.z, `${name}.z`),
  };
}

function parseReport(value: unknown): LitematicPlacementReport {
  if (!isRecord(value)) throw new LitematicPlacementError("Litematica bridge report must be a JSON object.");
  if (value.protocolVersion !== LITEMATICA_BRIDGE_PROTOCOL_VERSION) {
    throw new LitematicPlacementError(`Unsupported Litematica bridge protocol version '${String(value.protocolVersion)}'.`);
  }
  const sequence = safeInteger(value.sequence, "sequence");
  const sentAtMs = safeInteger(value.sentAtMs, "sentAtMs");
  if (sequence < 0) throw new LitematicPlacementError("Litematica bridge sequence must not be negative.");

  const rotation = value.rotation;
  if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
    throw new LitematicPlacementError("Litematica bridge rotation must be 0, 90, 180, or 270 degrees.");
  }
  const mirror = value.mirror;
  if (mirror !== "none" && mirror !== "left_right" && mirror !== "front_back") {
    throw new LitematicPlacementError("Litematica bridge mirror mode is invalid.");
  }
  if (!Array.isArray(value.enabledRegions) || value.enabledRegions.length > 32 || !value.enabledRegions.every((entry) => typeof entry === "string")) {
    throw new LitematicPlacementError("Litematica bridge enabledRegions must be a list of at most 32 region names.");
  }
  if (!isRecord(value.bounds)) throw new LitematicPlacementError("Litematica bridge bounds are missing.");

  const dimension = stringField(value.dimension, "dimension", 128);
  if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(dimension)) {
    throw new LitematicPlacementError("Litematica bridge dimension must be a namespaced dimension identifier.");
  }
  const worldId = stringField(value.worldId, "worldId", 160);
  const clientInstanceId = stringField(value.clientInstanceId, "clientInstanceId", 128);
  const placementId = stringField(value.placementId, "placementId", 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(clientInstanceId) || !/^[A-Za-z0-9._:-]+$/.test(placementId)) {
    throw new LitematicPlacementError("Litematica bridge identifiers contain unsupported characters.");
  }
  if (typeof value.blueprintSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.blueprintSha256)) {
    throw new LitematicPlacementError("Litematica bridge blueprintSha256 must be a SHA-256 hex digest.");
  }

  const enabledRegions = value.enabledRegions.map((region) => stringField(region, "enabledRegions[]", 160));
  if (new Set(enabledRegions).size !== enabledRegions.length) {
    throw new LitematicPlacementError("Litematica bridge enabledRegions must not contain duplicates.");
  }
  const bounds = {
    min: vector(value.bounds.min, "bounds.min"),
    max: vector(value.bounds.max, "bounds.max"),
  };
  return {
    protocolVersion: LITEMATICA_BRIDGE_PROTOCOL_VERSION,
    clientInstanceId,
    sequence,
    sentAtMs,
    placementId,
    blueprintSha256: value.blueprintSha256.toLowerCase(),
    worldId,
    dimension,
    origin: vector(value.origin, "origin"),
    rotation,
    mirror,
    enabledRegions: enabledRegions.sort((left, right) => left.localeCompare(right)),
    bounds,
  };
}

/**
 * Verify the HMAC-SHA256 over the exact request bytes. The bridge token must be shared out of band and
 * contain at least 32 UTF-8 bytes. Hex comparisons use a constant-time byte comparison.
 */
export function verifyLitematicaBridgeSignature(rawBody: Uint8Array, signatureHex: string, token: string): boolean {
  if (Buffer.byteLength(token, "utf8") < 32 || !/^[a-f0-9]{64}$/i.test(signatureHex)) return false;
  const expected = createHmac("sha256", token).update(rawBody).digest();
  const supplied = Buffer.from(signatureHex, "hex");
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

function fingerprint(report: LitematicPlacementReport): string {
  const canonical = JSON.stringify({
    protocolVersion: report.protocolVersion,
    clientInstanceId: report.clientInstanceId,
    placementId: report.placementId,
    blueprintSha256: report.blueprintSha256,
    worldId: report.worldId,
    dimension: report.dimension,
    origin: report.origin,
    rotation: report.rotation,
    mirror: report.mirror,
    enabledRegions: report.enabledRegions,
    bounds: report.bounds,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function validateAgainstBlueprint(report: LitematicPlacementReport, blueprint: LitematicBlueprint): void {
  if (report.blueprintSha256 !== blueprint.sourceSha256) {
    throw new LitematicPlacementError("Active Litematica placement does not match the imported blueprint SHA-256.");
  }
  const expectedRegions = blueprint.regions.map((region) => region.name).sort((left, right) => left.localeCompare(right));
  if (report.enabledRegions.length !== expectedRegions.length || report.enabledRegions.some((region, index) => region !== expectedRegions[index])) {
    throw new LitematicPlacementError("Protocol v1 requires every imported Litematic region to be enabled; partial-region placements are not approved.");
  }
  if (report.origin.x !== report.bounds.min.x || report.origin.y !== report.bounds.min.y || report.origin.z !== report.bounds.min.z) {
    throw new LitematicPlacementError("Protocol v1 origin must equal the inclusive minimum corner of the reported world bounds.");
  }
  const swapXZ = report.rotation === 90 || report.rotation === 270;
  const expectedSize = {
    x: swapXZ ? blueprint.dimensions.z : blueprint.dimensions.x,
    y: blueprint.dimensions.y,
    z: swapXZ ? blueprint.dimensions.x : blueprint.dimensions.z,
  };
  const actualSize = {
    x: report.bounds.max.x - report.bounds.min.x + 1,
    y: report.bounds.max.y - report.bounds.min.y + 1,
    z: report.bounds.max.z - report.bounds.min.z + 1,
  };
  if (actualSize.x !== expectedSize.x || actualSize.y !== expectedSize.y || actualSize.z !== expectedSize.z) {
    throw new LitematicPlacementError("Active placement bounds do not match the blueprint dimensions and rotation.");
  }
}

/**
 * Authenticated, freshness-checked placement state. Approval binds to one schematic/world/transform and is
 * invalidated whenever that identity changes, the bridge disappears, or a report becomes stale.
 * This guard deliberately contains no Minecraft action executor.
 */
export class LitematicPlacementGuard {
  private current: LitematicPlacementSnapshot | null = null;
  private approvedFingerprint: string | null = null;
  private approvedAtMs: number | null = null;
  private currentClientInstanceId: string | null = null;
  private lastSequence = -1;
  private lastInvalidationReason: string | null = "No active placement report has been received.";

  constructor(
    private readonly blueprint: LitematicBlueprint,
    private readonly token: string,
  ) {
    if (Buffer.byteLength(token, "utf8") < 32) {
      throw new LitematicPlacementError("Litematica bridge token must contain at least 32 UTF-8 bytes.");
    }
  }

  receive(rawBody: Uint8Array, signatureHex: string, nowMs = Date.now()): LitematicPlacementSnapshot {
    // A report arriving after a missed heartbeat must not silently extend an old approval.
    this.freshSnapshot(nowMs);
    if (rawBody.byteLength === 0 || rawBody.byteLength > LITEMATICA_BRIDGE_MAX_BODY_BYTES) {
      this.invalidate("bridge report body was empty or too large");
      throw new LitematicPlacementError(`Litematica bridge report must be 1 to ${LITEMATICA_BRIDGE_MAX_BODY_BYTES} bytes.`);
    }
    if (!verifyLitematicaBridgeSignature(rawBody, signatureHex, this.token)) {
      this.invalidate("bridge signature was invalid");
      throw new LitematicPlacementError("Litematica bridge signature is invalid.");
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(rawBody).toString("utf8")) as unknown;
    } catch (error) {
      this.invalidate("bridge report was not valid JSON");
      throw new LitematicPlacementError("Litematica bridge report is not valid JSON.", { cause: error });
    }

    try {
      const report = parseReport(decoded);
      const ageMs = nowMs - report.sentAtMs;
      if (ageMs > LITEMATICA_PLACEMENT_MAX_AGE_MS || ageMs < -LITEMATICA_PLACEMENT_MAX_FUTURE_SKEW_MS) {
        throw new LitematicPlacementError("Litematica bridge report is stale or its clock is too far in the future.");
      }
      if (report.clientInstanceId === this.currentClientInstanceId && report.sequence <= this.lastSequence) {
        throw new LitematicPlacementError("Litematica bridge report is a replay or arrived out of sequence.");
      }
      validateAgainstBlueprint(report, this.blueprint);

      if (report.clientInstanceId !== this.currentClientInstanceId) {
        this.currentClientInstanceId = report.clientInstanceId;
        this.lastSequence = -1;
        this.approvedFingerprint = null;
        this.approvedAtMs = null;
        this.current = null;
      }
      this.lastSequence = report.sequence;
      const nextFingerprint = fingerprint(report);
      if (this.current?.fingerprint !== nextFingerprint) {
        this.approvedFingerprint = null;
        this.approvedAtMs = null;
      }
      this.current = {
        report,
        fingerprint: nextFingerprint,
        receivedAtMs: nowMs,
        expiresAtMs: nowMs + LITEMATICA_PLACEMENT_MAX_AGE_MS,
        approved: this.approvedFingerprint === nextFingerprint,
      };
      this.lastInvalidationReason = null;
      return this.current;
    } catch (error) {
      this.invalidate(error instanceof Error ? error.message : "bridge report was invalid");
      if (error instanceof LitematicPlacementError) throw error;
      throw new LitematicPlacementError("Litematica bridge report failed validation.", { cause: error });
    }
  }

  /** Call only after displaying the exact fingerprint, world, dimension, origin, and rotation to the operator. */
  approve(expectedFingerprint: string, nowMs = Date.now()): LitematicPlacementApproval {
    const current = this.freshSnapshot(nowMs);
    if (!current || current.fingerprint !== expectedFingerprint) {
      this.invalidate("operator confirmation did not match the latest fresh placement");
      throw new LitematicPlacementError("Approval refused: placement changed, expired, or did not match the preview shown to the operator.");
    }
    this.approvedFingerprint = current.fingerprint;
    this.approvedAtMs = nowMs;
    this.current = { ...current, approved: true };
    return {
      fingerprint: current.fingerprint,
      blueprintSha256: current.report.blueprintSha256,
      worldId: current.report.worldId,
      dimension: current.report.dimension,
      placementId: current.report.placementId,
      approvedAtMs: nowMs,
      expiresAtMs: current.expiresAtMs,
    };
  }

  requireApproval(expectedFingerprint: string, nowMs = Date.now()): LitematicPlacementApproval {
    const current = this.freshSnapshot(nowMs);
    if (!current || current.fingerprint !== expectedFingerprint || this.approvedFingerprint !== current.fingerprint) {
      this.invalidate("active placement is not approved");
      throw new LitematicPlacementError("No current approval exists for this exact fresh Litematica placement.");
    }
    return {
      fingerprint: current.fingerprint,
      blueprintSha256: current.report.blueprintSha256,
      worldId: current.report.worldId,
      dimension: current.report.dimension,
      placementId: current.report.placementId,
      approvedAtMs: this.approvedAtMs ?? current.receivedAtMs,
      expiresAtMs: current.expiresAtMs,
    };
  }

  snapshot(nowMs = Date.now()): LitematicPlacementSnapshot | null {
    return this.freshSnapshot(nowMs);
  }

  get invalidationReason(): string | null {
    return this.lastInvalidationReason;
  }

  invalidate(reason: string): void {
    this.current = null;
    this.approvedFingerprint = null;
    this.approvedAtMs = null;
    this.lastInvalidationReason = reason;
    // Keep the per-client sequence high-water mark so malformed/replayed reports cannot roll it back.
  }

  private freshSnapshot(nowMs: number): LitematicPlacementSnapshot | null {
    if (!this.current || nowMs >= this.current.expiresAtMs) {
      if (this.current) this.invalidate("active placement report expired");
      return null;
    }
    return {
      ...this.current,
      approved: this.approvedFingerprint === this.current.fingerprint,
    };
  }
}

/** Helper for a Fabric bridge integration or an offline client; sign the exact UTF-8 JSON request bytes. */
export function signLitematicaBridgeMessage(rawBody: Uint8Array, token: string): string {
  if (Buffer.byteLength(token, "utf8") < 32) throw new LitematicPlacementError("Litematica bridge token must contain at least 32 UTF-8 bytes.");
  return createHmac("sha256", token).update(rawBody).digest("hex");
}
