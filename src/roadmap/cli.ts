#!/usr/bin/env node
import { ROADMAP_ACTIONS, type RoadmapAction } from "./model.js";
import { RoadmapService, defaultRoadmapOptions, type RoadmapSnapshot } from "./service.js";

const USAGE = `GameMind improvement roadmap

  npm run roadmap -- refresh            Rebuild the roadmap from recorded evidence and print a summary
  npm run roadmap -- list               Print the items, highest score first
  npm run roadmap -- next               Print the next recommended task
  npm run roadmap -- act FINGERPRINT ACTION [--value 1-5] [--note TEXT]
      ACTION: ${ROADMAP_ACTIONS.join(", ")}

Evidence is read from data/ (profiles, evidence/tests.json, training, episodes). Decisions are saved in data/roadmap/state.json.`;

function print(snapshot: RoadmapSnapshot): void {
  console.log(`Evidence measured: ${snapshot.evidenceAt ?? "none"}`);
  for (const source of snapshot.sources) {
    console.log(`  ${source.available ? "✓" : "–"} ${source.name}${source.measuredAt ? ` (${source.measuredAt})` : ""}`);
  }
  if (snapshot.error) console.log(`Error: ${snapshot.error}`);
  if (snapshot.items.length === 0) console.log("No open items.");
  for (const item of snapshot.items) {
    console.log(
      `[${item.status}] ${item.score.toFixed(2)}  ${item.kind} · ${item.category} · ${item.fingerprint}\n    ${item.title}`,
    );
  }
  console.log(`Resolved (no longer measured): ${snapshot.resolved}`);
  console.log(snapshot.next ? `Next: ${snapshot.next.summary}` : "Next: nothing open to recommend.");
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<number> {
  const [command = "help", ...rest] = process.argv.slice(2);
  if (command === "help" || command === "--help") {
    console.log(USAGE);
    return 0;
  }
  const service = new RoadmapService(defaultRoadmapOptions("data"));
  if (command === "refresh" || command === "list" || command === "next") {
    const snapshot = await service.refresh();
    if (command === "refresh" || command === "list") print(snapshot);
    if (command === "next") console.log(snapshot.next ? JSON.stringify(snapshot.next, null, 2) : "Nothing open to recommend.");
    return 0;
  }
  if (command === "act") {
    const [fingerprint, action, ...options] = rest;
    if (!fingerprint || !action) {
      console.error(USAGE);
      return 2;
    }
    const valueText = flag(options, "--value");
    const note = flag(options, "--note");
    const result = await service.act({
      fingerprint,
      action: action as RoadmapAction,
      ...(valueText !== undefined ? { value: Number(valueText) } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    console.log(result.message);
    return result.ok ? 0 : 1;
  }
  console.error(`Unknown command '${command}'.\n\n${USAGE}`);
  return 2;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
