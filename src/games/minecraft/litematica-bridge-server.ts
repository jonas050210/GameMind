import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LITEMATICA_BRIDGE_MAX_BODY_BYTES, LitematicPlacementGuard, LitematicPlacementError, type LitematicPlacementSnapshot } from "./litematica-placement-guard.js";

export interface LitematicaBridgeServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly token: string;
  /** Must be explicit to bind beyond loopback; still use a trusted private network and firewall. */
  readonly allowNonLoopback?: boolean;
  readonly onPlacement?: (snapshot: LitematicPlacementSnapshot) => void;
}

export interface LitematicaBridgeAddress {
  readonly host: string;
  readonly port: number;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  response.end(body);
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declaredLength = request.headers["content-length"];
    if (declaredLength !== undefined) {
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length < 0 || length > LITEMATICA_BRIDGE_MAX_BODY_BYTES) {
        request.resume();
        reject(new LitematicPlacementError(`Bridge body exceeds ${LITEMATICA_BRIDGE_MAX_BODY_BYTES} bytes.`));
        return;
      }
    }

    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > LITEMATICA_BRIDGE_MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        request.resume();
        reject(new LitematicPlacementError(`Bridge body exceeds ${LITEMATICA_BRIDGE_MAX_BODY_BYTES} bytes.`));
        return;
      }
      chunks.push(bytes);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, length));
    });
    request.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.on("aborted", () => {
      if (settled) return;
      settled = true;
      reject(new LitematicPlacementError("Bridge request was aborted."));
    });
  });
}

/**
 * Minimal HTTP receiver for the versioned, HMAC-authenticated Fabric bridge protocol. It has no route that
 * can approve a placement or send Minecraft actions; approvals remain an explicit local operator step.
 */
export class LitematicaBridgeServer {
  private readonly host: string;
  private readonly port: number;
  private readonly server: Server;
  private closing = false;

  constructor(
    private readonly guard: LitematicPlacementGuard,
    private readonly options: LitematicaBridgeServerOptions,
  ) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 39_990;
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) {
      throw new Error("Litematica bridge port must be an integer from 0 through 65535.");
    }
    const loopback = this.host === "127.0.0.1" || this.host === "::1" || this.host === "localhost";
    if (!loopback && options.allowNonLoopback !== true) {
      throw new Error("Litematica bridge is loopback-only unless allowNonLoopback is explicitly enabled.");
    }
    if (Buffer.byteLength(options.token, "utf8") < 32) {
      throw new Error("Litematica bridge token must contain at least 32 UTF-8 bytes.");
    }
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
        else response.destroy(error instanceof Error ? error : undefined);
      });
    });
    this.server.requestTimeout = 5_000;
    this.server.headersTimeout = 5_000;
    this.server.maxHeadersCount = 32;
  }

  async start(): Promise<LitematicaBridgeAddress> {
    if (this.server.listening) {
      const address = this.server.address();
      if (!address || typeof address === "string") throw new Error("Litematica bridge did not bind a TCP address.");
      return { host: this.host, port: address.port };
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Litematica bridge did not bind a TCP address.");
    return { host: this.host, port: address.port };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
      this.server.closeIdleConnections?.();
      this.server.closeAllConnections?.();
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closing) {
      sendJson(response, 503, { error: "shutting_down" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/placement") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      request.resume();
      sendJson(response, 415, { error: "content_type_must_be_application_json" });
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRequestBody(request);
    } catch (error) {
      sendJson(response, error instanceof LitematicPlacementError ? 413 : 400, {
        error: error instanceof Error ? error.message : "invalid_request_body",
      });
      return;
    }
    const signature = request.headers["x-gamemind-signature"];
    if (typeof signature !== "string") {
      this.guard.invalidate("bridge request had no HMAC signature");
      sendJson(response, 401, { error: "missing_bridge_signature" });
      return;
    }
    try {
      const snapshot = this.guard.receive(rawBody, signature);
      try {
        this.options.onPlacement?.(snapshot);
      } catch {
        // An operator-facing notification must not alter the authenticated bridge state.
      }
      sendJson(response, 200, {
        accepted: true,
        fingerprint: snapshot.fingerprint,
        approved: snapshot.approved,
        expiresAtMs: snapshot.expiresAtMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_bridge_report";
      const status = /signature/i.test(message) ? 401 : 400;
      sendJson(response, status, { accepted: false, error: message });
    }
  }
}
