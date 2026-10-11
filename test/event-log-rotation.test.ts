/**
 * Rotation of the event log's JSONL files. `keepFiles` is what the directory is left with in total, the
 * active file included, and slots a previous, larger configuration left behind are removed. Before, the
 * active file was renamed on top of a full history, so one file more than configured survived and a
 * forgotten `events.9.jsonl` stayed in the directory (and in the history the dashboard shows) forever.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppEventLog } from "../src/app/event-log.js";
import { defaultRedactionContext } from "../src/app/redact.js";

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gamemind-events-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function record(log: AppEventLog, from: number, to: number): void {
  for (let index = from; index < to; index += 1) {
    log.record({
      level: "info",
      category: "session",
      source: "system",
      message: `event ${index} ${"x".repeat(40)}`,
    });
  }
}

test("rotation leaves exactly keepFiles files and removes forgotten slots", async () => {
  await withDirectory(async (directory) => {
    const log = new AppEventLog({
      directory,
      redaction: defaultRedactionContext(directory),
      maxFileBytes: 200,
      keepFiles: 3,
    });
    record(log, 0, 40);
    await log.flush();
    assert.deepEqual((await readdir(directory)).sort(), ["events.1.jsonl", "events.2.jsonl", "events.jsonl"]);

    // A slot a previous, larger configuration left in the directory must not survive the next rotation.
    await writeFile(path.join(directory, "events.9.jsonl"), "{}\n", "utf8");
    record(log, 40, 90);
    await log.flush();
    assert.deepEqual((await readdir(directory)).sort(), ["events.1.jsonl", "events.2.jsonl", "events.jsonl"]);
    const active = await readFile(path.join(directory, "events.jsonl"), "utf8");
    assert.match(active, /event 89/, "the newest event is in the active file");
    // The surviving events are a gap-free suffix of everything that was written: rotation moves whole
    // files, so it can drop the oldest ones but never split the run.
    const kept: number[] = [];
    for (const name of ["events.jsonl", "events.1.jsonl", "events.2.jsonl"]) {
      const text = await readFile(path.join(directory, name), "utf8");
      for (const match of text.matchAll(/"message":"event (\d+) /g)) kept.push(Number(match[1]));
    }
    kept.sort((left, right) => left - right);
    assert.ok(kept.length > 0 && !kept.includes(0), "the oldest events were dropped");
    assert.deepEqual(
      kept,
      Array.from({ length: kept.length }, (_, index) => kept[0]! + index),
      "the kept events are consecutive",
    );
    assert.equal(kept[kept.length - 1], 89);

    // A fresh process reads the rotation back in chronological order and never sees the removed slot.
    const reloaded = new AppEventLog({ directory, redaction: defaultRedactionContext(directory) });
    const loaded = await reloaded.loadHistory(500);
    const history = reloaded.list({ scope: "previous", limit: 500 }).events;
    assert.ok(loaded > 0 && loaded === history.length);
    const sequences = history.map((event) => event.seq);
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right), "history is oldest-first");
    assert.ok(!history.some((event) => event.message.includes("event 3 ")), "the dropped events stay dropped");
  });
});

test("the active file is measured once per log, not once per event", async () => {
  await withDirectory(async (directory) => {
    const measured: string[] = [];
    const log = new AppEventLog({
      directory,
      redaction: defaultRedactionContext(directory),
      // Two lines fill the limit, so the counter decides about rotation several times per run.
      maxFileBytes: 200,
      keepFiles: 3,
      measureActiveFile: async (file) => {
        measured.push(file);
        // The file does not exist before the first append; the log counts from there.
        return (await readFile(file, "utf8").catch(() => "")).length;
      },
    });
    record(log, 0, 30);
    await log.flush();
    assert.equal(measured.length, 1, "the size is read from disk once; the counter follows the appends");
    assert.equal(path.basename(measured[0] ?? ""), "events.jsonl");
    const files = (await readdir(directory)).sort();
    assert.deepEqual(files, ["events.1.jsonl", "events.2.jsonl", "events.jsonl"], "rotation still happened on the counter alone");
  });
});

test("a log that finds an oversized active file still rotates it", async () => {
  await withDirectory(async (directory) => {
    await writeFile(path.join(directory, "events.jsonl"), `${"y".repeat(400)}\n`, "utf8");
    const log = new AppEventLog({
      directory,
      redaction: defaultRedactionContext(directory),
      maxFileBytes: 200,
      keepFiles: 2,
    });
    log.record({ level: "info", category: "session", source: "system", message: "after the restart" });
    await log.flush();
    assert.deepEqual((await readdir(directory)).sort(), ["events.1.jsonl", "events.jsonl"]);
    assert.match(await readFile(path.join(directory, "events.1.jsonl"), "utf8"), /^y{400}/, "the pre-existing file moved into history");
  });
});

test("keepFiles 1 keeps only the active file", async () => {
  await withDirectory(async (directory) => {
    const log = new AppEventLog({
      directory,
      redaction: defaultRedactionContext(directory),
      maxFileBytes: 200,
      keepFiles: 1,
    });
    record(log, 0, 40);
    await log.flush();
    assert.deepEqual(await readdir(directory), ["events.jsonl"]);
  });
});
