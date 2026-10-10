#!/usr/bin/env node
import pino from "pino";
import { evaluateCheckpoint } from "./evaluate.js";
import { readControlCommand, readTrainingState, trainingPaths, writeControlCommand } from "./state.js";
import { runTraining } from "./trainer.js";

const USAGE = `GameMind training

  npm run train -- train [--dir DIR] [--episodes-per-stage N] [--max-episodes N] [--max-minutes M] [--fresh]
      Runs the curriculum on the offline simulator. Resumes from DIR/state.json unless --fresh is given.
  npm run train -- evaluate [--dir DIR] [--checkpoint ID] [--seeds N]
      Scores a checkpoint against the baseline on held-out evaluation seeds and writes a JSON report.
  npm run train -- status [--dir DIR]
  npm run train -- pause|resume|stop [--dir DIR]
      Pause, resume or stop a run. Takes effect after the current episode.

DIR defaults to data/training.`;

interface ParsedArgs {
  readonly command: string;
  readonly dir: string;
  readonly episodesPerStage?: number;
  readonly maxEpisodes?: number;
  readonly maxMinutes?: number;
  readonly fresh: boolean;
  readonly checkpoint?: string;
  readonly seeds?: number;
}

function integerFlag(name: string, value: string | undefined, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}.`);
  }
  return parsed;
}

export function parseTrainingArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const parsed: { -readonly [K in keyof ParsedArgs]: ParsedArgs[K] } = { command, dir: "data/training", fresh: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    const value = () => {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value.`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--dir":
        parsed.dir = value();
        break;
      case "--episodes-per-stage":
        parsed.episodesPerStage = integerFlag(flag, value(), 1, 200);
        break;
      case "--max-episodes":
        parsed.maxEpisodes = integerFlag(flag, value(), 1, 5000);
        break;
      case "--max-minutes":
        parsed.maxMinutes = integerFlag(flag, value(), 1, 24 * 60);
        break;
      case "--fresh":
        parsed.fresh = true;
        break;
      case "--checkpoint":
        parsed.checkpoint = value();
        break;
      case "--seeds":
        parsed.seeds = integerFlag(flag, value(), 1, 200);
        break;
      default:
        throw new Error(`Unknown option ${flag}.\n\n${USAGE}`);
    }
  }
  return parsed;
}

async function main(): Promise<number> {
  const args = parseTrainingArgs(process.argv.slice(2));
  const paths = trainingPaths(args.dir);
  const logger = pino({ level: process.env.GAMEMIND_LOG_LEVEL ?? "info" });

  switch (args.command) {
    case "train": {
      const state = await runTraining({
        root: args.dir,
        ...(args.episodesPerStage !== undefined ? { episodesPerStage: args.episodesPerStage } : {}),
        ...(args.maxEpisodes !== undefined ? { maxEpisodes: args.maxEpisodes } : {}),
        ...(args.maxMinutes !== undefined ? { maxMinutes: args.maxMinutes } : {}),
        fresh: args.fresh,
        evaluationSeedCount: 10,
        logger,
      });
      console.log(JSON.stringify({ status: state.status, episodes: state.totalEpisodes, checkpoints: state.checkpoints.map((c) => c.id) }));
      return state.status === "failed" ? 1 : 0;
    }
    case "evaluate": {
      const report = await evaluateCheckpoint({
        root: args.dir,
        ...(args.checkpoint ? { checkpointId: args.checkpoint } : {}),
        ...(args.seeds !== undefined ? { seeds: args.seeds } : {}),
      });
      console.log(JSON.stringify({
        checkpoint: report.checkpointId,
        verdict: report.verdict,
        baselineSuccess: report.baseline.metrics.successRate,
        candidateSuccess: report.candidate.metrics.successRate,
        deltas: report.deltas,
        reasons: report.decision.reasons,
        blocking: report.decision.blocking,
      }, null, 2));
      return 0;
    }
    case "status": {
      const state = await readTrainingState(paths);
      console.log(JSON.stringify(state ? {
        status: state.status,
        control: await readControlCommand(paths),
        episodes: state.totalEpisodes,
        budget: state.maxEpisodes,
        stage: state.stageIndex,
        checkpoints: state.checkpoints.map((c) => c.id),
        lastEvaluation: state.lastEvaluation,
        lastError: state.lastError,
      } : { status: "idle" }, null, 2));
      return 0;
    }
    case "pause":
    case "resume":
    case "stop": {
      const command = args.command === "resume" ? "run" : args.command;
      await writeControlCommand(paths, command);
      console.log(`Requested ${args.command}; it takes effect after the current episode.`);
      return 0;
    }
    default:
      console.log(USAGE);
      return args.command === "help" ? 0 : 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
