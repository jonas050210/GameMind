# GameMind – Technical Project Plan

- **Status:** Architecture and implementation document. `src/` implements a bounded Minecraft agent loop, a multi-stage decision model, world and experience memory, a safety layer and the browser-based Control Center. There is still no RL and no gradient or model training; live behaviour with Minecraft Java 1.20.4 is untested.
- **As of:** 10 October 2026 (the fourth-phase status below was added on that date; the earlier phase statuses are kept as they were written, translated from German)
- **Purpose of this document:** Provide a solid basis for the MVP, for architecture decisions and for later extensions.

> **Scope note:** This document records the target architecture, the safety principles and the phase roadmap; it is not a complete product manual. The current implementation now also includes hierarchical goal selection, recovery and offline evaluation, persistent world memory, learning statistics with a strict promotion gate, and the operations Control Center. The concrete feature set and the measured offline results are also in `README.md`; live behaviour remains unconfirmed.

### Implementation status of the first phase

- Node.js 22 / TypeScript; Mineflayer 4.39.0 with a configurable Minecraft protocol (default 1.20.4).
- Runtime validation through Zod, structured Pino logs and ordered JSONL traces.
- A small generic game adapter / world model / action executor core; Minecraft skills for look direction, block inspection, conservative navigation, bounded log gathering, equipping, verified eating, whitelisted wood recipes and careful placement of a crafting table.
- A simple priority/utility model: visible nearby hostiles come first, then critical health/hunger (blocked when no validated recovery skills exist), then the user's task. The wood dependency planner computes plank/stick/table/tool prerequisites and reacts to missing material and blocked goals; there is no combat behaviour and no free-form action planning.
- A task loop with fresh observation, replanning, goal exclusion after failures, a navigation stuck watchdog, time and action budgets, and confirmed goal/inventory state. Metrics capture success/progress, items consumed, hunger gained, damage, failures, recovery and runtime.
- Deterministic offline fakes vary hunger, inventory, logs, crafting tables, hostiles, blocked paths, action failures and budgets. They test logic and mock behaviour, not Mineflayer or server compatibility.
- No real Minecraft server was available for testing; live compatibility and plugin behaviour in a real world therefore remain **unverified**.

### Implementation status of the second phase (exploration, food, survival)

- **Perception:** By default the live adapter captures a local cube of radius 5 (up to 256 prioritised blocks), nearby entities, and separate resource/ore scans of radius 32 with up to 192 results per scan. Sweet berry ripeness and item drops are read from client observations. Loaded chunk columns and scan truncation are reported explicitly; unknown and unloaded areas never count as empty. All radii, limits and the client view distance can be configured through `MINECRAFT_*`.
- **Memory:** Sightings are kept across observations and removed only when a fully captured, untruncated area proves their absence. Explored cells and last-seen enemies are carried along.
- **Exploration:** Bounded routes to unexplored cells around the task start; nearby enemies are avoided. The number of exploration legs is a task parameter.
- **Goal selection in three priority bands:** safety (flee, sidestep after a block), survival (eating, picking up food, harvesting berries, resting at low health) and progress (gathering, crafting, approaching remembered targets). Within a band, goals are weighted by utility with a small bonus for the previous goal.
- **Composition and verification:** Each decision projects the remaining steps; only the first is executed. Each confirmed action is checked against the next observation. Unsupported confirmations count as failures.
- **Blockage and recovery:** Route blockages lead to bounded, axis-aligned sidesteps; repeated attempts without progress exclude the goal.
- **Offline simulation and evaluation:** A deterministic, seeded world with 20 scenarios and gates against unsafe actions, deaths and contradicted confirmations. The results apply to control logic only, not to a real server.
- **Live status:** Still **unverified**. The verification steps and commands are in `docs/LIVE_VERIFICATION.md`.

### Implementation status of the third phase (safety broker, autonomy, learning, Control Center)

*Status as it was recorded at the end of the third phase. The Control Center description, the evaluation figures and the test counts below were superseded by the fourth phase; see its status after this list.*

- **Action broker / safety layer:** `src/core/safety-broker.ts` answers only "may this action run at all?" and sits below the decision model: policy enablement, risk ceiling, allow/deny list, operator opt-ins, per-run action and capability budgets, cooldowns, a protected-health threshold, proximity of hazard blocks, drowning and observation age. Every verdict is logged with the checks that were run. `pause` blocks world changes, `trip` blocks everything until an explicit reset; lifting a trip does not lift a pause that was set separately. The `ActionExecutor` reports the capability together with the `skillId` to the broker, and the decision model receives the same verdict in the trace (`DecisionRecord.safety`).
- **Autonomy beyond gathering:** `mine-block` (tool derived from the block, abort on `TOOL_REQUIRED` / `TOOL_TIER_INSUFFICIENT`), `place-block` and `build-shelter` (cardinal or full enclosure, only counted inventory blocks), `equip-item`, and `drop-item` when the inventory is full. Food/health, threat detection, fleeing and, after a triple opt-in, defence are anchored in the priority bands; survival and safety always beat gathering and progress.
- **Structured decision traces:** `decision.made` contains the selected goal, all alternatives with their utility, all rejections with a reason code and explanation, the plan, the bands, the world knowledge state and the safety verdict. `task.action` attaches the postcondition verification. Success is derived exclusively from a following observation, never from the act of issuing an action.
- **Learning system (experience statistics, not RL):** Each executed attempt is stored as an episode in `data/learning/episodes.jsonl`. A failure memory excludes goals that failed repeatedly without progress in later runs against the same world, until enough observations contradict it. Derived policy weights change only the ranking within a band — they cannot unlock a capability, bypass validation or move a goal to another band. The CLI and the Control Center use the same promotion check: a report for exactly the current candidate, a passed ranking gate, the complete current scenario set, at least 20 seeds per scenario, episodes and at least one supported weighting context, and zero contradicted confirmations. Episodes are persistent statistics, not a trained model; there is no gradient or online training.
- **Control Center:** `src/control-center/` shows, through real runtime objects, session/agent status, vitals/inventory, goals and decisions, safety verdicts, learning/evaluation, process/perception telemetry and the action/event history. The local interactive WebGL voxel view showed current observations separately from last-seen memories and did not fill in unknown terrain; orbit and zoom worked by mouse/touch and keyboard. (This view no longer exists; see the fourth phase.) The client polls `GET /api/snapshot` without overlapping requests; the removed stream `GET /api/stream` answers `410 STREAM_REMOVED`. `POST /api/command` serves the same runtime objects. Pause/resume, trip/reset, combat opt-in, action budget, stop and validated task start act directly on the runtime and the safety broker. Policy promotion uses the same full evidence check as the CLI. Writes without a token answer 403, unsupported ones 501, refused ones 409. HTML/CSS/JS are served locally (no CDNs); after the build the assets are under `dist/src/control-center/public`.
- **Evaluation and tests:** By default `npm run eval:offline` used 20 scenarios × 20 seeds (400 runs). The most recent extended evaluation, `npm run eval:offline -- --seeds 60`, ran 20 × 60 = 1,200 runs in 12.7 s; all gates passed, with 0 unsafe actions, 0 deaths and 0 contradicted confirmations. `food-remote-berries` reached 100%, `replanning-removed-log` 98% (against a passed 85% gate). The repeat comparison with a shared experience memory showed `recovery-persistent-stall` 5 → 0 actions / 5 → 0 wasted actions; the necessary action chains for freeing inventory space and crafting a pickaxe stayed unchanged (2 and 12 actions). There was no weighted candidate, so no policy-ranking evaluation took place. `npm run build` succeeded, `npm test` reported 178 passed and 0 failed, including the strict CLI/UI promotion gates; `npm audit --audit-level=low` found 0 vulnerabilities.
- **Limits and verification:** There was no run on a real Minecraft Java 1.20.4 server. Death/respawn, perception integration and combat remain confirmed by doubles/simulation rather than live. The Control Center API and commands are covered by HTTP integration tests; a visual browser/WebGL end-to-end test was not run. Node/host telemetry and perception timings are light runtime samples, not a hardware or Minecraft TPS measurement. The UI keeps 400 trace events in memory, offers no free-form command line and has only the process token (no TLS). Learning is episode statistics, not model training.

### Implementation status of the fourth phase (persistent sessions, launcher, Control Center rewrite, learning evidence)

Added on 10 October 2026. Everything below was verified **offline only**: unit and integration tests, the deterministic simulator, Mineflayer doubles, a fake DOM for the page and the real HTTP server. Nothing was run against a Minecraft server, the page was never opened in a real browser, and the Windows/WSL paths were exercised only with injected environments. `README.md` has the details and the commands; `docs/LIVE_VERIFICATION.md` §18 lists the checks that still need a real server, machine or browser.

- **Lifecycle and scheduling.** A session has explicit states (`connecting`, `initializing`, `idle`, `running`, `reconnecting`, `stopping`, `shutdown`) and is persistent by default: it stays connected after a task until the operator stops it. `--one-shot` keeps the earlier run-and-disconnect behaviour. One scheduler (`src/games/minecraft/task-scheduler.ts`) decides what runs: priority `cli` > `control-center` > `library` > `companion` > `autonomy`, a startup reservation so that the task given on the command line wins the race against autonomy, duplicate refusal, a queue of at most 5, and a drain on shutdown. Only autonomy can be pre-empted. Safety policies, action budgets, combat restrictions and capability checks are unchanged, and autonomy stays on by default.
- **Defects fixed, each with regression tests.** The `Cannot access 'host' before initialization` error in the autonomous subgoal path; the `A task is already running in this agent` race between autonomy and the CLI task; the immediate `CLI run complete` disconnect; a leaked task lock after a failed start; a shared temporary file that made concurrent saves fail with `ENOENT`; open dashboard defaults.
- **Process and dashboard hardening.** One GameMind per project (`data/run/gamemind.lock.json`); a loopback bind by default with a `Host` allowlist, same-origin writes and a per-process token; an orderly shutdown that stops the task, cancels the queue, disconnects once, closes the server and releases the lock; a single `src/core/atomic-file.ts` writer for all state files.
- **Launcher.** `python3 main.py` checks Node, the dependencies, the project path and the ports, chooses the Windows host under WSL2 only when no host was given and loopback does not answer, starts the existing TypeScript agent (there is no Python agent), waits for its `GAMEMIND_READY` line, opens the browser once and stops everything on Ctrl-C (SIGINT, then SIGTERM, then SIGKILL). It is a launcher, not a second implementation.
- **Control Center rewrite.** Seven tabs (Overview, Training, Bots, Tasks, Tests & Evaluation, Learning & Policy, World Memory & Events) in vanilla HTML, CSS and ES modules over one polling store, with no new dependency and no external asset. Every panel is labelled **LIVE**, **SIMULATED**, **HISTORICAL**, **OFFLINE** or **UNAVAILABLE**; a value that was not reported reads *unknown*; there are no placeholder charts or invented metrics. The WebGL view is gone. The page is checked in a fake DOM, never in a browser.
- **Training and evaluation from the page.** Headless offline training runs in a child process under `training.lock`, resumes by default, archives instead of deleting on `--fresh`, and states that offline training is not real-world training. Unit tests and the offline evaluation run as monitored jobs; live verification is a separate section that needs explicit confirmation before it touches a server, and a second one before anything that changes the world.
- **Learning evidence.** One rule decides what an episode says (success, failure or *excluded*); excluded outcomes (a dropped connection, a safety refusal, a game-mode refusal) are never held against a skill. A context needs 8 evidence-bearing attempts before it gets a weight. Simulator and live episodes are kept in separate stores. The state is schema v2 with backups. "Wasted actions" now follows `verified-world-progress.v2`, which counts revealed ground, a measurable approach, healing from a rest and a retreat from a hostile as verified effects; the definition is recorded in the evaluation reports.
- **Measured, offline.** The offline evaluation is now 26 scenarios × 20 seeds (520 runs): 0 unsafe actions, 0 deaths, 0 contradicted confirmations, every gate passed. On the 260-run held-out set the baseline succeeds in 191 runs (73.46%); an earlier figure of 192 was not reproduced and the reason is unknown. A 24-episode training run changed 10 of 260 choices and no outcome, so the conclusion is `behaviour-changed-no-gain`. **No improvement has been measured and none is claimed**, and the suite has no headroom to show one: the baseline already succeeds in every seed of the 15 success scenarios, and satisfies the 11 safety scenarios. The consecutive-failure limit was measured (2 to 5 give identical results) and stays at 2.
- **Open.** Live verification of everything above; a look at the page in a real browser; real Windows/WSL behaviour; scenarios in which a choice decides the outcome, so that a learned policy could show a gain; and evidence from a live comparison. One bot per process remains the limit; the Bots tab is laid out as a list so more sessions can be added, but nothing pretends to run several.

## Summary

GameMind should not be understood as a single neural network that translates pixels directly into key presses. For a system that stays extensible in the long term, a **hierarchical, hybrid agent architecture** makes more sense:

1. A **game adapter** delivers bounded, traceable observations and executes validated actions.
2. **Perception and the world model** translate observations into a time-stamped, partly uncertain world state.
3. The **decision model** prioritises goals, plans subtasks and selects suitable skills.
4. A **skill runtime** executes skills as monitored, abortable options and reports results back.
5. A **safety supervisor** checks every action, monitors progress and can pause at any time.
6. **Memory, evaluation and learning** store experience and improve skills in a controlled way; new models are not switched live unchecked.
7. A **Control Center** makes state, decisions, training status and errors understandable and controllable.

For the start, a narrow, reproducible field of use is recommended: **Minecraft Java Edition, one fixed version, a dedicated or local vanilla server and a single agent instance**. The first version should be able to solve a bounded task dynamically — not merely replay a hard-coded sequence of steps. Reinforcement learning is explicitly **not** the foundation of the MVP at first: the world model, goal selection, planner, verifiable skills and good evaluation tools bring the greater benefit first.

---

## 1. Vision

In the long term, GameMind should become a general, experience-capable game AI that can pursue goals in different games and react to new situations. "General" does not mean that a single unchanged model masters every game immediately. It means that a stable core can be extended with exchangeable **game adapters** and game-specific **domain packs**.

The AI should:

- build a traceable world state from incomplete observations;
- weigh needs, user tasks, opportunities, risks and long-term intentions against each other;
- break goals down into verifiable subgoals and skills;
- validate actions before executing them and be able to interrupt running skills;
- measure successes, failures and uncertainties and learn from them in a controlled way;
- store knowledge, episodes and skill quality durably, versioned and with provenance;
- continue working reproducibly after a restart, or establish a safe state;
- react to unknown situations by observing, running low-risk tests, using alternative plans or aborting safely.

**Important distinction:** In early versions, basic skills are deliberately implemented and tested by humans. This does not contradict the goal of a learning AI: adaptability initially lies in dynamic goal management, in the selection and combination of skills, and in the reaction to new states. Later, the execution of individual skills can be learned or optimised. An unvalidated model must never execute arbitrary game code or unrestricted actions directly.

## 2. Core requirements

### Functional requirements

- Take in observations and game events through a defined adapter interface.
- Maintain a current, time-stamped world state, including unknown and outdated information.
- Generate and prioritise goals from the user's task, survival needs, progress and opportunities.
- Break goals down into subgoals/skills and replan when the preconditions change.
- Monitor skills before, during and after execution; distinguish success, partial success, abort and failure.
- Take resources, hazards, health state and available capabilities into account.
- Store episodes, decision reasons, metrics, models and skill versions traceably.
- Run training and evaluation separately from live execution.
- Observe state and decisions through a GUI and be able to pause/stop the agent safely.

### Non-functional requirements

- **Safety:** No action without a capability, schema, freshness and precondition check.
- **Robustness:** Timeouts, reconnects, abort, resumption and detection of missing progress.
- **Traceability:** Every action must be traceable to an observation, goal, skill and decision record.
- **Reproducibility:** Record versions, scenarios, seeds, configurations and checkpoints.
- **Extensibility:** A small, stable core; game rules and capabilities in adapters/domain packs.
- **Measurability:** Judge success not only by a reward value but by domain metrics.
- **Controllability:** Change runtime and training configuration without exposing secrets or safety rules.
- **Data hygiene:** Store only necessary observations and episodes, version data formats, never write secrets to logs.

## 3. Proposed overall architecture

### 3.1 Data and control flow

```text
                           ┌──────────────────────────────┐
                           │         Control Center       │
                           │ Live state · Trace · Tests   │
                           └──────────────┬───────────────┘
                                          │ Observe / control safely
                                          ▼
┌──────────┐   Observations    ┌────────────────────┐   Facts / beliefs
│ Minecraft├─────────────────►│ Adapter + Ingestion├──────────────────────┐
└────┬─────┘                  └────────────────────┘                      ▼
     ▲                                                    ┌────────────────────────┐
     │ validated actions                                 │ Perception / World Model│◄──► Memory
     │                                                    └────────────┬───────────┘
     │                                                                 │ State,
┌────┴───────────┐   Action request   ┌──────────────────┐             │ context,
│ Safety Broker  │◄───────────────────│ Skill Runtime    │             │ competence
│ + Watchdog     │                    └────────▲─────────┘             ▼
└───────────────┘                             │                 ┌───────────────────┐
                                               │ Skill / Option  │ Decision Model   │
                                               └─────────────────┤ Goal Manager      │
                                                                 │ Planner + Selector│
                                                                 └─────────┬─────────┘
                                                                           │ Result,
                                                                           │ episode,
                                                                           ▼
                                                            ┌─────────────────────────┐
                                                            │ Telemetry / Evaluation  │
                                                            │ Offline Learning        │
                                                            └─────────────────────────┘
```

The agent does not decide anew about every key at every Minecraft tick. The game world can be updated at high frequency; the planner works event- and state-driven, while a running skill carries out its narrowly bounded control. A skill can be interrupted by a hazard, a timeout or a relevant state change. This keeps responsiveness and higher-level planning separate.

### 3.2 Architecture principles

1. **Hierarchical instead of monolithic:** Goal selection, planning, skill selection and action execution are separate responsibilities.
2. **Hybrid instead of "RL for everything":** Rules and constraints for safety, symbolic planning for known dependencies, learned policies only where experience actually helps.
3. **Observation is not truth:** Facts get a source, a timestamp and a confidence measure. Not observed means "unknown", not "does not exist".
4. **One action path:** Live actions run exclusively through the safety broker. The UI, an LLM, the planner and skill code must not bypass it.
5. **Learn offline, roll out in a controlled way:** New policies are evaluated on fixed scenarios, compared with the current version and activated only after approval.
6. **A game-neutral core, honest game boundaries:** Shared abstractions stay small. Recipes, block logic, combat rules and concrete capabilities stay in the Minecraft domain pack.
7. **A modular monolith first:** No distributed microservices for the MVP. A clear module boundary and an isolated adapter process suffice; further processes arise only with real scaling needs.

### 3.3 Recommended technical split

As a pragmatic start, a TypeScript/Node.js-based runtime is a good fit: it matches the widespread Minecraft Java client ecosystem, allows shared types between adapter, core and web GUI, and reduces initial integration work. A Python training process with PyTorch can be added later through versioned episode/dataset formats. Training should not be part of the time-critical action path.

This is a **recommendation, not a prior decision**. Before committing, a short compatibility test with a specifically supported Minecraft version and the selected adapter should take place. For the MVP, a local data store (e.g. SQLite plus append-only episode logs) and a WebSocket/HTTP channel for live telemetry are sufficient; additional brokers, databases and orchestration systems would initially be unnecessary complexity.

## 4. Components and responsibilities

| Component | Responsibility | Must not |
|---|---|---|
| **Game Adapter** | Connect to the game; normalise raw observations/events; report available capabilities; execute requests and confirm results. | Decide goal priorities or bypass safety rules. |
| **Ingestion / Session Manager** | Order session and tick time, handle duplicates, monitor the adapter connection, pass on state updates. | Present outdated data as current. |
| **Perception** | Condense raw data into semantic facts, produce objects/relations and derived features. | Assume game information that is not visible to be known. |
| **World Model** | Manage the current state, a partial map, uncertainty, freshness and change history. | Keep every world block in memory without limit. |
| **Memory** | Store episodes, facts, map knowledge, goal/plan progress and skill statistics, and retrieve them by context. | Treat stale or foreign-world knowledge as a certain fact without marking it. |
| **Goal Manager** | Create, prioritise, pause, resume and complete goals. | Net safety constraints off as mere preferences. |
| **Planner** | Break goals down into subgoals and possible skill sequences; consider resources, preconditions, costs and alternatives. | Output unbounded or unchecked action chains. |
| **Skill Selector** | Select applicable skills by goal contribution, chance of success, cost, risk and experience. | Ignore unmet preconditions. |
| **Skill Runtime** | Manage skills with deadlines, progress criteria, abort and result status. | Start new action paths on its own without limit. |
| **Safety Broker / Watchdog** | Validate, bound, serialise and abort actions; detect stalls, errors and critical states. | Be disabled by a model or the UI while the agent is active. |
| **Telemetry / Evaluator** | Collect decision traces, action results, metrics, scenario evaluation and regressions. | Equate the training reward with actual task success. |
| **Training Pipeline** | Version datasets, train models, produce checkpoints and test candidates against benchmarks. | Switch candidates live without an evaluation gate. |
| **Control Center** | Enable observing, debugging, controlled interventions and training management. | Expose credentials or unvalidated actions. |

## 5. Decision model

The decision model is the central decision logic between the world state, intentions and skills. It is not a single "black box" classifier but a pipeline with explicit results and verifiable intermediate states.

### 5.1 Inputs

- The current world state, change events, timestamps, confidence values and unknown areas.
- Health/survival state, resources, inventory, position, hazards and running activities.
- The active user task, goal and plan progress so far, time and risk budgets.
- Available adapter capabilities and skill metadata.
- The success probability and context-dependent failure history of the skills.
- Relevant episodes, confirmed rules and known hazards from memory.
- Runtime conditions: latency, disconnect, pause state, action budget and human interventions.

### 5.2 What it decides

1. **Do I need better information first?** With relevant uncertainty, the best decision can be a low-risk observation.
2. **Which goal is active now?** Goals can arise anew, switch, pause or lapse when conditions change.
3. **How is the goal broken down into subgoals?** The planner takes dependencies and available means into account.
4. **Which skill is suitable now?** Only skills with met preconditions and a matching capability are candidates.
5. **Should I continue, interrupt, sidestep, replan or stop safely?** That depends on progress, hazard, uncertainty and runtime limits.

### 5.3 Goal prioritisation

Goals should not compete against each other through a freely learnable score alone. **Hard constraints** apply first, for example: agent paused, action invalid, adapter state not trustworthy, immediately lethal hazard or user stop. After that comes a configurable priority order:

1. Hard safety and an explicit stop.
2. Acute survival and damage avoidance.
3. Urgent obligations of the user's task and protection of resources already invested.
4. Strategic subgoals and progress in the active task.
5. Opportunistic goals, exploration and intrinsic learning value.

Within the same level, an understandable score can be used, for example from **value of progress + urgency + user priority + strategic relevance + information value − time/resource cost − risk**. Feasibility and degree of confidence influence the score but do not replace a safety rule. The score and its factors are disclosed in the decision trace.

To avoid frantic switching between similarly rated goals, **hysteresis** is needed: a running goal stays active as long as it makes progress and there is no clear reason to switch. A goal switch happens on hazards, invalid preconditions, missing progress, relevant information gain or a clear priority gap. Goals also have deadlines, abort conditions and resumption conditions.

### 5.4 Planning and skill selection

For the start, a mix of the following is suitable:

- **rules/constraints** for safety and survival reactions;
- **HTN/GOAP-style planning** for known preconditions, costs and subgoals;
- **heuristic skill selection** with logged features;
- later **bandit or RL policies** for partial decisions whose quality can be measurably improved through experience.

For a goal, inadmissible skills are first filtered out by capability, precondition, resources, risk and state. Among the remaining skills, an expected quality can be estimated:

> **Expected utility = success probability × goal contribution − time/resource cost − risk cost + bounded learning/information value.**

In live worlds the learning bonus must not lead the agent to risk avoidable damage for experiments. With equivalent options, the decision can break ties deterministically or reproducibly, so that errors remain debuggable.

### 5.5 Uncertainty and unknown situations

- Uncertainty and data age are values of their own; "unknown" is not the same as "false".
- Critical facts (e.g. target position, passage, mob behaviour) must be freshly confirmed before risky actions.
- With low confidence, preference goes to observing, a safe detour, a reversible test or a plan with lower damage potential.
- If no option is above a minimum confidence: do not guess, but re-observe, check alternative skills, shorten the plan or pause in a controlled way.
- Random exploration is restricted to training scenarios with a risk and time budget.

### 5.6 Long-term goals and replanning

Long-term intentions are kept as a goal graph with milestones, preconditions, required resources, estimated costs, deadlines and progress. The agent does not rigidly pre-plan every action far into the future: it plans at milestone level and uses **receding-horizon replanning**. After important events — resource found/lost, path blocked, hazard detected, skill failed, world state changed — the affected plan section is re-evaluated. A successful partial plan can be stored in the episode knowledge and reused later, but remains tied to version and context.

### 5.7 Decision log

Every decision should contain at least the active mission, goal and score factors, relevant facts with age/confidence, the skills checked, rejected alternatives with the reason, the chosen skill, the expected result, abort criteria, the model/skill version and a correlation ID. A short structured explanation is more helpful than a free, possibly invented text justification.

## 6. Perception and world state

### 6.1 Minecraft information for the start

**Agent and movement**
- Position, look direction, dimension, speed or movement state, ground/flying/swimming state.
- Health, absorption, hunger/saturation, air, fire/effect state and death/respawn.

**Inventory and capabilities**
- Item type, count, metadata, durability, armour and the held item.
- Known recipes, available tools and relevant interaction possibilities.
- Free inventory slots and foreseeable resource bottlenecks.

**Environment and navigation**
- Locally observed blocks and their semantics (breakable, solid, liquid, hazard, interaction object).
- Navigable surfaces, height differences, obstacles, drops and known safe paths.
- Line of sight, distance and freshness of the observation.
- Biomes, time of day, weather and dimension, as far as relevant to a goal or risk.

**Entities and events**
- Type/identity, position, distance, movement/activity state and observable dangerousness of entities.
- Visibility, estimated direction/speed and — only if the adapter observes it legitimately — health.
- Events such as damage, item pickup, block change, action success, death, disconnect and chunk/view-area change.

### 6.2 Representation

The world state should consist of separate, mergeable layers:

1. **Direct observations:** adapter reports with source, tick/time and session.
2. **Derived facts:** e.g. "the inventory contains enough wood for goal X" or "the path is probably blocked".
3. **A short-term spatial model:** a bounded local voxel/navmesh/graph representation, not a complete copy of the world.
4. **Beliefs:** uncertain or indirect statements with confidence and expiry/staleness rules.
5. **Changes:** compact deltas and relevant events for replanning and debugging.

Every fact carries a timestamp, a source, a confidence and, where applicable, a validity period. The model must distinguish unknown chunks from empty/harmless areas. World knowledge is bound to server, world, dimension and coordinate system, so that a memory from another world does not create false certainty. The MVP primarily uses structured game observations; image/video perception is a later, optional adapter channel and not the first foundation.

## 7. Skill system

### 7.1 Skills as monitored options

A skill is more than an action. It is an executable, bounded capability with:

- a purpose and permitted parameters;
- initiation conditions and preconditions;
- required adapter capabilities and resources;
- expected effects as well as side effects/risks;
- an internal policy or sub-skill sequence;
- success, partial-success and abort criteria;
- a timeout, a progress indicator and a maximum action budget;
- a recovery/alternative strategy;
- a skill version, tests and success statistics by context.

Every skill ends with an explicit result status: **success**, **partial success**, **failed**, **aborted**, **not executable** or **unknown**. "The action was sent" does not count as success; the world state must confirm the expected effect.

### 7.2 Skill levels

- **Primitive capabilities (game-specific):** observe, move, align the view, interact, use/switch an item, wait, abort.
- **Atomic skills:** navigate to a target, inspect/mine a block, pick up drops, perform crafting, place an object, eat/equip, perform an attack or a dodge.
- **Composite skills/options:** obtain a resource, make a starter tool, leave a hazard, reach a safe place, explore an area, replenish supplies.
- **Strategic tasks:** longer goal chains such as setting up a base or obtaining particular resources; they belong in the planner/goal model and should not be hidden as opaque macro scripts.

### 7.3 Dependencies and composition

Dependencies are described through preconditions and expected effects, not as a rigid linear skill list. The planner can thereby consider alternative paths. Composite skills call other skills in a controlled way through the same runtime, with limits on depth, cycles, total duration and resources. A missing capability leads to an explicit plan gap; it must not be silently replaced by improvised, unvalidated actions.

### 7.4 Learning and improvement

The skill catalogue starts with human-implemented, versioned capabilities. After that, GameMind can:

1. measure context-dependent success rates, failure causes, costs and aborts;
2. optimise safe parameters (e.g. target selection or path costs) from episodes;
3. use demonstrations through behaviour cloning for suitable subproblems;
4. try controlled policy optimisation/RL for individual skills or for skill selection;
5. evaluate candidates in replay and tests against the current version;
6. mark them as a new version only after passing the gates.

Skills must not keep only a global success rate: success when navigating in open terrain says little about caves, water or night. Statistics should be stratified by a few meaningful context features and marked as uncertain when data is scarce. Every learned variant can be rolled back to a known stable version.

## 8. Learning and reinforcement learning

### 8.1 Where RL makes sense — and where it does not

| Problem class | Sensible approach at first | Possible later learning method |
|---|---|---|
| Recipe/crafting dependencies, inventory rules | symbolic data, constraint/graph planning | hardly any need for RL |
| Navigation in a known local map model | an established pathfinding algorithm with hazard costs | a learned cost heuristic or a local policy |
| Goal priority and skill selection | rules, utility, planner; cleanly logged alternatives | contextual bandit / offline RL, later hierarchical RL |
| Timing, movement, combat in complex dynamics | robust, tested controllers and safety rules | isolated skill/option RL with clear limits |
| Unknown situations | gather information, hypotheses and low-risk tests | imitation/offline learning; exploration in controlled scenarios |
| Long-term tasks | milestone planning and explicit resource models | a high-level policy once enough diverse episodes exist |

RL is attractive when a well-defined observation/action interface, many repeatable episodes and a measurable outcome exist. It is unsuitable as the first replacement for known game rules, safety logic or a missing test system. A hierarchy of options/skills can shorten the learning horizons; an agent that learns a complete sandbox task directly at the lowest input level would be expensive at the start of the project, data-hungry and hard to debug.

### 8.2 Reward and target metrics

Reward should be derived from verifiable goals and must not become the only measure of quality. Conceivable components are goal achievement, progress (preferably as potential-based shaping), time/resource costs, avoidable damage, death, invalid actions, idling and unnecessary goal switches. The actual reward is defined per training task; a universal "good move" reward is unrealistic.

Easily exploitable proxy goals should be avoided, for example rewarding merely collected items when the real goal is crafting or survival. Therefore:

- Report task success separately, as a success rate and rule violations.
- Make reward components visible in the GUI and in training logs.
- Model limits/safety invariants as constraints rather than as small penalty points.
- Include reward-hacking and edge-case tests in the evaluation.
- Store the reward and scenario version of every episode.

### 8.3 Exploration and curriculum

By default, exploration takes place in isolated, resettable training worlds. In a valuable live world, the safe base policy is decisive. Curiosity can primarily mean **information gain at low risk**: looking, gaining distance, checking a new route or testing a harmless interaction.

A curriculum should grow in stages:

1. isolated primitives and adapter contracts;
2. static, low-risk tasks with known resources;
3. variable start positions, inventories, obstacles and seeds;
4. time/supply pressure, a dynamic world and harmless opponents;
5. more complex, unknown combinations and disturbances;
6. only after that, broader, open worlds.

Scenarios need training, validation and **held-out test sets**. Difficulty rises according to measured competence, not merely according to elapsed training time.

### 8.4 Experience replay, training and checkpoints

Every usable episode should contain the scenario/seed, game and adapter version, observations or low-loss state deltas, decision traces, skills, actions, results, reward components and the final state. Replay buffers are stratified by success, failure type, rarity and scenario; storing only successful or prioritised episodes distorts learning. Raw data is bounded and versioned.

Training runs offline or in scenarios started explicitly for it. A checkpoint includes at least the model/skill version, the training configuration, the data state, RNG/seed information, an evaluation report and the schema version. A candidate is adopted only if it passes a fixed suite, shows no safety regression and generalises sufficiently on held-out seeds. The previous champion remains available.

### 8.5 Evaluation and generalisation

Successes must be checked across different seeds, start states, obstacles, resource layouts, times of day and disturbances. At least the task success rate, time to goal, death/damage rate, action/skill failures, resource consumption, stalls, replan rate and performance by context are reported. For generalisation, unknown combinations and slightly changed conditions matter more than a high score on training worlds.

## 9. Memory

GameMind needs several clearly separated kinds of memory:

1. **Working memory:** the current state, the running goal, the plan and a short event history; volatile and fast.
2. **Episodic memory:** the sequence of observation, decision, skill and result with context; the basis for debugging and later training data.
3. **Semantic memory:** confirmed recipes, resource relationships, hazard hints and general facts with source, validity and confidence.
4. **Spatial memory:** explored partial maps, paths and hazards, bound to world/dimension/version and subject to ageing.
5. **Procedural memory:** the skill catalogue, versions, preconditions, quality and known recovery paths.
6. **Strategic memory:** longer-term goals, milestone progress, user preferences and open plans.
7. **Training artefacts:** separate, reproducible datasets, checkpoints and evaluation results.

The data stores should not be mixed: an old episode history is not automatically a valid world rule; a model checkpoint is not a skill; a configurable user wish is not a learned fact. For the MVP, a small local relational database and file-based, versioned episode/model artefacts are enough. What matters are searchability, proof of provenance, expiry rules, export/deletion and the ability to start with an empty memory in a controlled way. Embeddings/semantic search can be added later if the volume of data justifies it.

## 10. Minecraft integration

### 10.1 Recommended start

For a fast, observable Minecraft Java prototype, a client adapter based on the **Mineflayer ecosystem** is an obvious option. It can communicate with the server as an isolated process, pass on structured events and use tested movement/pathfinding functions. The concrete game version must be fixed and pinned at the start through a compatibility test. Bedrock, modified servers, multiplayer PvP and arbitrary versions do not belong in the MVP.

The adapter is an exchangeable transport/execution module, not the AI. It reports its capabilities, for example navigation, inventory access, block interaction and available observation fields, through a versioned contract. The agent should use only information that the connected game client can actually observe; server-side omniscience or direct world-file queries would be an impermissible information advantage for the actual policy and would distort the evaluation.

### 10.2 Typical technical difficulties

- Latency, packet loss, delayed confirmation and events in a different order.
- Chunk/view-area boundaries as well as incomplete or quickly outdated local maps.
- Blocked paths, height differences, liquids, fall heights and dynamic obstacles.
- The difference between "request sent" and "game state has changed".
- Unintended repetition of non-idempotent actions such as attacking, mining or crafting.
- Disconnect, death, respawn, inventory loss, a new dimension and manual takeover.
- Version/mod deviations, changed recipes and server rules.
- Game mechanics can differ between test and live servers.

Therefore, requests get unique IDs, deadlines and state confirmations. Repetition is permitted only for explicitly idempotent operations. After a timeout, the agent first re-observes and reconciles before a non-idempotent action is tried again. Adapter errors are reported as a state of their own to the goal manager and the safety supervisor.

### 10.3 Operation and credentials

The MVP should preferably run on a local/private test server with a purpose-built world. Credentials belong exclusively in local secret management/environment variables and never in the repository, UI telemetry or episodes. Logs must redact sensitive connection data. Automated behaviour should at first take place only in an authorised test environment.

## 11. Game adapter system

An adapter implements a versioned boundary with four main tasks:

1. **Connect / lifecycle:** connect, capability handshake, session ID, disconnect, reconnect and error states.
2. **Observe:** a snapshot plus events with game time, observation source and freshness.
3. **Act:** accept typed semantic requests, validate them, abort them and confirm the result/error.
4. **Describe:** declare the game version, mode, coordinate system, supported observations and actions.

The core should have a small, general vocabulary for agent state, resources, entities, spatial references, goals and capabilities. Game-specific data stays in namespaced extensions. Not every game has an inventory, blocks or the same movement semantics — a forced universal ontology would create false commonalities.

Game-specific perception, action mapping, primitive skills, recipes and combat/movement models belong in a **domain pack**. The core takes over goal management, memory interfaces, telemetry, safety orchestration, the evaluation protocol and the basic UI framework. Every new adapter needs contract tests, version compatibility and at least a benchmark suite of its own. Transfer between games is a research question, not an automatic guarantee: at first only higher-level concepts such as careful exploration, uncertainty handling and resource planning can be reused.

## 12. GUI / Control Center

*§§12.1 to 12.4 are the design target and implementation status as they were written for the third phase. The fourth phase rewrote the page; §12.5 describes the page as it is now, and where the two differ (themes, the WebGL view, the tab structure) §12.5 is current.*

### 12.1 Design goal

The earlier Liquid Glass concept has been replaced by the user's requirement: **AI Command Center × Minimal Dark × Minecraft Operations**. Matte charcoal surfaces, cyan/green accents, high contrast, compact telemetry and a clear status hierarchy take precedence over decorative transparency. Keyboard operability, screen-reader labels and reduced motion remain functional requirements; the current operating screen is consistently dark.

The GUI is a development and operations tool. It should provide answers to three questions: **What does the agent see? What is it trying to achieve? Why is it running this skill right now?** Live control remains limited and traceable by default.

### 12.2 Areas and sensible content

- **Overview:** adapter/session state, pause/stop, current goal, progress, active skill, health/risk, last decision and central errors. Only a few prioritised signals instead of a wall of KPIs.
- **Agent state:** position, inventory, survival, active effects, nearby entities and the latest state changes.
- **World / observation:** a bounded interactive WebGL voxel view of blocks that were actually observed; current observations, hazards, resources, visible hostiles and wireframe last-seen memory are distinguishable. Unknown/unloaded terrain is not filled in.
- **Decision model:** goal agenda, priority signals, milestone/plan tree, current selection, skill confidence, rejected alternatives and structured reasons.
- **Skills:** catalogue, preconditions, dependencies, version, status, context-dependent success/failure rate, latest episodes and tests. Live changes to skill code are not the job of this view.
- **Training:** active/completed runs, scenario version, throughput, reward breakdown, data/model version, checkpoints and abort reason. No misleading training curves when no training is running.
- **Evaluation:** benchmark comparison between champion/candidate, seeds, success rate, failure classes, safety regressions and generalisation.
- **Memory:** searchable episodes/facts with source, time, confidence and world reference; correction, expiry or deletion with an audit entry.
- **Logs:** chronological events with filters for session, decision, skill, adapter and severity; correlation from the goal to the adapter confirmation.
- **Configuration:** game/adapter version, runtime limits, goal weights, evaluation profiles and model choice. Risky changes only in a controlled way; never show secrets.

### 12.3 Information architecture and usability

The main view prioritises live status and safe control; deeper causes live in inspection pages. An event should lead from the overview into the associated decision trace and the responsible skill episode. Relevant control actions: **pause after the current safe action**, **immediate stop/abort**, **safe resume**, **read-only/observer mode** and **start a new scenario run**. Stop and pause must show a clear status even with a partial backend failure.

Unnecessary for the MVP are dozens of real-time charts, freely editable internal variables, unfiltered raw packet logs, a chatbot as a substitute for decision reasons and a full 3D reconstruction of the entire world. A compact local 3D voxel view was implemented because it makes observed spatial relationships visible for operation; it explicitly does not show unloaded chunks.

### 12.4 Implemented status (third phase)

The Control Center is implemented (`src/control-center/`, enabled with `--control-center`) as a three-column operations dashboard without external dependencies: run control and validated task start, goal/decision trace, safety broker, agent vitals/inventory, an interactive WebGL voxel view with observed blocks and marked last-seen targets, perception timing, Node process/host resource sampling, an action/failure/event timeline, skills and learning/evaluation. Layout and colours follow **AI Command Center × Minimal Dark × Minecraft Operations**: matte charcoal surfaces, cyan/green accents and compact status displays. The 3D view can be operated by drag/touch and keyboard, with visible focus, screen-reader control hints and `aria-live` status output.

Deliberately **not** implemented: a searchable memory browser across all episodes (episodes are JSONL, world knowledge is JSON snapshots), filter/severity interfaces for all raw logs, a training dashboard (no model training takes place), free editing of internal variables and a full 3D reconstruction of the world. The views remain a time window of the ring trace; long-term forensics is the job of the trace files. Hardware values are lightweight process/host samples, not a full profiler.

### 12.5 Implemented status (fourth phase)

The page was rewritten in the same stack (plain HTML, CSS and ES modules, no dependency, no external asset). It is a status bar plus seven tabs over one polling store (every 1.5 s while visible, 15 s hidden): **Overview**, **Training**, **Bots**, **Tasks**, **Tests & Evaluation**, **Learning & Policy** and **World Memory & Events** (a searchable, redacted event log). What differs from §§12.1 to 12.4:

- The visual direction is restrained and typographic, with automatic, light and dark themes, subtle transitions switched off under `prefers-reduced-motion`, and a desktop-first, responsive layout. It follows a written brief that named learningview.org as inspiration; that site was not reachable from the build environment and nothing was copied from it.
- The WebGL voxel view no longer exists. The page publishes the player's whole-block position but no blocks, terrain or entity coordinates.
- A training view and a searchable event log now exist. Offline training is a monitored child process that states plainly that offline training is not real-world training. Memory shows the world identity, remembered resource sightings and explored regions, not a browser over every episode.
- Every panel is labelled live, simulated, historical, offline or unavailable; a value that was not reported reads *unknown*; there are no placeholder charts.
- Controls act only where the runtime implements them, and a refused command is shown with the server's reason. The page can pause, arm and stop the agent; it never writes to the world.

Not looked at in a real browser; see `docs/LIVE_VERIFICATION.md` §18, item 8.

## 13. Additional proposals

These additions are deliberately conceived beyond the original idea. They mainly strengthen reproducibility, safety and controlled learning.

| Proposal | Problem it solves | Benefit for GameMind | Priority | Timing |
|---|---|---|---|---|
| **Scenario and replay lab** | Errors are hard to reproduce without identical starting conditions; live-only tests are slow and risky. | Repeat seeds, world state and event sequences; automate scenarios; detect regressions after every change. | **P0** | **MVP** — first simple deterministic scenarios and mock adapters. |
| **Decision provenance / traceability** | With wrong decisions it often stays unclear which observation or assumption led to them. | Trace every decision back to state, goal, skill, action and confirmation; essential for debugging and trust. | **P0** | **MVP** — a structured trace from the first vertical slice. |
| **Safety ladder and human override** | A single failed action can lead to endless repetition or avoidable damage. | Escalation from re-observe → safe alternative → replan → pause; human takeover at any time, and an audit. | **P0** | **MVP** — stop, pause, timeouts and stall detection from the start. |
| **Failure taxonomy and automatic curriculum generation** | Failures are often stored only as "episode lost" and help the next training little. | Sort failures into navigation, outdated perception, resource planning, hazard, timing, etc., and generate matching scenarios in a targeted way. | **P1** | After the MVP, once enough episodes exist. |
| **Skill quality gates and canary rollouts** | A locally improved skill version can worsen other situations. | Test candidates first in replay and on a subset of scenarios, compare them and roll back to the champion immediately. | **P1** | The first learning/optimisation phase. |
| **Uncertainty calibration and active perception** | An agent can react confidently to stale or thin observations. | Compare confidence with the actual hit rate and choose the next useful observation in a targeted way. | **P1** | After the MVP; at first for critical decisions. |
| **World snapshot and reset manager** | Reliable training and safe experiments need reproducible, resettable worlds. | Isolate scenarios, back up before/after runs and separate destructive experiments from valuable worlds. | **P1** | Before broader RL/exploration training. |
| **Task/scenario description instead of special-purpose code** | New tests or tasks otherwise require changes to many components. | Make goals, start conditions, success criteria and limits configurable; improves benchmark reuse and the curriculum. | **P1** | After the first hard-coded vertical scenario. |
| **Learning approval and data lifecycle** | Permanent learning can spread wrong or outdated knowledge and be hard to undo. | Manage provenance, validity, retention, export/deletion, model lineage and approval of every knowledge/policy change. | **P1** | Data capture from the start, extended management before live learning. |
| **Game transfer benchmark** | "Game-agnostic" can remain an architectural promise without proof if it is not measured. | With a second game, check which capabilities are really reusable in the core and which rightly live in the domain pack. | **P2** | Only after a stable Minecraft version and a second adapter prototype. |
| **Optional LLM planning partner with validation** | In complex unknown situations, symbolic planners cannot find a helpful hypothesis. | Later propose candidate goals or explanations; all proposals stay typed, bounded and subject to checks by the planner/safety. | **P2** | Later, and only as an optional proposal channel; never direct authority over actions. |

## 14. Risks and technical challenges

| Risk | Impact | Countermeasure |
|---|---|---|
| **Too large a scope / a false promise of generality** | Many abstract systems, but no agent that plays reliably. | One game, one version, one task; justify every abstraction step with real benefit or a second adapter. |
| **Partial observability and stale state** | Wrong assumptions lead to faulty planning or damage. | Keep freshness/confidence explicit, re-observe when there is risk, mark unknown world areas. |
| **Asynchronous actions and protocol latency** | A duplicated action, a lost confirmation, irreproducible bugs. | Request IDs, deadlines, state reconciliation, an action broker, idempotent repetition only where safe. |
| **Infinite loops / missing progress** | Loss of resources or a stuck agent. | Progress metrics, repetition counters, diversified recovery, a watchdog and a safe pause. |
| **Reward hacking and sparse rewards** | A high training score with poor real behaviour. | Domain success criteria kept separately, reward components disclosed, held-out edge cases and safety constraints. |
| **RL sample and compute costs** | Training stays slow or only memorises start states. | Skills/planner/imitation first, a controlled curriculum, diverse seeds and targeted subproblems. |
| **Skill composition explodes** | Unmanageable combinations and errors that are hard to localise. | Typed pre-/postconditions, a bounded plan length, skill contracts and replay tests. |
| **Version/mod drift in Minecraft** | Capabilities or observation semantics break without an obvious error. | Pin the version, an adapter capability handshake, contract tests and a support matrix. |
| **False security from memories** | Knowledge from another world or context is treated as true. | World/version reference, expiry times, sources, confidence, reset and controlled forgetting. |
| **The UI becomes decorative instead of diagnostic** | A lot of data, but no quick answer to "Why?" or "What now?". | Tie every view to concrete debugging/operations questions, test for usability, show only actionable KPIs. |
| **Credentials / unsafe plugins** | Account or server risk. | Remove secrets from logs/DB, a local test environment, adapter/plugin trust boundaries, minimal permissions. |
| **Apparent generalisation** | Success on known seeds is mistaken for general intelligence. | Held-out seeds, changed conditions, adversarial tests and, later, a separate second game adapter. |

## 15. Feature prioritisation

### P0 – before and in the MVP

- A fixed Minecraft Java version and a bounded test environment.
- A versioned adapter contract and contract/mock tests.
- A state model with source, time and unknown/outdated marking.
- A goal manager with hard safety rules, explainable prioritisation and hysteresis.
- A bounded planner and verifiable basic skills.
- A serialised safety broker, timeouts, pause/stop and a no-progress watchdog.
- Structured decision traces, telemetry and repeatable scenarios.
- A small Control Center with live state, the active decision, skills, events and safe control.

### P1 – first robust version after the MVP

- An extended skill library and context-dependent competence estimation.
- Episodic/semantic memory with expiry, search and provenance.
- More variation in scenarios, benchmark suites and a champion/candidate comparison.
- Human correction/takeover and a structured failure taxonomy.
- Parameter optimisation or imitation for a clearly bounded problem.
- Training/evaluation views, reset and snapshot tools.

### P2 – long-term capabilities

- RL/hierarchical RL in selected skills and in skill selection.
- Procedural scenario generation, controlled open exploration and active perception.
- An LLM as an optional, validated hypothesis/planning partner.
- Extended visual perception, modified/further Minecraft modes.
- A second game with its own adapter and a formal transfer evaluation.
- Distributed training, extensive model management or multi-agent functions only on demonstrated need.

## 16. Concrete development phases

### Phase 0 – Scope and technical feasibility

- Fix the target version, operating system, private test environment and legal usage limits.
- Test adapter candidates for connection, observation, state confirmation and abort.
- Document a minimal data/action contract design and failure cases.
- **Exit:** Stable proof of connection and observation; the decision on the stack and the supported version is justified.

### Phase 1 – Foundation and test lab

- Define module boundaries, the session/event model, logs, a mock adapter and deterministic scenarios.
- Build the action broker, structured request results, timeouts and a kill/pause path.
- Validate schema/contract tests and the state reducer.
- **Exit:** Invalid, outdated and late actions are detected reproducibly and handled safely.

### Phase 2 – End-to-end Minecraft vertical slice

- Connect a real adapter; build a basic world state.
- Integrate the goal manager, a bounded planner and the first atomic skills.
- Complete one controlled task entirely, from observation through goal/skill to a confirmed result.
- Test interrupted paths, missing resources, simple hazards and disconnect failures.
- **Exit:** The agent solves the task through dynamic state evaluation and replanning, not through a fixed, unchanged list of actions.

### Phase 3 – MVP hardening and Control Center

- Add episodes/traces, simple durable memory, skill statistics and replays.
- Implement the overview, live state, decision trace, skill and event views, and pause/stop.
- Automate multiple seeds, failure cases and regressions; bound and document data storage.
- **Exit:** A developer can understand a failed run from the UI/trace, repeat it and stop it safely.
- **Status:** met. The Control Center (page plus HTTP/SSE API against the running runtime), decision traces with rejections, skill statistics, episode/failure memory and the safe stop between actions are implemented and tested; the repeatability of a failed run remains available through the seed and the trace, not through a replay player. *(Update, fourth phase: the SSE stream has since been removed, the page polls, and the page itself was rewritten; see §12.5.)*

### Phase 4 – Competence measurement and first controlled learning

- Freeze the benchmark and test set; publish the baseline and metrics.
- Improve the failure taxonomy and episode quality.
- First examine simple parameter optimisation/bandit or imitation for an isolated subproblem.
- Add champion/candidate gates, checkpoints, rollback and reward-hacking tests.
- **Exit:** A learned variant improves on the baseline under held-out conditions without a safety regression.
- **Status:** partly met. The benchmark, metrics and the champion/candidate gate with rollback exist and run against the real evaluation suite; the "learned variant" is context-based utility weights from episodes (no model training), and the evidence for its effect comes from the simulation — the comparison against a real server world is still outstanding. *(Update, fourth phase: the baseline is now reproducible on the held-out set (191 of 260 runs), the definition of progress is versioned, and counting was tightened to verified outcomes. A 24-episode run changed choices but no outcome, so no improvement has been measured, and the suite has no headroom to show one; the exit criterion is therefore not met.)*

### Phase 5 – Autonomy and scenario breadth

- Multi-goal planning, longer-term resource planning, uncertainty calibration and advanced skills.
- A curriculum, harder worlds, wider coverage of disturbance cases and, optionally, a clearly delimited RL problem.
- **Exit:** Reliable, measured competence across several scenario classes; errors can still be reproduced and rolled back.

### Phase 6 – Second game adapter

- Prototype a deliberately different game against the same core/adapter contract.
- Document commonalities, necessary domain extensions and skills that do not transfer.
- **Exit:** Establish which GameMind core parts are actually reusable; simplify the architecture if necessary instead of forcing commonalities.

## 17. Definition of a sensible MVP

The MVP is a **safe, traceable, boundedly autonomous Minecraft agent** — not yet a self-training general game AI.

### Scope

- One agent, Minecraft Java Edition, a pinned vanilla version and a controlled private/local server.
- Structured perception of position, inventory, health/hunger, relevant nearby blocks/entities and state events.
- Goal selection at least for task progress and a higher-priority safety/abort reaction.
- A small, verified skill library, e.g. observe, navigate, obtain wood resources, craft/place, equip, avoid/abort simple hazards.
- A bounded planner that resolves preconditions dynamically from the inventory and the environment and replans on disturbances.
- Persistent episode/decision traces and reproducible test runs.
- A web Control Center with an overview, agent state, decision trace, skills, logs, and pause/stop.
- No online RL, no unvalidated LLM actions, no arbitrary building/fighting, no multiplayer PvP and no claim to full survival autonomy.

### Proposed type of acceptance scenario

In a controlled world, the agent should reach a bounded starter goal from a fresh start state, for example gather a defined amount of wood and make a simple tool from it. The start position, resource layout and obstacles vary; individual runs contain an interruption or a harmless disturbance. The agent must select goals and skills from the current state and replan after an invalid assumption. The concrete recipe/goal set is finalised only after the adapter compatibility test.

### Preliminary acceptance criteria

The thresholds are starting values and are adjusted after a first baseline:

- At least **80% success** on a small, predefined suite of at least 20 test seeds.
- **0 unvalidated actions or actions outside the capability** in the suite.
- Every skill has a timeout, abort and a confirmed success indicator.
- No unbounded repetition of the same unsuccessful action; a stall leads to recovery or a safe pause.
- At least one disturbance case is handled without a restart through re-observation/replanning.
- Failed runs can be analysed through the session ID and replay/trace.
- Stop/pause works regardless of whether the current goal is succeeding.

The MVP makes no claim that the AI already invents new skills on its own. It establishes the data, control and evaluation paths through which skill improvement can later be measured safely.

## 18. Long-term roadmap

1. **A reliable Minecraft agent:** stable perception, safe skills, understandable goal selection, failure recovery and verifiable tasks.
2. **Competence-based improvement:** better context-dependent skill selection, learning-to-rank/bandits, imitation and RL for subproblems that are demonstrably suitable.
3. **Longer-term planning and open exploration:** milestones, resource strategies, active information seeking, robust adaptation to unknown world states.
4. **A scalable knowledge/skill ecosystem:** versioned domain packs, skill quality gates, scenario curricula and traceable memory lifecycle management.
5. **A second and further game adapters:** check transfer against benchmarks and generalise the core only where experience justifies it.
6. **Optional advanced models:** multimodal perception, LLM-assisted hypotheses/plan proposals or hierarchical policies — always within the validated planner and safety boundaries.

## Closing architecture decision

The most important early success is not the largest possible model but a **closed, safe and measurable control loop**: observation → explicit world state → reasoned goal selection → verified skill → confirmed result → stored episode → reproducible evaluation. If this loop works cleanly, GameMind can improve its skills and policies step by step. Without it, RL, memory and an elaborate GUI would mostly be complexity that is hard to verify.
