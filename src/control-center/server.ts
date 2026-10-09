import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  ControlCenterCommands,
  ControlCenterHost,
  ControlCenterServerOptions,
  ControlCenterHandle,
  ControlCenterSnapshot,
} from "./types.js";

const MAX_BODY_BYTES = 64 * 1024;

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function text(response: import("node:http").ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Serves the Control Center: a read-only-by-default operator surface over the live runtime. Every
 * number in the UI comes from `host.snapshot()`; the only writes are the explicit safety commands,
 * which are forwarded to the running agent and answered with its real result.
 */
export class ControlCenter {
  private readonly server: Server;
  private readonly token = randomUUID();
  private readonly staticDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
  private snapshotCache: { at: number; value: ControlCenterSnapshot } | null = null;
  private lastSequence: number | null = null;
  private portValue = 0;

  constructor(
    private readonly host: ControlCenterHost,
    private readonly options: ControlCenterServerOptions = {},
  ) {
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        this.options.logger?.warn(`Control Center request failed: ${String(error)}`);
        if (!response.headersSent) json(response, 500, { ok: false, message: String(error) });
        else response.end();
      });
    });
  }

  get url(): string {
    const host = this.options.host === "0.0.0.0" ? "127.0.0.1" : (this.options.host ?? "127.0.0.1");
    return `http://${host}:${this.portValue}/`;
  }

  get port(): number {
    return this.portValue;
  }

  /** Token handed to the served UI; required on POSTs so another local page cannot drive the agent. */
  get csrfToken(): string {
    return this.token;
  }

  async start(): Promise<ControlCenterHandle> {
    const port = this.options.port ?? 8787;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, this.options.host ?? "0.0.0.0", () => resolve());
    });
    const address = this.server.address();
    this.portValue = typeof address === "object" && address ? address.port : port;
    this.options.logger?.info(`Control Center listening on ${this.url}`);
    return {
      port: this.portValue,
      url: this.url,
      token: this.token,
      stop: (reason) => this.stop(reason),
    };
  }

  /** `reason` is accepted for handle compatibility; there is no longer a stream to announce it on. */
  async stop(_reason?: string): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async currentSnapshot(force = false): Promise<ControlCenterSnapshot> {
    const now = Date.now();
    if (!force && this.snapshotCache && now - this.snapshotCache.at < 250) return this.snapshotCache.value;
    const snapshot = await this.host.snapshot();
    this.snapshotCache = { at: now, value: snapshot };
    this.lastSequence = snapshot.connection.sequence;
    return snapshot;
  }

  private async route(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    const target = request.url ?? "/";
    // A client that appended the API path to a base URL ending in "/" sends "//api/...". Parsed as a
    // URL that would read as a protocol-relative authority and lose the route entirely, so collapse the
    // leading separators first and only then parse.
    const url = new URL(target.replace(/^\/+(?=\/)/, ""), "http://localhost");
    const route = url.pathname.replace(/\/{2,}/g, "/");
    if (request.method === "GET" && route === "/api/health") {
      json(response, 200, { ok: true, title: this.host.title, at: new Date().toISOString() });
      return;
    }
    if (request.method === "GET" && route === "/api/snapshot") {
      json(response, 200, await this.currentSnapshot(url.searchParams.has("fresh")));
      return;
    }
    if (route === "/api/stream") {
      // The live event stream was removed: every frame it pushed was a re-send of the same snapshot the
      // poll returns, while the open connections made the page depend on a channel the agent never
      // controlled. It answers 410 so a stale bookmark or cached page says so instead of hanging.
      response.writeHead(410, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({
        ok: false,
        code: "STREAM_REMOVED",
        message: "The Control Center event stream was removed; poll GET /api/snapshot?fresh=1 instead.",
      }));
      return;
    }
    if (request.method === "POST" && route === "/api/command") {
      await this.handleCommand(request, response);
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      await this.serveStatic(route, response, request.method === "HEAD");
      return;
    }
    json(response, 405, { ok: false, message: `${request.method} is not supported on ${route}.` });
  }

  private async handleCommand(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    const supplied = request.headers["x-gamemind-token"];
    if (supplied !== this.token) {
      json(response, 403, { ok: false, message: "Missing or incorrect control token. Reload the Control Center page." });
      return;
    }
    let body: { type?: unknown; payload?: unknown };
    try {
      const raw = await readBody(request);
      body = raw.length > 0 ? (JSON.parse(raw) as typeof body) : {};
    } catch (error) {
      json(response, 400, { ok: false, message: `Invalid JSON body: ${String(error)}` });
      return;
    }
    const type = typeof body.type === "string" ? body.type : "";
    const commands: ControlCenterCommands = this.host.commands;
    const handler = (commands as Record<string, unknown>)[type];
    if (typeof handler !== "function") {
      json(response, 501, {
        ok: false,
        message: handler === undefined
          ? `Command '${type || "(missing)"}' is not available in this run.`
          : `Command '${type}' is not callable.`,
      });
      return;
    }
    try {
      const result = await (handler as (payload: unknown) => unknown).call(commands, body.payload);
      const normalized =
        result && typeof result === "object" && "ok" in (result as object)
          ? (result as { ok: boolean; message: string; data?: unknown })
          : { ok: true, message: `${type} accepted.` };
      json(response, normalized.ok ? 200 : 409, normalized);
      void this.currentSnapshot(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, 500, { ok: false, message: `${type} failed: ${message}` });
    }
  }

  private async serveStatic(pathname: string, response: import("node:http").ServerResponse, headOnly: boolean): Promise<void> {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.join(this.staticDirectory, relative);
    if (!target.startsWith(this.staticDirectory)) {
      text(response, 403, "Outside the Control Center asset directory.");
      return;
    }
    let content: Buffer;
    try {
      content = await readFile(target);
    } catch {
      text(response, 404, `No Control Center asset at '${relative}'.`);
      return;
    }
    const extension = path.extname(target);
    let body = content.toString("utf8");
    if (target.endsWith("index.html")) {
      // The token is injected into the served page instead of being readable from an API endpoint.
      body = body
        .replace('"__CONTROL_TOKEN__"', JSON.stringify(this.token))
        .replace('"__BANNER__"', JSON.stringify(this.options.banner ?? ""))
        .replace('"__TITLE__"', JSON.stringify(this.host.title));
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "content-length": Buffer.byteLength(body),
      "cache-control": extension === ".html" ? "no-store" : "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    if (headOnly) {
      response.end();
      return;
    }
    response.end(body);
  }

}

export async function startControlCenter(
  host: ControlCenterHost,
  options?: ControlCenterServerOptions,
): Promise<ControlCenterHandle> {
  const center = new ControlCenter(host, options ?? {});
  return center.start();
}
