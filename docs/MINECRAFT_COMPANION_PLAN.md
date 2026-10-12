# GameMind Minecraft Companion — Living Product Plan

**Living source of agreed scope and decisions.** Update this file when the user makes or changes a product decision. Preserve the distinction between implemented, planned, deferred, and verified. Do not treat a plan in this document as permission to act in a live Minecraft world.

**Last updated:** 12 October 2026  
**Current mode:** the implementation-end offline audit completed on 12 October 2026. Build, full test suites, public typecheck, launcher checks, safe preflight, and the 520-run offline evaluation passed; `/gamemind help` was explicitly tested and a slash-prefix parsing bug was fixed before rerunning validation. No live Minecraft connection or world change occurred. Any live use still requires separate explicit approval.

## 1. Product direction

GameMind should become a safe Minecraft companion that can understand the configured operator, discuss a request, form an understandable plan, and—only when separately enabled and approved—carry it out within strict bounds.

The product should have its own deterministic orchestration, planning, validation, and safety logic. A local language model may help with lightweight natural-language conversation and intent routing, but must not directly issue Minecraft actions or make unvalidated block-placement decisions.

## 2. Decisions confirmed by the user

- Chat commands must be accepted only from the **exact configured Minecraft player name**. The code setting is `MINECRAFT_OPERATOR`; its value has not been supplied/configured here. Never trust arbitrary chat users.
- The user wants a **small Ollama model under 1 billion parameters** for lightweight replies and command navigation, in **English and German only**. The chosen first candidate is `qwen3:0.6b`; the user has an NVIDIA RTX 4060 Ti with 8 GB VRAM. The Ollama service may be installed on Windows, WSL, or both; the active endpoint is not yet confirmed.
- This implementation and audit remained **offline with respect to Minecraft**: no live world was connected to, and no blocks, materials, inventory, or other live state were changed. Offline validation is complete; further live use still needs separate explicit approval.
- The eventual goal may include building from a Litematica schematic, but only after a future explicit implementation/operation decision and operator confirmation.
- If an eventual builder sees the active Litematica placement move or rotate, the previous approval must become invalid and the new placement must be confirmed before continuing. Confirm once per placement/transform, not once per block, unless the user later requests finer-grained approvals.
- The eventual builder should work only inside the schematic's bounded area. Skip blocks that already match. Never silently break or replace an existing/unknown block; stop and ask when a target cell is blocked or unsafe.
- The user wants a **large, attractive house**, not just the existing fixed 5×5 prototype. No final style, floor plan, or dimensions have been chosen. Offer concepts/options rather than forcing the user to invent all details.
- Do not add optional rooms, furnishings, landscaping, or other extras without asking first. If material gathering is ever proposed, ask separately before gathering; listing estimated materials in a plan is fine.
- The user uses Windows and runs GameMind through an Ubuntu WSL terminal. Minecraft is currently Java 1.20.4; the user expects to use the Modrinth App and Fabric API. The exact Fabric profile and matching Litematica/MaLiLib versions are not yet confirmed.
- The user has seen Arena messages arrive to the assistant without appearing in their UI and may resend them. Before acting on a repeated coding request, inspect the current workspace/diff and apply only missing changes. This repository cannot fix Arena's message-display/delivery behavior.
- GUI training and training-benchmarking are out of scope. Chat and terminal remain the primary operator surfaces; the dashboard is optional. No new terminal task-submission interface was requested for house/farm projects.

## 3. Current scope and implementation snapshot

The implementation-end offline audit completed on 12 October 2026: `npm test` passed (952 Node tests plus 1 Vitest integration test), `npm run build`, `npm run typecheck:public`, all 50 Python launcher tests, and `python3 main.py --check` passed. `npm run eval:offline` passed all scenario gates across 520 runs with zero unsafe actions, unverified confirmations, or deaths. Its policy-ranking check was skipped because no weighted candidate existed. Nothing in this session was connected to a live Minecraft world:

- **Excavation:** bounded to at most 10×10×10 cells, with an approval step and safety checks. Explicit coordinates use the specified top face; “here” uses the captured position.
- **House prototype and large-house plans:** the fixed 5×5 starter-house remains a separately confirmed prototype with a second material-gathering approval. Offline deterministic plans A/B/C now produce bounded relative block cells, room labels, material estimates, and per-layer counts; `plan house A|B|C` previews one in chat, `--house-plan A|B|C` prints a summary, and `--house-plan-json PATH` exports the complete block plan. These plans never inspect or modify a world and are not a build executor.
- **Wheat planting:** at most 25×50 cells; requires enough seeds and existing hydrated farmland. It does not till soil or place irrigation. The adapter rechecks overworld/survival mode after internal approach navigation, as well as the target soil/crop and nearby hostile state, before planting; these checks are covered offline, not live-verified.
- **Chat path:** a finite English/German command grammar, exact-username filtering, short duplicate suppression, project confirmation, and an optional bounded Ollama conversation helper are in code. Chat is disabled unless `MINECRAFT_OPERATOR` is set to the exact in-game name. Ollama never chooses actions, coordinates, or approval outcomes.
- **Controls:** status, stop, hold/stay, follow, and come commands are recognized. Priority controls bypass the serialized command/model queue. Stop during an atomic operation remains bounded by the underlying skill's cancellation support.
- **House safety:** a generic “build house” request no longer silently selects the fixed 5×5 prototype. “Build starter house at X Y Z” names its lower corner; without coordinates the prototype is centered on the fresh position measured when chat arrives. It starts only after a project confirmation, followed by a separate yes/no permission for collecting up to 20 visible oak logs within the adapter's 24-block resource-gather limit. Declining collection restricts the run to carried materials; the runner fails before construction if they are insufficient. The larger-house planner now offers deterministic A/B/C previews and optional JSON export, but those plans are relative, planning-only, and do not authorize construction. See [`LARGE_HOUSE_CONCEPTS.md`](LARGE_HOUSE_CONCEPTS.md).
- **Litematica P1:** `--litematic-plan PATH` imports a bounded `.litematic` offline and prints dimensions, regions, material totals, and a SHA-256; `--litematic-layer Y` optionally renders a selected normalized layer. A protocol-v1, loopback-by-default receiver and exact-placement review guard are implemented; `docs/LITEMATICA_BRIDGE_PROTOCOL.md` documents them. The terminal `confirm <fingerprint>` records review only and cannot build.
- **Still missing or deferred:** no Fabric/Litematica client sender, live world diff, `.litematic` export from generated house plans, or Litematica build executor exists. The exact Modrinth/Fabric/Litematica/MaLiLib versions and Windows/WSL networking mode remain unknown, so client compatibility cannot yet be claimed. The large-house plans remain relative previews and do not authorize a build. The README and setup docs document these limits.

**Important:** The offline audit passed, but this is not proof of live behavior. Do not claim Java 1.20.4, Fabric/Modrinth, Windows/WSL, real-browser, or Ollama-endpoint compatibility; no live Minecraft verification occurred.

## 4. Ollama recommendation

Start with:

```sh
ollama pull qwen3:0.6b
```

Role of this model:

- answer brief, ordinary English or German chat questions and explain the deterministic command vocabulary;
- return only a short conversational reply, or no reply so GameMind can use its deterministic fallback; it does not classify intents, choose tasks, or route commands;
- never set coordinates, choose arbitrary blocks, bypass the allowlist/approval rules, grant approval, claim to perform an action, or call Minecraft skills directly.

The deterministic command parser and safety layer remain authoritative. The 0.6B model is deliberately small and may be unreliable with nuanced German, complex plans, or structured spatial reasoning; fail closed and ask rather than guess. An optional reply-only connector now defaults to `http://127.0.0.1:11434`, model `qwen3:0.6b`, a 1.8-second timeout, and `GAMEMIND_OLLAMA_URL` / `GAMEMIND_OLLAMA_MODEL` overrides. No model has been downloaded, no endpoint location has been confirmed, and no live chat request has been run. If Ollama runs on Windows instead of WSL, verify the actual WSL-reachable address before setting the override.

## 5. Litematica direction

Litematica is a client-side schematic mod. Its upstream repository describes it as a client-side mod and notes Fabric ports for newer Minecraft versions: <https://github.com/maruohon/litematica>. The `.litematic` format is its own schematic format: <https://github.com/maruohon/litematica/discussions/332>.

A schematic import/export is feasible as a **blueprint/preview workflow**, but a static `.litematic` file alone does not give a separate GameMind process reliable live knowledge of the currently moved/rotated placement. The likely future design is:

1. Parse a `.litematic` into a normalized, versioned blueprint: regions, relative block positions/states, dimensions, palette, and material totals.
2. Add a small, version-matched Fabric client bridge that reads the active Litematica placement and reports its schematic identity/hash, world/dimension, origin, rotation/mirror, enabled regions, and bounding box to GameMind over a local authenticated interface. If this is impractical for the selected Litematica version, fall back to explicit manual origin/rotation confirmation.
3. Compare the blueprint only with the reported bounded world area. Report matching blocks, cells that would need placement, obstructions, unknown cells, entities, and estimated materials.
4. Bind any future approval to the exact schematic hash, world, transform, and bounding box. A move, rotation, changed region, changed schematic, disconnect, or unsafe world change invalidates approval and stops the job.
5. Only after a future explicit go-ahead, consider placement execution. Never silently replace blocks or build outside the approved schematic bounds.

Because GameMind currently runs in WSL and the Minecraft client is expected to run through the Windows Modrinth App, the bridge must be local-only, authenticated, and designed for the Windows/WSL boundary. Do not expose it to the public network. Exact Minecraft/Fabric/Litematica/MaLiLib compatibility remains to be determined.

## 6. Larger-house planning goal

[`LARGE_HOUSE_CONCEPTS.md`](LARGE_HOUSE_CONCEPTS.md) documents three non-binding directions, and the code now generates a bounded relative block/material plan for each. `plan house A|B|C` and the offline `--house-plan` command only preview/export a design; they do not choose a site or build. Before any future execution, the selected plan still needs operator review for exact footprint, palette, orientation, site fit, and omitted/optional features. The generated planner currently provides room labels, openings, two floor levels, material totals, and per-Y counts, but has no world fit-check, renderer, or `.litematic` export.

A future plan revision/build flow should provide:

- exact site/footprint assumptions and world-space bounding dimensions;
- reviewed floor-by-floor layout, room purposes, doors, windows, roof, foundation, stairs, and circulation;
- optional features separately approved (for example balcony, cellar, workshop, storage, garden, or decoration);
- a verified block palette and material estimate;
- reviewed build/placement order, per-layer views, and ideally `.litematic` export;
- a separate explicit material-gathering approval and a separately confirmed, bounded build workflow.

Do not silently select a style, add optional features, gather resources, terraform, or demolish existing blocks. Ask only for decisions that materially change the proposal; offer sensible defaults and visual variants where the user is unsure.

## 7. Roadmap

### P0 — planning foundation (current)

- Keep this document current.
- The optional small-model connector, exact-operator gate, and duplicate suppression passed offline tests. Confirm where Ollama runs before use; do not silently change the default endpoint. The 520-run offline evaluator passed scenario gates, but skipped policy-ranking evaluation because no weighted candidate was present.
- The Modrinth/Fabric/Litematica/MaLiLib profile is still unconfirmed.
- README/setup reconciliation is complete. Large-house concepts A/B/C now generate offline relative block plans with material and layer summaries. Offline `.litematic` import/summary and the plan-only bridge receiver passed offline tests; they are not live-verified.
- No live Minecraft behavior was exercised. Any later connection or world-changing use needs separate explicit approval.

### P1 — Litematica plan import and preview (partial implementation)

- **Implemented; offline-tested, not live-verified:** `--litematic-plan PATH` reads a bounded `.litematic`, normalizes signed/multi-region bounds, decodes the packed block-state palette, reports dimensions/material totals/source SHA-256, and rejects malformed or conflicting data.
- **Partially implemented:** generated house plans include per-Y totals; imported `.litematic` files can render one selected Y layer as a bounded ASCII map. Generated house plans do not yet render a per-block map. No blueprint-to-world geometric diff or GameMind-to-Litematica export path exists.
- Report intended origin/rotation explicitly in any future preview; no world changes.

### P2 — active placement tracking (receiver implemented; client integration pending)

- **Implemented; offline-tested, not live-verified:** a versioned HMAC-authenticated receiver protocol, short heartbeat lease, sequence/replay checks, exact blueprint hash/regions/dimensions binding, and a review guard that invalidates on transform/world/client changes. It binds to loopback by default and has no action endpoint. See `docs/LITEMATICA_BRIDGE_PROTOCOL.md`.
- The Windows Modrinth client sender is not implemented. Pin the user's exact Fabric/Litematica/MaLiLib versions before writing it; no live client connection has occurred.
- Terminal confirmation records plan review only, not permission to build. A future manual origin/rotation fallback remains an option if client integration is too fragile.

### P3 — optional Litematica building executor (not implemented; live use prohibited without separate approval)

- No placement executor exists. Do not imply that approval in the receiver can place blocks.
- Future execution must survey only the approved bounding area, compute the difference, skip correct blocks, and stop on obstructions/unknown state.
- Bind any future construction confirmation to the exact schematic hash, world, transform, and enabled region set; any move/rotation/world change invalidates it.
- Add progress checkpoints, high-priority stop, and safe pause/resume before larger builds. Material collection requires its own explicit permission; loading a schematic never authorizes it.

### P4 — additional building designs

- Add functional survival homes, workshops/storage, barns/stables, walls/gates, bridges, paths, towers, and eventually multi-building compounds.
- Keep each design bounded, costed, reviewable, and optional. Defer complex Redstone and unrestricted terraforming.

## 8. Implementation and final audit protocol

The user has authorized autonomous implementation and offline validation after the coding phase is complete.

### During implementation

- Implement useful in-scope features autonomously and update this brief when decisions or status change.
- Defer tests, builds, type checks, and other validation until the implementation end gate; the user has explicitly authorized those checks at that point.
- Do not connect to, place blocks in, or otherwise modify a live Minecraft world; that requires separate explicit approval.
- Keep user-facing operations bounded and confirmation-gated in code.

### End gate, after implementation is complete

1. Perform a systematic review of changed code and integration points across the repository.
2. Run appropriate offline tests, type checks, builds, Python tests, and safe simulations; do not perform live-world actions or live-server tests.
3. Record each reproducible bug, fix it, inspect directly related files/call sites, and rerun relevant offline checks. Continue until no known in-scope defect remains or a limitation is explicitly documented.
4. Do not claim that all possible bugs are gone; report exactly what was checked, what passed, and remaining uncertainty.
5. Deliver an operator report with exact setup/run commands for Ollama, GameMind from Python/WSL, the configured operator name, and the optional Litematica bridge.

No live Minecraft verification has been performed for the latest chat, house, excavation, or wheat-farm changes, and live-world verification remains out of scope without separate explicit approval.

## 9. Smoothness, responsiveness, and hazard detection (new priority)

The user's priority is a companion that feels responsive and fluid, does not stand around without explanation, and recognizes danger quickly. This remains a **design target**, not a verified current capability. Implement offline improvements in scope; validate them at the authorized implementation end gate. Do not execute actions in a live world without separate approval.

### Control-loop design

- Separate the system into priority tiers:
  1. **Safety interrupt:** lightweight and event-driven; never waits for Ollama, a full planner run, or a slow world scan.
  2. **Movement/action controller:** owns the single active movement/action sequence and responds to safety interrupts.
  3. **Task planner:** replans on meaningful events or task boundaries, not on every game tick.
  4. **Conversation/model layer:** runs asynchronously for ordinary chat and intent clarification; strict timeout and deterministic fallback.
- Keep the small Ollama model warm when configured, use concise prompts/outputs, and avoid calling it for every step. The deterministic parser handles safety-critical commands and known task vocabulary.
- Consume Mineflayer events and incremental state changes where available. Reuse fresh observations; do not repeatedly scan the whole environment or regenerate a full plan when a small local update is enough.
- Keep movement goals stable. Avoid resetting pathfinding every time a new observation arrives; update waypoints only when the target, path, or risk meaningfully changes. Use bounded navigation and explicit movement constraints.
- Serialize actions through one scheduler/action owner. Coalesce an identical chat request while its approval or task is pending/running, but allow the same legitimate request again after it has finished. This prevents duplicate placement plans without suppressing future commands.

### Safety response

- Monitor urgent changes such as health loss, nearby hostile entities, fire/lava, drowning/suffocation, falling/unsafe drops, changed or blocked route cells, disconnect/respawn, and world/dimension changes.
- Recheck hazards immediately before consequential actions as well as while navigating. Treat unknown or stale state as a reason to pause/reobserve, not as safe.
- On urgent danger: cancel queued work, stop pathfinding as soon as possible, set a high-priority stop flag, and prevent the next action. Propagate cancellation into an active skill wherever the underlying Mineflayer operation supports it; otherwise stop at the earliest safe action boundary and report that limitation. Do not claim an atomic server operation can always be interrupted mid-packet.
- Replan only once or a bounded number of times after a blockage. If there is no safe route, hold/stop and explain; never spin in a retry loop or repeatedly walk into the same obstruction.
- Combat remains disabled unless it has its separate explicit opt-in. A hazard response defaults to stopping or a verified safe retreat, not attacking.

### “No standing around” behavior

- Track task stage, intended waypoint/action, last confirmed progress, and reason for any wait.
- A watchdog distinguishes expected waits (server response, chunk load, required confirmation) from a stuck agent. On apparent stall: refresh only the relevant observation, try a bounded safe replan, then stop with a clear explanation if progress still cannot be confirmed.
- During a long task, send concise progress updates at phase changes or meaningful waits; avoid chat spam. Status must distinguish **moving**, **working**, **waiting for confirmation**, **replanning**, and **stopped for safety**.
- Never leave an active task indefinitely marked as working without either measurable progress, an explained wait, or a stop reason.

### Responsiveness measurements to define later

At the implementation end gate, validate offline and simulated behavior only; do not connect to a live world. Command-to-acknowledgement latency, hazard-event-to-stop latency, path-progress gaps, and false-positive hazard stops require later, separate live-environment approval. Agree on numeric targets before claiming “smooth” or “fast.” No performance or live-safety claim is made until those measurements are permitted and completed.

## 10. Multi-agent decision (deferred until single-agent reliability)

The user is considering two or four agents in one Minecraft world. Product recommendation: first make one agent reliable; then introduce a two-agent pilot, not four agents immediately. Four bots multiply pathfinding load, ambiguous chat routing, duplicate work, collision risk, and shared-world conflicts.

- Give each bot a stable, human-readable name and role (for example, `GameMind` as operator-facing coordinator and `Scout` as read-only surveyor). Do not route by changing numeric slot IDs such as `#agent 1` as the sole identity.
- A future command syntax may support `@GameMind ...` and `@Scout ...`. `@all` should initially be restricted to safe broadcasts such as status, hold, and emergency stop. Never broadcast build, excavation, farming, or resource-gathering tasks to every bot.
- Before two bots can act in one world, add a shared coordinator with task leases, target/region reservations, duplicate suppression, a single operator allowlist, shared hazard/stop state, and an audit trail. The existing per-agent task scheduler alone does not prove cross-agent coordination.
- Add agents three and four only after the two-agent pilot demonstrates stable ownership, collision avoidance, and measured performance in an authorized offline/test environment.

The user says they cannot reliably describe the current bugs. Do not require hand-written bug reports: the authorized final systematic audit is the mechanism for finding them. Record symptoms and reproduction evidence from the repository/offline checks, fix in-scope issues, inspect related call sites/files, and report residual uncertainty honestly.
