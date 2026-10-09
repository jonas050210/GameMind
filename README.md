# GameMind

GameMind is a modular, observable game-agent runtime. The current implementation closes a small Minecraft loop: observe the world, choose a bounded goal, execute a validated skill, observe again, and replan. The wider architecture and roadmap are documented in [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md).

## Current implementation

- Minecraft Java through Mineflayer **4.39.0**, defaulting to protocol **1.20.4** (configurable).
- Structured observations for player state, inventory/equipment, nearby entities, and a capped local block sample. Unknown/unloaded blocks are not treated as empty.
- Strictly validated skills for looking, local block inspection, conservative navigation, observed overworld-log collection, equipment, allowlisted wood crafting, food consumption, and cautious crafting-table placement.
- Craft recipes are planned offline from a small explicit wood dependency set (planks, sticks, crafting tables, and wooden tools); the live adapter asks Mineflayer's version-specific registry for the actual recipe before crafting. Crafting/eating/placement report confirmed post-state changes rather than assuming success.
- Pathfinder **2.4.5**, CollectBlock **1.6.0**, and its Mineflayer Tool **1.2.0** dependency. The live adapter disables path digging, building/scaffolding, parkour and sprinting, limits drops to one block, and uses a bounded search radius plus a no-progress watchdog.
- A small priority/utility decision model. Visible nearby hostiles take priority over food and task progress; low hunger takes priority over crafting/gathering; critically low health or hunger with no validated recovery skill blocks further task progress. Resource targets near visible hostiles remain excluded. It chooses bounded flee/recovery routes and does not fight.
- A bounded task runner for gathering logs or crafting one wooden pickaxe. It verifies post-action observations, replans around failed targets/prerequisites, and tracks success/progress, resources spent, food gain, damage, errors, recovery, and runtime.
- Offline fake-adapter tests vary hunger, inventory, crafting-table access, hostile mobs, blocked routes, resources, action errors, and budgets. These tests validate the control logic only, not server behavior.

This remains a deliberately narrow, rule-based agent—not a full survival agent, RL system, LLM planner, or GUI. Crafting is limited to whitelisted wooden recipes; it does not mine stone/ores, acquire food from the world, fight, or handle every recipe/version. No real Minecraft server was available for these changes, so offline test success is **not** a claim of live-server compatibility.

## Requirements and checks

- Node.js 22 or newer.
- For live play: an authorized private/local Minecraft Java server that matches the configured protocol.

```bash
npm ci
npm run build
npm test
```

## Offline demos (no Minecraft server required)

```bash
npm run scenario:demo    # seeded look-skill roundtrip
npm run task:demo        # bounded fake gather-log task
npm run task:demo:craft  # fake wood → table → wooden-pickaxe task
```

The demos run against deterministic fake fixtures. The gather demo exercises collection; the craft demo starts with a small wood supply and exercises recipe prerequisites, crafting-table placement, a missing-log recovery, and wooden-pickaxe verification. They do not exercise a live Mineflayer connection. JSONL traces are written under `data/traces/` (ignored by Git).

## Live Minecraft

Start a private/local Java server first. To print one structured observation and shut down:

```bash
npm run dev -- --host 127.0.0.1 --port 25565 --username GameMind
```

To run the bounded gather task or wooden-pickaxe task:

```bash
npm run dev -- --task gather-logs --resource oak_log --count 1 \
  --host 127.0.0.1 --port 25565 --username GameMind

npm run dev -- --task craft-wooden-pickaxe \
  --host 127.0.0.1 --port 25565 --username GameMind
```

Tasks default to at most **12 actions** and **120 seconds**, limit target distance, stop after repeated failures, and replan from fresh observations. The craft task may gather nearby logs, craft planks/sticks/a crafting table, place the table on a locally observed safe support cell, and craft a wooden tool. It stops when prerequisites are missing or no safe placement/navigation choice remains. Nearby hostile mobs take priority; both the task model and adapter check hostile proximity before collection and placement. Entities can still move after a check, and Pathfinder entity avoidance is a weighted cost—not a hard safety barrier. Use a private test world, supervise live runs, and stop the process if behavior looks unsafe.

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

For an offline-mode server, keep `MINECRAFT_AUTH=offline`. Use Microsoft authentication only where appropriate. Do not put account credentials in command-line arguments, source control, logs, or traces; Mineflayer manages its own authentication flow/cache.

## Traces and tests

- `scenarios/minecraft-look-roundtrip.json` is the seeded orientation scenario.
- `data/traces/<session-id>.jsonl` stores ordered session, observation, decision, skill, action, and task events; sensitive-looking fields are redacted.
- Tests use offline fixtures and injected Mineflayer bot doubles. They verify program logic and mock interactions, **not** Minecraft server behavior, protocol compatibility, or plugin behavior in a live world.
