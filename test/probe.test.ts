/**
 * The probe is the shortest live run: connect, one small step, one JSON report, disconnect. The original CLI printed the
 * first observation for a bare `--host` run; persistent sessions became the default, and without this the observation-only
 * check (`--one-shot` with no task) would have connected and left without a word.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runProbe, type ProbeOutput } from "../src/app/probe.js";
import { createSessionFixture } from "./support/session-fixture.js";

function capture(): ProbeOutput & { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { out: (text) => void stdout.push(text), err: (text) => void stderr.push(text), stdout, stderr };
}

test("an observation probe prints the first observation and the skills, then disconnects", async () => {
  const fixture = await createSessionFixture({ request: { mode: "one-shot", autonomy: false } });
  try {
    const io = capture();
    const code = await runProbe(fixture.session, { kind: "observe" }, io);
    assert.equal(code, 0);
    assert.equal(io.stderr.length, 0, io.stderr.join("\n"));
    assert.equal(io.stdout.length, 1, "exactly one report");
    const report = JSON.parse(io.stdout[0] as string) as { type: string; sessionId: string | null; observation: { sessionId: string; state: { player: { health: number | null } } } | null; availableSkills: Array<{ id: string }> };
    assert.equal(report.type, "initial-observation");
    assert.ok(report.observation, "the observation the agent actually holds is in the report");
    assert.equal(report.sessionId, report.observation?.sessionId, "the report names the adapter session the observation came from");
    assert.ok(report.availableSkills.some((skill) => skill.id === "minecraft.navigate"), "the skills the agent can run are listed");
    assert.equal(fixture.session.state, "shutdown", "the probe always disconnects");
  } finally {
    await fixture.close();
  }
});

test("a probe against a server that refuses the connection explains why, prints no report, and still shuts down", async () => {
  const fixture = await createSessionFixture({ failConnects: 1, request: { mode: "one-shot", autonomy: false } });
  try {
    const io = capture();
    const code = await runProbe(fixture.session, { kind: "observe" }, io);
    assert.equal(code, 1);
    assert.deepEqual(io.stdout, [], "no observation was made, so none is reported");
    assert.match(io.stderr.join("\n"), /Connection failed: /);
    assert.match(io.stderr.join("\n"), /ECONNREFUSED/, "the error the server returned is kept verbatim");
    assert.ok(io.stderr.length >= 3, "a summary, at least one hint and the reported error");
    assert.equal(fixture.session.state, "shutdown");
  } finally {
    await fixture.close();
  }
});

test("a look probe turns the bot once, reports the skill result, and disconnects", async () => {
  const fixture = await createSessionFixture({ request: { mode: "one-shot", autonomy: false } });
  try {
    const io = capture();
    const code = await runProbe(fixture.session, { kind: "look", yaw: Math.PI / 2, pitch: 0 }, io);
    const report = JSON.parse(io.stdout[0] as string) as { type: string; action: { status: string; skillId?: string } };
    assert.equal(report.type, "skill-result");
    assert.equal(code, report.action.status === "succeeded" ? 0 : 1, "the exit code follows the action's own verdict");
    assert.equal(fixture.session.state, "shutdown");
  } finally {
    await fixture.close();
  }
});
