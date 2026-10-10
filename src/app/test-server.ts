/**
 * The offline Minecraft test server (vanilla 1.20.4 in Docker, see src/testing/live/docker-compose.yml) as the Control
 * Center sees it: start and stop it with the same `docker compose` commands the README lists, read back whether it is
 * running, and check whether a host:port accepts connections before the operator presses Connect.
 *
 * Only these fixed argument lists are ever executed; nothing from the page is put on a command line, and no shell is used.
 * Starting and stopping run in the background: an image pull can take minutes, so the page polls `testServer` instead
 * of waiting on one request.
 */
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

export type TestServerState = "unknown" | "docker-missing" | "docker-stopped" | "stopped" | "starting" | "running" | "stopping" | "failed";

export interface TestServerStatus {
  readonly state: TestServerState;
  readonly message: string;
  /** Where GameMind connects to the test server, and the sign-in it uses (ONLINE_MODE is false there). */
  readonly connection: { readonly host: string; readonly port: number; readonly version: string; readonly auth: "offline" };
  readonly busy: boolean;
  readonly updatedAt: string;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a fixed command. Injected in tests; the default runs `docker` directly without a shell. */
export type ExecFn = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

export const TEST_SERVER_CONNECTION = { host: "127.0.0.1", port: 25565, version: "1.20.4", auth: "offline" } as const;
export const TEST_SERVER_COMPOSE_FILE = fileURLToPath(new URL("../testing/live/docker-compose.yml", import.meta.url));
const CONTAINER_NAME = "gamemind-mc-test";
const START_TIMEOUT_MS = 15 * 60 * 1000;
const QUICK_TIMEOUT_MS = 20 * 1000;

export const defaultExec: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ code: 127, stdout: "", stderr: "docker: not found" });
        return;
      }
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export class TestServerController {
  private state: TestServerState = "unknown";
  private message = "Not checked yet.";
  private busy = false;
  private updatedAt = new Date().toISOString();

  constructor(
    private readonly composeFile: string = TEST_SERVER_COMPOSE_FILE,
    private readonly exec: ExecFn = defaultExec,
  ) {}

  status(): TestServerStatus {
    return {
      state: this.state,
      message: this.message,
      connection: TEST_SERVER_CONNECTION,
      busy: this.busy,
      updatedAt: this.updatedAt,
    };
  }

  private set(state: TestServerState, message: string): void {
    this.state = state;
    this.message = message;
    this.updatedAt = new Date().toISOString();
  }

  /** Reads Docker and the container. Never changes anything. */
  async refresh(): Promise<TestServerStatus> {
    if (this.busy) return this.status();
    const version = await this.exec("docker", ["version", "--format", "{{.Server.Version}}"], QUICK_TIMEOUT_MS);
    if (version.code === 127 || /not found|not recognized/i.test(version.stderr)) {
      this.set("docker-missing", "Docker is not installed. Install Docker Desktop (with WSL integration) to run the offline test server.");
      return this.status();
    }
    if (version.code !== 0 || !version.stdout.trim()) {
      this.set("docker-stopped", "Docker is installed, but its engine does not answer. Start Docker Desktop and check again.");
      return this.status();
    }
    const running = await this.exec("docker", ["ps", "--filter", `name=^${CONTAINER_NAME}$`, "--filter", "status=running", "--format", "{{.Names}}"], QUICK_TIMEOUT_MS);
    if (running.code === 0 && running.stdout.trim().split("\n").includes(CONTAINER_NAME)) {
      this.set("running", `The test server is running on ${TEST_SERVER_CONNECTION.host}:${TEST_SERVER_CONNECTION.port}.`);
    } else if (this.state === "failed") {
      // Keep the failure message from the last start so the operator sees why it did not come up.
    } else {
      this.set("stopped", "The test server is not running. Press Start to run it.");
    }
    return this.status();
  }

  /** Starts the container in the background. The result says whether the start was accepted, not whether the server is up. */
  start(): { ok: boolean; message: string } {
    if (this.busy) return { ok: false, message: "The test server is already being started or stopped." };
    this.busy = true;
    this.set("starting", "Starting the test server. The first start downloads the server image and can take several minutes.");
    void this.run(["compose", "-f", this.composeFile, "up", "-d"], START_TIMEOUT_MS, "running", "failed", (text) => {
      return `Starting the test server failed: ${text || "docker compose exited with an error"}`;
    });
    return { ok: true, message: "Starting the test server. Watch the status on this page." };
  }

  stop(): { ok: boolean; message: string } {
    if (this.busy) return { ok: false, message: "The test server is already being started or stopped." };
    this.busy = true;
    this.set("stopping", "Stopping the test server. The world data is kept in a Docker volume.");
    void this.run(["compose", "-f", this.composeFile, "down"], QUICK_TIMEOUT_MS * 3, "stopped", "failed", (text) => {
      return `Stopping the test server failed: ${text || "docker compose exited with an error"}`;
    });
    return { ok: true, message: "Stopping the test server." };
  }

  private async run(args: string[], timeoutMs: number, onSuccess: TestServerState, onFailure: TestServerState, describe: (stderr: string) => string): Promise<void> {
    try {
      const result = await this.exec("docker", args, timeoutMs);
      if (result.code === 0) {
        this.set(onSuccess, onSuccess === "running" ? `The test server is starting on ${TEST_SERVER_CONNECTION.host}:${TEST_SERVER_CONNECTION.port}. It is ready when the port accepts connections.` : "The test server is stopped.");
      } else {
        const last = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
        this.set(onFailure, describe(last));
      }
    } catch (error) {
      this.set(onFailure, `Docker command failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
    }
  }
}

export type PortProbe = "open" | "refused" | "timeout" | "invalid";

/** A plain TCP connect with a short timeout. It does not speak the Minecraft protocol and it closes at once. */
export function probePort(host: string, port: number, timeoutMs = 1500): Promise<PortProbe> {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.trim().length === 0) return Promise.resolve("invalid");
  return new Promise((resolve) => {
    const socket = createConnection({ host: host.trim(), port });
    let settled = false;
    const finish = (result: PortProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () => finish("timeout"));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" ? "refused" : "timeout"));
  });
}

/** One sentence per probe result, written for the operator (no internal codes). */
export function describeProbe(host: string, port: number, result: PortProbe): string {
  switch (result) {
    case "open":
      return `Something answers at ${host}:${port}. Press Connect.`;
    case "refused":
      return `Nothing listens at ${host}:${port}. Start Minecraft or open the world to LAN, or check the port.`;
    case "timeout":
      return `No answer from ${host}:${port} within a few seconds. Check the host, the port and the firewall.`;
    default:
      return "Enter a host and a port between 1 and 65535 first.";
  }
}
