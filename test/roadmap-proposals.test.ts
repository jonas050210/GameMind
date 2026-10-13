/**
 * Operator-authored roadmap proposals.
 *
 * The point of these tests is the one property that makes proposals safe to allow at all: a proposal carries no
 * measurement, so writing an idea down can never undo a decision somebody already made about a finding. It also
 * pins that a malformed file loads nothing and says why, instead of half-applying.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProposals, withoutCollisions } from "../src/roadmap/proposals.js";
import { loadEvidence, type EvidenceBundle } from "../src/roadmap/evidence.js";
import { deriveCandidates } from "../src/roadmap/rules.js";
import { applyAction, nextRecommendedTask, reconcile, type RoadmapCandidate } from "../src/roadmap/model.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED_FILE = path.join(ROOT, "config", "roadmap-proposals.json");
const T0 = "2026-10-10T08:00:00.000Z";
const T1 = "2026-10-13T09:00:00.000Z";

function file(proposals: unknown[], schemaVersion: unknown = 1): string {
  return JSON.stringify({ schemaVersion, proposals });
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    fingerprint: "survival.example-proposal",
    title: "An example proposal",
    category: "survival",
    kind: "idea",
    explanation: "Why this is worth doing, in at least a sentence.",
    ...overrides,
  };
}

async function withDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "gamemind-proposals-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function bundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return { profiles: [], proposals: [], tests: null, episodes: null, liveVerification: null, runtime: null, ...overrides };
}

test("a valid file becomes candidates, and every one of them carries no measurement", async () => {
  await withDirectory(async (directory) => {
    const pathA = path.join(directory, "proposals.json");
    await writeFile(pathA, file([proposal(), proposal({ fingerprint: "reliability.second", title: "A second proposal", category: "reliability", kind: "known-limitation" })]));
    const loaded = await loadProposals([pathA]);
    assert.equal(loaded.files[0]?.found, true);
    assert.equal(loaded.files[0]?.problem, null);
    assert.equal(loaded.candidates.length, 2);
    for (const candidate of loaded.candidates) {
      assert.equal(candidate.measuredAt, null, "a proposal is a plan, not a measurement");
      assert.ok(candidate.evidence.length >= 1, "every candidate can say where it came from");
      assert.match(candidate.evidence[0]!.source, /proposals\.json/, "and names the file it was read from");
    }
    assert.equal(loaded.candidates[0]!.expectedBenefit.length > 0, true, "the benefit has a default, never an empty string");
  });
});

test("a proposal can never reopen a finding that was implemented, verified or dismissed", async () => {
  const settled = (fingerprint: string): RoadmapCandidate => ({
    fingerprint, title: "Settled finding", category: "reliability", kind: "defect", explanation: "measured before",
    evidence: [], expectedBenefit: "b", effort: 1, impact: 4, urgency: 4, confidence: 0.9, dependencies: [],
    severity: 5, measuredAt: T0,
  });
  const proposalCandidate = (fingerprint: string): RoadmapCandidate => ({
    ...settled(fingerprint), kind: "idea", confidence: 0.4, severity: 1, measuredAt: null, title: "A proposal about the same thing",
  });

  // Implemented, then a proposal appears for the same fingerprint: still implemented.
  let decisions = reconcile({ candidates: [settled("a")], decisions: {}, now: T0, evidenceAt: T0 }).decisions;
  applyAction(decisions.a!, "implement", null, T0, 5, "done");
  let next = reconcile({ candidates: [proposalCandidate("a")], decisions, now: T1, evidenceAt: T1 });
  assert.equal(next.items[0]!.status, "implemented", "a proposal carries no measurement, so it cannot reopen this");

  // Dismissed, then a proposal: still dismissed, however high the proposal's severity.
  decisions = reconcile({ candidates: [settled("b")], decisions: {}, now: T0, evidenceAt: T0 }).decisions;
  applyAction(decisions.b!, "dismiss", null, T0, 5, "not worth it");
  next = reconcile({ candidates: [{ ...proposalCandidate("b"), severity: 100 }], decisions, now: T1, evidenceAt: T1 });
  assert.equal(next.items[0]!.status, "dismissed");

  // Verified through the real path: implemented, then the finding disappears while newer evidence exists.
  decisions = reconcile({ candidates: [settled("c")], decisions: {}, now: T0, evidenceAt: T0 }).decisions;
  applyAction(decisions.c!, "implement", null, T0, 5, null);
  decisions = reconcile({ candidates: [], decisions, now: T1, evidenceAt: T1 }).decisions;
  assert.equal(decisions.c!.status, "verified", "the finding is gone on newer evidence");
  next = reconcile({ candidates: [proposalCandidate("c")], decisions, now: T1, evidenceAt: T1 });
  assert.equal(next.items[0]!.status, "verified", "no proposal-driven reopening");
});

test("idea proposals are listed but never recommended as the next task", async () => {
  const ideas = await loadProposals([TRACKED_FILE]);
  const candidates = deriveCandidates(bundle({ proposals: ideas.candidates }));
  const items = reconcile({ candidates, decisions: {}, now: T1, evidenceAt: null }).items;
  const recommended = nextRecommendedTask(items);
  assert.ok(recommended, "something is recommended");
  assert.notEqual(recommended.kind, "idea", "an idea is optional work and is never pushed to the front");
  assert.ok(items.some((item) => item.kind === "idea"), "ideas are still in the list");
});

test("a malformed file loads nothing and says why", async () => {
  await withDirectory(async (directory) => {
    const cases: Array<[string, string, RegExp]> = [
      ["not json", "{ this is not json", /not valid JSON/],
      ["wrong version", file([proposal()], 2), /schemaVersion/],
      ["unknown key", file([{ ...proposal(), priority: 5 }]), /priority/],
      ["bad fingerprint", file([proposal({ fingerprint: "Has Spaces" })]), /fingerprint/],
      ["unknown category", file([proposal({ category: "cooking" })]), /category/],
      ["unknown kind", file([proposal({ kind: "guess" })]), /kind/],
      ["impact out of range", file([proposal({ impact: 9 })]), /impact/],
      ["not an object", JSON.stringify([proposal()]), /expected object/],
    ];
    for (const [name, contents, expected] of cases) {
      const target = path.join(directory, `${name.replace(/ /g, "-")}.json`);
      await writeFile(target, contents);
      const loaded = await loadProposals([target]);
      assert.equal(loaded.candidates.length, 0, `${name}: nothing is half-applied`);
      assert.match(loaded.files[0]?.problem ?? "", expected, `${name}: the reason is quoted`);
    }
  });
});

test("a missing file is not an error, and later paths win on a duplicate fingerprint", async () => {
  await withDirectory(async (directory) => {
    const absent = path.join(directory, "does-not-exist.json");
    const tracked = path.join(directory, "tracked.json");
    const local = path.join(directory, "local.json");
    await writeFile(tracked, file([proposal({ title: "From the tracked file" })]));
    await writeFile(local, file([proposal({ title: "From the local file" })]));
    const loaded = await loadProposals([absent, tracked, local]);
    assert.equal(loaded.files[0]?.found, false);
    assert.equal(loaded.files[0]?.problem, null, "an absent local file is normal, not a problem");
    assert.equal(loaded.candidates.length, 1);
    assert.equal(loaded.candidates[0]!.title, "From the local file", "the local file wins, so it can be tried before committing");
  });
});

test("a proposal that collides with a measured finding is dropped in favour of the finding", () => {
  const derived: RoadmapCandidate = {
    fingerprint: "reliability.test:flaky", title: "Measured failure", category: "reliability", kind: "defect",
    explanation: "measured", evidence: [], expectedBenefit: "b", effort: 1, impact: 4, urgency: 4, confidence: 0.9,
    dependencies: [], severity: 5, measuredAt: T0,
  };
  const colliding: RoadmapCandidate = { ...derived, kind: "idea", title: "A note about the same thing", measuredAt: null };
  const unique: RoadmapCandidate = { ...derived, fingerprint: "survival.only-proposed", measuredAt: null };
  const result = withoutCollisions([colliding, unique], [derived]);
  assert.deepEqual(result.dropped, ["reliability.test:flaky"]);
  assert.deepEqual(result.kept.map((candidate) => candidate.fingerprint), ["survival.only-proposed"]);
  const candidates = deriveCandidates(bundle({ proposals: [colliding, unique] }));
  assert.equal(candidates.filter((candidate) => candidate.fingerprint === "reliability.test:flaky").length, 1, "one entry per fingerprint");
});

test("loadEvidence reports each proposal file separately, with the problem when there is one", async () => {
  await withDirectory(async (directory) => {
    const good = path.join(directory, "good.json");
    const bad = path.join(directory, "bad.json");
    await writeFile(good, file([proposal()]));
    await writeFile(bad, "not json at all");
    const loaded = await loadEvidence({
      profileDirectory: path.join(directory, "profile"),
      testRecordPath: path.join(directory, "tests.json"),
      episodeFiles: [],
      liveVerificationPath: path.join(directory, "live.json"),
      proposalPaths: [good, bad],
      runtime: null,
    });
    assert.equal(loaded.bundle.proposals.length, 1);
    const sources = loaded.sources.filter((source) => source.name.startsWith("operator proposals"));
    assert.equal(sources.length, 2, "one row per file, so the operator can see which one failed");
    assert.equal(sources[0]?.available, true);
    assert.equal(sources[1]?.available, false);
    assert.match(sources[1]?.problem ?? "", /not valid JSON/);
    assert.equal(loaded.evidenceAt, null, "proposals are not measurements and do not date the evidence");
  });
});

test("the tracked proposal file in this repository is valid and internally consistent", async () => {
  // Guards the file itself: it is hand-written, it is the plan of record, and a typo in it would otherwise show
  // up only as a missing roadmap item.
  const loaded = await loadProposals([TRACKED_FILE]);
  assert.equal(loaded.files[0]?.problem, null, loaded.files[0]?.problem ?? "");
  assert.ok(loaded.candidates.length >= 30, `${loaded.candidates.length} proposals were loaded`);

  const fingerprints = loaded.candidates.map((candidate) => candidate.fingerprint);
  assert.equal(new Set(fingerprints).size, fingerprints.length, "fingerprints are unique");
  for (const candidate of loaded.candidates) {
    assert.match(candidate.fingerprint, /^[a-z-]+\.[a-z0-9.-]+$/, "category.subject, so a collision with a rule fingerprint is visible");
    assert.ok(candidate.explanation.length >= 40, `${candidate.fingerprint} explains itself`);
    assert.equal(candidate.measuredAt, null);
    assert.ok(candidate.impact >= 1 && candidate.impact <= 5 && candidate.urgency >= 1 && candidate.urgency <= 5);
  }

  // The four items the plan called settled by code rather than by proposal must not be sitting in the file.
  const raw = JSON.parse(await readFile(TRACKED_FILE, "utf8")) as { proposals: Array<{ fingerprint: string }> };
  const listed = new Set(raw.proposals.map((entry) => entry.fingerprint));
  for (const done of ["survival.combat-health-floor", "survival.hostile-classification", "observation.enderman-not-hostile", "survival.attack-cooldown-table"]) {
    assert.equal(listed.has(done), false, `${done} is implemented, so it is not proposed`);
  }
});
