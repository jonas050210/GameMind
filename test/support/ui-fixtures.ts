/**
 * Real data for the page tests: a GameMindApp on the offline simulator, and the JSON it serves captured once, so tests that
 * stub the server still feed the page the genuine shape of every snapshot and query rather than a hand-written guess.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameMindApp } from "../../src/app/app.js";
import { BrowserOpener, type SpawnOpener } from "../../src/app/browser.js";
import { captureLogger, waitFor } from "./lifecycle-fixture.js";

export interface UiApp {
  readonly app: GameMindApp;
  readonly directory: string;
  readonly spawned: Array<{ command: string; args: readonly string[] }>;
  readonly base: string;
  get<T = unknown>(route: string): Promise<T>;
  command(type: string, payload?: unknown): Promise<{ status: number; body: { ok?: boolean; message?: string; data?: Record<string, unknown> } }>;
  close(): Promise<void>;
}

export async function startUiApp(options: { directory?: string } = {}): Promise<UiApp> {
  const directory = options.directory ?? (await mkdtemp(path.join(tmpdir(), "gamemind-ui-")));
  const logs = captureLogger("warn");
  const spawned: Array<{ command: string; args: readonly string[] }> = [];
  const spawnOpener: SpawnOpener = (command, args) => {
    spawned.push({ command, args });
    return { settled: Promise.resolve({ kind: "running" as const }) };
  };
  const app = await GameMindApp.start({
    root: directory,
    dataDirectory: path.join(directory, "data"),
    logger: logs.logger,
    version: "0.0.0-test",
    bind: { host: "127.0.0.1", port: 0 },
    instanceLock: false,
    sessionDefaults: { reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 10 } },
    browser: new BrowserOpener({ platform: { os: "linux", wsl: false, wslVersion: null, distro: null }, spawnOpener }),
    stepTimeoutMs: 5_000,
  });
  const base = app.url;
  const token = app.handle.token;
  return {
    app,
    directory,
    spawned,
    base,
    async get<T>(route: string): Promise<T> {
      const response = await fetch(new URL(route.replace(/^\//, ""), base));
      if (response.status !== 200) throw new Error(`GET ${route} answered ${response.status}`);
      return (await response.json()) as T;
    },
    async command(type, payload) {
      const response = await fetch(new URL("api/command", base), {
        method: "POST",
        headers: { "content-type": "application/json", "x-gamemind-token": token },
        body: JSON.stringify(payload === undefined ? { type } : { type, payload }),
      });
      return { status: response.status, body: (await response.json()) as { ok?: boolean; message?: string; data?: Record<string, unknown> } };
    },
    async close() {
      await app.shutdown("test complete");
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export const SIMULATED_CONNECT = { source: "simulated", scenarioId: "explore-remote-log", seed: 101, autonomy: false } as const;

export interface CapturedData {
  readonly snapshot: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  readonly queries: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

let captured: Promise<CapturedData> | null = null;

/** What a real app serves with an idle simulated session connected. Cloned per use: tests mutate their copy. */
export function capturedData(): Promise<CapturedData> {
  captured ??= (async () => {
    const fixture = await startUiApp();
    try {
      const connected = await fixture.command("connectSession", SIMULATED_CONNECT);
      if (connected.status !== 200) throw new Error(`could not connect the fixture session: ${connected.body.message}`);
      await waitFor(() => fixture.app.session?.state === "idle", "the fixture session became idle");
      const snapshot = await fixture.get<Record<string, any>>("api/snapshot?fresh=1"); // eslint-disable-line @typescript-eslint/no-explicit-any
      const queries: Record<string, unknown> = {};
      for (const name of ["tasks", "learning", "memory", "evaluation", "events", "jobs", "training-preflight", "diagnostics"]) {
        queries[name] = await fixture.get(`api/${name}`);
      }
      return { snapshot, queries };
    } finally {
      await fixture.close();
    }
  })();
  return captured;
}

/** A deep copy tests can change freely. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}
