/** The offline test server controller and the port check. Docker is replaced by a fake; the port check uses a real loopback socket. */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { TestServerController, describeProbe, probePort, type ExecFn } from "../src/app/test-server.js";

function fakeDocker(script: Record<string, { code: number; stdout?: string; stderr?: string }>): { exec: ExecFn; calls: string[] } {
  const calls: string[] = [];
  const exec: ExecFn = async (file, args) => {
    const key = args.join(" ");
    calls.push(`${file} ${key}`);
    const hit = Object.entries(script).find(([prefix]) => key.startsWith(prefix));
    if (!hit) return { code: 0, stdout: "", stderr: "" };
    return { code: hit[1].code, stdout: hit[1].stdout ?? "", stderr: hit[1].stderr ?? "" };
  };
  return { exec, calls };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("without Docker the page is told to install it, and nothing is started", async () => {
  const { exec, calls } = fakeDocker({ version: { code: 127, stderr: "docker: not found" } });
  const controller = new TestServerController("/x/compose.yml", exec);
  const status = await controller.refresh();
  assert.equal(status.state, "docker-missing");
  assert.match(status.message, /Install Docker Desktop/);
  assert.equal(calls.some((call) => call.includes(" up ")), false);
});

test("Docker installed but its engine down says so", async () => {
  const { exec } = fakeDocker({ version: { code: 1, stderr: "Cannot connect to the Docker daemon" } });
  const status = await new TestServerController("/x/compose.yml", exec).refresh();
  assert.equal(status.state, "docker-stopped");
  assert.match(status.message, /engine does not answer/);
});

test("start runs a fixed compose argument list and ends in running once the container is up", async () => {
  const { exec, calls } = fakeDocker({
    version: { code: 0, stdout: "27.3.1\n" },
    compose: { code: 0 },
    ps: { code: 0, stdout: "gamemind-mc-test\n" },
  });
  const controller = new TestServerController("/x/compose.yml", exec);
  const accepted = controller.start();
  assert.equal(accepted.ok, true);
  assert.equal(controller.status().busy, true);
  await waitFor(() => !controller.status().busy);
  assert.equal(controller.status().state, "running");
  assert.ok(calls.includes("docker compose -f /x/compose.yml up -d"), calls.join("\n"));
  const refreshed = await controller.refresh();
  assert.equal(refreshed.state, "running");
  assert.equal(refreshed.connection.auth, "offline");
  assert.equal(refreshed.connection.port, 25565);
});

test("a failed start keeps the reason from Docker in plain words", async () => {
  const { exec } = fakeDocker({
    compose: { code: 1, stderr: "line one\nError: port is already allocated" },
  });
  const controller = new TestServerController("/x/compose.yml", exec);
  controller.start();
  await waitFor(() => !controller.status().busy);
  const status = controller.status();
  assert.equal(status.state, "failed");
  assert.match(status.message, /port is already allocated/);
});

test("a second start while one is busy is refused, not queued", async () => {
  let release: () => void = () => {};
  const exec: ExecFn = () => new Promise((resolve) => {
    release = () => resolve({ code: 0, stdout: "", stderr: "" });
  });
  const controller = new TestServerController("/x/compose.yml", exec);
  assert.equal(controller.start().ok, true);
  const second = controller.start();
  assert.equal(second.ok, false);
  assert.match(second.message, /already being started or stopped/);
  release();
  await waitFor(() => !controller.status().busy);
});

test("stop ends in stopped and keeps the connection details", async () => {
  const { exec, calls } = fakeDocker({ compose: { code: 0 } });
  const controller = new TestServerController("/x/compose.yml", exec);
  controller.stop();
  await waitFor(() => !controller.status().busy);
  assert.equal(controller.status().state, "stopped");
  assert.ok(calls.includes("docker compose -f /x/compose.yml down"));
});

test("probePort reports an open loopback port and a closed one", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    assert.equal(await probePort("127.0.0.1", port), "open");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(await probePort("127.0.0.1", port), "refused");
});

test("probePort refuses nonsense input without touching the network", async () => {
  assert.equal(await probePort("127.0.0.1", 0), "invalid");
  assert.equal(await probePort("127.0.0.1", 70000), "invalid");
  assert.equal(await probePort("  ", 25565), "invalid");
});

test("probe messages tell the operator what to do", () => {
  assert.match(describeProbe("127.0.0.1", 25565, "open"), /Press Connect/);
  assert.match(describeProbe("127.0.0.1", 25565, "refused"), /Start Minecraft/);
  assert.match(describeProbe("127.0.0.1", 25565, "invalid"), /between 1 and 65535/);
});
