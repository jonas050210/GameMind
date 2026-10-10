# Live verification checklist

This checklist is what remains before GameMind's new Minecraft behaviour can be described as verified on a real server. Nothing here has been executed against a server yet. Sections 16 and 17 record the only runs so far, against a non-vanilla stand-in; section 18 lists the checks for the persistent session, the scheduler, the launcher and the rewritten Control Center, none of which has been run against a server either. Record the result of each check, including failures, before making any compatibility claim.

## 0. Safety and scope

- Use a **disposable, private world** on a server you are authorized to operate, on Minecraft Java **1.20.4** (or the version you pin with `--version`).
- Use `MINECRAFT_AUTH=offline` for offline-mode servers only. Do not pass account credentials on the command line or in files you commit.
- Stop the agent with **Ctrl-C** at any time. The CLI closes the Minecraft session before exiting.
- A session is **persistent** by default: it stays connected after a task until you stop it. Commands in this checklist that expect the run to finish by itself and print a result carry `--one-shot`.
- Keep an operator account in-game for the setup commands below. The agent's account should start in **survival** mode.

## 1. Server setup

Start a vanilla 1.20.4 Java server in a directory of your choice. For a local test, `server.properties` should contain at least:

```properties
online-mode=false
difficulty=normal
view-distance=8
simulation-distance=6
```

`online-mode=false` is only for a local private test; never expose such a server publicly. `view-distance=8` should load enough nearby columns for the default 32-block client scan. The adapter can only inspect chunks the server/client actually loaded; unloaded terrain remains unknown.

Join once as `GameMind` (through the agent or a client), then run these commands as an operator in the server console or chat, substituting your own coordinates:

```text
/gamemode survival GameMind
/gamerule naturalRegeneration true
/gamerule doMobSpawning false          # first pass; enable for the threat checks in §7
/tp GameMind 0 80 0
/setblock 30 80 0 minecraft:oak_log    # a log outside the local cube, inside the default 32-block scan
/setblock -10 80 6 minecraft:sweet_berry_bush[age=3]   # ripe berries
/summon item 4 80 -4 {Item:{id:"minecraft:bread",Count:1b}}   # a dropped food item
```

Adjust `y` values to the ground level of your world (the grass surface is at y 63 in a flat world, so the agent stands at y 64). Confirm the blocks with `/data get block` or by looking.

## 2. Connection and wide observation

```bash
npm run dev -- --host 127.0.0.1 --port 25565 --username GameMind --one-shot
```

**Expected:** a JSON `initial-observation` with `observation.state` containing `resourceScan` (`radius: 32`, `center` at the agent's block, `truncated: false`), `resourceSightings` including the log at `30 80 0` (when the agent is at about 0,0) and the berry bush with `properties.age: 3`, and `itemDrops` listing `bread` near `4,-4`. This tests perception only; the task's separate 24-block collection limit can require an approach before collection.

**Record:** whether the log beyond the 3-block cube appears in `resourceSightings` (this tests `findBlocks` and chunk loading), whether the bush shows `properties.age`, and whether the bread appears in `itemDrops` (this tests `getDroppedItem`). Any of these being missing is a result to report, not a reason to change the thresholds.

## 3. Gather with exploration

Remove any nearby test log, leaving only the one at 30 blocks. Then:

```bash
npm run dev -- --task gather-logs --resource oak_log --count 1 --explore-legs 8 --max-actions 24 \
  --host 127.0.0.1 --port 25565 --username GameMind --one-shot
```

**Expected:** `task-report` with `"status": "succeeded"`. The `actions` array shows either a direct `collect:oak_log` or an `approach:oak_log` followed by collection, and every action has `"verification": "verified"`.

**Record:** `metrics.explorationLegs`, `metrics.unverifiedConfirmations` (should be 0), `metrics.failedActions`, and any `failureCode` (for example `PATH_NOT_FOUND` from a waypoint across unloaded terrain). A failed waypoint should be excluded and replaced, not repeated.

## 4. Craft with exploration

Give the agent no logs (clear its inventory with `/clear GameMind`) and keep the 30-block log:

```bash
npm run dev -- --task craft-wooden-pickaxe --explore-legs 8 --max-actions 24 \
  --host 127.0.0.1 --port 25565 --username GameMind --one-shot
```

**Expected:** `succeeded`, with the crafted `wooden_pickaxe` in the final inventory. The first `decision.made` event in the trace carries a `plan` such as `collect 1 oak_log`, `craft 4 oak_planks`, and so on.

**Record:** the number of replans, the plan changes, and whether the crafting table was placed on a supported block.

## 5. Dropped food: pickup, then eat

Lower the agent's hunger first, for example `/effect give GameMind minecraft:hunger 60 4`, then wait until the food bar is at or below about 5. Keep the bread at `4 80 -4` (or re-summon it).

```bash
npm run dev -- --task secure-food --target-hunger 12 --explore-legs 8 --max-actions 24 \
  --host 127.0.0.1 --port 25565 --username GameMind --one-shot
```

**Expected:** the actions include `pickup:bread` (skill `minecraft.pickup-item`) and then `restore-hunger` (`minecraft.eat-food`). Each has `"verification": "verified"`, and `metrics.foodSourcesUsed` is at least 1.

**Record:** whether walking onto the item cell picked it up automatically (`confirmation: dropped_item_entered_inventory_delta_checked`), and the time taken.

## 6. Ripe berries and harvest

Remove the bread (`/clear GameMind minecraft:bread` or let it be eaten). Keep the bush at `-10 80 6`. Lower hunger as in §5, then:

```bash
npm run dev -- --task secure-food --target-hunger 8 --explore-legs 8 --max-actions 24 \
  --host 127.0.0.1 --port 25565 --username GameMind --one-shot
```

**Expected:** `harvest:sweet_berry_bush` (skill `minecraft.harvest-berries`) confirms with `berriesAfter > berriesBefore`, and the bush's `age` in `details` drops to 1. An unripe bush (`age=1`) must never be harvested; check that the agent skips it.

**Record:** `details.ageBefore`, `details.ageAfter`, and `berriesAfter - berriesBefore`. If `activateBlock` on a ripe bush gives no berries on this server, the adapter will report `ACTION_NOT_CONFIRMED` and the target is excluded; record that as a failure.

## 7. Rest and threat interruption

**Rest (natural regeneration):** lower health with a short damage effect (for example `/effect give GameMind minecraft:instant_damage 1 1`), keep food at 18 or more, and run a gather task:

```bash
npm run dev -- --task gather-logs --count 1 --host 127.0.0.1 --port 25565 --username GameMind --one-shot
```

**Expected:** a `minecraft.rest` action with `confirmation: health_increase_observed_during_rest` and `metrics.restMs > 0`, then the log collection.

**Threat:** enable mobs (`/gamerule doMobSpawning true`), summon a zombie beside the log (`/summon zombie 25 80 1`), and run the gather task again.

**Expected:** no `collect` action starts while the zombie is within 6 blocks. Either the agent flees (`avoid-nearby-hostile`) or it reports a blocked state naming the danger radius. `metrics.unsafeActions` must be `0`.

**Record:** any `REST_INTERRUPTED_BY_THREAT` or `REST_INTERRUPTED_BY_DAMAGE` failure, and whether natural regeneration was observed at all (a server with `naturalRegeneration` off must produce a "not confirmed" rest, not a success).

## 8. Stall recovery (only if you can create a blocking cell)

Build a single block on the direct approach to the log, for example `/setblock 23 80 0 minecraft:stone` with the log at `24 80 0`, and run the gather task with `--explore-legs 0`. A real pathfinder usually routes around a single block, so this check may not stall at all; record what happens rather than forcing a result.

## 9. Trace review

After any run, open `data/traces/<session-id>.jsonl` (the session id is in the `task-report` or in the first event). Confirm:

- `task.action` events have a `verification` object with `verified: true` for every successful action.
- `decision.made` events have `plan`, `band`, and `knowledge` fields.
- No event contains a credential-looking value (the trace redactor should show `[REDACTED]` for any such key).

## 10. Control Center against a live run

**Setup:** start an authorized server and run GameMind with its Control Center. A persistent session is the default and keeps the page up for the whole session:

```bash
python3 main.py --task gather-logs --host 127.0.0.1 --port 25565 --username GameMind
# or, without the launcher:
npm run dev -- --task gather-logs --host 127.0.0.1 --port 25565 --username GameMind --open-browser
```

Open the printed URL (`http://127.0.0.1:8787/`) on the same machine; the launcher and `--open-browser` do this for you, once. The page has no push channel: it re-reads `/api/snapshot` every 1.5 s while the tab is visible (every 15 s in a hidden tab), so a panel that updates is evidence that the runtime is producing new state, not evidence of a lost event. Then check, in order:

1. **Session and freshness.** The status bar shows the session state (`Running a task`, `Connected · idle`, …) and a **LIVE** badge. On the Overview, the *Player and world* card reads `Observation #N · Xs ago` with N increasing and X staying small. An idle connected agent is refreshed by the page's own poll; if the card says `stale` while the console shows the bot still observing, the refresh is broken. A genuinely stale observation must show the notice *The latest observation is stale* with its consequence (`STALE_OBSERVATION` refuses world-changing actions).
2. **Telemetry matches the client.** Health, food, position, dimension, game mode and inventory must match what the Minecraft client shows, including when the server reports nothing: a field the session never sent must read *unknown*, never 20 health, 20 food or a default position. The position is shown as whole blocks. On death, *Alive* must read `no — respawning` until the session reports the respawn.
3. **Dimension and game mode.** Switch mode mid-run with `/gamemode creative GameMind`: the *Game mode* row must change and the next action must be refused with `GAME_MODE_BLOCKS_*` (or a new task must end as `TASK_BLOCKED_MODE`); switch back to survival and the refusal must clear. `/execute in minecraft:the_nether run tp …` must move *Dimension* to `the_nether` and gate overworld-only work with `UNSUPPORTED_DIMENSION`. On the Tasks tab, the *Latest decision* card shows *Game mode seen* and *Dimension seen* with their evidence (`survival · verified`, `single-source`, or `unknown · unreported`).
4. **Decision explanation.** The *Latest decision* card names the goal that is actually running, with its rationale. *Alternatives considered* and *Rejected candidates* must give real reasons (`combat is not enabled for this run…`, `target excluded after repeated failure`, a danger radius around the target, …). The page never shows a candidate's coordinates; the trace file does.
5. **Pause and resume.** Press **Pause** on the Overview. The next action must be denied with `RUN_PAUSED`, the Overview shows the *Paused* notice, and the agent must keep observing. **Resume** continues and the notice goes away.
6. **Trip and stop.** On the Bots tab press **Trip** (or use the Overview's **Emergency stop**), then **Stop task**. The run must end as `aborted` / `OPERATOR_STOP` after the action in flight, never in the middle of one. **Reset trip** clears the *Safety trip raised* notice.
7. **Start a task from the page** (Tasks tab, `mine-stone`, amount 2). It must go through the same limits as the CLI, and *Actions used* counts up. Starting a second task while it runs must be refused, or queued when *Queue it* is ticked, never run alongside.
8. **A Library action** (Bots tab, *Library actions (advanced)*): run one with real parameters, for example inspecting the block at the agent's feet. The operation must report `succeeded` only when the observation agrees; disconnect the run and the same entry must refuse with the connection named. Entries the run cannot serve (combat on an adapter without the switch, companion entries with no coordinator) must read as unavailable with the missing requirement named, never as runnable buttons that fail silently.
9. **Kill the server process mid-run.** Within a poll the session state must change to `Reconnecting` with the attempt count, and *Connection diagnostics* on the Bots tab must say what failed. A disconnect must never be displayed as a task failure or a safety refusal.
10. **Reload the page.** The token comes from the served page, so the controls keep working and nothing restarts. From a terminal, `POST /api/command` without the `x-gamemind-token` header must return `403`, an unknown command `501`, and `GET /api/stream` must return `410` with `STREAM_REMOVED` (the live event stream is retired; polling replaced it).

**Record:** any panel that stayed unchanged while the console showed new state, any number the page showed that the client did not report, and every control that reported success without a matching event or trace line. The page's wiring, its poll model and its text are covered offline by `test/ui-page.test.ts`, `test/ui-e2e.test.ts`, `test/control-center.test.ts` and `test/session-gates.test.ts`; this section is the only place that can verify them against Minecraft, and §18 item 8 covers how the page looks in a real browser.

## 11. Experience memory across two runs

**Setup:** keep the default learning directory, and run the same task twice against the same world:

```bash
npm run dev -- --policy status
npm run dev -- --task gather-logs --resource oak_log --host 127.0.0.1 --username GameMind --one-shot
npm run dev -- --policy status
npm run dev -- --task gather-logs --resource oak_log --host 127.0.0.1 --username GameMind --one-shot
```

**Expected:** after the first run, `episodes` equals the number of attempted actions and a `data/learning/` directory exists. If the first run blocked on a target (unreachable log, no tool, full inventory), the second run must not spend its budget on that same target: `wastedActions` in the second `task-report` is lower, and the dashboard's Learning panel lists the target as blocked. `activePolicy` stays `null` until you promote something.

**Record:** the two `wastedActions` figures and `learning.blockedTargets` from the trace. If the second run repeats the first run's failures verbatim, the world key or the memory read is broken — that is a defect, not a flaky test.

## 12. Combat opt-in (only where fighting is allowed by the server rules)

**Setup:** on a test world with mobs, first run **without** the flag:

```bash
npm run dev -- --task secure-food --target-hunger 6 --max-actions 20 --host 127.0.0.1 --username GameMind --one-shot
```

Summon a zombie next to you. **Expected:** no `attack_hostile` action; the agent flees, and the decision trace records the rejection `combat is not enabled for this run, so the agent flees instead of attacking`.

Then run with `--allow-combat` (this arms the adapter, the safety policy and the planner together), or press the dashboard's Combat switch **before** starting the task. **Expected:** with a weapon in hand and the hostile within range, `attack-hostile` runs, each hit is confirmed by the mob's observed health, and the action stops when the target dies or flees; without a weapon the agent equips one first or keeps fleeing. `metrics.combatActions` counts the attacks; `unsafeActions` must stay 0.

**Record:** the weapon you held, the damage sequence in the trace, and whether any attack happened while the mob was outside the task's danger radius.

## 13. Mining and shelter

```bash
npm run dev -- --task mine-stone --resource stone --count 4 --max-actions 30 --host 127.0.0.1 --username GameMind --allow-combat --one-shot
npm run dev -- --task mine-stone --resource coal_ore --count 2 --host 127.0.0.1 --username GameMind --one-shot
```

**Expected for a bare hand:** no dig is attempted on stone; the agent crafts or equips a pickaxe first (`equip:pickaxe` appears in the plan), and only then digs. A dig that would drop nothing is refused by name — `TOOL_REQUIRED` with no pickaxe at all, `TOOL_TIER_INSUFFICIENT` when the best pickaxe is below the block's minimum tier (`iron_ore` and above need stone tier), `BLOCK_NOT_MINEABLE_CLASS` for a block outside the mineable classes.

For shelter, place the agent somewhere open and check that `build-shelter` only uses blocks counted in the inventory, reports `no-support` for an observed non-solid side and `unknown` for an unobserved one, and that the four cardinal sides are closed in the next observation.

**Record:** the dig durations versus Mineflayer's own estimate (a systematic underestimate means the dig timeout slack needs raising), and whether the drop appeared within the settle window.

## 14. Death and respawn recovery

Use only a disposable world. With `MINECRAFT_AUTO_RESPAWN` unset (default `true`), begin a bounded task that takes long enough to remain active, then run `/kill GameMind` from the server console while the task is in progress. Repeat with `MINECRAFT_AUTO_RESPAWN=false` if you want to verify the disabled path; leave the player dead for the wait window, or manually respawn it if your test harness can send the vanilla respawn request.

**Expected with auto-respawn enabled:** the Mineflayer health plugin sends its respawn request, the adapter observes the player alive again, and the task loop re-observes/replans. The trace contains `player.death`, `metrics.deathsObserved` is at least 1, and `metrics.respawnRecoveries` is at least 1 if the player becomes alive before the budget ends. No world-changing action may be issued while the observed player state is dead.

**Expected with auto-respawn disabled:** the adapter does not request a respawn on death. Unless a respawn is sent externally, the runner waits without acting and stops with `RESPAWN_TIMEOUT` after 30 seconds or `TASK_DEADLINE` if the task budget expires first. Disconnect and operator stop should also terminate the wait explicitly.

**Record:** the environment setting, death and respawn trace timestamps, terminal status/failure code, recovery metrics, and confirmation that no action began while dead. This check has not been executed against a live server; simulated death/recovery tests are not live evidence.

## 15. Session facts under a real login sequence

**Setup:** join a server that has *not* been touched by the agent before, with the agent in survival, and
watch the first two observations in the trace plus the Control Center's Overview.

```bash
npm run dev -- --host 127.0.0.1 --port 25565 --username GameMind --no-autonomy --open-browser
```

**Expected:** on the very first observation the `player.session` line may still read
`not reported` for mode or dimension, because Mineflayer fills `bot.game` only with the login packets — but
the session must then keep running and the page must fill in, not block (the Overview's *Player and world* card and the Tasks tab's *Latest decision* card show the values and their evidence). A `bot.game = {}` server, a server
that answers `login` with a numeric dimension (`0`, `-1`, `1`) and one that answers with a level name
(`world`, `World`, `DIM-1`) must all reach a canonical reading (`overworld`, `the_nether`, `the_end`) or an
honest `unrecognised dimension name` — never `no overworld` for a plain survival world. A custom dimension
such as `custom:lobby` must appear verbatim as an unknown, non-overworld value.

**Record:** the raw `bot.game` values (the `observed` strings in `player.session` quote them), which of the
two mode sources answered, how many observations the first decision waited for, and whether any action was
refused while a fact was only `unreported` — a refusal without a positively reported value is a defect: the
policy is to block on a verified wrong value and to proceed while stating the uncertainty.

## Open questions this checklist answers

| Question | Check | Current status |
| --- | --- | --- |
| Does `findBlocks` return a log 30 blocks away in loaded chunks under the default 32-block scan? | §2 | Unverified |
| Does `getDroppedItem()` return `bread` for item entities in 1.20.4? | §2, §5 | Unverified |
| Does `getProperties().age` report berry age on 1.20.4? | §2, §6 | Unverified |
| Does `activateBlock` on a ripe bush give berries and reset age? | §6 | Unverified |
| Does walking onto a dropped item pick it up? | §5 | Unverified |
| Does natural regeneration work at food ≥ 18 with the default rules? | §7 | Unverified |
| Do pathfinder errors arrive with `name` = `NoPath` / `Timeout` / `PathStopped`? | §3 (unreachable waypoint) | Unverified |
| Is `sweet_berry_bush` respected by `blocksToAvoid` in path planning? | §6 | Unverified |
| Does `bot.dig` on 1.20.4 need more time than the estimated dig for deepslate or ore? | §13 | Unverified |
| Does the inventory report `inventoryFull` correctly when a stack boundary is hit? | §11, §13 | Unverified |
| Do placed blocks survive an observed check on a real server (shelter sides)? | §13 | Unverified |
| Does `bot.attack` plus health tracking confirm damage on 1.20.4 mobs? | §12 | Unverified |
| Does the Control Center see live observations, and do Pause/Trip/Stop reach the running agent? | §10 | Unverified |
| Does the panel report `not reported` instead of a default when the server sends no vitals? | §10, §15 | Unverified |
| Does a mid-run `/gamemode` change both update the panel and gate/ungate actions? | §10 | Unverified |
| Does the mode/dimension read survive `bot.game = {}`, numeric dimensions and level names? | §15 | Unverified |
| Does the world view draw current blocks with a correct horizon (fog, near/far) at 1.20.4 chunk density? | §10 | Unverified |
| Does the experience memory change a second live run in the same world? | §11 | Unverified |
| Does Mineflayer auto-respawn by default, and does the task runner wait action-free until alive? | §14 | Unverified |

Only mark a row verified when the check was run against a server and the evidence is recorded in your notes.

## 16. Run the harness against your server (added with the headless-learning work)

The automated live runner already exists. Run it from your own machine, against your server, with a disposable world:

```bash
# Connection, observation, and a single decision. Read-only; it never dispatches a world-changing action.
npm run test:live -- --host 127.0.0.1 --port 61889 --mode verify --output test-results

# Full learn mode: adds episode recording, a learning update, and the Control Center check.
npm run test:live -- --host 127.0.0.1 --port 61889 --mode learn --output test-results
```

The report is written to `test-results/live-verification-report.json`. It separates per-phase `PASS`/`FAIL`, and it exits non-zero when the server is not reached. A run where the server refused connections reports **no** live result; that is what happened in the last attempt from the development sandbox (`ECONNREFUSED 127.0.0.1:61889`).

**What the harness does not yet cover, and therefore has not verified live:** movement to a chosen block, digging, block placement, entity attacks, swimming and leaving water, drowning response, and task completion as individual capabilities. Each of those needs a controlled phase with a known-good setup (for example, a flat platform the operator builds, and a pool built for the swim test). They are listed as open work in `docs/HEADLESS_LEARNING.md` and in the change notes, and must not be described as verified until a run records them.

## 17. Live results on a non-vanilla stand-in, and how to run the harness on a real server (2026-10-10)

**What was and was not run.** This sandbox has no Java, no Docker, and no network route to Mojang, PaperMC, Maven, or Adoptium, so the vanilla 1.20.4 server could not be started. Every result below is from a **non-vanilla stand-in** (`flying-squid@1.12.0`, protocol 1.20.4, offline auth, `127.0.0.1:25566`) and is labelled as such. It is live evidence about the adapter against a real protocol server, but it is **not** evidence about vanilla Java server behaviour. Vanilla live verification is still required.

**Harness honesty fixes (this change).**
- A phase counts as "reached the server" only when its own bot logged in. Before, any phase that passed (including the in-process learner phases) set `Reached: YES`.
- A refused connection is `NOT RUN` (not a failed server test), and the exit code is 2.
- `learning-update` and `control-center` are tagged `[offline]`. They never connect and are not live evidence.
- Each server phase is tagged `[server]`. Skipped action phases (`SKIPPED`) are neither a pass nor a failure.
- A closed connection now releases the protocol client's timers, so a refused run exits in about a second instead of after 30 s.

**Results on the stand-in (`npm run test:live -- --host 127.0.0.1 --port 25566 --mode learn`):** exit 0, `ALL PASSED`, `Reached: YES`. Connection, observation, decision, and episode-recording ran `[server]` in 1.8–2.4 s each. Learning-update and control-center ran `[offline]`.

**Opt-in action phases (`--actions --allow-dig --allow-combat`), stand-in:**

| Phase | Result | Evidence |
|---|---|---|
| movement | PASSED `[server]` (899 ms) | navigate confirmed by position |
| timeout-recovery | PASSED `[server]` (5.4 s) | timeout → cancel → next action |
| dig | PASSED `[server]` (5.5 s) | block broken, inventory delta checked |
| swim | SKIPPED | the phase starts where the bot stands, not in water (swim verified separately: exit from pool in 1306 ms, 13 steps) |
| combat | SKIPPED | no hostile visible; summoned mobs are not client-visible on this stand-in |

**Other live probes on the stand-in (single runs, `npm run dev` CLI):**
- Long navigate with `timeoutMs=1200`: `timed_out`, `ACTION_TIMEOUT`, 1207 ms. The bot coasted about 0.25 blocks in the first second, then stayed still.
- Unreachable navigate `(12,30,8)`: `PATH_NOT_FOUND` from 4 starts. From the cell beside the target, the planner's empty path now gives `ACTION_NOT_CONFIRMED` with reason `pathfinder_resolved_but_goal_not_reached_by_position`.
- A normal navigate after the failure: `succeeded`, confirmed by position, 1556 ms.
- `gather-logs --resource oak_log --count 1` from (12.5,5,18), the baseline flags: **exit 0** (before the fix: `blocked`, `TASK_BLOCKED_TARGETS`, exit 1). Caveat: the bot already held 2 oak logs from earlier probes, so the task reported `succeeded` with 0 actions. That is a pre-satisfied success, not a collect.
- Valid collect: `--count 3` with the same flags, after restoring the fixture log: `succeeded`, 1 action (`minecraft.collect-log`), `targetItemsGained` 1, 0 failed actions, 0 unverified confirmations, 0 unsafe actions.

**Not verified live:** drowning (the stand-in does not report air supply), combat (no client-visible mobs), vanilla server behaviour, and the original Defect 5 "OK with `confirmed=false`" (not reproduced at any start tested on HEAD or on the fixed code).

**Commands for a real server (run these yourself where Java 1.20.4 runs):**

```bash
# 1. Start a private, disposable 1.20.4 Java server in survival mode. Use a test account and a world you can throw away.
# 2. Read-only checks first:
npm run test:live -- --host <ip> --port 25565 --mode learn --output ./test-results
# 3. Action phases, only in a private world (dig and combat change the world; combat needs a hostile in view):
npx tsx src/testing/live/live-test-runner.ts --host <ip> --port 25565 --actions --allow-dig --allow-combat --mode learn --output ./test-results
# Exit codes: 0 all passed (skips allowed), 1 a phase failed, 2 server unreachable (nothing was tested).
```

Read the tags in the report. Only `[server]` phases are live evidence; `NOT RUN` and `SKIPPED` mean nothing was tested.

## 18. Lifecycle, scheduler, launcher and Control Center (added with the persistent-session work)

None of the following has been run against a Minecraft server. Each item is the live counterpart of offline tests (named in each item); the offline tests prove the logic with doubles and a simulator, not the behaviour of a real server, a real operating system or a real browser. Run these in a disposable world, record the result of each, failures included, and make no compatibility claim from the offline tests alone.

**Setup:** a private 1.20.4 server as in §1, the agent's account in survival, and the launcher: `python3 main.py --host 127.0.0.1 --port 25565 --username GameMind` (WSL2: see item 7). `python3 main.py --check` first, to confirm Node, the dependencies and the Control Center port.

1. **Persistent session.** Start `python3 main.py` with no task. Expected: the browser opens once; the status bar goes `Connecting` → `Initializing` → `Connected · idle` with the **LIVE** badge, and *Player and world* fills in with the real health, food and position. Turn autonomy off (*Turn autonomy off* on the Bots tab, or `--no-autonomy`) and wait five minutes: the bot stays connected, `CLI run complete` never appears, and refreshing, or closing and reopening the tab, restarts nothing (same session, no second browser tab, no new `connection` events in the event log). Then start `gather-logs` from the Tasks tab: when it finishes the session returns to `Connected · idle` and stays connected. *Offline counterparts:* `test/lifecycle.test.ts`, `test/cli-lifecycle.test.ts`, `test/ui-e2e.test.ts`.
2. **The CLI task wins the startup race, and tasks never overlap.** With autonomy on (the default), run `python3 main.py --task gather-logs --resource oak_log --count 1` with a log in reach, ten times (stop the session between runs), because the original defect was a race and one pass proves little. Expected every time: no `A task is already running in this agent` message and no `Cannot access 'host' before initialization`; the Tasks tab shows the task started by `cli` first; autonomous work, if any, starts after it. Then, while a task runs, start the same task again (refused as `TASK_DUPLICATE`), start a different one (refused, or queued with *Queue it* ticked) and queue six (the sixth is refused: the queue holds five). Stopping the running task must start the next queued one. *Offline:* `test/task-scheduler.test.ts`, `test/lifecycle.test.ts`.
3. **A dropped connection.** Stop the server mid-session. Expected: `Reconnecting` with `Reconnect attempt N of 5` and growing delays (2 s doubling to 30 s); a running task ends as an excluded connection outcome, never as a skill failure; after the last attempt the session ends `Disconnected` with `RECONNECT_EXHAUSTED` and the Control Center still answers. Restart the server during the retries and the session must come back to `Connected · idle` on the same page. Stop it again and press **Stop session** during a retry: the retry is cancelled. *Offline:* `test/lifecycle.test.ts`.
4. **Shutdown.** End a session four ways: the Overview's **Stop session**, the footer's **Quit GameMind**, Ctrl-C under `npm run dev`, and Ctrl-C under `python3 main.py`. Expected each time: the bot leaves the server once (a single `left the game` line in the server log, not a timeout), the Control Center port is released, the process exits, no `node` or `tsx` process remains (`ps`), and `data/run/gamemind.lock.json` is gone. Then `kill -9` the process once and confirm the next start replaces the stale lock instead of refusing. *Offline:* `test/cli-lifecycle.test.ts`, `test/launcher.test.ts`, `tests_py/test_launcher.py`, `test/app.test.ts`.
5. **Game-mode refusal.** Put the player in creative (`/gamemode creative GameMind`) and start a task. Expected: it ends as `TASK_BLOCKED_MODE` with the explanation on the Learning & Policy tab, no action was dispatched, and the learning store counts it as excluded (the context's success rate does not move). Also switch mode during a task: the next action is refused with `GAME_MODE_BLOCKS_*`. *Offline:* `test/learning-evidence.test.ts`.
6. **Real action failures.** Run tasks likely to fail in a real world (a log behind water, stone without a pickaxe, a full inventory) and read the codes behind any `CONSECUTIVE_ACTION_FAILURES` or `NO_FEASIBLE_GOAL` stop on the Learning & Policy tab and in the trace. Expected: each failure code names a world condition (path blocked, tool missing, block not diggable, …), the failed target is excluded and the run tries an alternative before stopping, and a second run in the same world does not retry the excluded target first. Record the codes: the simulator cannot produce the real ones. *Offline:* `test/learning-evidence.test.ts`, `test/training-safety.test.ts`, `npm run eval:offline`.
7. **WSL2 and Windows.** With the server on Windows and GameMind in WSL2 (default NAT networking): `python3 main.py --check`, then `python3 main.py` with no `--host` and no `MINECRAFT_HOST`. Expected: the launcher reports which host it chose (`127.0.0.1` if it answers, otherwise the Windows host), connects, and opens the Control Center in the Windows browser (`wslview`, `explorer.exe`, `cmd.exe` or `powershell.exe`). Record the Windows firewall rule you needed, whether mirrored networking changes the choice, and what happens with the project under `/mnt/c` (a warning about slow file access). Repeat natively on Windows if you run Node there. *Offline:* injected platforms, fake probes and a fake process spawner in `tests_py/test_launcher.py` and `test/launcher.test.ts`.
8. **The page in a real browser.** Look at every tab at about 1440 px and at about 700 px wide, in light and dark themes, with the system's reduced-motion setting on and off. Record contrast problems, text that is cut off or overlaps, controls that are hard to use, and anything that moves when it should not. Nobody has looked at the page yet. *Offline:* `test/ui-page.test.ts`, `test/ui-components.test.ts`, `test/ui-e2e.test.ts` and `test/ui-static.test.ts` check text, controls, states and code in a fake DOM, never appearance.
9. **Live verification phases.** On the Tests & Evaluation tab, try to run live verification without confirming (the controls must stay disabled), then confirm the connection and run the read-only phases; confirm again only in a disposable world before the digging and combat phases. Expected: PASS, FAIL or SKIPPED with a reason for every skip, and a result labelled `NOT VERIFIED LIVE` unless a server was actually reached. Compare with the headless harness in §16.

**Record for every item:** what you ran, the date, the server software and version, the evidence (event-log lines, trace file names, a screenshot for item 8) and anything that differed from *Expected*. A difference is a result.
