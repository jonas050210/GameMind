# GameMind

GameMind is a modular, observable game-agent runtime. The current implementation closes a bounded Minecraft loop: observe the world, choose a goal by priority and utility, execute a validated skill, verify the result against the next observation, and replan. The wider architecture and roadmap are documented in [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md). The live test checklist is in [`docs/LIVE_VERIFICATION.md`](docs/LIVE_VERIFICATION.md).

> **Live status:** none of the behaviour below has been run against a Minecraft server in this repository. Offline tests and an offline simulator validate control logic and mock interactions only. Live compatibility is **not** claimed; see [Live Minecraft](#live-minecraft) and the checklist.

## Current implementation

- Minecraft Java through Mineflayer **4.39.0**, defaulting to protocol **1.20.4** (configurable). Pathfinder **2.4.5**, CollectBlock **1.6.0**, and Mineflayer Tool **1.2.0**.
- **Observations** carry the player state, inventory and equipment, nearby entities, a capped local cube, a **wide resource scan** (logs, crafting tables, sweet berry bushes with their `age`, up to 24 blocks away), and **dropped items** read from entity metadata. Unknown or unloaded cells are not treated as empty, and truncation is reported.
- **Skills** are strictly validated and allowlisted: look, inspect, conservative navigation, log collection, equipment, wood crafting, food consumption, cautious crafting-table placement, and three survival skills added in this release: **pickup of an observed food or log drop**, **harvest of a ripe sweet berry bush**, and **bounded rest** for natural regeneration. None of them attacks an entity.
- **World memory** (`src/games/minecraft/world-memory.ts`) keeps resource, berry, and dropped-item sightings across observations. A sighting is removed only when a fully scanned, untruncated volume proves it gone. It also tracks explored coverage cells and recently seen hostiles, with approach detection.
- **Exploration** (`src/games/minecraft/exploration.ts`) chooses unexplored coverage cells within a bounded radius of the task start, prefers cells with more unknown neighbours, and avoids remembered hostiles. The leg budget and radius are task parameters.
- **Goal selection** is grouped into three priority bands, and lower bands always win:
  - **Safety (band 0):** flee visible or approaching hostiles, and sidestep after a stall or oscillation.
  - **Survival (band 1):** eat from inventory, pick up dropped food, harvest ripe berries, explore for food when hunger is low, and rest when health is low and natural regeneration is possible.
  - **Progress (band 2):** gather, craft, approach remembered targets beyond the collection limit, and explore for resources.
  Within a band, candidates are ranked by utility with a small hysteresis bonus for the previous target, which prevents flip-flopping between equal goals.
- **Skill composition and verification.** Each decision projects the remaining plan (for crafting, the expanded recipe steps), and only the first actionable step is executed. Every confirmed action is then checked against the next observation by a per-skill **postcondition contract** (`src/games/minecraft/skill-contracts.ts`). A confirmation the observed world does not support is recorded as `unverified` and counted as a failure, not progress.
- **Stuck detection and recovery.** Route stalls (`NAVIGATION_STUCK`, pathfinder stop or timeout) keep the goal and request a bounded sidestep. The sidestep is axis-aligned, so its straight route has one shortest path, and it is rejected if that route would cross the estimated blocked cell. Repeated attempts without progress exclude the target. Oscillation between nearby cells is also detected and triggers a recovery request.
- **Task runner.** Bounded by action count, virtual or wall-clock time, target distance, exploration legs, rest time, and consecutive failures. It records exploration, food sources, rest time, verification results, unsafe-start counts, recoveries, plan revisions, and runtime, and writes ordered JSONL traces.
- **Offline simulator and evaluation.** A deterministic, seeded grid world (`src/testing/simulated-minecraft/`) models walking time, a loaded-chunk boundary, hostiles that chase, hunger and regeneration, drops, ripening berries, stall cells, and scheduled world changes. It advertises the same capabilities and reports the same error codes as the live adapter. Twelve scenarios are judged over seeded layouts (see [Offline evaluation](#offline-evaluation)).

This remains a deliberately narrow, rule-based agent. It is not a full survival agent, an RL system, an LLM planner, or a GUI. It does not hunt or fight animals or hostiles, mine stone or ores, build shelters, handle every recipe or version, or plan across dimensions.

## Behaviour changes in this release

Existing users should review these. Each is deliberate and covered by tests.

1. **Resource and table blocks are kept first in the local observation.** The 64-block cap used to drop blocks in loop order, which could silently hide logs. Blocks are now ordered by category and then distance.
2. **Critical hunger explores before it stops.** With no food in inventory, hunger ≤ 4 used to block immediately. It now explores for a food source (dropped food, ripe berries) first, within the leg budget. Pass `--explore-legs 0` to restore the immediate stop.
3. **Gather and craft tasks explore by default.** When no log is visible or remembered, the task explores up to 8 legs within 48 blocks of its start before blocking. Pass `--explore-legs 0` to disable.
4. **Resting is new.** At health ≤ 12 with food ≥ 18 and no visible hostile, the agent rests in bounded chunks (up to 60 s of rest per task).
5. **Stalled routes are retried, not dropped.** A `NAVIGATION_STUCK` or pathfinder stop keeps the goal, requests a sidestep, and retries. Other failures still exclude the target at once.
6. **Confirmations are cross-checked.** An action the adapter confirms but the next observation does not support is failed with `UNVERIFIED_POSTCONDITION`.
7. **Pathfinder failures have their own codes:** `PATH_NOT_FOUND`, `PATH_STOPPED`, `PATH_PLANNING_TIMEOUT`, and `PATH_GOAL_CHANGED`, instead of a generic adapter failure.
8. **Movement avoids sweet berry bushes**, which damage on contact.
9. **The legacy fixture adapter** (`FakeMinecraftAdapter`, used by the original demos) advertises only the original eight capabilities. Skills are registered only when the adapter advertises their capability.
10. **The decision model is `minecraft-priority-utility.v3`.** Trace events for `decision.made` carry `plan`, `band`, and `knowledge`; `task.action` carries `verification`.

## Requirements and checks

- Node.js 22 or newer.
- For live play: an authorized private or local Minecraft Java server that matches the configured protocol.

```bash
npm ci
npm run build
npm test
npm run eval:offline     # offline simulated evaluation (no server)
npm audit                # the dependency audit must report 0 vulnerabilities
```

## Offline demos (no Minecraft server required)

```bash
npm run scenario:demo      # seeded look-skill roundtrip (legacy fixture)
npm run task:demo          # bounded fake gather-log task (legacy fixture)
npm run task:demo:craft    # fake wood → table → wooden-pickaxe task (legacy fixture)
npm run task:demo:food     # secure-food task in the simulated world: berries beyond the scan
npm run sim:demo           # food-remote-berries (seed 101)
npm run sim:demo:explore   # explore-remote-log: a log outside the scan
npm run sim:demo:stall     # recovery-single-hidden-obstacle: stall, sidestep, retry
```

The legacy demos run against deterministic fixtures. The simulated demos run the grid world described above; their reports carry `"simulatedWorld": true`. Traces are written under `data/traces/` (ignored by Git).

## Offline evaluation

`npm run eval:offline` runs each scenario over seeded layouts (`src/testing/eval/scenarios.ts`). It writes `data/eval/offline-report.json` and exits non-zero if a gate fails. The output is simulated control behaviour, not a live result.

Scenarios and gates:

- **Success scenarios** must reach the goal in at least the stated share of seeds (80% or more). They cover exploration for a remote log, crafting with distant trees, food from remote berries and dropped bread, rest then gather, eating before gathering, a single hidden obstacle, and replanning after a removed log.
- **Safety scenarios** may end blocked or failed, but must start no action under threat, never reach zero health, and never make an unsupported confirmation. They cover no food anywhere, a zombie guarding berries, critical health with no food, and a route with no way around.
- **Global gates:** zero unsafe actions, zero deaths, and zero contradicted confirmations across every run.

Results from the default run (`npm run eval:offline`, 20 seeds per scenario, 240 runs in about 2 seconds):

| Scenario | Expectation | Success | Notes |
| --- | --- | --- | --- |
| explore-remote-log | success ≥ 90% | 100% | Exploration then collection |
| explore-craft-pickaxe | success ≥ 80% | 100% | Remote trees, full crafting chain |
| food-remote-berries | success ≥ 80% | 90% | Exploration, harvest, eat |
| food-dropped-bread | success ≥ 95% | 100% | Pickup, eat |
| food-none-reachable | safe | safe | Blocks after bounded exploration |
| survival-zombie-guards-berries | safe | safe | No harvest under threat |
| survival-rest-then-gather | success ≥ 90% | 100% | Rest, then gather |
| survival-critical-no-food | safe | safe | Stops with no actions |
| recovery-single-hidden-obstacle | success ≥ 85% | 100% | Stall, sidestep, retry |
| recovery-persistent-stall | safe | safe | Stops within budget |
| replanning-removed-log | success ≥ 85% | 100% | Replans after a removed log |
| survival-eat-before-gather | success ≥ 95% | 100% | Eats at the threshold first |

A 60-seed run (720 runs) gave the same gate outcomes, with 92% for remote berries and 98% for replanning. The misses were blocked runs in which exploration ran out of frontier within its radius before the bush's coverage cell was reached. No run had an unsafe action, a death, or a contradicted confirmation.

**What these numbers do and do not mean.** The simulator is written by the same project, uses simplified physics and mob behaviour, and has no protocol layer, so these figures show the planner, recovery, and verification logic behave as designed. They are not evidence about real Minecraft server behaviour.

## Live Minecraft

Start a private or local Java server first. Use only an account and server you are authorized to use, and keep the world disposable. The exact checks, expected evidence, and server setup commands are in [`docs/LIVE_VERIFICATION.md`](docs/LIVE_VERIFICATION.md).

To print one structured observation and shut down:

```bash
npm run dev -- --host 127.0.0.1 --port 25565 --username GameMind
```

Task runs (each uses the same limits as the offline runs):

```bash
# Gather one log, exploring up to 8 legs when none is known
npm run dev -- --task gather-logs --resource oak_log --count 1 --explore-legs 8 --max-actions 24 \
  --host 127.0.0.1 --port 25565 --username GameMind

# Craft a wooden pickaxe, gathering and exploring as needed
npm run dev -- --task craft-wooden-pickaxe --explore-legs 8 --max-actions 24 \
  --host 127.0.0.1 --port 25565 --username GameMind

# Secure food: eat, pick up dropped food, harvest ripe berries, explore for them
npm run dev -- --task secure-food --target-hunger 12 --explore-legs 8 --max-actions 24 \
  --host 127.0.0.1 --port 25565 --username GameMind
```

Task options: `--count`, `--resource`, `--target-hunger` (secure-food only), `--explore-legs` (0–30, 0 disables exploration), `--explore-radius` (8–96 blocks), `--max-actions` (1–100, default 12), and `--max-duration-ms` (default 120000). Exploration consumes actions and real time: each leg is one navigation that can take tens of seconds, so use `--max-actions 24` and a larger `--max-duration-ms` (for example `300000`) for exploration-heavy runs. Run `npm run dev -- --help` for the full list.

Nearby visible hostiles take priority. Collection, pickup, berry harvesting, and table placement are refused when a visible hostile is within the task's danger radius of the target. Entities can still move after a check, and Pathfinder's entity avoidance is a weighted cost, not a hard barrier. **Use a private test world, supervise live runs, and stop the process if behaviour looks unsafe** (Ctrl-C shuts the session down cleanly).

The orientation example remains available:

```bash
npm run scenario:minecraft -- --host 127.0.0.1 --username GameMind
```

Yaw and pitch are radians. The preset turns to yaw π/2.

### Connection settings

Environment variables may set connection defaults:

- `MINECRAFT_HOST` (default `127.0.0.1`)
- `MINECRAFT_PORT` (default `25565`)
- `MINECRAFT_USERNAME` (default `GameMind`)
- `MINECRAFT_VERSION` (default `1.20.4`)
- `MINECRAFT_AUTH` (`offline` by default; or `microsoft`)
- `MINECRAFT_CONNECT_TIMEOUT_MS` (default `15000`)
- `GAMEMIND_TRACE_DIR` (default `data/traces`)

For an offline-mode server, keep `MINECRAFT_AUTH=offline`. Use Microsoft authentication only where appropriate. Do not put account credentials in command-line arguments, source control, logs, or traces; Mineflayer manages its own authentication flow and cache.

## Known limitations

- **No live verification has been run.** Mineflayer calls for the wide resource scan (`findBlocks`), item drops (`getDroppedItem`), berry `age` (`getProperties`), harvesting (`activateBlock`), pickup, rest, and pathfinder error names are implemented against the installed library types and source, and are unit-tested with a double. Their behaviour on a real 1.20.4 server is an open question listed in [`docs/LIVE_VERIFICATION.md`](docs/LIVE_VERIFICATION.md).
- **Natural regeneration depends on the server.** Rest is confirmed only by an observed health increase. A server with `naturalRegeneration` off, or with food below 18, will correctly report "not confirmed" and the task will stop.
- **Exploration uses the loaded world.** The live wide scan sees only loaded chunks. Unloaded areas are unknown, and waypoints across them may fail with `PATH_NOT_FOUND`. Waypoints are navigated at the agent's current height with a 3-D goal, so on steep terrain some waypoints will fail, be excluded, and be replaced by the next frontier cell.
- **Food sources are limited.** Dropped food, ripe sweet berries, and inventory food. Animals are not hunted. This is a deliberate boundary: attacking entities is combat, which this project does not implement.
- **Simulator fidelity.** Walking, hostiles, hunger, and regeneration are simplified; the simulator has no collisions beyond solid cells, no lighting, no mob pathing, and no protocol.
- **Recovery is bounded, not exhaustive.** A route blocked everywhere, or one whose shortest paths all pass through an unobservable block, ends in a bounded stop.

## Traces and tests

- `scenarios/minecraft-look-roundtrip.json` is the seeded orientation scenario.
- `data/traces/<session-id>.jsonl` stores ordered session, observation, decision (with plan, band, and memory knowledge), skill, action, verification, and task events. Sensitive-looking fields are redacted.
- Tests use offline fixtures, the simulator, and an injected Mineflayer double. They verify program logic and mock interactions. They **do not** verify Minecraft server behaviour, protocol compatibility, or plugin behaviour in a live world.
- `npm test` runs 113 tests: the original suite (three task tests pinned explicitly to the legacy no-exploration setting, and one adapter assertion updated for the new block ordering), world memory, the simulator, decision policy, skill contracts, stuck recovery, food seeking, exploration behaviour, the live-adapter double, and an evaluation regression gate.
