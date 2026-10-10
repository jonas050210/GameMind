# GameMind

GameMind is a modular, observable game-agent runtime. The current implementation closes a bounded Minecraft loop: observe the world, choose a goal by priority and utility, pass it a safety gate, execute a validated skill, verify the result against the next observation, and replan. Decisions, refusals and outcomes are recorded as structured traces, an experience memory makes later runs avoid known dead ends, and a **Control Center** serves that same live state in a browser — with operator controls that reach the running agent. The wider architecture and roadmap are documented in [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md). The live test checklist is in [`docs/LIVE_VERIFICATION.md`](docs/LIVE_VERIFICATION.md). Run it with `python3 main.py` (see [Quick start](#quick-start)).

> **Live status:** none of the behaviour below has been run against a Minecraft server in this repository, and the Control Center has never been opened in a real browser from the build environment. Offline tests, an offline simulator, Mineflayer doubles and a fake DOM validate control logic and mock interactions only. Live compatibility is **not** claimed. The Control Center labels every figure as live, simulated, historical or unavailable, and a simulated figure is never evidence about a real world. See [Live Minecraft](#live-minecraft), [What still needs your environment](#what-still-needs-your-environment) and the checklist.

## Quick start

```bash
npm ci               # once; `python3 main.py --install` does this for you when node_modules is missing
python3 main.py      # checks, Control Center, browser and a persistent Minecraft session
```

`python3 main.py` is the supported way to run GameMind. It is a launcher around the TypeScript agent, not a second implementation: no agent, planner or learning code exists in Python. It:

1. checks Node.js 22+ (set `NODE=/full/path/to/node`, or `GAMEMIND_NODE`, if it is installed somewhere unusual), the installed dependencies (including the platform build of `esbuild`), the project path (a warning for `/mnt/c/...` checkouts under WSL, which are slow), whether another GameMind is already running in this project, and the Control Center port (8787, or the next free one unless you pass `--control-port`);
2. under **WSL2**, with no `--host` and no `MINECRAFT_HOST`: if nothing answers on `127.0.0.1:<port>` but the Windows host does, connects to the Windows host. An explicit `--host` or `MINECRAFT_HOST` always wins and is never rewritten;
3. starts `src/cli.ts` through the project's own `tsx`, waits for its `GAMEMIND_READY` line, prints the Control Center address and has the agent open your default browser **once**. The Control Center stays up for the whole session, so refreshing or closing the tab restarts nothing, and state updates never open another tab;
4. on Ctrl-C or SIGTERM asks the agent to stop: the running task is stopped, queued work is cancelled, the bot disconnects once, the Control Center closes and the single-instance lock is released. If that takes longer than 25 s the launcher sends SIGTERM, then SIGKILL; a second Ctrl-C sends SIGTERM at once.

| Command | What it does |
| --- | --- |
| `python3 main.py` | Persistent session on `$MINECRAFT_HOST` (default `127.0.0.1`) port `$MINECRAFT_PORT` (default 25565) |
| `python3 main.py --host 192.168.1.20 --port 25565 --username GameMind` | The same, on an explicit server |
| `python3 main.py --task gather-logs --resource oak_log --count 2` | Run that task first (it has priority over autonomy), then stay connected |
| `python3 main.py --task gather-logs --one-shot` | End the session when the task finishes; exit code 1 if it did not succeed |
| `python3 main.py --simulated [SCENARIO]` | The offline simulator instead of a server, labelled simulated everywhere |
| `python3 main.py --no-connect` | Only the Control Center; connect from the **Bots** tab |
| `python3 main.py --no-autonomy` | The agent acts only on tasks you start (safety limits are unchanged either way) |
| `python3 main.py --no-browser` | Do not open a browser |
| `python3 main.py --check` | Check Node, dependencies, ports and WSL, report every problem, and exit |
| `python3 main.py -- --help` | Everything after `--` goes to the TypeScript CLI unchanged |

The launcher's own exit codes: `0` normal, `1` `--check` found a problem, `2` it could not start (the message names the fix). If GameMind is already running in this project it says where and does not start a second bot. The Control Center binds to `127.0.0.1`; to reach it from another machine (or a hosted preview) pass `--control-host 0.0.0.0` and read [Control Center](#control-center) first. The TypeScript CLI can also be run directly: `npm run app -- --host 127.0.0.1` (development) or `npm run build && npm run app:build -- --host 127.0.0.1`.

## Sessions, tasks and the scheduler

A **session** is one bot's connection plus everything that lives and dies with it. It has explicit states: `connecting` → `initializing` → `idle` ⇄ `running` → `stopping` → `shutdown`, with `reconnecting` when a live connection drops. The Control Center and the CLI report the same state, and a failed start ends in `shutdown` with a diagnosis (refused, timed out, DNS, wrong version, banned) rather than a stack trace.

- **Persistent (default).** Connect, run the task you asked for (if any), then stay connected and idle (or autonomous) until you stop the session from the Control Center or press Ctrl-C. A finished task never ends a persistent session.
- **One-shot (`--one-shot`).** The session ends with its task and says why; the exit code is `1` if the task did not succeed. A one-shot run serves no Control Center unless you also pass `--control-center`.
- **Reconnecting.** A dropped live connection is retried with exponential backoff (2 s doubling to 30 s, 5 attempts by default; `--reconnect-attempts 0` disables it). A ban or kick is not retried. When every attempt fails the session shuts down with `RECONNECT_EXHAUSTED`; stopping during a retry cancels it.

Every piece of work goes through **one scheduler** (`src/games/minecraft/task-scheduler.ts`), whichever side asks:

| Origin | Priority | Notes |
| --- | --- | --- |
| `cli` | highest | The task you passed on the command line. It **reserves the startup window** (30 s), so autonomy cannot take the idle gap between "connected" and "task starts". |
| `control-center` | | Tasks started from the page. |
| `library`, `companion` | | Library entries and companion modes. |
| `autonomy` | lowest | The only origin that can be pre-empted: an operator task stops a running autonomous subgoal at its next safe point instead of racing it. |

At most one task runs at a time. A second request is either **queued** (up to 5, ordered by origin priority, only when the caller asked for queueing) or refused with a message that names the running task. An identical request (same kind, resource and count) is refused as `TASK_DUPLICATE`. The lock a task holds is released in a single `finally`, so a failed start can never leave the agent unable to accept the next task, and closing the session drains the scheduler: the running task is stopped, queued tasks are cancelled and nothing starts afterwards.

Only one GameMind process runs per project at a time (`data/run/gamemind.lock.json`; `--no-instance-lock` opts out). Exit codes of the TypeScript CLI: `0` success, `1` a one-shot task did not succeed, `2` the app could not start, `3` another GameMind is already running.

### Root causes fixed in this release

Each row has regression tests; none of it has been run against a live server.

| Symptom | Root cause | Fix |
| --- | --- | --- |
| `ReferenceError: Cannot access 'host' before initialization` on the first autonomous subgoal | `execute()` read `host.runnerOptions`, but `const host` was declared only after `await startControlCenter(...)`. The autonomy loop could start a subgoal while the server was still starting and reached `host` in its temporal dead zone | `runnerOptions` is a plain value built before anything can start a task, and tasks run through the scheduler; a test starts autonomy while the server is still starting |
| `A task is already running in this agent; stop it before starting another.` right after start | Autonomy took the idle window between "connected" and the CLI task's start, so the CLI task found the slot taken (and the leaked lock below made it permanent) | The scheduler's startup reservation gives the CLI task priority; autonomy waits or is pre-empted |
| `CLI run complete` and a disconnect just after joining | The CLI was one-shot by design: its `finally` always ended in `runtime.shutdown("CLI run complete")`, and only an observation-only run with a dashboard waited for Ctrl-C | Persistent sessions are the default and end only on an explicit stop; one-shot is opt-in |
| The agent refused every task after one failed start | `control.task` was set *before* the `try` that releases it, so an exception while creating the runner (the temporal-dead-zone error was one) left the lock held for good | Slot acquisition, runner creation and release sit in one `try/finally` |
| The dashboard answered requests for any `Host` and from any origin | Permissive server defaults | Loopback bind, `Host` allowlist, same-origin writes, `x-gamemind-token` |
| Two trainings (or a training and an evaluation) in one directory overwrote each other | No lock; a run directory could even be the app's own data folder | `training.lock`, a preflight, reserved data folders, archive-never-delete for fresh runs |
| A command racing a refresh answered `500` (`ENOENT` on rename) | Every writer used `<file>.<pid>.tmp`, so two saves in one process shared a temp file | `src/core/atomic-file.ts`: unique temp names and per-file ordered writes |
| The learner counted confirmed-but-unverified actions as successes; the runner counted them as failures | Two definitions of "success" | One definition (`src/core/learning/outcome.ts`) used by both |
| A context that failed because of the game mode or a safety refusal looked like a skill that never works | Every non-success counted against the chosen skill | Environment, session and policy outcomes are *excluded*: counted and shown, never held against a skill |
| Demo episodes shaped the live policy | One store pooled simulator and live episodes | Episodes carry a provenance; each store admits only its own (`live`, `simulator-demo`) |
| "Wasted actions" reported more than half of all actions as waste | Only item and food gains counted as an effect, so every move, rest and retreat was "waste" | A verified effect is also revealed ground, a measurably shorter distance to the target, healing from a rest, or a retreat from a hostile (see [Offline evaluation](#offline-evaluation)); the figure is a measurement and steers nothing |

## Current implementation

- Minecraft Java through Mineflayer **4.39.0**, defaulting to protocol **1.20.4** (configurable). Pathfinder **2.4.5**, CollectBlock **1.6.0**, and Mineflayer Tool **1.2.0**.
- **Observations** carry player state, inventory/equipment, nearby entities, a local cube, wider resource/minable scans, and dropped items from entity metadata. The live adapter defaults to a 5-block local radius/cap 256 and a 32-block wide radius/cap 192 per scan; its radii, caps, entity range and view distance are configurable through `MINECRAFT_*` settings. The offline simulator uses a 5-block local radius and a 24-block wide radius. Loaded chunk columns, scan truncation and (live adapter) measured perception timings are reported. These are client-visible scans, not server-wide queries: unloaded chunks stay unknown, and a saturated scan is never evidence that an unreturned block is absent.
- **Skills** are strictly validated and allowlisted: look, inspect, conservative navigation, log collection, equipment, wood crafting, food consumption, cautious crafting-table placement, and three survival skills added in the previous release: **pickup of an observed food or log drop**, **harvest of a ripe sweet berry bush**, and **bounded rest** for natural regeneration. None of them attacks an entity.
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
- **Offline simulator and evaluation.** A deterministic, seeded grid world (`src/testing/simulated-minecraft/`) models walking time, a loaded-chunk boundary, hostiles that chase, hunger and regeneration, drops, ripening berries, stall cells, and scheduled world changes. It advertises the same capabilities and reports the same error codes as the live adapter. Twenty-six scenarios are judged over seeded layouts (see [Offline evaluation](#offline-evaluation)).

This remains a deliberately narrow, rule-based agent. It is not a full survival agent, an RL system, an LLM planner, or a general-purpose GUI. It does not hunt passive animals, go mining below the surface deliberately (it digs blocks it can reach with a tool it holds), build anything beyond a closed shell around the player, handle every recipe or version, or plan across dimensions. Fighting is only reachable when an operator armed combat for that run.

## Behaviour changes in this release

Existing users should review these. Each is deliberate and covered by offline tests; none has been run against a live server.

1. **Sessions are persistent by default.** `--task` (and a plain `--host`) now keeps the bot connected after the task and serves the Control Center until you stop it. Pass `--one-shot` for the old "run, report, disconnect" behaviour (with no task and no Control Center it prints the first observation and the skill list, as a bare `--host` run used to); the `task:minecraft*` npm scripts now end with `--one-shot` so they behave as before.
2. **The Control Center is on by default** for persistent sessions, on `127.0.0.1:8787` (`--control-port`, `--control-host`, `--no-control-center`). One-shot runs serve it only with `--control-center`. `--open-browser` opens it once.
3. **One scheduler decides what runs.** A CLI task has priority over autonomy during startup; an operator task pre-empts a running autonomous subgoal; duplicates are refused; a queue of at most 5 holds follow-up tasks. Autonomy is still on by default (`--no-autonomy` turns it off) and every safety policy, action budget, combat restriction and capability check is unchanged.
4. **One GameMind per project.** A second process refuses to start and names the first (`--no-instance-lock` opts out).
5. **The dashboard server is hardened.** Loopback bind, a `Host` allowlist (`--allow-host`), same-origin writes and a per-process token. Binding beyond loopback needs `--control-host`.
6. **Training is locked, preflighted and non-destructive.** One run per directory (`training.lock`), data folders of the app cannot be used as a training directory, resume is the default, and `--fresh` archives the previous run instead of overwriting it. `npm run train` and the Control Center now explore by default (rate 0.15, seeded and recorded on each decision, never used in evaluation); `--explore 0` restores the earlier greedy behaviour.
7. **Learning counts verified outcomes only.** Success, failure and *excluded* are defined once. **A safety refusal is not an attempt**: it happens before the action runs, so across runs it is counted as a denial and as an excluded outcome and cannot move a skill's success rate or weight (inside a run it is still a failed action: it counts toward the consecutive-failure stop and its target is excluded). The one existing assertion that expected `attempts` to be 1 for a denied approach was changed on purpose to expect 0 attempts and 1 excluded outcome. Simulator and live episodes are kept in separate stores; learning state is schema v2 (the old file is backed up as `state.json.v1.bak` or `state.json.evidence-filter.bak`, and the episode log is never rewritten).
8. **"Wasted actions" has a new definition** (`verified-world-progress.v2`): an action is wasted only if the next observation shows no item or food gained, no new ground explored, no measurable approach to its target, no healing from a rest and no retreat from a hostile. Reports and evaluation sets record the definition, so figures measured under the old one are never compared with new ones. The figure is a measurement: it does not change any decision.
9. **The snapshot publishes the player's whole-block position.** `test/control-center.test.ts` used to require `world.position` to be absent; that assertion was changed deliberately because the Control Center now shows the position. Block coordinates, terrain and entity coordinates are still not published.
10. **The Control Center page was rewritten** as seven tabs over one polling store (see [Control Center](#control-center)). The old WebGL block view is gone (it had already been removed from the code; its documentation is cleaned up).
11. **Atomic file writes are serialised.** Every data file written by the app uses `src/core/atomic-file.ts` (unique temp names, ordered writes per file).
12. **The build verifies the packaged UI.** `npm run build` fails if any file of the page did not reach `dist/`.

## Behaviour changes in the previous release

These were introduced before the lifecycle and Control Center work above. Each is deliberate and covered by tests.

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
15. **The Control Center is an operations console.** It includes bounded task launch, operator safety controls, live decision/action/event panels, perception timings, and an interactive WebGL block view. The view distinguishes current blocks from wireframe last-seen memory and never fills unknown terrain. *(Superseded: the page was rewritten and the WebGL block view was removed; see the release notes above.)*
16. **World knowledge survives live CLI restarts.** Debounced, validated snapshots preserve resource/minable sightings and explored cells only. Hostiles and drops remain transient; default identity is host + port + dimension, with `--world-key` for operator-defined separation.
17. **Death recovery is explicit and bounded.** The Mineflayer health plugin is configured for automatic respawn by default (`MINECRAFT_AUTO_RESPAWN=false` disables it). After a death observation, the task loop waits for an alive state from the adapter without issuing actions, re-observes before replanning, and ends on disconnect, operator stop, a 30-second wait limit, or the task deadline. This path is covered by offline tests, not a live-server test.

## Requirements and checks

- Node.js 22 or newer.
- Python 3 for the `python3 main.py` launcher (standard library only, nothing to install; developed and tested with 3.11).
- For live play: an authorized private or local Minecraft Java server that matches the configured protocol.

```bash
npm ci                   # reproducible install from package-lock.json
npm run build            # TypeScript typecheck + copy the Control Center assets
npm test
npm run test:launcher    # Python tests for main.py and the launcher
npm run eval:offline     # offline simulated evaluation (no server)
python3 main.py --check  # check Node, dependencies, ports and WSL, then exit
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

- **Success scenarios** (15) must reach the goal in at least the stated share of seeds (80% or more). They cover exploration for a remote log, crafting with distant trees, food from remote berries and dropped bread, rest then gather, eating before gathering, a single hidden obstacle, replanning after a removed log, mining with and without a pickaxe, shelter on the open sides, freeing a full inventory, and picking up dropped logs and cobblestone.
- **Safety scenarios** (11) may end blocked or failed, but must start no action under threat, never reach zero health, and never make an unsupported confirmation. They cover no food anywhere, a zombie guarding berries, critical health with no food, a route with no way around, sheltering when hurt at night, combat with and without the operator's opt-in, a lava edge, and three autonomous multi-step runs (extended survival, a stone-pickaxe crafting chain, milestone progression). Some of them also reach the goal (see the table); the gate does not require it.
- **Global gates:** zero unsafe actions, zero deaths, and zero contradicted confirmations across every run.

The default command evaluates 26 scenarios × 20 seeds (520 runs). The latest run took 12.7 seconds; the table below is its result (`data/eval/offline-report.json`), and every scenario gate passed. *Reached the goal* is the share of seeds whose task succeeded. A scenario judged on safety alone is expected to stop safely, so a low figure there is the correct behaviour, not a failure.

| Scenario | Judged on | Reached the goal | Notes |
| --- | --- | --- | --- |
| explore-remote-log | success ≥ 90% | 100% | Exploration then collection |
| explore-craft-pickaxe | success ≥ 80% | 100% | Remote trees, full crafting chain |
| food-remote-berries | success ≥ 80% | 100% | Exploration, harvest, eat |
| food-dropped-bread | success ≥ 95% | 100% | Pickup, eat |
| food-none-reachable | safety only | 0% | Blocks after bounded exploration |
| survival-zombie-guards-berries | safety only | 5% | No harvest under threat |
| survival-rest-then-gather | success ≥ 90% | 100% | Rest, then gather |
| survival-critical-no-food | safety only | 0% | Stops with no actions |
| recovery-single-hidden-obstacle | success ≥ 85% | 100% | Stall, sidestep, retry |
| recovery-persistent-stall | safety only | 0% | Stops within budget |
| replanning-removed-log | success ≥ 85% | 100% | Replans after a removed log |
| survival-eat-before-gather | success ≥ 95% | 100% | Eats at the threshold first |
| mine-stone-with-pickaxe | success ≥ 95% | 100% | Equips, digs, verifies the drop |
| mine-stone-needs-pickaxe | success ≥ 80% | 100% | Crafts a pickaxe first, then digs |
| shelter-close-cardinal-sides | success ≥ 90% | 100% | Places blocks on open sides |
| shelter-before-night-when-hurt | safety only | 0% | Shelters instead of gathering at night |
| combat-opt-in-defence | safety only | 100% | Attacks only when combat is armed |
| combat-denied-by-default | safety only | 100% | Flees; attacks refused without opt-in |
| inventory-full-frees-space | success ≥ 90% | 100% | Drops junk, then collects |
| hazard-lava-edge | safety only | 100% | Refuses stationary work next to lava |
| gather-pickup-dropped-log | success ≥ 80% | 100% | Picks up a dropped log as free progress |
| mine-pickup-cobblestone | success ≥ 80% | 100% | Picks up a cobblestone drop during a mining task |
| autonomous-extended-survival | safety only | 0% | Long autonomous run from nothing (100-action budget) |
| crafting-chain-stone-pickaxe | safety only | 0% | Wood, then pickaxe, then stone; judged on safety |
| autonomous-milestone-progression | safety only | 100% | Logs, tools, wooden-tools milestone; judged on safety |
| gather-pickup-useful-cobblestone | success ≥ 80% | 100% | Picks up cobblestone while gathering logs |

Across all 520 runs there were **0 unsafe actions, 0 deaths, and 0 contradicted confirmations**. The overall goal-reached rate was 73.3% (381 of 520 runs); it is not a quality score, because the safety-only scenarios are expected to stop. (The evaluation set that `npm run train -- evaluate` uses is a different one, with 10 seeds per scenario: 191 of 260 runs, 73.5%.) The report showed no weighted candidate policy, so policy-ranking evaluation was not run.

The suite also measures the learning memory: the same seeded worlds are run twice back to back with one shared experience store, and the repeat run is compared action-for-action.

```
scenario                    cold act.  repeat act.  cold waste  repeat waste
recovery-persistent-stall   5          0            3           0
inventory-full-frees-space  2          2            1           1
mine-stone-needs-pickaxe    12         12           2           2
```

The first row is the effect a memory can have: the targets that only wasted actions are no longer proposed, so the second run stops immediately instead of repeating them. The other two rows are the honest limit of that claim: those actions were not mistakes but the only path to completion (crafting a pickaxe, freeing inventory space), so remembering the failure must not remove them. `wastedActions` counts an action as wasted when the observations around it show none of the verified effects listed below, so the claim here is "fewer actions wasted on already-failed targets in a repeat run, at equal or better success", never "waste reaches zero".

**What counts as a wasted action.** An action is *not* wasted when the next observation shows an item or food gained, new ground explored (an exploration leg that revealed at least one cell the agent had never seen), an approach of at least one block to its target, health raised by a rest, or a retreat from a hostile (it left view, or is at least two blocks farther away). Everything else counts, including actions that change the world in ways this measure does not read (equipping a tool, placing a block, dropping an item), so the figure is an upper bound on waste, not a count of mistakes. This is definition `verified-world-progress.v2`. Under the first definition only item and food gains counted, so every move, rest and retreat was scored as waste: over the 260-run comparison set the mean fell from 2.87 to 0.64 wasted actions per run, with no run's outcome, choices or action count changing. Both evaluation reports (`eval:offline` and `train evaluate`) record the definition, and it is part of an evaluation set's identity, so figures measured under another definition are not compared with these. An `offline-report.json` written before this release holds numbers from the first definition; regenerate it with `npm run eval:offline`. The figure is a measurement only: it feeds no decision, so the brakes against wandering are unchanged.

**No headroom, so no measured gain.** The 15 success scenarios already succeed in every seed with the baseline policy, and the 11 safety scenarios are judged on safety, which the baseline already satisfies. A learned policy can therefore match the baseline or regress on these gates, but it cannot beat it. See [Learning and policy](#learning-and-policy) for what a training run has and has not measured.

Policy candidates are additionally compared against the baseline through the gate (`test/policy-comparison.test.ts` runs the full scenario set for both and refuses promotion on any regression, unsafe action, death, or contradicted confirmation).

**What these numbers do and do not mean.** The simulator is written by the same project, uses simplified physics and mob behaviour, and has no protocol layer, so these figures show the planner, recovery, and verification logic behave as designed. They are not evidence about real Minecraft server behaviour.

## Control Center

The Control Center is the operator surface of a running GameMind. It is served by the same process as the agent (one server per process, bound to `127.0.0.1:8787` by default) and stays up for the whole persistent session, so refreshing or closing the page restarts nothing and the browser is opened at most once. It is plain HTML, CSS and ES modules served from this package: no build step, no dependencies, and no CDN, remote font or other external asset. Its visual direction (restrained colours, a strong typographic hierarchy, top tabs with a compact status area) follows the written brief that named learningview.org as inspiration; that site was not reachable from the build environment and nothing was copied from it. It has automatic, light and dark themes, switches off its transitions under `prefers-reduced-motion`, and is laid out desktop-first with a responsive fallback.

```bash
python3 main.py                                   # persistent session + Control Center + browser
python3 main.py --simulated                       # the same, against the offline simulator
npm run dev -- --sim recovery-persistent-stall --control-center --control-port 0
npm run ui:demo                                   # simulator + Control Center on all interfaces (sandbox previews)
```

A status bar is always visible: session state, a data-source badge, the age of the last update, an emergency stop and a theme switch. Seven tabs share one polling store:

| Tab | What it shows and does |
| --- | --- |
| **Overview** | Session and connection state, Minecraft version, world identity, health, food, whole-block position, the current task with measurable progress, runtime, recent timestamped events and compact training and evaluation summaries; pause, resume, stop task, emergency stop and stop session. A stale observation is called out together with what it means: the safety policy refuses world-changing actions until a newer one arrives. |
| **Training** | Headless offline training in a separate process: directory, episode and time budgets, curriculum stages, exploration rate. Resume is the default; a fresh run first explains that the existing run will be archived (never deleted) and needs an explicit confirmation. Live episode count, stage, elapsed time, state, checkpoints and errors; start, pause, resume and stop. It says in so many words that offline training is not real-world training. |
| **Bots** | The sessions: connection state, world, task, position, health and runtime, with connected-idle, running and disconnected kept apart. Connect to a live server or the simulator (with diagnostics and actionable errors), start or queue a task, run library entries, stop; task history with failure explanations. There is one bot today; the layout is a list so more can be added, and nothing pretends to run several. |
| **Tasks** | Only tasks the agent really implements, with their enforced limits; the active task with measurable progress, actions and outcome; the latest decision (what was chosen, the alternatives weighed, and the model's own reason for every rejected candidate); the queue (up to 5, no duplicates) or an explicit reason when queueing is unavailable. |
| **Tests & Evaluation** | Unit tests and the offline evaluation as monitored jobs (one at a time, cancellable); baseline-versus-candidate comparisons with success rate, median actions, wasted actions, unsafe actions, deaths, 95% intervals and per-scenario deltas; PASS, FAIL and SKIPPED with the reason for every skip; the roadmap queue. **Live verification is a separate section**: it names the server it will touch and needs an explicit confirmation of the connection, and a second one before any phase that changes the world. |
| **Learning & Policy** | The real experience store: policy status, candidate and active policy, contexts with evidence and weights, contradictions, excluded outcomes, blocked targets, historical runs. Plain explanations of `CONSECUTIVE_ACTION_FAILURES`, `NO_FEASIBLE_GOAL` and `TASK_BLOCKED_MODE` with what to check. Promote and reject only through the existing gate. |
| **World Memory & Events** | World identity, remembered resource sightings, explored regions and memory status; the world seed (entered by hand, never auto-detected); and a searchable event log of connections, decisions, actions, task transitions, safety refusals, errors and shutdown reasons. |

**Where each number comes from.** Every panel carries a badge: **LIVE** (a connected Minecraft session), **SIMULATED** (the offline simulator), **HISTORICAL** (remembered or stored data, or a session that has ended), **OFFLINE** (unit tests, evaluation and training) or **UNAVAILABLE**. A value that was not reported is shown as *unknown*, never as a default; there are no placeholder charts and no invented metrics. An offline result is never labelled live, and nothing is called "improved" or "promotable" except by the existing gate's own verdict.

Controls exist only where the runtime really implements them:

| Control | What it really does |
| --- | --- |
| Pause / Resume | `SafetyBroker.pause()` / `resume()`. While paused, every non-read-only capability is denied with `RUN_PAUSED`. |
| Trip / Reset trip | `SafetyBroker.trip()` / `clearTrip()` + resume. A trip denies *everything*, including read-only actions, until an operator resets it. A reset never lifts an independent pause. |
| Emergency stop | Trips the broker, stops the running task and disarms combat in one step. |
| Combat allowed | `adapter.setCombatAllowed()` **and** the safety policy's `optedInCapabilities`, so both enforcement layers move. Hidden when the adapter has no such switch. |
| Action budget | `SafetyBroker.configure({ maxActionsPerRun })` plus the running task's own `maxActions`, clamped to the task schema's 1–100. |
| Start task | Builds a task through the same zod schemas the CLI uses. Refuses while tripped or paused. While another task runs it queues (when asked to) or refuses with the running task's name; a duplicate is refused as `TASK_DUPLICATE`. |
| Stop task / Cancel queued / Clear queue | Cooperative stop checked between actions: the run ends as `aborted` / `OPERATOR_STOP` with the operator's reason. |
| Connect / Stop session | Starts or ends the session through the same lifecycle as the CLI (live or simulated). A connect while a session exists is refused (`SESSION_ALREADY_ACTIVE`): only one session runs at a time. |
| Autonomy on / off | Switches the autonomous planner; safety limits are identical either way. |
| Start / Pause / Resume / Stop training | Runs the offline trainer in a child process under `training.lock`; pause and stop take effect after the current episode. |
| Run unit tests / offline evaluation | Monitored jobs in child processes; one at a time; cancelled on shutdown. |
| Run live verification | Only after the confirmations above; the server must receive `confirmed === true`. |
| Promote / Reject policy | `ExperienceLearner.promote()` / `rollback()`, refusing when any confirmation was contradicted or the candidate never left the baseline. |
| Library entries, roadmap decisions, world seed | Validated commands handled by the run host, each answered with its measured outcome or the reason it was refused. The seed is a manual field. |
| Quit GameMind | The footer button runs the orderly shutdown of the whole process. Closing the tab does not. |
| Nothing about the world | The page can hold, arm and stop the agent; it never writes to the world or to `bot.*`. |

**HTTP surface.** `GET /api/health`; `GET /api/snapshot` (`?fresh=1` bypasses the one-second cache); detail reads `GET /api/events` (`q`, `category`, `level`, `source`, `scope`, `after`, `limit`), `learning` (`store=simulated|live`), `memory`, `evaluation`, `jobs`, `training-preflight` (`directory`), `tasks` and `diagnostics`; and `POST /api/command` with `{ "type", "payload" }`. The page polls instead of holding a stream (every 1.5 s while visible, 15 s in a hidden tab; slower detail queries only for the tab that is open) and shows the connection as lost after two failed reads, then recovers by itself. `GET /api/stream` answers `410 STREAM_REMOVED`. Writes need the `x-gamemind-token` header (the token is injected into the served page only and is not readable from any endpoint), the `Host` header must be the bound address or a name allowed with `--allow-host`, and a cross-origin write is refused. A command the host cannot honour returns `501`, a refused one `409` with the reason, and a missing token `403`, so the page can never look as if something worked when nothing happened.

**What it deliberately does not do.** It exposes no free-form command console, no credential handling and no block map. The world snapshot carries the player's whole-block position but no blocks, terrain or entity coordinates; a decision's own explanation may name the block it is about, because that is what explains it, but a candidate's raw target and input are never drawn. Every message and field in the event log is redacted before it is stored (no tokens, no home directory, no absolute paths), and the log is kept as rotating JSONL files under `data/events/` (four files by default). The server authenticates with a per-process token but has no TLS: keep it on loopback, or on a trusted network if you pass `--control-host 0.0.0.0`, because the commands it accepts move a real character. Persisted world memory stores only last-seen resource and minable locations and explored coverage; the default key (server host + port + dimension) cannot distinguish a reset or replaced world at the same endpoint, so use `--world-key` / `GAMEMIND_WORLD_KEY` to give separate worlds distinct identities. Perception timings are the adapter's last scan sample, not a hardware benchmark.

**How it was tested.** The page is checked in a fake DOM that runs the real `index.html` and JavaScript against the genuine shape of every snapshot and query (`test/ui-page.test.ts`, `test/ui-components.test.ts`), against a real `GameMindApp` and its HTTP server (`test/ui-e2e.test.ts`), and by a static check that type-checks the page's modules for undeclared names, broken imports, use-before-declaration, duplicates and unused code (`test/ui-static.test.ts`). That shows which text, controls and states are on the page and what each control sends. **It cannot show how the page looks: nobody has opened it in a browser from this build environment**, so spacing, colour, contrast, responsive behaviour and animation are unverified until you look at it.

## Learning and policy

```bash
npm run policy:status              # what has been recorded, and what it concluded
npm run dev -- --policy promote    # requires full candidate evidence (20+ seeds, all scenarios)
npm run dev -- --policy reject     # back to the active (or baseline) policy
npm run dev -- --task gather-logs --no-learning   # this run records nothing
```

Every attempted action becomes an episode in an append-only JSONL log (band, skill, target class, distance, threat, inventory state, outcome, verification, failure code, provenance), and one aggregate per run goes to the failure memory. The same information is browsable in the **Learning & Policy** tab.

### What an outcome says

One rule decides what an episode says about the choice that produced it (`src/core/learning/outcome.ts`); the task runner, the learner and the Control Center all use it:

- **success**: the action succeeded, the adapter confirmed it, and the next observation does not contradict the confirmation;
- **failure**: the action ran (or was claimed to run) and the observed world says it did not work. A confirmation the world does not support is a failure, not a success with a footnote;
- **excluded**: the outcome is about something else: the connection dropped, the safety policy refused, the game mode forbids the action, a reflex cut it short. It is counted and shown, but it never moves a success rate, a weight or a target's failure memory.

Failed versus successful therefore rests on a verified change in the observed world, and a context that "failed" eight times because the player was in the wrong game mode no longer looks like a skill that never works. Each episode also records where it came from (`live`, `simulator-demo`, `simulator-eval`, `training`, or an inferred `simulator-unlabelled` / `unlabelled` for old rows). A store learns only from its own provenance: live sessions use `data/learning` (evidence `live`), simulated sessions use `data/learning-simulated` (evidence `simulator-demo`), so a demo can never become evidence for the live policy. The learning state is schema v2; opening an older file backs it up (`state.json.v1.bak`, or `state.json.evidence-filter.bak` when mixed episodes were filtered out) and rebuilds from the episode log, which is never rewritten.

### What changes decisions

1. **Repeatedly failed targets are excluded** in a later run against the same world key (`<scenario>#<seed>` offline, `host:port` on a live server) until enough observations contradict the failure. Only outcomes that say something about the target feed this memory, and a later success at the same target weakens the lesson instead of leaving a permanent ban.
2. **Policy weights are derived** from verified success rates: one multiplier per context band, clamped to 0.75–1.25, and only for contexts with at least 8 evidence-bearing attempts. They reorder candidate goals inside their priority band; a weight can never make a denied capability allowed, skip a postcondition check, or move a goal between bands. The reward breakdown is recorded for analysis but does not feed the weights.
3. **Within a run**, a failed target is excluded at once (a stalled route is retried after a sidestep), attempts at one target without progress are bounded (3), oscillation is detected, and a run ends after `maxConsecutiveFailures` failed actions in a row (default 2, schema range 1–5). Offline, that limit was measured: 2, 3, 4 and 5 give identical outcomes on the whole suite (191 of 260 runs succeed in each case, same actions, same waste, no `CONSECUTIVE_ACTION_FAILURES` stop) and only 1 changes the result (58.1%), so the default stays at 2; it is a safety brake and there is no measured reason to loosen it.
4. **Promotion is gated consistently in the CLI and the Control Center.** A derived candidate has no effect while it is only a candidate: the running agent uses the *promoted* policy, or the hand-tuned baseline. Promotion refuses unless the offline report passed, was generated for the exact current candidate, covers every current scenario with at least 20 seeds per scenario, the learner has episodes and at least one statistically supported weighted context, the candidate comparison itself is promotable, and no confirmation was contradicted. `--policy reject` (or the dashboard button) drops the promoted policy entirely and records the reason in the state history. Nothing promotes automatically.

### Why runs stop, in plain words

`CONSECUTIVE_ACTION_FAILURES`: the last actions all failed in a row; each failure excluded its target and the planner replanned, but the next attempt failed too, so the codes of those actions (path blocked, tool missing, block not diggable) name the world condition to look at. `NO_FEASIBLE_GOAL`: every candidate the planner was allowed to act on was excluded, unreachable, unsafe or already tried, and no exploration was left. `TASK_BLOCKED_MODE`: the live session reported a game mode the agent will not act in (creative, spectator), so the task was refused before any action ran: a policy decision, recorded as excluded evidence and never held against a skill. The Learning tab explains each of them with what to check, and the event log keeps the decision text of the blocked run.

### Evaluating a checkpoint

`npm run train -- evaluate` (or the Training tab) scores a checkpoint against the unchanged baseline policy on **held-out seeds**: training seeds start at a fixed base, evaluation seeds never overlap them, and the split is asserted before any run. The baseline is re-measured in the same report, and the first baseline recorded for an evaluation set is kept so a later measurement that no longer reproduces it is flagged (the code or the scenarios changed). The evaluation set's identity covers the scenarios, the seeds, the decision model and the definition of progress, so reports are only compared when it matches. The report carries success rates with 95% Wilson intervals, median actions, wasted actions, unsafe actions, deaths, per-scenario deltas, how often the candidate chose differently on the same world, and paired outcomes on identical worlds. Its conclusion is one of:

| Conclusion | Meaning |
| --- | --- |
| `no-learned-contexts` | The checkpoint holds no learned weights (a context needs 8 verified attempts first), so it *is* the baseline. The comparison measured nothing. Train longer. |
| `identical-behaviour` | The learned weights never changed a decision, so identical results are expected and say nothing about whether the weights work. |
| `behaviour-changed-no-gain` | The candidate chose differently somewhere, and the outcomes did not improve. |
| `improved` | The candidate chose differently and the existing gate measured an improvement without a safety regression (the same condition as "promotable"). |
| `regressed` | The candidate chose differently and did worse: lower success, more unsafe actions, or more deaths. |

**What has and has not been measured (offline simulator only).** On the baseline policy, 191 of 260 runs (73.5%; 26 scenarios × 10 seeds) succeed, identically on the original code, on the current code and under heavy CPU load. A 24-episode training run produced 6 learned contexts with weights up to 1.25 and changed the agent's choices in 10 of 260 paired runs, all in `autonomous-milestone-progression`; no outcome changed (95% interval 0.678–0.785 for both policies), so the conclusion is `behaviour-changed-no-gain`. A very short run (a few episodes) produces no learned context at all and says `no-learned-contexts`. **No improvement has been measured, and none is claimed.** The suite also has no headroom to show one: the 15 scenarios judged on success already succeed in every seed with the baseline, and the other 11 are judged on safety, which the baseline already satisfies (no unsafe action, no death). A learned policy can therefore match the baseline or regress, but it cannot beat it on these gates. Building scenarios where a choice decides the result would make a gain measurable, but scenarios designed so that learning wins would prove nothing, so none were added; real evidence of improvement needs a live comparison. The simulator is written by this project and is not Minecraft.

The design keeps the door open for real RL: episodes are the training records, the store is append-only JSONL, and `ExperienceLearner` is the only consumer. There is no gradient training, no neural network and no LLM in the loop; the "learning" is count-based experience statistics, and checkpoints reach a policy only through the gate above.

## Autonomy, observation and training

The agent runs two loops. A fast loop observes about once per second (`observationIntervalMs`, default 1000), checks reflexes (critical health, starvation, a close hostile, and so on), and interrupts an in-flight action only when the action is not protected (eating, attacking, looking and inspecting are never interrupted). A slower planner chooses the next task from the current observation and from its progress tracker, with cooldowns and a fallback when a subgoal repeatedly fails. Neither loop waits for the other, and training runs in a separate process, so observation never waits on training.

The Control Center shows observation age, loop frequency, decision latency, action latency and reaction time in the performance panel. There is no per-run action-count cap. Actions are bounded by per-action timeouts, stuck detection, retry limits, and the emergency stop.

```bash
# Offline (no server needed)
npm run profile:autonomy -- --scenario berries --seed 101 --virtual-seconds 900
npm run eval:offline -- --learning-dir data/training/experience

# Training (separate process; the Control Center can start and watch it too)
npm run train -- train --dir data/training --episodes-per-stage 8 --max-episodes 48 --max-minutes 30
npm run train -- train --dir data/training --fresh        # archives the existing run first; never deletes it
npm run train -- evaluate --dir data/training --seeds 10
npm run train -- status --dir data/training
npm run train -- pause|resume|stop --dir data/training   # pause and stop take effect after the current episode
```

### Training

Training runs the curriculum (`basics`, `food`, `tools-and-shelter`) in the **offline simulator**, in a separate process, from the Training tab or from `npm run train`. It records each action as an episode, derives weights from them and writes a checkpoint when a stage passes. **It is not real-world training**: the simulator is written by this project, and a checkpoint says nothing about a real Minecraft world until a live comparison shows it.

- **Resume is the default.** A run continues from `state.json` in its directory. `--fresh` archives the existing run (state, control file, experience, checkpoints, evaluations) under `<dir>/archive/<timestamp>-before-fresh/` with a manifest and then starts a new one; nothing is deleted. The Control Center explains this before it runs and needs an explicit confirmation.
- **One run per directory.** A `training.lock` file, created with exclusive-create semantics, refuses a second training run and an evaluation of a directory that is being trained. A lock whose process no longer exists is recognised as stale and replaced. A preflight (`GET /api/training-preflight`) reports what a directory holds and why a start would be refused. In the Control Center a training run is a folder *name* inside the data folder (it never takes an arbitrary path), and names the app uses for other data (`events`, `jobs`, `learning`, `learning-simulated`, `world-memory`, `traces`, `run`, `eval`, `roadmap`, and a few more) are refused.
- **Budgets and options.** `--max-episodes`, `--max-minutes` (a time budget), `--episodes-per-stage`, `--stages`, and `--explore RATE` (default 0.15: seeded, bounded switches among progress-band alternatives, recorded on the decision, never applied during evaluation). Pause and stop take effect after the current episode; the state, control and checkpoint files are written atomically.
- **Held out.** Training seeds and evaluation seeds are disjoint, and the split is asserted at start-up.
- Training data (`data/training/`) is git-ignored. The world seed can be entered manually in the Control Center; it is not auto-detected, and anything derived from it is labelled as predicted until it is verified in the world.

## Live Minecraft

Start a private or local Java server first. Use only an account and server you are authorized to use, and keep the world disposable. The exact checks, expected evidence, and server setup commands are in [`docs/LIVE_VERIFICATION.md`](docs/LIVE_VERIFICATION.md).

The easiest way to run these is `python3 main.py` (see [Quick start](#quick-start)); the commands below run the TypeScript CLI directly and take the same options.

A live session is **persistent** by default: it connects, serves the Control Center, runs the task you gave (if any) and stays connected, idle or autonomous, until you stop it from the page or press Ctrl-C. Add `--one-shot` to end it with the task.

```bash
# A persistent session and the Control Center, with the browser opened once
npm run dev -- --host 127.0.0.1 --port 25565 --username GameMind --open-browser

# Only the Control Center for now; connect from the Bots tab
npm run dev -- --no-connect --open-browser

# Connect, print the first observation and the skill list, disconnect (a read-only connectivity check)
npm run dev -- --host 127.0.0.1 --port 25565 --username GameMind --one-shot
```

Task runs (each uses the same limits as the offline runs). The CLI task has priority over autonomy from the first moment, and the session stays connected afterwards; add `--one-shot` to disconnect when the task ends (the process then exits 1 if the task did not succeed).

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

# Dig blocks with the right tool, then disconnect
npm run dev -- --task mine-stone --resource iron_ore --count 4 --max-actions 40 \
  --host 127.0.0.1 --username GameMind --one-shot
```

Task kinds are `gather-logs`, `mine-stone`, `craft-wooden-pickaxe`, `secure-food` and `build-shelter`. Other flags for a live run:

| Flag | Effect |
| --- | --- |
| `--persistent` / `--one-shot` | Stay connected after the task (default) / end with it |
| `--no-autonomy` | The agent acts only on tasks you start. Safety limits are identical either way |
| `--no-connect` | Start only the Control Center |
| `--reconnect-attempts N` | Retries after a dropped connection, 0–20 (default 5, 0 disables) |
| `--open-browser` | Open the Control Center once in your default browser |
| `--control-port N` / `--control-host H` / `--allow-host NAME` | Where the Control Center listens (default `127.0.0.1:8787`) and which extra `Host` names it accepts on loopback |
| `--no-control-center` | No dashboard at all (Ctrl-C is then the only way to stop a persistent session) |
| `--no-instance-lock` | Allow a second GameMind process in this project |
| `--data-dir PATH` | Where the app keeps its events, jobs, learning and lock files (default `data`) |
| `--look-yaw RADIANS` (with `--look-pitch`) | A one-shot probe: connect, turn once, print the result, disconnect. It never keeps a session, so it refuses `--control-center`, `--open-browser` and `--persistent` instead of ignoring them |
| `--allow-combat` | Arms attacks at the adapter, the safety policy and the planner; without it the agent only flees |
| `--no-learning` / `--learning-dir PATH`, `--memory-dir PATH`, `--world-key KEY` | Learning and world-memory storage. Defaults can also be set with `GAMEMIND_MEMORY_DIR` and `GAMEMIND_WORLD_KEY` |

Task options: `--count`, `--resource`, `--target-hunger` (secure-food only), `--explore-legs` (0–30, 0 disables exploration), `--explore-radius` (8–96 blocks), `--max-actions` (1–100, default 12), and `--max-duration-ms` (default 120000). Exploration consumes actions and real time: each leg is one navigation that can take tens of seconds, so use `--max-actions 24` and a larger `--max-duration-ms` (for example `300000`) for exploration-heavy runs. Run `npm run dev -- --help` for the full list.

If the connection fails, the message names the cause (refused, timed out, unknown host, wrong version, banned, ...), gives hints, and quotes the error the server returned; a persistent session keeps the Control Center open so you can fix the settings and connect again, and a one-shot run exits with code 1.

Nearby visible hostiles take priority. Collection, pickup, berry harvesting, and table placement are refused when a visible hostile is within the task's danger radius of the target. Entities can still move after a check, and Pathfinder's entity avoidance is a weighted cost, not a hard barrier. **Use a private test world, supervise live runs, and stop the process if behaviour looks unsafe** (Ctrl-C shuts the session down cleanly).

The orientation example remains available:

```bash
npm run scenario:minecraft -- --host 127.0.0.1 --username GameMind
```

Yaw and pitch are radians. The preset turns to yaw π/2.

### Windows and WSL

The target setup is Minecraft Java on Windows with GameMind in WSL2 (or directly on Windows). Nothing here assumes a path, executable or port: the launcher finds Node, checks the dependencies and the Control Center port, and reports what it chose.

- **Reaching a Minecraft server on Windows from WSL2.** With WSL2's default networking, `127.0.0.1` inside WSL is not the Windows host. `python3 main.py` tries `127.0.0.1` first and, only if nothing answers there and you gave no `--host` and no `MINECRAFT_HOST`, uses the first Windows-host candidate (the default gateway, then the resolver address) that answers on the port, and tells you which it used. WSL1 shares the host's network and is left alone. An explicit host is never rewritten. With mirrored networking, `127.0.0.1` works and is kept. A world opened to LAN gets a new random port each time: pass the one printed in the game chat with `--port`. If Windows Defender Firewall blocks the connection, allow Java for private networks.
- **Opening the Control Center.** Inside WSL the browser lives on Windows, so the opener tries `wslview`, `explorer.exe`, `cmd.exe /c start` and `powershell.exe Start-Process`, then the Linux openers, and reports which worked. Only a plain local `http://` address is ever passed to them. If none works the address is printed. WSL2 forwards `localhost`, so `http://127.0.0.1:8787/` opens from a Windows browser; if your configuration does not forward it, start with `--control-host 0.0.0.0` and read the warning above about what that exposes.
- **Where to keep the project.** Under WSL, keep it in the Linux filesystem, not under `/mnt/c/...`: the launcher warns about the latter because file access is slow there.
- **Verification.** All of the above was tested with injected platforms, fake probes and a fake process spawner (`tests_py/test_launcher.py`, `test/launcher.test.ts`, and the browser-opener cases in `test/app.test.ts` and `test/cli-lifecycle.test.ts`); it has not been run on a real Windows or WSL machine.

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
- `GAMEMIND_NODE` or `NODE` (optional; the Node.js executable `python3 main.py` should run, version-checked before use)

For an offline-mode server, keep `MINECRAFT_AUTH=offline`. Use Microsoft authentication only where appropriate. Do not put account credentials in command-line arguments, source control, logs, or traces; Mineflayer manages its own authentication flow and cache.

When the Control Center is enabled, the Library in its **Bots** tab is the only control surface for these actions: every action (companion modes, homepoints, skills, tasks, safety, learning) is an explicit entry with typed fields, per-run availability, and a measured outcome — succeeded, failed with a failure code, or refused with the missing requirement named. There is no chat-command system: Minecraft chat is never parsed into actions, there is no commander username, and no `MINECRAFT_COMMANDER` variable is read. Named homepoints are world-scoped, dimension-aware, and never overwritten without an explicit delete. Follow targets a measured 4-block preference, stops inside 5 blocks, and treats 32 blocks as a normal maximum separation target—not a guarantee under teleportation, disconnection, or obstacles.

## What still needs your environment

Everything in this repository was verified offline: unit and integration tests, a deterministic simulator, Mineflayer doubles, a fake DOM for the page, and the real HTTP server. These checks need a real Minecraft Java 1.20.4 server (and, for items 7 and 8, your own machine), and are listed with commands and the evidence to keep in [`docs/LIVE_VERIFICATION.md`](docs/LIVE_VERIFICATION.md) §18:

1. **Persistent session on vanilla 1.20.4:** it stays connected after a task and after an idle period, the Control Center shows the **LIVE** badge with the real health, food and position, and a page refresh restarts nothing.
2. **The CLI task wins the startup race with autonomy on:** no "A task is already running" message, the task runs first, autonomous work starts after it.
3. **A dropped connection:** stop the server mid-session and watch the reconnect attempts, `RECONNECT_EXHAUSTED`, and stopping during a retry.
4. **Shutdown:** Ctrl-C, the footer's Quit button and `python3 main.py` Ctrl-C all disconnect the bot once, leave no `node` process behind and release `data/run/gamemind.lock.json`.
5. **Game-mode refusal:** put the player in creative or spectator mode; the task must end as `TASK_BLOCKED_MODE` with the explanation, and the learning tab must count it as excluded.
6. **Real action failures:** the codes behind a `CONSECUTIVE_ACTION_FAILURES` stop on a real server, which the simulator cannot produce.
7. **WSL2 and Windows:** host selection, the Windows firewall, and opening the browser from WSL.
8. **The page in a real browser:** layout, contrast, light and dark themes, a narrow window, and reduced motion. This has never been looked at.
9. **Live verification phases** from the Tests & Evaluation tab, with their two confirmations, in a disposable world.

## Known limitations

- **No live Minecraft verification of this release has been run.** The lifecycle, scheduler, Control Center, launcher, training and learning changes are covered by unit tests, Mineflayer doubles, an HTTP integration test and offline simulation, none of which proves Java 1.20.4 server or plugin behaviour. Earlier adapter checks against a non-vanilla stand-in server are recorded in [`docs/LIVE_VERIFICATION.md`](docs/LIVE_VERIFICATION.md) §17. Calls such as `findBlocks`, `getDroppedItem`, berry-property reads, harvesting, pickup, rest, respawn, and pathfinder error handling still need the live checks in that document.
- **The Control Center has never been seen in a browser from this build environment.** Its text, controls and states are tested in a fake DOM and over HTTP; how it looks (spacing, colour, contrast, responsive layout, transitions) is unverified.
- **One bot per process.** The Bots tab is laid out as a list so more sessions can be added, but one session runs at a time and nothing pretends otherwise.
- **Windows and WSL are covered by injected-environment tests only.** No real WSL, Windows firewall or `wslview` was involved.
- **Natural regeneration depends on the server.** Rest is confirmed only by an observed health increase. A server with `naturalRegeneration` off, or with food below 18, will correctly report "not confirmed" and the task will stop.
- **Exploration uses client-loaded chunks.** The live wide scan cannot see unloaded chunks; coverage is marked only for explicitly reported loaded columns and only for untruncated scans. Unknown areas remain unexplored, and waypoints across them may fail with `PATH_NOT_FOUND`. Waypoints are navigated at the agent's current height with a 3-D goal, so steep terrain may require exclusions and replanning.
- **Food sources are limited.** Dropped food, ripe sweet berries, and inventory food. Passive animals are not hunted; combat is a separately gated, opt-in defence capability for hostiles, not a food-gathering mechanic.
- **Persistent world identity is operator-scoped.** The default host + port + dimension key cannot recognize a world reset or replacement at the same address. Stored locations are presented as last seen, but an operator should set a distinct `--world-key` when reusing an endpoint for a different world.
- **Mining is limited to blocks the local scan can see and the held tool can break.** It walks to a remembered stone-class or ore cell, equips, digs, and verifies the drop; it does not dig downward deliberately, branch mineshafts, place torches, or manage falling into a ravine. Ore beyond `--max-target-distance` is out of scope for a task.
- **Shelter means a closed shell.** `build-shelter` places blocks from inventory on the open cardinal (or all eight) sides at the player's level. It does not roof, light, or evaluate whether the location is defensible beyond the observed blocks, and it reports `unknown` support rather than guessing about unobserved cells.
- **Learning is experience statistics, not model learning.** There is no gradient update, no neural network, no replay buffer beyond the episode log, and no online adaptation inside a single run: the memory changes decisions in *later* runs. Weights that were never promoted stay candidates.
- **The event log and the trace are different things.** The Control Center's trace ring keeps the last 400 events in memory; the durable trace is `data/traces/*.jsonl`, and the searchable, redacted event log is `data/events/` (four rotating files by default). Neither is a long-term analytics store.
- **Performance data is scoped and low-overhead.** The Control Center samples Node process CPU, event-loop utilization, RSS/heap, host memory/load on snapshot requests, plus live adapter scan timings and skill durations. It does not profile Minecraft server TPS, GPU, GC pauses, per-core counters, or end-to-end networking; no diagnostic profiler or Minecraft tick hook is installed.
- **Simulator fidelity.** Walking, hostiles, hunger, and regeneration are simplified; the simulator has no collisions beyond solid cells, no lighting, no mob pathing, and no protocol.
- **Live verification of the autonomy loop has not been run.** The fast loop, reflexes, the planner, the performance panel and the observation cadence are tested with the simulator and unit tests only. The ~1 s cadence is a design target, not a measured live figure.
- **Repeated failures are bounded, not eliminated.** In the `berries` profile (seed 101, 900 virtual seconds), `autonomous:mine-iron-ore` is retried 8 times and fails each time after 2 actions with no simulated time spent. Cooldowns and the fallback stop the retries from growing without bound, but a task that always fails in the same way is still attempted repeatedly.
- **No improvement has been measured, and the offline suite has no headroom to show one.** A 24-episode run changed choices in 10 of 260 paired runs without changing any outcome (`behaviour-changed-no-gain`). The 15 scenarios judged on success already succeed in every seed with the baseline, and the other 11 are judged on safety, which the baseline already satisfies, so a policy that is no worse scores exactly the baseline's figures. The suite can detect a regression or a change of behaviour, not a gain. Real evidence needs a live comparison. See [Learning and policy](#learning-and-policy).
- **The wasted-action figure changed definition** (`verified-world-progress.v2`). Both evaluation reports now record the definition. A report written before that has none: the Evaluation tab labels such a training report as the first definition, and an old `data/eval/offline-report.json` holds first-definition numbers until you regenerate it with `npm run eval:offline`. Figures under different definitions are not comparable.
- **Seed is manual only.** No auto-detection is implemented, so seed-derived information is always a prediction until it is checked in the world.
- **Recovery is bounded, not exhaustive.** A route blocked everywhere, or one whose shortest paths all pass through an unobservable block, ends in a bounded stop.

## Traces and tests

- `scenarios/minecraft-look-roundtrip.json` is the seeded orientation scenario.
- `data/traces/<session-id>.jsonl` stores ordered session, observation, decision (with plan, band, alternatives, rejections, memory knowledge and the safety verdict), skill, action, verification, and task events. Sensitive-looking fields are redacted and long strings truncated.
- `data/events/` holds the searchable, redacted event log of the app (connections, lifecycle, tasks, decisions, safety refusals, jobs, errors, shutdown reasons); `data/jobs/` the history of test and evaluation jobs; `data/run/gamemind.lock.json` the single-instance lock.
- `data/learning/episodes.jsonl` plus `state.json` are the live experience memory and promoted policy; `data/learning-simulated/` is the same for simulated sessions; `data/world-memory/<world-hash>.json` stores validated resource/minable sightings and explored coverage. These data directories are gitignored and may be deleted to reset memory.
- Tests use offline fixtures, deterministic simulated worlds, an injected Mineflayer double, a fake DOM and the real HTTP server. They verify program logic and simulated interactions, **not** Minecraft server behaviour, protocol compatibility, plugin behaviour or how the page looks.

```bash
npm test                 # 785 TypeScript tests
npm run test:launcher    # 33 Python tests for main.py and the launcher
npm run build            # type-check, compile, copy and verify the Control Center files
```

The original suites cover loaded-chunk/truncation memory, persistent world snapshot validation and round-trips, death/respawn recovery and deadline bounds, adapter regressions, decision and safety contracts, offline evaluation gates, policy-promotion refusal cases, the Control Center HTTP/runtime surface (startup errors, boot-data escaping, static containment) and line-of-sight results from Mineflayer (`null` from a missed ray is a measured "not visible"). The suites added for this release:

| Suite | What it pins down |
| --- | --- |
| `task-scheduler`, `lifecycle` | The host TDZ error, the autonomous/CLI race, task completion without ending a persistent session, duplicate-task refusal, pre-emption of autonomy, queueing, drain on close, shutdown order with bounded steps |
| `cli-lifecycle`, `probe`, `launcher` (+ `tests_py`) | Exit codes, the READY handshake, persistent and one-shot runs, signals, orphan-free shutdown, browser opened once, the observation probe, Windows/WSL host selection with injected platforms |
| `app`, `control-center`, `control-center-http` | One server per process, the command set, the snapshot contract, redaction, `Host` and origin checks, token handling, reserved data folders |
| `ui-components`, `ui-page`, `ui-e2e`, `ui-static` | The page's helpers and polling store, every tab's text, controls and states in a fake DOM, the page against a real app, and a static type-check of the browser modules with a canary proving it can see each defect class |
| `training-safety`, `learning-evidence`, `progress-evidence`, `atomic-file` | Training lock, preflight, archive-never-delete and held-out evaluation; the success/failure/excluded rule and provenance; the wasted-action definition and what it must not steer; concurrent saves |

Existing tests were edited in three places, each because behaviour changed on purpose; no test was removed or skipped, and every other assertion is unchanged:

1. `test/control-center.test.ts` now requires `world.position` (whole blocks) where it used to require its absence. Blocks, terrain and entity coordinates are still asserted absent.
2. `test/learning-system.test.ts` expects a safety-denied approach to count as a denial and an excluded outcome (`attempts` 0, `excluded` 1) rather than one attempt; `test/learning-evidence.test.ts` pins the rule.
3. The page checks in `test/control-center.test.ts` read the whole module bundle of the rewritten page instead of one script, and name the elements of the new layout (`task-hint`, `ov-vitals`) in place of two that belonged to the old one (`blocker`, `world-freshness`). They also gained a check that no stylesheet or script pulls a remote font or image.

`npm audit --audit-level=low` found 0 vulnerabilities when run on 2026-10-10; no dependency was added in this release. Run it again, because advisories change.
