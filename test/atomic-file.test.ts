/**
 * Atomic file replacement under concurrency. The Control Center can send two commands that save the same file at once (a
 * double click on a roadmap decision, a refresh finishing while an operator action saves); with one shared temp name per
 * process, the second rename failed with ENOENT and the request answered 500.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { temporaryPathFor, writeFileAtomic } from "../src/core/atomic-file.js";
import { RoadmapService } from "../src/roadmap/service.js";
import { writeJsonAtomic } from "../src/training/state.js";

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-atomic-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("temporary names are unique per write, so writers can never share a half-written file", () => {
  const names = new Set(Array.from({ length: 200 }, () => temporaryPathFor("/data/state.json")));
  assert.equal(names.size, 200);
  assert.ok([...names].every((name) => name.startsWith("/data/state.json.") && name.endsWith(".tmp")));
});

test("many simultaneous writes to one file all succeed and the last requested content wins, with no temp files left", async () => {
  await withDirectory(async (directory) => {
    const target = path.join(directory, "nested", "state.json");
    const writes = Array.from({ length: 60 }, (_, index) => writeFileAtomic(target, `${"x".repeat((60 - index) * 500)}#${index}\n`));
    await Promise.all(writes);
    const final = await readFile(target, "utf8");
    assert.ok(final.endsWith("#59\n"), "the write requested last is the one on disk, even though it was the smallest and would finish first");
    assert.deepEqual((await readdir(path.dirname(target))).filter((name) => name.endsWith(".tmp")), []);
  });
});

test("a failed write is reported and cleans up its temp file, and the file can be written again afterwards", async () => {
  await withDirectory(async (directory) => {
    const target = path.join(directory, "state.json");
    await mkdir(target); // a directory where the file should be: the rename cannot succeed
    await assert.rejects(() => writeFileAtomic(target, "never lands"), /EISDIR|EPERM|ENOTEMPTY|EEXIST|EACCES/);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), [], "no temp file is left behind");
    await rm(target, { recursive: true });
    await writeFileAtomic(target, "recovered\n");
    assert.equal(await readFile(target, "utf8"), "recovered\n");
  });
});

test("a parent that is a file is reported instead of hanging, and does not disturb writes to other files", async () => {
  await withDirectory(async (directory) => {
    const blocker = path.join(directory, "blocker");
    await writeFile(blocker, "a file where a directory is needed");
    const good = path.join(directory, "good.json");
    const [bad, fine] = await Promise.allSettled([writeFileAtomic(path.join(blocker, "child.json"), "x"), writeFileAtomic(good, "ok\n")]);
    assert.equal(bad.status, "rejected");
    assert.equal(fine.status, "fulfilled");
    assert.equal(await readFile(good, "utf8"), "ok\n");
  });
});

test("a failure in the middle of the queue for one file does not block or reorder the writes around it", async () => {
  await withDirectory(async (directory) => {
    const target = path.join(directory, "state.json");
    const results = await Promise.allSettled([
      writeFileAtomic(target, "first\n"),
      writeFileAtomic(target, undefined as unknown as string), // fails inside the queue, after the file was prepared
      writeFileAtomic(target, "last\n"),
    ]);
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
    assert.equal(await readFile(target, "utf8"), "last\n");
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  });
});

test("writes to different files do not wait for each other and the file mode is honoured", async () => {
  await withDirectory(async (directory) => {
    const a = path.join(directory, "a.json");
    const b = path.join(directory, "b.json");
    await Promise.all([writeFileAtomic(a, "a\n", { mode: 0o600 }), writeFileAtomic(b, "b\n")]);
    assert.equal(await readFile(a, "utf8"), "a\n");
    assert.equal(await readFile(b, "utf8"), "b\n");
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      assert.equal((await stat(a)).mode & 0o777, 0o600);
    }
  });
});

test("the training state writer (used by the roadmap, training state and reports) survives concurrent saves", async () => {
  await withDirectory(async (directory) => {
    const target = path.join(directory, "roadmap", "state.json");
    await Promise.all(Array.from({ length: 25 }, (_, index) => writeJsonAtomic(target, { index })));
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { index: 24 });
  });
});

test("roadmap: operator decisions saved while a refresh is writing never fail and never lose the decision", async () => {
  await withDirectory(async (directory) => {
    const options = {
      root: path.join(directory, "roadmap"),
      profileDirectory: path.join(directory, "profile"),
      testRecordPath: path.join(directory, "tests.json"),
      trainingRoot: path.join(directory, "training"),
      episodeFiles: [],
      liveVerificationPath: path.join(directory, "live.json"),
    };
    await writeFile(options.testRecordPath, JSON.stringify({ measuredAt: "2026-10-01T00:00:00.000Z", passed: 10, failed: 2, failures: ["flaky: one", "flaky: two"] }));
    const service = new RoadmapService(options);
    const first = await service.refresh();
    const items = first.items.filter((item) => item.fingerprint.startsWith("reliability.test:"));
    assert.ok(items.length >= 2);
    // The shape of the original failure: several saves and refreshes in flight together.
    const results = await Promise.all([
      service.act({ fingerprint: items[0]?.fingerprint, action: "plan", note: "a" }),
      service.act({ fingerprint: items[1]?.fingerprint, action: "plan", note: "b" }),
      service.refresh(),
      service.act({ fingerprint: items[0]?.fingerprint, action: "pin" }),
      service.refresh(),
    ].map((operation) => operation.then((value) => value, (error: Error) => ({ ok: false as const, message: error.message }))));
    for (const result of results) {
      if ("ok" in result) assert.equal(result.ok, true, "message" in result ? String(result.message) : "");
    }
    await service.idle();
    assert.deepEqual((await readdir(options.root)).filter((name) => name.endsWith(".tmp")), []);
    const reloaded = await new RoadmapService(options).refresh();
    assert.equal(reloaded.items.find((item) => item.fingerprint === items[0]?.fingerprint)?.status, "planned");
    assert.equal(reloaded.items.find((item) => item.fingerprint === items[1]?.fingerprint)?.status, "planned");
  });
});
