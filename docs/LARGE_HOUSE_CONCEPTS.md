# Large-house concept shortlist and generated plans

These are planning options, **not authorization to build**. The current fixed 5×5 starter-house prototype remains separate from the larger-house designs.

Three deterministic, relative block blueprints are now generated offline by `src/games/minecraft/house-blueprint.ts`:

- **A — Bavarian timber farmhouse:** 17×23×14 relative dimensions; timber frame, pale infill, stone base, stepped dark roof.
- **B — Modern courtyard house:** 21×19×12 relative dimensions, including a 5×5 open-to-sky courtyard; stone-and-wood palette and flat roof.
- **C — Alpine lodge:** 15×21×16 relative dimensions; stone lower level, spruce frame, compact glazing and steep stepped roof.

Each generated plan contains block-state cells relative to `(0,0,0)`, two-floor room labels, per-layer block totals, and material counts. Generate a preview and optional JSON block plan without connecting to Minecraft:

```bash
npm run dev -- --house-plan A
python3 main.py -- --house-plan A
npm run dev -- --house-plan B --house-plan-json ./blueprints/modern-courtyard.json
```

JSON export creates a new file and refuses to overwrite an existing one. A plan is for review only: it does not inspect a Minecraft world, assert structural correctness, select a world origin/orientation, gather materials, or place blocks. The site is assumed flat and already cleared. Review openings, stair geometry, exact placement, and material availability before any future build workflow.

Optional rooms and features remain excluded until separately requested. Examples include cellar, balcony, detached barn, garden, chimney, terrace, pool, garage, furnishings, workshop and landscaping. Do not terraform, remove trees, gather materials, or place blocks as part of choosing a concept. Material gathering and any actual construction require separate explicit approval.

The chat command `plan house A`, `plan house B`, or `plan house C` returns a concise plan-only preview. A generic `build house` request never silently chooses one of these designs or begins a build.
