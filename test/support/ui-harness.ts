/**
 * Runs the real Control Center page (index.html, app.js, lib/, views/) inside the fake DOM.
 *
 * Two ways to feed it: `stubServer` answers from canned JSON and records every request (fast, deterministic, used for
 * page logic), and `serverFetch` points the page at a real GameMindApp HTTP server (used for end-to-end wiring).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { FakeClock, Page, waitUntil } from "./fake-dom.js";

export const PUBLIC_DIRECTORY = fileURLToPath(new URL("../../src/control-center/public/", import.meta.url));

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface UiModules {
  readonly app: any;
  readonly h: any;
  readonly api: any;
  readonly store: any;
  readonly model: any;
  readonly format: any;
  readonly ui: any;
  readonly views: Record<"overview" | "training" | "bots" | "tasks" | "evaluation" | "learning" | "memory", any>;
}

let loaded: Promise<UiModules> | null = null;

/** The browser modules are plain JavaScript, so tests load them dynamically (and before any page is installed). */
export function loadUi(): Promise<UiModules> {
  loaded ??= (async () => {
    const load = (relative: string): Promise<any> => import(pathToFileURL(path.join(PUBLIC_DIRECTORY, relative)).href);
    const [app, h, api, store, model, format, ui, overview, training, bots, tasks, evaluation, learning, memory] = await Promise.all([
      load("app.js"),
      load("lib/h.js"),
      load("lib/api.js"),
      load("lib/store.js"),
      load("lib/model.js"),
      load("lib/format.js"),
      load("lib/ui.js"),
      load("views/overview.js"),
      load("views/training.js"),
      load("views/bots.js"),
      load("views/tasks.js"),
      load("views/evaluation.js"),
      load("views/learning.js"),
      load("views/memory.js"),
    ]);
    return { app, h, api, store, model, format, ui, views: { overview, training, bots, tasks, evaluation, learning, memory } };
  })();
  return loaded;
}

/** The page exactly as the server would serve it, with the placeholders filled in. */
export async function pageHtml(token = "test-token", banner = "", title = "GameMind"): Promise<string> {
  const html = await readFile(path.join(PUBLIC_DIRECTORY, "index.html"), "utf8");
  return html.replace('"__CONTROL_TOKEN__"', JSON.stringify(token)).replace('"__BANNER__"', JSON.stringify(banner)).replace('"__TITLE__"', JSON.stringify(title));
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Route = unknown | ((params: URLSearchParams) => unknown);

export interface StubServer {
  readonly fetch: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;
  readonly requests: RecordedRequest[];
  snapshot: unknown;
  /** Query results by name (`learning`, `tasks`, ...); a function receives the URL's parameters. */
  readonly queries: Record<string, Route>;
  /** What each command answers; the default is a plain accepted result. */
  readonly commandResults: Record<string, { status?: number; body: Record<string, unknown> }>;
  failSnapshot: boolean;
  commands(): Array<{ type: string; payload: unknown }>;
}

export function stubServer(snapshot: unknown, queries: Record<string, Route> = {}): StubServer {
  const requests: RecordedRequest[] = [];
  const server: StubServer = {
    snapshot,
    queries,
    commandResults: {},
    failSnapshot: false,
    requests,
    commands: () => requests.filter((request) => request.method === "POST").map((request) => ({ type: (request.body as { type: string }).type, payload: (request.body as { payload?: unknown }).payload })),
    fetch: async (input, init = {}) => {
      const method = init.method ?? "GET";
      const url = String(input);
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ method, url, headers, body });
      const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (method === "POST" && url.endsWith("api/command")) {
        const configured = server.commandResults[(body as { type: string }).type];
        return configured ? json(configured.status ?? 200, configured.body) : json(200, { ok: true, message: `${(body as { type: string }).type} accepted.` });
      }
      const route = /api\/([\w-]+)(?:\?(.*))?$/.exec(url);
      if (!route) return json(404, { ok: false, message: `No route ${url}` });
      const name = route[1] as string;
      if (name === "snapshot") return server.failSnapshot ? json(503, { ok: false, message: "down" }) : json(200, server.snapshot);
      const query = server.queries[name];
      if (query === undefined) return json(404, { ok: false, message: `No query ${name}` });
      const params = new URLSearchParams(route[2] ?? "");
      return json(200, typeof query === "function" ? (query as (p: URLSearchParams) => unknown)(params) : query);
    },
  };
  return server;
}

export interface BootedPage {
  readonly page: Page;
  readonly clock: FakeClock;
  readonly app: any;
  readonly modules: UiModules;
  /** One full poll round (snapshot plus the tab's detail queries), then a render. */
  settle(): Promise<void>;
  restore(): void;
}

/** Boots the real page against `fetch`. Timers are fake: nothing polls until the test says so. */
export async function bootPage(options: { fetch: (input: string, init?: any) => Promise<Response>; token?: string; banner?: string; hash?: string; storedTheme?: string; html?: string; settle?: boolean }): Promise<BootedPage> {
  const modules = await loadUi(); // before the page is installed: app.js starts itself when it finds a global page
  const page = new Page({ html: options.html ?? (await pageHtml(options.token ?? "test-token", options.banner ?? "")) });
  if (options.hash) page.window.location.hash = options.hash;
  if (options.storedTheme) page.window.localStorage.setItem("gamemind.theme", options.storedTheme);
  const restore = page.install();
  const clock = new FakeClock();
  const app = modules.app.boot({
    window: page.window,
    document: page.document,
    fetch: options.fetch,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    confirm: page.window.confirm,
  });
  const booted: BootedPage = {
    page,
    clock,
    app,
    modules,
    async settle() {
      await app.store.tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    restore,
  };
  if (options.settle !== false) await booted.settle();
  return booted;
}

/** The page as a real Control Center server serves it (token injected), for end-to-end runs. */
export async function servedHtml(base: string): Promise<string> {
  const response = await fetch(new URL("./", base));
  if (response.status !== 200) throw new Error(`GET / answered ${response.status}`);
  return response.text();
}

/** A fetch that resolves the page's relative URLs against a real server. */
export function serverFetch(base: string): (input: string, init?: any) => Promise<Response> {
  return (input, init) => fetch(new URL(input, base), init);
}

export { waitUntil };
