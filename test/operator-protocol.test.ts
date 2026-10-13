/**
 * The live protocol has to stay honest without a server.
 *
 * The steps are the part an operator follows, so the catalogue itself is checked here (every step says what
 * to do, what to expect and what to write down), and so is the judgement of a result file: a step may not
 * claim `verified` without the observation and the values it asks for. LIVE_FINDINGS.md §5 records what
 * happens when that rule is missing.
 *
 * The protocol document is checked against the catalogue in both directions, because a checklist that drifts
 * from the steps the validator knows is worse than no checklist.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPERATOR_PROTOCOL_STEPS,
  describeProtocol,
  judgeProtocolResult,
  parseProtocolResult,
  protocolTemplate,
  type ProtocolResult,
  type ProtocolStepResult,
} from "../src/testing/live/operator-protocol.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function filledSteps(): ProtocolStepResult[] {
  return OPERATOR_PROTOCOL_STEPS.map((step) => ({
    id: step.id,
    outcome: "verified" as const,
    observed: `watched ${step.id} happen`,
    values: Object.fromEntries(step.evidence.map((field) => [field, 1])),
  }));
}

function filledResult(steps = filledSteps()): ProtocolResult {
  const template = protocolTemplate("127.0.0.1:25565", "Tester", new Date("2026-10-13T10:00:00Z"));
  return { ...template, finishedAt: "2026-10-13T11:05:00Z", steps };
}

test("every step says what to do, what to expect and what to write down", () => {
  assert.equal(OPERATOR_PROTOCOL_STEPS.length, 15);
  const ids = new Set<string>();
  for (const step of OPERATOR_PROTOCOL_STEPS) {
    assert.ok(!ids.has(step.id), `duplicate step ${step.id}`);
    ids.add(step.id);
    assert.ok(step.title.length > 5, `${step.id} needs a title`);
    assert.ok(step.precondition.length > 10, `${step.id} needs a precondition`);
    assert.ok(step.expected.length > 10, `${step.id} needs an expectation`);
    assert.ok(["chat", "combat", "survival", "shelter", "metrics"].includes(step.group), `${step.id} group`);
    for (const field of step.evidence) {
      assert.match(field, /^[a-zA-Z][a-zA-Z0-9]*$/, `${step.id} evidence '${field}' must be a plain name`);
    }
  }
});

test("a fresh template is fifteen pending steps and counts as no result", () => {
  const template = protocolTemplate("mc.example.com", "Operator");
  const verdict = judgeProtocolResult(template);
  assert.equal(verdict.pending, 15);
  assert.equal(verdict.verified, 0);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.problems.length, 15);
  assert.ok(verdict.problems.every((problem) => /still pending/.test(problem.problem)));
});

test("a session that recorded everything counts as a result", () => {
  const verdict = judgeProtocolResult(filledResult());
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verified, 15);
});

test("verified without the values it asks for is refused", () => {
  const steps = filledSteps();
  const combat = steps.find((step) => step.id === "combat-opt-in-kills");
  assert.ok(combat);
  delete combat.values["healthAfter"];
  combat.observed = "";

  const verdict = judgeProtocolResult(filledResult(steps));
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.problems.some((problem) => problem.stepId === "combat-opt-in-kills" && /value 'healthAfter'/.test(problem.problem)),
    "the missing value is named",
  );
  assert.ok(
    verdict.problems.some((problem) => problem.stepId === "combat-opt-in-kills" && /nothing was written down/.test(problem.problem)),
    "an empty observation is refused too",
  );
});

test("a skipped step needs a reason, a failed step needs what happened", () => {
  const steps = filledSteps();
  const skipped = steps.find((step) => step.id === "combat-creeper-avoided");
  const failed = steps.find((step) => step.id === "shelter-breaks-out");
  assert.ok(skipped && failed);
  skipped.outcome = "skipped";
  failed.outcome = "failed";
  failed.observed = "it stayed inside the sealed shelter for two minutes";

  const verdict = judgeProtocolResult(filledResult(steps));
  assert.equal(verdict.skipped, 1);
  assert.equal(verdict.failed, 1);
  assert.equal(verdict.verified, 13);
  assert.ok(
    verdict.problems.some((problem) => problem.stepId === "combat-creeper-avoided" && /without a reason/.test(problem.problem)),
    "skipping silently is refused",
  );
  assert.ok(
    !verdict.problems.some((problem) => problem.stepId === "shelter-breaks-out"),
    "an honest failure is a result, not a problem",
  );
});

test("steps that are not part of the protocol and steps nobody reached are both reported", () => {
  const steps = [...filledSteps().slice(0, 14), { id: "chat-teleport", outcome: "verified" as const, observed: "worked", values: {} }];
  const verdict = judgeProtocolResult(filledResult(steps));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.stepId === "chat-teleport" && /not a step/.test(problem.problem)));
  assert.ok(verdict.problems.some((problem) => problem.stepId === "metrics-loop-targets" && /missing/.test(problem.problem)));
});

test("a result file that is not one says why", () => {
  assert.match(parseProtocolResult("{").error ?? "", /not valid JSON/);
  const noServer = parseProtocolResult(JSON.stringify({ ...filledResult(), server: "" }));
  assert.equal(noServer.result, null);
  assert.match(noServer.error ?? "", /server/);
  const wrongVersion = parseProtocolResult(JSON.stringify({ ...filledResult(), schemaVersion: 2 }));
  assert.match(wrongVersion.error ?? "", /schemaVersion/);

  const good = parseProtocolResult(JSON.stringify(filledResult()));
  assert.equal(good.error, null);
  assert.equal(good.result?.steps.length, 15);
});

test("the printed checklist and the document name every step and every value", () => {
  const printed = describeProtocol().join("\n");
  const document = readFileSync(path.join(ROOT, "docs", "LIVE_PROTOCOL.md"), "utf8");
  for (const step of OPERATOR_PROTOCOL_STEPS) {
    for (const text of [printed, document]) {
      assert.ok(text.includes(step.id), `${step.id} is missing`);
    }
    for (const field of step.evidence) {
      assert.ok(printed.includes(field), `${step.id}: '${field}' is missing from the checklist`);
      assert.ok(document.includes(field), `${step.id}: '${field}' is missing from the document`);
    }
  }
  assert.match(document, /A failed step is a result/, "the document has to keep the honesty rule");
  assert.match(
    document,
    /not authorized by this document/,
    "the document must not read as permission to touch a live world, exactly like LIVE_VERIFICATION.md",
  );
  assert.ok(
    document.includes("changes the world") || document.includes("*changes the world*"),
    "the destructive steps have to be called out",
  );
});
