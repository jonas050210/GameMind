#!/usr/bin/env node
/**
 * The operator's live-test protocol: print the steps, start a result file, and judge a filled one in.
 *
 * The point of `check` is that a session cannot be reported as verified by accident. A step that says
 * `verified` without the observation and the values it asks for is refused, and a step nobody reached is
 * listed as pending rather than silently missing.
 */
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../../core/atomic-file.js";
import {
  OPERATOR_PROTOCOL_STEPS,
  describeProtocol,
  judgeProtocolResult,
  parseProtocolResult,
  protocolTemplate,
} from "./operator-protocol.js";

const USAGE = `GameMind live protocol

  npm run protocol -- print                                   The 15 steps, grouped, with what to write down
  npm run protocol -- template PATH --server HOST --operator NAME
                                                              Start an empty result file for one session
  npm run protocol -- check PATH                              Judge a filled-in result file

The result file is the evidence: it names the server, the version, the operator and the time, and one outcome
per step. Keep it out of data/ if you want it committed - data/ is gitignored, docs/live-results/ is not.
A step counts as verified only with what you saw and the values it asks for.`;

function getArg(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "print" || command === undefined) {
    for (const line of describeProtocol()) console.log(line);
    return;
  }

  if (command === "template") {
    const target = args[1];
    const server = getArg(args, "--server");
    const operator = getArg(args, "--operator");
    if (!target || !server || !operator) {
      console.error(USAGE);
      process.exit(1);
    }
    const template = protocolTemplate(server, operator);
    await mkdir(path.dirname(path.resolve(target)), { recursive: true });
    await writeFileAtomic(target, `${JSON.stringify(template, null, 2)}\n`);
    console.log(`Wrote ${OPERATOR_PROTOCOL_STEPS.length} steps to ${target}.`);
    console.log("Fill in one outcome per step as the session runs, then: npm run protocol -- check " + target);
    return;
  }

  if (command === "check") {
    const target = args[1];
    if (!target) {
      console.error(USAGE);
      process.exit(1);
    }
    let text: string;
    try {
      text = await readFile(target, "utf8");
    } catch (error) {
      console.error(`Cannot read ${target}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    const { result, error } = parseProtocolResult(text);
    if (!result) {
      console.error(`${target}: ${error}`);
      process.exit(1);
    }
    const verdict = judgeProtocolResult(result);
    console.log(`${target}`);
    console.log(`  server   ${result.server} (${result.serverVersion})`);
    console.log(`  operator ${result.operator}`);
    console.log(`  session  ${result.startedAt} .. ${result.finishedAt}`);
    console.log(
      `  steps    ${verdict.verified} verified, ${verdict.failed} failed, ${verdict.skipped} skipped, ${verdict.pending} pending of ${verdict.steps}`,
    );
    if (verdict.problems.length === 0) {
      console.log("Every step carries an outcome and the evidence it asks for.");
      return;
    }
    console.log(`\n${verdict.problems.length} problem(s) keep this file from counting as a result:`);
    for (const problem of verdict.problems) {
      console.log(`  - ${problem.stepId ?? "file"}: ${problem.problem}`);
    }
    process.exit(1);
  }

  console.error(USAGE);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`Live protocol failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
