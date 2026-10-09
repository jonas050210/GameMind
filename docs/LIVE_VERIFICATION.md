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

`online-mode=false` is only for a local private test; never expose such a server publicly. `view-distance=8` keeps chunks loaded for the 24-block resource scan.

Join once as `GameMind` (through the agent or a client), then run these commands as an operator in the server console or chat, substituting your own coordinates:

```text
/gamemode survival GameMind
/gamerule naturalRegeneration true
/gamerule doMobSpawning false          # first pass; enable for the threat checks in §7
/tp GameMind 0 80 0
/setblock 24 80 0 minecraft:oak_log    # a log outside the 3-block cube, inside the 24-block scan
/setblock -10 80 6 minecraft:sweet_berry_bush[age=3]   # ripe berries
/summon item 4 80 -4 {Item:{id:"minecraft:bread",Count:1b}}   # a dropped food item
```

Adjust `y` values to the ground level of your world (the grass surface is at y 63 in a flat world, so the agent stands at y 64). Confirm the blocks with `/data get block` or by looking.

## 2. Connection and wide observation

```bash
npm run dev -- --host 127.0.0.1 --port 25565 --username GameMind
```

**Expected:** a JSON `initial-observation` with `observation.state` containing `resourceScan` (`radius: 24`, `center` at the agent's block, `truncated: false`), `resourceSightings` including the log at `24 80 0` (when the agent is at about 0,0) and the berry bush with `properties.age: 3`, and `itemDrops` listing `bread` near `4,-4`.

**Record:** whether the log beyond the 3-block cube appears in `resourceSightings` (this tests `findBlocks` and chunk loading), whether the bush shows `properties.age`, and whether the bread appears in `itemDrops` (this tests `getDroppedItem`). Any of these being missing is a result to report, not a reason to change the thresholds.

## 3. Gather with exploration

Remove the nearby test log, leaving only the one at 24 blocks. Then:

```bash
npm run dev -- --task gather-logs --resource oak_log --count 1 --explore-legs 8 --max-actions 24 \
  --host 127.0.0.1 --port 25565 --username GameMind
```

**Expected:** `task-report` with `"status": "succeeded"`. The `actions` array shows either a direct `collect:oak_log` or an `approach:oak_log` followed by collection, and every action has `"verification": "verified"`.

**Record:** `metrics.explorationLegs`, `metrics.unverifiedConfirmations` (should be 0), `metrics.failedActions`, and any `failureCode` (for example `PATH_NOT_FOUND` from a waypoint across unloaded terrain). A failed waypoint should be excluded and replaced, not repeated.

## 4. Craft with exploration

Give the agent no logs (clear its inventory with `/clear GameMind`) and keep the 24-block log:

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

## Open questions this checklist answers

| Question | Check | Current status |
| --- | --- | --- |
| Does `findBlocks` return logs 20–24 blocks away in loaded chunks? | §2 | Unverified |
| Does `getDroppedItem()` return `bread` for item entities in 1.20.4? | §2, §5 | Unverified |
| Does `getProperties().age` report berry age on 1.20.4? | §2, §6 | Unverified |
| Does `activateBlock` on a ripe bush give berries and reset age? | §6 | Unverified |
| Does walking onto a dropped item pick it up? | §5 | Unverified |
| Does natural regeneration work at food ≥ 18 with the default rules? | §7 | Unverified |
| Do pathfinder errors arrive with `name` = `NoPath` / `Timeout` / `PathStopped`? | §3 (unreachable waypoint) | Unverified |
| Is `sweet_berry_bush` respected by `blocksToAvoid` in path planning? | §6 | Unverified |

Only mark a row verified when the check was run against a server and the evidence is recorded in your notes.
