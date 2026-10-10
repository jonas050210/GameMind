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

/** Routes served by the server itself; a host query may not shadow them. */
const RESERVED_ROUTES: ReadonlySet<string> = new Set(["health", "snapshot", "stream", "command"]);
const QUERY_NAME = /^[a-z][a-z0-9-]{0,40}$/;

const LOOPBACK_BIND = /^(?:localhost|::1|\[::1\]|127(?:\.\d{1,3}){3})$/i;

export function isLoopbackBind(host: string): boolean {
  return LOOPBACK_BIND.test(host.trim());
}

/** The host name of a Host header value, without port, lowercased; null when it is not a plausible host. */
export function hostnameOfHeader(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^(\[[0-9a-f:]+\]|[^:/\s]+)(?::\d{1,5})?$/i.exec(value.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

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

function scriptJson(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
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
  private portValue = 0;
  private stopping: Promise<void> | null = null;

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

  /** The address to open in a browser on this machine; wildcard binds are shown as loopback. */
  get url(): string {
    const bound = this.options.host ?? "127.0.0.1";
    const host = bound === "0.0.0.0" || bound === "::" ? "127.0.0.1" : bound.includes(":") && !bound.startsWith("[") ? `[${bound}]` : bound;
    return `http://${host}:${this.portValue}/`;
  }

  get bindHost(): string {
    return this.options.host ?? "127.0.0.1";
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
    const host = this.bindHost;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", (error: NodeJS.ErrnoException) => {
        // A bare EADDRINUSE stack appeared after the agent had already connected and said nothing about
        // the fix. Name the port and the option that changes it.
        if (error.code === "EADDRINUSE") {
          reject(new Error(
            `Control Center port ${port} is already in use on ${host}. Stop the other GameMind run, or pass --control-port PORT (0 picks a free port).`,
          ));
          return;
        }
        reject(error);
      });
      this.server.listen(port, host, () => resolve());
    });
    const address = this.server.address();
    this.portValue = typeof address === "object" && address ? address.port : port;
    this.options.logger?.info(`Control Center listening on ${this.url}`);
    return {
      port: this.portValue,
      url: this.url,
      token: this.token,
      bindHost: host,
      localOnly: isLoopbackBind(host),
      stop: (reason) => this.stop(reason),
    };
  }

  /** `reason` is accepted for handle compatibility; there is no longer a stream to announce it on. */
  async stop(_reason?: string): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      // Keep-alive connections from a browser tab would otherwise hold the close open for several seconds.
      this.server.closeIdleConnections?.();
      const force = setTimeout(() => this.server.closeAllConnections?.(), 1_000);
      force.unref();
    });
    return this.stopping;
  }

  /**
   * DNS-rebinding guard. A page on `evil.example` can make the browser resolve that name to 127.0.0.1 and then
   * talk to this server as "same origin". Such a request still carries `Host: evil.example`, so while the server is
   * bound to loopback only loopback host names (and any the operator listed) are served. A server the operator
   * deliberately bound to a LAN address or a wildcard accepts any Host, because the names it is reached by (a
   * machine name, a proxy) cannot be known in advance; that choice is theirs and is reported in `/api/health`.
   */
  private refuseForeignHost(request: import("node:http").IncomingMessage): string | null {
    if (!isLoopbackBind(this.bindHost)) return null;
    const hostname = hostnameOfHeader(request.headers.host);
    if (hostname !== null && (isLoopbackBind(hostname) || (this.options.allowedHosts ?? []).some((allowed) => allowed.toLowerCase() === hostname))) return null;
    return `The Control Center is bound to ${this.bindHost} and only answers requests addressed to it (localhost or 127.0.0.1), not to '${request.headers.host ?? "(no host)"}'. Open ${this.url} instead.`;
  }

  private async currentSnapshot(force = false): Promise<ControlCenterSnapshot> {
    const now = Date.now();
    if (!force && this.snapshotCache && now - this.snapshotCache.at < 250) return this.snapshotCache.value;
    const snapshot = await this.host.snapshot();
    this.snapshotCache = { at: now, value: snapshot };
    return snapshot;
  }

  private async route(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    const refusal = this.refuseForeignHost(request);
    if (refusal) {
      json(response, 403, { ok: false, code: "HOST_NOT_ALLOWED", message: refusal });
      return;
    }
    const target = request.url ?? "/";
    // A client that appended the API path to a base URL ending in "/" sends "//api/...". Parsed as a
    // URL that would read as a protocol-relative authority and lose the route entirely, so collapse the
    // leading separators first and only then parse.
    const url = new URL(target.replace(/^\/+(?=\/)/, ""), "http://localhost");
    const route = url.pathname.replace(/\/{2,}/g, "/");
    if (request.method === "GET" && route === "/api/health") {
      let extra: Readonly<Record<string, unknown>> = {};
      try {
        extra = this.host.health?.() ?? {};
      } catch {
        extra = {};
      }
      json(response, 200, { ...extra, ok: true, app: "gamemind", title: this.host.title, at: new Date().toISOString() });
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
    if (request.method === "GET" && route.startsWith("/api/")) {
      const name = route.slice("/api/".length);
      const queries = this.host.queries;
      if (queries && QUERY_NAME.test(name) && !RESERVED_ROUTES.has(name) && Object.prototype.hasOwnProperty.call(queries, name)) {
        const query = queries[name];
        if (typeof query === "function") {
          try {
            json(response, 200, await query(url.searchParams));
          } catch (error) {
            json(response, 500, { ok: false, message: `${name} failed: ${error instanceof Error ? error.message : String(error)}` });
          }
          return;
        }
      }
      json(response, 404, { ok: false, code: "UNKNOWN_QUERY", message: `There is no '${name}' endpoint in this run.` });
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      await this.serveStatic(route, response, request.method === "HEAD");
      return;
    }
    json(response, 405, { ok: false, message: `${request.method} is not supported on ${route}.` });
  }

  private async handleCommand(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    if (typeof origin === "string" && origin !== "null") {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = null;
      }
      const requestHost = (request.headers.host ?? "").toLowerCase();
      if (originHost === null || originHost !== requestHost) {
        json(response, 403, { ok: false, code: "CROSS_ORIGIN", message: "Commands are only accepted from the Control Center page itself, not from another origin." });
        return;
      }
    }
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
    // Own properties only: a name such as "constructor" or "toString" resolves on every object and must not dispatch.
    const handler = Object.prototype.hasOwnProperty.call(commands, type) ? (commands as Record<string, unknown>)[type] : undefined;
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
      // Warm the cache for the poll that follows. A failing snapshot is reported by that poll; as a background
      // task it must never become an unhandled rejection, which would take the whole process down.
      this.currentSnapshot(true).catch((error: unknown) => {
        this.options.logger?.warn(`Control Center snapshot refresh after '${type}' failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, 500, { ok: false, message: `${type} failed: ${message}` });
    }
  }

  private async serveStatic(pathname: string, response: import("node:http").ServerResponse, headOnly: boolean): Promise<void> {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.join(this.staticDirectory, relative);
    // A bare prefix test also accepts a sibling such as `public-old/`; require the separator as well.
    if (target !== this.staticDirectory && !target.startsWith(this.staticDirectory + path.sep)) {
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
      // Values go in as JSON inside a <script> element: `<`, `>`, `&` and the JS line separators are escaped
      // so text such as `</script>` cannot end the element early. Function replacers keep `$&`-style
      // sequences in a value from being read as replacement patterns.
      body = body
        .replace('"__CONTROL_TOKEN__"', () => scriptJson(this.token))
        .replace('"__BANNER__"', () => scriptJson(this.options.banner ?? ""))
        .replace('"__TITLE__"', () => scriptJson(this.host.title));
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "content-length": Buffer.byteLength(body),
      "cache-control": extension === ".html" ? "no-store" : "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(extension === ".html" ? { "content-security-policy": CONTENT_SECURITY_POLICY } : {}),
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
