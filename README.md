# GameMind

GameMind is a modular, observable game-agent runtime. The current implementation closes a bounded Minecraft loop: observe the world, choose a goal by priority and utility, pass it a safety gate, execute a validated skill, verify the result against the next observation, and replan. Decisions, refusals and outcomes are recorded as structured traces, an experience memory makes later runs avoid known dead ends, and a **Control Center** serves that same live state in a browser — with operator controls that reach the running agent. The wider architecture and roadmap are documented in [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md). The live test checklist is in [`docs/LIVE_VERIFICATION.md`](docs/LIVE_VERIFICATION.md).

> **Live status:** none of the behaviour below has been run against a Minecraft server in this repository. Offline tests and an offline simulator validate control logic and mock interactions only. Live compatibility is **not** claimed; see [Live Minecraft](#live-minecraft) and the checklist.

## Current implementation

- Minecraft Java through Mineflayer **4.39.0**, defaulting to protocol **1.20.4** (configurable). Pathfinder **2.4.5**, CollectBlock **1.6.0**, and Mineflayer Tool **1.2.0**.
- **Observations** carry player state, inventory/equipment, nearby entities, a local cube, wider resource/minable scans, and dropped items from entity metadata. The live adapter defaults to a 5-block local radius/cap 256 and a 32-block wide radius/cap 192 per scan; its radii, caps, entity range and view distance are configurable through `MINECRAFT_*` settings. The offline simulator uses a 5-block local radius and a 24-block wide radius. Loaded chunk columns, scan truncation and (live adapter) measured perception timings are reported. These are client-visible scans, not server-wide queries: unloaded chunks stay unknown, and a saturated scan is never evidence that an unreturned block is absent.
- **Skills** are strictly validated and allowlisted: look, inspect, conservative navigation, log collection, equipment, wood crafting, food consumption, cautious crafting-table placement, and three survival skills added in this release: **pickup of an observed food or log drop**, **harvest of a ripe sweet berry bush**, and **bounded rest** for natural regeneration. None of them attacks an entity.
- **World memory** (`src/games/minecraft/world-memory.ts`) keeps resource/minable sightings, dropped-item and hostile sightings in the current process, plus chunk-aware explored coverage. Persistent snapshots (`src/games/minecraft/persistent-world-memory.ts`) store only world-scoped resource/minable last-seen locations, explored cells, and counters—never moving hostiles or despawnable item drops. Snapshots are schema-validated, expire after seven days by default, and are atomically replaced after a short debounce. `--memory-dir` / `GAMEMIND_MEMORY_DIR` selects storage; `--world-key` / `GAMEMIND_WORLD_KEY` can disambiguate server identities. The default identity is server host + port + dimension, not a cryptographic world/seed ID.
- **Exploration** (`src/games/minecraft/exploration.ts`) chooses unexplored coverage cells within a bounded radius of the task start, prefers cells with more unknown neighbours, and avoids remembered hostiles. The leg budget and radius are task parameters.
- **Goal selection** is grouped into three priority bands, and lower bands always win:
  - **Safety (band 0):** flee visible or approaching hostiles, and sidestep after a stall or oscillation.
  - **Survival (band 1):** eat from inventory, pick up dropped food, harvest ripe berries, explore for food when hunger is low, and rest when health is low and natural regeneration is possible.
  - **Progress (band 2):** gather, craft, approach remembered targets beyond the collection limit, and explore for resources.
  Within a band, candidates are ranked by utility with a small hysteresis bonus for the previous target, which prevents flip-flopping between equal goals.
- **Skill composition and verification.** Each decision projects the remaining plan (for crafting, the expanded recipe steps), and only the first actionable step is executed. Every confirmed action is then checked against the next observation by a per-skill **postcondition contract** (`src/games/minecraft/skill-contracts.ts`). A confirmation the observed world does not support is recorded as `unverified` and counted as a failure, not progress.
- **Stuck detection and recovery.** Route stalls (`NAVIGATION_STUCK`, pathfinder stop or timeout) keep the goal and request a bounded sidestep. The sidestep is axis-aligned, so its straight route has one shortest path, and it is rejected if that route would cross the estimated blocked cell. Repeated attempts without progress exclude the target. Oscillation between nearby cells is also detected and triggers a recovery request.
- **Safety Broker** (`src/core/safety-broker.ts`) sits below the decision model and is the only place that answers "may this action run at all?". It checks policy enablement, risk ceiling, allow/deny lists, operator opt-ins, per-run and per-capability budgets, cooldowns, a protected health floor, hazard proximity, drowning, and observation staleness, and it records every verdict with the named checks that produced it. `pause` blocks world changes, `trip` blocks everything until an operator resets it; clearing a trip never releases a pause an operator set deliberately.
- **Skills added for progression and shelter:** `mine-block` (tool requirement derived from the block, drop verified through the inventory), `place-block` and `build-shelter` (closed cardinal or full surround), `equip-item`, and `drop-item` to free inventory space. Combat exists only behind three independent opt-ins (adapter config, safety policy, task runner), and `attack-hostile` additionally requires a weapon in hand.
- **Structured decision traces.** `decision.made` carries the selected goal, every alternative with its score, every rejected candidate with a reason code and detail, the utility bands, the plan, the world-memory knowledge behind the decision, and the safety verdict. `task.action` carries the action record plus the postcondition verification, so a claim of success is always traceable to an observation.
- **Experience learning** (`src/core/learning/`): one episode per attempted action, persisted as JSONL; failure memory that blocks a target that repeatedly failed without progress; derived policy weights that only *rank* candidates (they can never unlock a capability or skip validation); and a gate that compares a candidate against the baseline before anything is promoted. See [Learning and policy](#learning-and-policy).
- **Task runner.** Bounded by action count, virtual or wall-clock time, target distance, exploration legs, rest time, and consecutive failures. On observed death it waits up to 30 seconds (never beyond the task deadline), performs no actions while the player is dead, and resumes only after the adapter reports an alive state; it then observes and replans. Automatic respawn is enabled by default through Mineflayer's health plugin and can be disabled with `MINECRAFT_AUTO_RESPAWN=false`; live server behavior is unverified. Budgets are measured per run. Metrics include death/respawn recovery, and ordered JSONL traces preserve the cause.
- **Offline simulator and evaluation.** A deterministic, seeded grid world (`src/testing/simulated-minecraft/`) models walking time, a loaded-chunk boundary, hostiles that chase, hunger and regeneration, drops, ripening berries, stall cells, and scheduled world changes. It advertises the same capabilities and reports the same error codes as the live adapter. Twenty scenarios are judged over seeded layouts (see [Offline evaluation](#offline-evaluation)).

This remains a deliberately narrow, rule-based agent. It is not a full survival agent, an RL system, an LLM planner, or a general-purpose GUI. It does not hunt passive animals, go mining below the surface deliberately (it digs blocks it can reach with a tool it holds), build anything beyond a closed shell around the player, handle every recipe or version, or plan across dimensions. Fighting is only reachable when an operator armed combat for that run.

## Behaviour changes in this release

Existing users should review these. Each is deliberate and covered by tests.

1. **Perception defaults are broader but bounded.** The local cube now returns up to 256 ordered blocks, while separate resource/minable scans query up to 32 blocks and return at most 192 results each. Chunk coverage is only marked when the client reports those columns loaded and the scan is not truncated.
2. **Critical hunger explores before it stops.** With no food in inventory, hunger ≤ 4 used to block immediately. It now explores for a food source (dropped food, ripe berries) first, within the leg budget. Pass `--explore-legs 0` to restore the immediate stop.
3. **Gather and craft tasks explore by default.** When no log is visible or remembered, the task explores up to 8 legs within 48 blocks of its start before blocking. Pass `--explore-legs 0` to disable.
4. **Resting is new.** At health ≤ 12 with food ≥ 18 and no visible hostile, the agent rests in bounded chunks (up to 60 s of rest per task).
5. **Stalled routes are retried, not dropped.** A `NAVIGATION_STUCK` or pathfinder stop keeps the goal, requests a sidestep, and retries. Other failures still exclude the target at once.
6. **Confirmations are cross-checked.** An action the adapter confirms but the next observation does not support is failed with `UNVERIFIED_POSTCONDITION`.
7. **Pathfinder failures have their own codes:** `PATH_NOT_FOUND`, `PATH_STOPPED`, `PATH_PLANNING_TIMEOUT`, and `PATH_GOAL_CHANGED`, instead of a generic adapter failure.
8. **Movement avoids sweet berry bushes**, which damage on contact.
9. **The legacy fixture adapter** (`FakeMinecraftAdapter`, used by the original demos) advertises only the original eight capabilities. Skills are registered only when the adapter advertises their capability.
10. **The decision model is `minecraft-priority-utility.v3`.** Trace events for `decision.made` carry `plan`, `band`, `knowledge`, `alternatives`, `rejected`, and `safety`; `task.action` carries `verification`.
11. **Mining is judged by the tool in hand.** A dig is only proposed when the pickaxe (or axe/shovel) that the block requires is the held item; `equip:pickaxe` is inserted into the plan before the dig instead of assuming the inventory is enough.
12. **Combat is opt-in at three layers.** `--allow-combat` sets the adapter switch, the safety policy opt-in, and the runner's `combatEnabled` context. Without all three, `defend` is refused and the agent flees — and the refusal is visible in the decision trace as `combat is not enabled for this run, so the agent flees instead of attacking`. The Control Center can arm and disarm it between runs.
13. **A run can be stopped safely.** `MinecraftTaskRunner` honours a cooperative `shouldStop` between actions (never mid-action), which the Control Center's Stop control and `OPERATOR_STOP` reporting use.
14. **Experience is persisted by default** for CLI task runs (`data/learning`, `--no-learning` to turn off, `--learning-dir` to move). Nothing learned can raise a risk ceiling, widen an allowlist, or bypass the safety broker; it only reorders candidates and avoids targets it already failed on.
15. **The Control Center is an operations console.** It includes bounded task launch, operator safety controls, live decision/action/event panels, perception timings, and an interactive WebGL block view. The view distinguishes current blocks from wireframe last-seen memory and never fills unknown terrain.
16. **World knowledge survives live CLI restarts.** Debounced, validated snapshots preserve resource/minable sightings and explored cells only. Hostiles and drops remain transient; default identity is host + port + dimension, with `--world-key` for operator-defined separation.
17. **Death recovery is explicit and bounded.** The Mineflayer health plugin is configured for automatic respawn by default (`MINECRAFT_AUTO_RESPAWN=false` disables it). After a death observation, the task loop waits for an alive state from the adapter without issuing actions, re-observes before replanning, and ends on disconnect, operator stop, a 30-second wait limit, or the task deadline. This path is covered by offline tests, not a live-server test.

## Requirements and checks

- Node.js 22 or newer.
- For live play: an authorized private or local Minecraft Java server that matches the configured protocol.

```bash
npm ci                   # reproducible install from package-lock.json
npm run build            # TypeScript typecheck + copy the Control Center assets
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
npm run task:demo:mine     # mine-stone-with-pickaxe in the simulated world
npm run ui:demo            # simulated run + Control Center on port 8787 (all interfaces), left open
npm run ui:demo:offline    # offline fixture gather task + Control Center
```

The legacy demos run against deterministic fixtures. The simulated demos run the grid world described above; their reports carry `"simulatedWorld": true`. Traces are written under `data/traces/` (ignored by Git).

## Offline evaluation

`npm run eval:offline` runs each scenario over seeded layouts (`src/testing/eval/scenarios.ts`). It writes `data/eval/offline-report.json` and exits non-zero if a gate fails. The output is simulated control behaviour, not a live result.

Scenarios and gates:

- **Success scenarios** must reach the goal in at least the stated share of seeds (80% or more). They cover exploration for a remote log, crafting with distant trees, food from remote berries and dropped bread, rest then gather, eating before gathering, a single hidden obstacle, and replanning after a removed log.
- **Safety scenarios** may end blocked or failed, but must start no action under threat, never reach zero health, and never make an unsupported confirmation. They cover no food anywhere, a zombie guarding berries, critical health with no food, and a route with no way around.
- **Global gates:** zero unsafe actions, zero deaths, and zero contradicted confirmations across every run.

The default command evaluates 20 scenarios × 20 seeds (400 runs). For the latest expanded check I ran `npm run eval:offline -- --seeds 60`: 20 scenarios × 60 seeds = **1,200 runs in 12.7 seconds**. The table below reports that 60-seed result; all scenario gates passed.

| Scenario | Expectation | Success | Notes |
| --- | --- | --- | --- |
| explore-remote-log | success ≥ 90% | 100% | Exploration then collection |
| explore-craft-pickaxe | success ≥ 80% | 100% | Remote trees, full crafting chain |
| food-remote-berries | success ≥ 80% | 100% | Exploration, harvest, eat |
| food-dropped-bread | success ≥ 95% | 100% | Pickup, eat |
| food-none-reachable | safe | safe | Blocks after bounded exploration |
| survival-zombie-guards-berries | safe | safe | No harvest under threat |
| survival-rest-then-gather | success ≥ 90% | 100% | Rest, then gather |
| survival-critical-no-food | safe | safe | Stops with no actions |
| recovery-single-hidden-obstacle | success ≥ 85% | 100% | Stall, sidestep, retry |
| recovery-persistent-stall | safe | safe | Stops within budget |
| replanning-removed-log | success ≥ 85% | 98% | Replans after a removed log |
| survival-eat-before-gather | success ≥ 95% | 100% | Eats at the threshold first |
| mine-stone-with-pickaxe | success ≥ 90% | 100% | Equips, digs, verifies the drop |
| mine-stone-needs-pickaxe | success ≥ 85% | 100% | Crafts a pickaxe first, then digs |
| shelter-close-cardinal-sides | success ≥ 90% | 100% | Places blocks on open sides |
| shelter-before-night-when-hurt | safe | safe | Shelters instead of gathering at night |
| combat-opt-in-defence | safe | safe | Attacks only when combat is armed |
| combat-denied-by-default | safe | safe | Flees; attacks refused without opt-in |
| inventory-full-frees-space | success ≥ 85% | 100% | Drops junk, then collects |
| hazard-lava-edge | safe | safe | Refuses stationary work next to lava |

Across all 1,200 runs there were **0 unsafe actions, 0 deaths, and 0 contradicted confirmations**. The two misses in `replanning-removed-log` were within its 85% success gate. The report showed no weighted candidate policy, so policy-ranking evaluation was not run.

The suite also measures the learning memory: the same seeded worlds are run twice back to back with one shared experience store, and the repeat run is compared action-for-action.

```
scenario                    cold act.  repeat act.  cold waste  repeat waste
recovery-persistent-stall   5          0            5           0
inventory-full-frees-space  2          2            1           1
mine-stone-needs-pickaxe    12         12           3           3
```

The first row is the effect a memory can have: the targets that only wasted actions are no longer proposed, so the second run stops immediately instead of repeating them. The other two rows are the honest limit of that claim — those actions were not waste but the only path to completion (crafting a pickaxe, freeing inventory space), so remembering the failure must not remove them. `wastedActions` counts every action without observable progress, so the claim here is "fewer actions wasted on already-failed targets in a repeat run, at equal or better success", never "waste reaches zero".

Policy candidates are additionally compared against the baseline through the gate (`test/policy-comparison.test.ts` runs the full scenario set for both and refuses promotion on any regression, unsafe action, death, or contradicted confirmation).

**What these numbers do and do not mean.** The simulator is written by the same project, uses simplified physics and mob behaviour, and has no protocol layer, so these figures show the planner, recovery, and verification logic behave as designed. They are not evidence about real Minecraft server behaviour.

## Control Center

The Control Center is the operator surface for a running agent: connection/life state, vitals, inventory/equipment, current goals, decisions and alternatives, action/recovery timelines, safety verdicts, learning results, and measured perception/skill timings. It is a status surface: it shows activity, goal, health, food, inventory summary, connection state, task progress, errors, training status and performance timings. It does not show block or entity coordinates, a terrain census, or a 3D world view (that renderer was removed; no replacement renderer is planned). Panels use the runtime, broker, world memory, trace ring and learner snapshots; with `--sim` or `ui:demo`, those snapshots describe the simulator, not a live server.

```bash
npm run ui:demo                     # simulated world, no server needed
npm run dev -- --task gather-logs --host 127.0.0.1 --control-center
npm run dev -- --sim recovery-persistent-stall --control-center --control-port 0
```

`--control-center` starts the dashboard on `127.0.0.1:8787` (`--control-port`, `--control-host`) and leaves the process open after the run finishes so the trace, the learning result and the world state stay readable; `Ctrl-C` closes it. With `--control-host 0.0.0.0` it is reachable from another machine on a trusted network. The two offline demos (`ui:demo`, `ui:demo:offline`) pass `--control-host 0.0.0.0` because they drive only the simulator and need to be reachable through a sandbox preview; live runs keep the `127.0.0.1` default, since the dashboard serves the control token and accepts commands that move a real character. If the port is taken the run stops with a message naming `--control-port`. The page needs no external network access: HTML, CSS and JavaScript are served from this package; there is no CDN or remote font. Updates use a single non-overlapping `GET /api/snapshot` polling loop (1 s while running, 3 s idle, 15 s in a hidden tab). The retired event-stream endpoint returns `410 STREAM_REMOVED`.

Controls that exist because the runtime actually implements them:

| Control | What it really does |
| --- | --- |
| Pause / Resume | `SafetyBroker.pause()` / `resume()`. While paused, every non-read-only capability is denied with `RUN_PAUSED`. |
| Trip / Reset trip | `SafetyBroker.trip()` / `clearTrip()` + resume. A trip denies *everything*, including read-only actions, until an operator resets it. A reset never lifts an independent pause. |
| Combat allowed | `adapter.setCombatAllowed()` **and** the safety policy's `optedInCapabilities`, so both enforcement layers move. Hidden when the adapter has no such switch. |
| Action budget | `SafetyBroker.configure({ maxActionsPerRun })` plus the running task's own `maxActions`, clamped to the task schema's 1–100. |
| Stop task | Cooperative stop checked between actions; the run ends as `aborted` / `OPERATOR_STOP` with the operator's reason. |
| Start task | Builds a task through the same zod schemas the CLI uses (kind, resource, count), refuses while tripped or paused, and refuses a second task while one runs. |
| Promote / roll back policy | `ExperienceLearner.promote()` / `rollback()`, refusing when any confirmation was contradicted or the candidate never left the baseline. |
| Nothing about the world | The dashboard is read-only for game state: it can hold, arm and stop the agent, and it never writes to the world or to `bot.*`. |

Two panels carry their own provenance, because "blocked" and "a flat map of blocks" are not explanations:

- **Blocker** classifies the one thing stopping the loop — safety refusal, missing capability, connection
  fault, missing perception, planner decline or task failure — with the source's own reason verbatim, who
  has to act, and whether the agent can clear it by retrying (`src/core/failure-taxonomy.ts` is the single
  classifier behind the dashboard, the CLI report and the trace).
- **Observed world** states which observation its numbers came from (`live · observation #43 (2s old)`,
  `stale`, `session-changed`, or `simulated world`), and shows dimension and game mode as the session
  reported them — `survival · verified (bot.game.gameMode + bot.player.gamemode)` versus `unknown · not
  reported by the session` — with the same evidence attached to every decision record.

The HTTP surface is `GET /api/health`, `GET /api/snapshot` and `POST /api/command`. The page reads the
snapshot on an interval (1 s while a task runs, 3 s while idle, 15 s while the tab is hidden) — there is no
push stream: every frame it would have sent was a re-send of the same snapshot, and `GET /api/stream`
answers `410 STREAM_REMOVED` so an old bookmark says so instead of hanging. Writes require the
`x-gamemind-token` header, and the token is injected into the served page only — it is not readable from
any endpoint. A command the host cannot honour returns `501`, and a host command that reports failure returns `409` with its message, so the UI can never look like it worked when nothing happened.

**What it deliberately does not do:** it keeps only the recent trace window in memory (400 events; the durable trace is `data/traces/*.jsonl`), it does not persist a full terrain map or moving entities, it exposes no free-form command console or credential handling, and it cannot bypass the safety broker. Persisted world memory stores only last-seen resource/minable locations and explored coverage; the default key (server host + port + dimension) cannot distinguish a reset/replaced world at the same endpoint, so use `--world-key` / `GAMEMIND_WORLD_KEY` to give separate worlds distinct identities. The UI authenticates with a per-process token but no TLS: keep it on loopback or a trusted network. Perception timings are the adapter's last scan sample, not a complete hardware benchmark.

## Learning and policy

```bash
npm run policy:status              # what has been recorded, and what it concluded
npm run dev -- --policy promote    # requires full candidate evidence (20+ seeds, all scenarios)
npm run dev -- --policy reject     # back to the active (or baseline) policy
npm run dev -- --task gather-logs --no-learning   # this run records nothing
```

Every attempted action becomes an episode in `data/learning/episodes.jsonl` (band, skill, target class, distance, threat, inventory state, outcome, verification, failure code) and one aggregate per run goes to the failure memory. Three effects follow, all bounded:

1. **Repeatedly failed targets are excluded** in a later run against the same world key (`<scenario>#<seed>` offline, `host:port` on a live server) until enough observations contradict the failure.
2. **Policy weights are derived** from those statistics — one multiplier per context band, clamped, and only for contexts with enough samples. They reorder candidate goals inside their priority band; a weight can never make a denied capability allowed, skip a postcondition check, or move a goal between bands.
3. **Promotion is gated consistently in the CLI and Control Center.** A derived candidate has no effect while it is only a candidate: the running agent uses the *promoted* policy, or the hand-tuned baseline. Promotion refuses unless the offline report passed, was generated for the exact current candidate, covers every current scenario with at least 20 seeds per scenario, the learner has episodes and at least one statistically supported weighted context, the candidate comparison itself is promotable, and no confirmation was contradicted. The CLI passes the current scenario manifest and the Control Center uses the run host's report path; neither UI nor CLI has a shorter bypass. `--policy reject` (or the dashboard button) drops the promoted policy entirely — decisions go back to the hand-tuned weights, there is no stack of previous policies — and records the reason in the state history. An embedding that wants candidates live immediately can construct the learner with `useCandidateWeights: true`; no CLI flag sets it, because a live experiment should be a deliberate call.

The design keeps the door open for real RL: episodes are the training records, the store is append-only JSONL, and `ExperienceLearner` is the only consumer. There is no gradient training and no LLM in the loop — the "learning" here is measured experience, not model fitting.

Training (below) uses this same learner: it runs curriculum episodes in the offline simulator, records each action as an episode, and writes a checkpoint of the candidate weights when a stage passes. There is no gradient training, no neural network and no LLM in the loop; the "learning" is count-based experience statistics. Checkpoints are compared against the baseline on held-out evaluation seeds, and a checkpoint is promoted only through the existing gate.

## Autonomy, observation and training

The agent runs two loops. A fast loop observes about once per second (`observationIntervalMs`, default 1000), checks reflexes (critical health, starvation, a close hostile, and so on), and interrupts an in-flight action only when the action is not protected (eating, attacking, looking and inspecting are never interrupted). A slower planner chooses the next task from the current observation and from its progress tracker, with cooldowns and a fallback when a subgoal repeatedly fails. Neither loop waits for the other, and training runs in a separate process, so observation never waits on training.

The Control Center shows observation age, loop frequency, decision latency, action latency and reaction time in the performance panel. There is no per-run action-count cap. Actions are bounded by per-action timeouts, stuck detection, retry limits, and the emergency stop.

```bash
# Offline (no server needed)
npm run profile:autonomy -- --scenario berries --seed 101 --virtual-seconds 900
npm run eval:offline -- --learning-dir data/training/experience

# Training (separate process; the Control Center can start and watch it too)
npm run train -- train --dir data/training --episodes-per-stage 8 --max-episodes 48
npm run train -- evaluate --dir data/training --seeds 10
npm run train -- status --dir data/training
npm run train -- pause|resume|stop --dir data/training   # pause and stop take effect after the current episode
```

Training data (`data/training/`) is git-ignored. Training seeds are split from evaluation seeds and asserted disjoint at start-up. The world seed can be entered manually in the Control Center. It is not auto-detected; anything derived from it is labelled as predicted until it is verified in the world.

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

# Dig blocks with the right tool, with the dashboard open for the whole run
npm run dev -- --task mine-stone --resource iron_ore --count 4 --max-actions 40 \
  --host 127.0.0.1 --username GameMind --control-center
```

Task kinds are `gather-logs`, `mine-stone`, `craft-wooden-pickaxe`, and `secure-food`. Other flags for a live run: `--allow-combat` (arms attacks at the adapter, safety policy and planner; without it the agent only flees), `--no-learning` / `--learning-dir PATH`, `--memory-dir PATH`, `--world-key KEY`, and `--control-center` / `--control-port` / `--control-host`. The storage defaults can also be set with `GAMEMIND_MEMORY_DIR` and `GAMEMIND_WORLD_KEY`.

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
- `MINECRAFT_VIEW_DISTANCE` (`short` by default; `tiny`, `short`, `normal`, or `far`)
- `MINECRAFT_OBSERVATION_RADIUS` (default `5`, valid range `1–16`)
- `MINECRAFT_MAX_OBSERVED_BLOCKS` (default `256`, valid range `1–4096`)
- `MINECRAFT_ENTITY_RADIUS` (default `24`, valid range `1–128`)
- `MINECRAFT_RESOURCE_SCAN_RADIUS` (default `32`, valid range from the local radius through `128`)
- `MINECRAFT_RESOURCE_SCAN_LIMIT` (default `192`, valid range `1–512`)
- `MINECRAFT_AUTO_RESPAWN` (`true` by default; set `false` to disable Mineflayer's automatic respawn request)
- `GAMEMIND_TRACE_DIR` (default `data/traces`)
- `GAMEMIND_LEARNING_DIR` (default `data/learning`)
- `GAMEMIND_CONTROL_HOST` (default `127.0.0.1`; the dashboard binds this interface)

For an offline-mode server, keep `MINECRAFT_AUTH=offline`. Use Microsoft authentication only where appropriate. Do not put account credentials in command-line arguments, source control, logs, or traces; Mineflayer manages its own authentication flow and cache.

When the Control Center is enabled, its **Library** panel is the only control surface: every action (companion modes, homepoints, skills, tasks, safety, learning) is an explicit entry with typed fields, per-run availability, and a measured outcome — succeeded, failed with a failure code, or refused with the missing requirement named. There is no chat-command system: Minecraft chat is never parsed into actions, there is no commander username, and no `MINECRAFT_COMMANDER` variable is read. Named homepoints are world-scoped, dimension-aware, and never overwritten without an explicit delete. Follow targets a measured 4-block preference, stops inside 5 blocks, and treats 32 blocks as a normal maximum separation target—not a guarantee under teleportation, disconnection, or obstacles.

## Known limitations

- **No live Minecraft verification has been run.** The adapter, respawn path, persistent memory, Control Center, and combat behavior are covered by unit tests, Mineflayer doubles, or offline simulation, but none of those proves Java 1.20.4 server or plugin behavior. The Control Center API/assets have HTTP integration coverage, but the WebGL view has not had a visual browser/E2E test. Calls such as `findBlocks`, `getDroppedItem`, berry-property reads, harvesting, pickup, rest, respawn, and pathfinder error handling still need the live checks in [`docs/LIVE_VERIFICATION.md`](docs/LIVE_VERIFICATION.md).
- **Natural regeneration depends on the server.** Rest is confirmed only by an observed health increase. A server with `naturalRegeneration` off, or with food below 18, will correctly report "not confirmed" and the task will stop.
- **Exploration uses client-loaded chunks.** The live wide scan cannot see unloaded chunks; coverage is marked only for explicitly reported loaded columns and only for untruncated scans. Unknown areas remain unexplored, and waypoints across them may fail with `PATH_NOT_FOUND`. Waypoints are navigated at the agent's current height with a 3-D goal, so steep terrain may require exclusions and replanning.
- **Food sources are limited.** Dropped food, ripe sweet berries, and inventory food. Passive animals are not hunted; combat is a separately gated, opt-in defence capability for hostiles, not a food-gathering mechanic.
- **Persistent world identity is operator-scoped.** The default host + port + dimension key cannot recognize a world reset or replacement at the same address. Stored locations are presented as last seen, but an operator should set a distinct `--world-key` when reusing an endpoint for a different world.
- **Mining is limited to blocks the local scan can see and the held tool can break.** It walks to a remembered stone-class or ore cell, equips, digs, and verifies the drop; it does not dig downward deliberately, branch mineshafts, place torches, or manage falling into a ravine. Ore beyond `--max-target-distance` is out of scope for a task.
- **Shelter means a closed shell.** `build-shelter` places blocks from inventory on the open cardinal (or all eight) sides at the player's level. It does not roof, light, or evaluate whether the location is defensible beyond the observed blocks, and it reports `unknown` support rather than guessing about unobserved cells.
- **Learning is experience statistics, not model learning.** There is no gradient update, no neural network, no replay buffer beyond the episode log, and no online adaptation inside a single run: the memory changes decisions in *later* runs. Weights that were never promoted stay candidates.
- **The Control Center keeps only the recent window.** A 400-event trace ring feeds recent action, decision, event and failure panels. The JSONL trace and separate world-memory snapshots are durable; the dashboard itself is for live operations, not long-term trace browsing.
- **Performance data is scoped and low-overhead.** The Control Center samples Node process CPU, event-loop utilization, RSS/heap, host memory/load on snapshot requests, plus live adapter scan timings and skill durations. It does not profile Minecraft server TPS, GPU, GC pauses, per-core counters, or end-to-end networking; no diagnostic profiler or Minecraft tick hook is installed.
- **Simulator fidelity.** Walking, hostiles, hunger, and regeneration are simplified; the simulator has no collisions beyond solid cells, no lighting, no mob pathing, and no protocol.
- **Live verification of the autonomy loop has not been run.** The fast loop, reflexes, the planner, the performance panel and the observation cadence are tested with the simulator and unit tests only. The ~1 s cadence is a design target, not a measured live figure.
- **Repeated failures are bounded, not eliminated.** In the `berries` profile (seed 101, 900 virtual seconds), `autonomous:mine-iron-ore` is retried 8 times and fails each time after 2 actions with no simulated time spent. Cooldowns and the fallback stop the retries from growing without bound, but a task that always fails in the same way is still attempted repeatedly.
- **No measured training gain.** The latest run (24 episodes, 3 checkpoints, 10 evaluation seeds per scenario) gives a candidate success rate equal to the baseline (73.5% → 73.5%). Its verdict is `not-promotable`. Training works end to end, but it has not produced a measured improvement.
- **Seed is manual only.** No auto-detection is implemented, so seed-derived information is always a prediction until it is checked in the world.
- **Recovery is bounded, not exhaustive.** A route blocked everywhere, or one whose shortest paths all pass through an unobservable block, ends in a bounded stop.

## Traces and tests

- `scenarios/minecraft-look-roundtrip.json` is the seeded orientation scenario.
- `data/traces/<session-id>.jsonl` stores ordered session, observation, decision (with plan, band, alternatives, rejections, memory knowledge and the safety verdict), skill, action, verification, and task events. Sensitive-looking fields are redacted and long strings truncated.
- `data/learning/episodes.jsonl` plus `state.json` are the experience memory and promoted policy; `data/world-memory/<world-hash>.json` stores validated resource/minable sightings and explored coverage. These data directories are gitignored and may be deleted to reset memory.
- Tests use offline fixtures, deterministic simulated worlds, and an injected Mineflayer double. They verify program logic and simulated interactions, **not** Minecraft server behaviour, protocol compatibility, or plugin behaviour in a live world.
- `npm test` runs 586 tests, including loaded-chunk/truncation memory, persistent world snapshot validation/round-trips, death/respawn recovery and deadline bounds, adapter regressions, decision/safety contracts, offline evaluation gates, policy-promotion refusal cases, and the Control Center HTTP/runtime surface (startup errors, boot-data escaping, static containment), and line-of-sight results from Mineflayer (`null` from a missed ray is a measured "not visible"). The latest `npm audit --audit-level=low` check found 0 vulnerabilities.
