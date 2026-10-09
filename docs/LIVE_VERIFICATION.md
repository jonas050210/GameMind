# Live verification checklist

This checklist is what remains before GameMind's new Minecraft behaviour can be described as verified on a real server. Nothing here has been executed against a server yet. Record the result of each check, including failures, before making any compatibility claim.

## 0. Safety and scope

- Use a **disposable, private world** on a server you are authorized to operate, on Minecraft Java **1.20.4** (or the version you pin with `--version`).
- Use `MINECRAFT_AUTH=offline` for offline-mode servers only. Do not pass account credentials on the command line or in files you commit.
- Stop the agent with **Ctrl-C** at any time. The CLI closes the Minecraft session before exiting.
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
npm run dev -- --host 127.0.0.1 --port 25565 --username GameMind
```

**Expected:** a JSON `initial-observation` with `observation.state` containing `resourceScan` (`radius: 32`, `center` at the agent's block, `truncated: false`), `resourceSightings` including the log at `30 80 0` (when the agent is at about 0,0) and the berry bush with `properties.age: 3`, and `itemDrops` listing `bread` near `4,-4`. This tests perception only; the task's separate 24-block collection limit can require an approach before collection.

**Record:** whether the log beyond the 3-block cube appears in `resourceSightings` (this tests `findBlocks` and chunk loading), whether the bush shows `properties.age`, and whether the bread appears in `itemDrops` (this tests `getDroppedItem`). Any of these being missing is a result to report, not a reason to change the thresholds.

## 3. Gather with exploration

Remove any nearby test log, leaving only the one at 30 blocks. Then:

```bash
npm run dev -- --task gather-logs --resource oak_log --count 1 --explore-legs 8 --max-actions 24 \
  --host 127.0.0.1 --port 25565 --username GameMind
```

**Expected:** `task-report` with `"status": "succeeded"`. The `actions` array shows either a direct `collect:oak_log` or an `approach:oak_log` followed by collection, and every action has `"verification": "verified"`.

**Record:** `metrics.explorationLegs`, `metrics.unverifiedConfirmations` (should be 0), `metrics.failedActions`, and any `failureCode` (for example `PATH_NOT_FOUND` from a waypoint across unloaded terrain). A failed waypoint should be excluded and replaced, not repeated.

## 4. Craft with exploration

Give the agent no logs (clear its inventory with `/clear GameMind`) and keep the 30-block log:

```bash
npm run dev -- --task craft-wooden-pickaxe --explore-legs 8 --max-actions 24 \
  --host 127.0.0.1 --port 25565 --username GameMind
```

**Expected:** `succeeded`, with the crafted `wooden_pickaxe` in the final inventory. The first `decision.made` event in the trace carries a `plan` such as `collect 1 oak_log`, `craft 4 oak_planks`, and so on.

**Record:** the number of replans, the plan changes, and whether the crafting table was placed on a supported block.

## 5. Dropped food: pickup, then eat

Lower the agent's hunger first, for example `/effect give GameMind minecraft:hunger 60 4`, then wait until the food bar is at or below about 5. Keep the bread at `4 80 -4` (or re-summon it).

```bash
npm run dev -- --task secure-food --target-hunger 12 --explore-legs 8 --max-actions 24 \
  --host 127.0.0.1 --port 25565 --username GameMind
```

**Expected:** the actions include `pickup:bread` (skill `minecraft.pickup-item`) and then `restore-hunger` (`minecraft.eat-food`). Each has `"verification": "verified"`, and `metrics.foodSourcesUsed` is at least 1.

**Record:** whether walking onto the item cell picked it up automatically (`confirmation: dropped_item_entered_inventory_delta_checked`), and the time taken.

## 6. Ripe berries and harvest

Remove the bread (`/clear GameMind minecraft:bread` or let it be eaten). Keep the bush at `-10 80 6`. Lower hunger as in §5, then:

```bash
npm run dev -- --task secure-food --target-hunger 8 --explore-legs 8 --max-actions 24 \
  --host 127.0.0.1 --port 25565 --username GameMind
```

**Expected:** `harvest:sweet_berry_bush` (skill `minecraft.harvest-berries`) confirms with `berriesAfter > berriesBefore`, and the bush's `age` in `details` drops to 1. An unripe bush (`age=1`) must never be harvested; check that the agent skips it.

**Record:** `details.ageBefore`, `details.ageAfter`, and `berriesAfter - berriesBefore`. If `activateBlock` on a ripe bush gives no berries on this server, the adapter will report `ACTION_NOT_CONFIRMED` and the target is excluded; record that as a failure.

## 7. Rest and threat interruption

**Rest (natural regeneration):** lower health with a short damage effect (for example `/effect give GameMind minecraft:instant_damage 1 1`), keep food at 18 or more, and run a gather task:

```bash
npm run dev -- --task gather-logs --count 1 --host 127.0.0.1 --port 25565 --username GameMind
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

**Setup:** start an authorized server and run the agent with the dashboard:

```bash
npm run dev -- --task gather-logs --host 127.0.0.1 --port 25565 --username GameMind --control-center
```

Open the printed URL (`http://127.0.0.1:8787/`) on the same machine. Then check, in order:

1. The header shows `minecraft-java · seq N` with N increasing while the run is live, and the world panel shows your real position, health, hunger and inventory — not the values from any previous run.
2. The Current decision panel shows the goal that is actually running. Open "Alternatives considered": rejections must name a real reason (`combat is not enabled for this run…`, `target excluded after repeated failure`, `danger radius around the target`, …).
3. Press **Pause** mid-run. The next action must be denied with `RUN_PAUSED` and appear under "Failures and refusals"; the agent must keep observing. **Resume** continues it.
4. Press **Trip**, then **Stop task**. The run must end as `aborted` / `OPERATOR_STOP` after the action in flight, never in the middle of one.
5. Start a task from the dashboard (`mine-stone`, count 2). It must go through the same limits as the CLI; `Actions` counts up and the map highlights the target block class when it is observed.
6. Reload the page: the token comes from the served page, so the controls keep working; `POST /api/command` from a terminal without the header must return `403`, and an unknown command `501`.

**Record:** any panel that stayed empty while the CLI log showed the event, and every control that reported success without a matching trace line. The dashboard is verified against a live agent by `test/control-center.test.ts`; this section verifies it against Minecraft.

## 11. Experience memory across two runs

**Setup:** keep the default learning directory, and run the same task twice against the same world:

```bash
npm run dev -- --policy status
npm run dev -- --task gather-logs --resource oak_log --host 127.0.0.1 --username GameMind
npm run dev -- --policy status
npm run dev -- --task gather-logs --resource oak_log --host 127.0.0.1 --username GameMind
```

**Expected:** after the first run, `episodes` equals the number of attempted actions and a `data/learning/` directory exists. If the first run blocked on a target (unreachable log, no tool, full inventory), the second run must not spend its budget on that same target: `wastedActions` in the second `task-report` is lower, and the dashboard's Learning panel lists the target as blocked. `activePolicy` stays `null` until you promote something.

**Record:** the two `wastedActions` figures and `learning.blockedTargets` from the trace. If the second run repeats the first run's failures verbatim, the world key or the memory read is broken — that is a defect, not a flaky test.

## 12. Combat opt-in (only where fighting is allowed by the server rules)

**Setup:** on a test world with mobs, first run **without** the flag:

```bash
npm run dev -- --task secure-food --target-hunger 6 --max-actions 20 --host 127.0.0.1 --username GameMind
```

Summon a zombie next to you. **Expected:** no `attack_hostile` action; the agent flees, and the decision trace records the rejection `combat is not enabled for this run, so the agent flees instead of attacking`.

Then run with `--allow-combat` (this arms the adapter, the safety policy and the planner together), or press the dashboard's Combat switch **before** starting the task. **Expected:** with a weapon in hand and the hostile within range, `attack-hostile` runs, each hit is confirmed by the mob's observed health, and the action stops when the target dies or flees; without a weapon the agent equips one first or keeps fleeing. `metrics.combatActions` counts the attacks; `unsafeActions` must stay 0.

**Record:** the weapon you held, the damage sequence in the trace, and whether any attack happened while the mob was outside the task's danger radius.

## 13. Mining and shelter

```bash
npm run dev -- --task mine-stone --resource stone --count 4 --max-actions 30 --host 127.0.0.1 --username GameMind --allow-combat
npm run dev -- --task mine-stone --resource coal_ore --count 2 --host 127.0.0.1 --username GameMind
```

**Expected for a bare hand:** no dig is attempted on stone; the agent crafts or equips a pickaxe first (`equip:pickaxe` appears in the plan), and only then digs. A dig that would drop nothing is refused by name — `TOOL_REQUIRED` with no pickaxe at all, `TOOL_TIER_INSUFFICIENT` when the best pickaxe is below the block's minimum tier (`iron_ore` and above need stone tier), `BLOCK_NOT_MINEABLE_CLASS` for a block outside the mineable classes.

For shelter, place the agent somewhere open and check that `build-shelter` only uses blocks counted in the inventory, reports `no-support` for an observed non-solid side and `unknown` for an unobserved one, and that the four cardinal sides are closed in the next observation.

**Record:** the dig durations versus Mineflayer's own estimate (a systematic underestimate means the dig timeout slack needs raising), and whether the drop appeared within the settle window.

## 14. Death and respawn recovery

Use only a disposable world. With `MINECRAFT_AUTO_RESPAWN` unset (default `true`), begin a bounded task that takes long enough to remain active, then run `/kill GameMind` from the server console while the task is in progress. Repeat with `MINECRAFT_AUTO_RESPAWN=false` if you want to verify the disabled path; leave the player dead for the wait window, or manually respawn it if your test harness can send the vanilla respawn request.

**Expected with auto-respawn enabled:** the Mineflayer health plugin sends its respawn request, the adapter observes the player alive again, and the task loop re-observes/replans. The trace contains `player.death`, `metrics.deathsObserved` is at least 1, and `metrics.respawnRecoveries` is at least 1 if the player becomes alive before the budget ends. No world-changing action may be issued while the observed player state is dead.

**Expected with auto-respawn disabled:** the adapter does not request a respawn on death. Unless a respawn is sent externally, the runner waits without acting and stops with `RESPAWN_TIMEOUT` after 30 seconds or `TASK_DEADLINE` if the task budget expires first. Disconnect and operator stop should also terminate the wait explicitly.

**Record:** the environment setting, death and respawn trace timestamps, terminal status/failure code, recovery metrics, and confirmation that no action began while dead. This check has not been executed against a live server; simulated death/recovery tests are not live evidence.

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
| Does the experience memory change a second live run in the same world? | §11 | Unverified |
| Does Mineflayer auto-respawn by default, and does the task runner wait action-free until alive? | §14 | Unverified |

Only mark a row verified when the check was run against a server and the evidence is recorded in your notes.
