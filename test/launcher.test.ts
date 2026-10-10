/**
 * The Python launcher (`python3 main.py`). Its logic is unit-tested in tests_py with injected environments (WSL, Windows,
 * missing tools); this file runs those tests as part of `npm test`, and then starts the real launcher against the real
 * TypeScript app on the simulated world to prove the whole path: checks, child process, READY line, graceful stop.
 * None of this says anything about Windows itself: the Windows and WSL behaviour is covered by the injected tests only.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = (() => {
  for (const name of ["python3", "python"]) {
    const result = spawnSync(name, ["--version"], { encoding: "utf8" });
    if (result.status === 0 && /Python 3\.(\d+)/.test(result.stdout + result.stderr)) return name;
  }
  return null;
})();

test("launcher unit tests pass (WSL, Windows and missing-tool cases use injected environments)", { skip: python === null ? "python3 is not installed here, so the launcher cannot be tested" : false }, () => {
  const result = spawnSync(python!, ["-m", "unittest", "discover", "-s", "tests_py", "-v"], { cwd: root, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /Ran \d+ tests/);
});

test("python3 main.py --check validates the environment without starting anything", { skip: python === null ? "python3 is not installed here" : false }, () => {
  const result = spawnSync(python!, ["main.py", "--check", "--control-port", "0"], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Environment OK\./);
  assert.match(result.stdout, /Node:\s+\S+\s+22\./);
});

test("python3 main.py starts the TypeScript agent and Control Center, relays the READY banner, and stops cleanly on SIGINT", { skip: python === null || process.platform === "win32" ? "needs python3 and POSIX signals" : false, timeout: 90_000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), "gamemind-launcher-"));
  const child = spawn(python!, ["main.py", "--simulated", "--no-browser", "--control-port", "0", "--", "--data-dir", data, "--learning-dir", path.join(data, "learning"), "--no-instance-lock"], {
    cwd: root,
    env: { ...process.env, LOG_LEVEL: "error" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no Control Center banner within 60 s. Output so far:\n${output}`)), 60_000);
      const check = setInterval(() => {
        const match = /Control Center: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
        if (match?.[1]) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(match[1]);
        }
      }, 100);
      child.once("exit", (code) => {
        clearInterval(check);
        clearTimeout(timer);
        reject(new Error(`the launcher exited early with code ${code}. Output:\n${output}`));
      });
    });
    const health = (await (await fetch(`${url}api/health`)).json()) as { app: string; localOnly: boolean };
    assert.equal(health.app, "gamemind", "the launcher started the real app");
    assert.equal(health.localOnly, true, "bound to this machine only");
    assert.doesNotMatch(output, /GAMEMIND_READY/, "the machine-readable line is not shown to the person");
    assert.match(output, /Press Ctrl-C to stop GameMind/);

    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.kill("SIGINT");
    let guard: NodeJS.Timeout | null = null;
    const code = await Promise.race([
      exited,
      new Promise<"timeout">((resolve) => {
        guard = setTimeout(() => resolve("timeout"), 45_000);
      }),
    ]);
    if (guard) clearTimeout(guard);
    assert.equal(code, 0, `the launcher did not stop cleanly. Output:\n${output}`);
    await assert.rejects(fetch(`${url}api/health`), "the Control Center is gone: no orphaned agent process keeps serving it");
    assert.match(output, /Stopping GameMind \(SIGINT\)/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(data, { recursive: true, force: true });
  }
});
