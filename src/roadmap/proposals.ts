/**
 * Operator-authored roadmap proposals.
 *
 * The rules in `rules.ts` only ever produce findings from *recorded evidence*: a profile, a test record,
 * episode statistics, a live verification file or the running loop. That is the right behaviour for defects,
 * but it leaves planned work with nowhere to live — an improvement nobody has measured yet simply does not
 * exist in the roadmap, so it is tracked in chat or in a document and then forgotten.
 *
 * These files close that gap without weakening the rule: a proposal is read, validated and turned into a
 * candidate, but it carries **no measurement of its own**. `measuredAt` is always null, which has one
 * consequence that matters: `newerThan(null, ...)` is false, so a proposal can never reopen a finding that was
 * already implemented, verified or dismissed. Writing an idea down cannot undo somebody's decision about it.
 *
 * Two locations are read, later paths winning on a duplicate fingerprint:
 *  - the tracked file (`config/roadmap-proposals.json`), versioned with the code and reviewed like it;
 *  - the local file (`data/roadmap/proposals.json`), gitignored, for proposals an operator wants to try before
 *    committing them.
 *
 * A malformed file loads nothing and says why. No entry is invented, defaulted or half-applied.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ROADMAP_CATEGORIES, ROADMAP_KINDS, type RoadmapCandidate, type RoadmapEvidence } from "./model.js";

/** Fingerprints group findings across refreshes, so they are stable identifiers: lowercase, dot- or dash-separated. */
const FINGERPRINT_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

const proposalEvidenceSchema = z
  .object({
    source: z.string().min(1).max(160),
    metric: z.string().min(1).max(160),
    value: z.string().min(1).max(160),
  })
  .strict();

const proposalSchema = z
  .object({
    fingerprint: z.string().min(3).max(96).regex(FINGERPRINT_PATTERN, "lowercase, digits, '.' or '-', starting with a letter"),
    title: z.string().min(5).max(160),
    category: z.enum(ROADMAP_CATEGORIES),
    kind: z.enum(ROADMAP_KINDS),
    /** Why this is worth doing. For a hypothesis it has to say that the cause is not established. */
    explanation: z.string().min(10).max(1_200),
    expectedBenefit: z.string().min(1).max(400).default("Not stated in the proposal."),
    effort: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
    impact: z.number().int().min(1).max(5).default(2),
    urgency: z.number().int().min(1).max(5).default(1),
    /** Kept low by default: a proposal is a plan, not a measurement, and confidence divides nothing but the score. */
    confidence: z.number().min(0.05).max(1).default(0.4),
    dependencies: z.array(z.string().min(1).max(160)).max(12).default([]),
    evidence: z.array(proposalEvidenceSchema).max(8).default([]),
    severity: z.number().min(0).max(100).default(1),
  })
  .strict();

const proposalsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposals: z.array(proposalSchema).max(400),
  })
  .strict();

export type RoadmapProposal = z.infer<typeof proposalSchema>;

export interface ProposalFileResult {
  readonly path: string;
  readonly found: boolean;
  readonly proposals: readonly RoadmapProposal[];
  /** Why nothing was loaded: a parse failure or a validation failure, quoted verbatim. Null when it loaded. */
  readonly problem: string | null;
}

export interface LoadedProposals {
  /** One entry per path that was read, in order, so a caller can report each separately. */
  readonly files: readonly ProposalFileResult[];
  /** Merged candidates, later paths winning on a duplicate fingerprint. */
  readonly candidates: readonly RoadmapCandidate[];
}

function describeProblems(error: z.ZodError): string {
  const issues = error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
  const more = error.issues.length > issues.length ? ` (+${error.issues.length - issues.length} more)` : "";
  return `${issues.join("; ")}${more}`;
}

async function readProposalFile(path: string): Promise<ProposalFileResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    // A missing file is normal: the local proposals file only exists once somebody writes one.
    return { path, found: false, proposals: [], problem: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { path, found: true, proposals: [], problem: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = proposalsFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { path, found: true, proposals: [], problem: describeProblems(parsed.error) };
  }
  return { path, found: true, proposals: parsed.data.proposals, problem: null };
}

function toCandidate(proposal: RoadmapProposal, path: string): RoadmapCandidate {
  const evidence: readonly RoadmapEvidence[] = proposal.evidence.length > 0
    ? proposal.evidence.map((entry) => ({ ...entry, measuredAt: null }))
    : [{ source: path, metric: "operator proposal", value: proposal.kind, measuredAt: null }];
  return {
    fingerprint: proposal.fingerprint,
    title: proposal.title,
    category: proposal.category,
    kind: proposal.kind,
    explanation: proposal.explanation,
    evidence,
    expectedBenefit: proposal.expectedBenefit,
    effort: proposal.effort,
    impact: proposal.impact,
    urgency: proposal.urgency,
    confidence: proposal.confidence,
    dependencies: proposal.dependencies,
    severity: proposal.severity,
    // Never a measurement. This is what keeps a proposal from reopening a settled finding.
    measuredAt: null,
  };
}

/** Reads every path and merges the results. Later paths win on a duplicate fingerprint. */
export async function loadProposals(paths: readonly string[]): Promise<LoadedProposals> {
  const files: ProposalFileResult[] = [];
  const merged = new Map<string, RoadmapCandidate>();
  for (const path of paths) {
    const result = await readProposalFile(path);
    files.push(result);
    for (const proposal of result.proposals) merged.set(proposal.fingerprint, toCandidate(proposal, path));
  }
  return { files, candidates: [...merged.values()] };
}

/**
 * Drops proposals that would collide with a finding the rules already derived. Two candidates sharing one
 * fingerprint would produce two list entries and fight over the same saved decision, so the measured finding
 * wins: it has evidence, and the proposal was only a note about the same thing.
 */
export function withoutCollisions(
  proposals: readonly RoadmapCandidate[],
  derived: readonly RoadmapCandidate[],
): { readonly kept: readonly RoadmapCandidate[]; readonly dropped: readonly string[] } {
  const taken = new Set(derived.map((candidate) => candidate.fingerprint));
  const kept: RoadmapCandidate[] = [];
  const dropped: string[] = [];
  for (const proposal of proposals) {
    if (taken.has(proposal.fingerprint)) dropped.push(proposal.fingerprint);
    else kept.push(proposal);
  }
  return { kept, dropped };
}
