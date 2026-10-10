# Live-run findings: what failed, what changed, what is still unproven

Scope note, in one sentence: **nothing in this file has been verified against a live Minecraft server.**
Everything below is either (a) a cause established by reading Mineflayer 4.39.0's source, (b) a defect
reproduced offline against the built-in adapters, or (c) a fix proven by an offline regression test. The
failed live run has to be repeated (§0 and §2 of `LIVE_VERIFICATION.md`) before any of it is called fixed.

## 1. What the live report actually said, and what each line turned out to be

| Reported symptom | Real cause | Evidence class |
| --- | --- | --- |
| Dashboard/CLI says `blocked` with no reason | The task runner's blocked branch hard-coded `status = "blocked"` + `NO_FEASIBLE_GOAL`, and the UI printed only `failure.code`, dropping the message. Any planner refusal, capability gap, disconnect or observation gap looked identical. | read in `task-runner.ts`, `run-control.ts`, `app.js`; now covered by `test/control-center.test.ts` |
| `no overworld` | `dimension` is read from `bot.game.dimension`, which 1.20.4 may leave as `{}` until later packets, or fill with the *level name* (`world`, `World`) or a numeric id; the old check compared against the literal string `overworld` and treated anything else as "not overworld", then *blocked* on it. | Mineflayer `lib/plugins/game.js`; `normalizeDimension`/`readDimension` in `src/games/minecraft/live-session.ts`, `test/live-session.test.ts` |
| false Creative while playing Survival | Only `bot.game.gameMode` was consulted, and only after a `game_state_change` with reason 3. The second, more current source (`bot.player.gamemode`) was ignored, and a *missing* value was compared as if it were a claim. | Mineflayer `lib/plugins/game.js` + `lib/plugins/physics.js`; `readGameMode`, `test/live-session.test.ts` |
| Health/hunger/saturation not synced | `observation.player.health/food` were copied with defaults (`health ?? 20`, `food ?? 0`) in the adapter, the decision model and the run-control snapshot, so an unreported value was rendered as a healthy, well-fed player and used to *gate actions*. | `grep` for the defaults; now `readVitals` (`live-session.ts`), `test/minecraft-live-actions.test.ts` |
| Air/oxygen looked full always | The old code multiplied `bot.oxygenLevel` by 30 and defaulted to 300. This Mineflayer divides air supply by 15, so the ceiling is 20 ticks-of-level. | Mineflayer `lib/plugins/breath.js`; `airTicksFromSession`, `test/live-session.test.ts` |
| Movement/exploration "did nothing" | Not a single defect: (a) `collect-block` was invoked on targets the client could not see; (b) the navigate confirmation is *stricter* than the goal (`hypot` to block corner `+0.5` within `range + 1.25`, `|dy| <= 2`), so a successful walk could be scored as a failure; (c) inventory counts were only trusted from the last scan. | `minecraft-adapter.ts`, `task-runner.ts`; regression tests in `test/minecraft-live-actions.test.ts` |
| Inventory not updating | `inventoryFull` was `slots >= 27` while a player inventory is 36 (main + hotbar), and the snapshot merged the last non-empty inventory instead of the current one. | fixed in `observe()` / `run-control.ts`; `test/minecraft-live-actions.test.ts` |
| World view broken | Two independent causes: the panel was rendering *stale or simulated* blocks (the loop only ran when the world source changed, and never re-fetched), and `world-view.js` fitted its camera to the *farthest remembered* block, so everything collapsed onto the far plane and fog ate the scene. | `test/world-view.test.ts` (a headless WebGL probe asserts the projection, fit and fog), `test/control-center.test.ts` (the snapshot carries freshness and provenance, and the page has no `EventSource`) |
| Event stream | It was a re-send of the same snapshot on a timer, and one more way for the dashboard to look alive while nothing had changed. | removed; `GET /api/stream` now `410 STREAM_REMOVED`, `test/control-center.test.ts` asserts the page never opens it |
| Bot connects, then exits with `OBSERVATION_SCHEMA_INVALID` on `minableSightings[].visible` (and `nearbyBlocks[].visible`) | Mineflayer's `bot.canSeeBlock` ends with `raycastHit && raycastHit.position.equals(block.position)`. `prismarine-world`'s `raycast` returns `null` when the ray hits nothing, so the call returns `null`, not `false`. `observedBlockVisibility` only caught *throws*, so `null` reached `z.boolean().optional()` and failed the whole observation, which `connect()` runs before the Control Center starts. Fix: a completed ray test maps to a real boolean (`null` and blocked rays are `false`, an exception stays *unknown* and the field is omitted). The schema is unchanged and still rejects `null`. The error message now quotes the received value. | Mineflayer 4.39.0 `lib/plugins/blocks.js` `canSeeBlock`; prismarine-world `src/worldsync.js` `raycast`; `test/minecraft-live-actions.test.ts` ("line-of-sight ray that hits nothing"), reproduced red before the fix |

## 2. Changes that carry those causes

- **`src/core/failure-taxonomy.ts`** — one classifier for every code in the project (`kind`, `owner`,
  `hint`, `retryable`), so a safety refusal, a missing capability, a connection fault, a perception gap, a
  planner decline and a task failure are never drawn the same. The dashboard's blocker card, the CLI
  `task-report.classification` and the trace all read it. `test/failure-taxonomy.test.ts` scans the sources
  and fails on any code that is not classified, so a new refusal cannot arrive without a category.
- **`src/games/minecraft/live-session.ts`** — every session fact returns a `SessionField`
  (`verified` / `single-source` / `unreported` / `conflicting` plus the raw `observed` strings). This is what
  makes "we do not know" representable end to end, including in the decision record and the UI.
- **`src/games/minecraft/minecraft-adapter.ts`** — ten action gates now block only on a *verified* wrong
  value and otherwise proceed and record the uncertainty; `reportUnverifiedSessionFacts` puts the raw read
  into the log; `watchSession` re-observes on a real dimension/mode change; `parseMinecraftObservation`
  turns a schema failure into a message naming the path and the value instead of killing the observation.
- **`src/games/minecraft/decision-model.ts`** — gates read the `SessionField`s, refusal messages quote the
  evidence, and the three remaining default-substitutions (`health ?? 20` twice, `food ?? 0`) are gone; a
  task whose skills are not registered reports `capabilityGap`.
- **`src/games/minecraft/run-control.ts` + `src/control-center/*`** — the snapshot carries `blocker`,
  `world.provenance`, `world.freshness`, `world.sessionFacts`, per-block `source`, and
  `connection.statusReason`; the page polls, shows a freshness line (`live — observation #N (2s old)`),
  and the world panel re-reads through `observeIfStale` while the agent is idle.
- **`src/control-center/public/world-view.js`** — camera fitted to *current* observations only
  (`clamp(extent · 1.35 + 8, 12, 90)`), near/far derived from that distance, depth-based fog, and an explicit
  `data-live="0"` + `renderer=fallback` state instead of a silently wrong picture.
- **SSE removed** from `server.ts`, `types.ts`, `run-control.ts`, `attach-control-center.ts`, `app.js`,
  `index.html` and `styles.css`. Everything the stream carried is in the snapshot the poll reads.

## 3. What offline testing cannot close

- **Packet layout.** `minecraft-data('pc', '1.20.4')` resolves to `null` in this checkout and there is no
  `protocol.json`, so the exact 1.20.4 field names for the login/status packets are read from Mineflayer's
  source, not executed. `bot.game`, `bot.player.gamemode` and `bot.oxygenLevel` must be checked on a real
  server (§15).
- **Mineflayer behaviour itself.** Every adapter test here runs against mocks. A mock can only prove the
  adapter handles a shape; it cannot prove the shape. `test/minecraft-live-actions.test.ts` was rewritten so
  its mock matches this Mineflayer version (20-level oxygen, `bot.game`, `game.hardcore`, `emptySlotCount`),
  and the gate tests were checked to be non-vacuous by running them against a deliberately empty `bot.game` —
  but the server remains the only authority.
- **Task outcomes.** No offline test can show that gather-logs or secure-food *completes* in 1.20.4; the
  suites prove the refusal paths, the evidence strings and the state transitions.
- **Rendered pixels.** `test/world-view.test.ts` drives the real module against a recording WebGL stub, which
  proves projection, fit and fog math and the fallback path — not appearance in a browser.
- **Anything the operator changed in-game.** A mid-run `/gamemode`, a dimension change, a death, a kick, or a
  full inventory need a live run; §10 and §15 of `LIVE_VERIFICATION.md` are the checklists for them.

## 4. Re-running the live test that started this

```bash
npm run build && npm test         # 220 offline tests, all of them in the repo, no server needed
npm run dev -- --task gather-logs --resource oak_log --count 2 \
  --host 127.0.0.1 --port 25565 --username GameMind --version 1.20.4 --control-center
```

Then work through `LIVE_VERIFICATION.md` §2 (observation), §3 (gather + exploration), §10 (dashboard) and
§15 (session facts), and keep `data/traces/*.jsonl` for the run. If the panel and the trace disagree with
each other, that disagreement is the bug — the numbers themselves may be the server's honest answer.

## 5. Status of each defect after the live stand-in checks (2026-10-10)

Evidence is from a non-vanilla stand-in (flying-squid 1.12.0, protocol 1.20.4). It is not vanilla server evidence.

| # | Defect | Fix | Live status on the stand-in |
|---|---|---|---|
| 1 | Harness said `Reached: YES` when no server answered | `live-verifier.ts`: `reachedServer` only from `[server]` phases; `NOT RUN`; `[offline]` tags; bot ends and timers released | **Verified**: refused run → `Reached: NO`, exit 2; stand-in run → `Reached: YES` |
| 2 | Mine targets 6–24 blocks away failed at once with `BLOCK_NOT_DIGGABLE` (no walk) | pre-checks use `diggable` and `canHarvest`; reach is checked after the walk | **Verified**: dirt (16,5,0) from 6–8 blocks, confirmed in 3528 ms |
| 3 | Log 18 blocks away failed at once with `BLOCK_NOT_HARVESTABLE`; dropped log not picked up | walk, then dig, then walk onto the drop (`pickUpNearbyDrops`) | **Verified**: collect confirmed in 7648 ms; `gather-logs` exit 1 → 0 (with the caveat in LIVE_VERIFICATION §17) |
| 4 | Swim stopped with the feet still in water (`inWater` used the contracted physics flag) | feet and body block checks | **Verified**: exit to shore in 1306 ms, 13 steps |
| 5 | A navigate with an empty planner path resolved as OK without reaching the goal | rejects NoPath/Timeout on an empty path; confirmation by position | **Partly verified**: the empty-path start now gives `ACTION_NOT_CONFIRMED`. The original "OK, `confirmed=false`" did not reproduce on HEAD or on the fix, at any start tested |
| 6 | Exploration never fired during training (`goalId`-only eligibility) | compares goal and target | **Offline only**: switches 0 → 2 at ε=0.2, 24 at ε=1; held-out results unchanged (see HEADLESS_LEARNING §3) |

Not verified live: drowning (no air supply on the stand-in), combat (no client-visible mobs), and every behaviour on a vanilla server.
