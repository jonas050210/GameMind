# RL Readiness Assessment

This document describes the criteria that must be met before introducing reinforcement learning (RL) to GameMind. The assessment is available programmatically via `assessRLReadiness()` in `src/core/learning/rl-readiness.ts`.

## Current Status

Run the assessment:
```typescript
import { assessRLReadiness } from "./src/core/learning/rl-readiness.js";
const assessment = assessRLReadiness();
console.log(`Score: ${assessment.score}/${assessment.maxScore}`);
console.log("Ready:", assessment.ready);
console.log("Blockers:", assessment.blockers);
```

## Criteria

| Criterion | Weight | Status | Rationale |
|---|---|---|---|
| Continuous state representation | 15 | ✓ Met | `episode-extended.ts` provides continuous distances, inventory state, equipment tiers |
| Action parameterisation | 10 | ✗ Unmet | Skills have continuous params but no probability distribution π(a\|s) |
| Reward function | 15 | ✓ Met | `reward.ts` provides multi-objective reward with anti-exploitation design |
| Reward validation | 10 | ✗ Unmet | Reward function is untested against real gameplay data |
| Fast training environment | 20 | ✗ Unmet | Simulator too simple for transfer; Mineflayer too slow (single client) |
| Sim-to-real transfer evidence | 15 | ✗ Unmet | No live testing infrastructure validated against real Minecraft |
| Live Minecraft testing | 10 | ✗ Unmet | Docker-based test infrastructure exists but not yet validated |
| Safety broker integration | 5 | ✓ Met | Safety broker is external to any policy — learned components cannot bypass it |

**Current Score: 35/100**

## What Must Be True Before RL

### 1. Fast Training Environment (Critical — 20 points)

**Problem:** Mineflayer connects one client to one server. At ~1 step/second, training requires weeks. The simulator is too simplified (2D grid, no crafting grid, no 3D terrain) for learned policies to transfer.

**Required:** An environment that can execute ≥10,000 steps/second with faithful Minecraft mechanics. Options:
- Custom Rust/C++ server stub implementing the protocol subset the agent needs
- Significantly enhanced simulator with 3D terrain, full crafting, storage
- Parallel Mineflayer instances (limited by server capacity)

### 2. Sim-to-Real Transfer Evidence (Critical — 15 points)

**Problem:** Even with a fast environment, policies trained there must work in real Minecraft. The current simulator has enormous gaps (no 3D, no crafting grid, no chest interfaces, no biomes).

**Required:** Demonstrated evidence that at least one learned component trained in the simulator performs at least as well as the hand-tuned baseline in real Minecraft.

### 3. Reward Validation (Important — 10 points)

**Problem:** The reward function in `reward.ts` is designed based on reasoning about what "good" behavior looks like, but has not been validated against actual gameplay outcomes.

**Required:** At least 100 episodes of real Minecraft gameplay with computed rewards, validated by a human observer that high-reward episodes correspond to genuinely good decisions.

### 4. Action Probability Distribution (Important — 10 points)

**Problem:** The current system outputs discrete skill choices. RL needs a probability distribution over actions that can be optimized by gradient methods.

**Required:** An interface that maps observations to action probabilities, compatible with the existing `PolicyAdvisor` interface.

## What Is Already In Place

These components exist and are tested:

1. **Continuous state features** (`episode-extended.ts`): exact distances, inventory counts, equipment tiers, visible entities
2. **Reward function** (`reward.ts`): multi-objective (survival, progress, efficiency, safety, exploration) with component caps and anti-exploitation design
3. **Policy checkpoint system** (`checkpoint.ts`): immutable versioned policies, rollback, comparison
4. **Class-level failure memory** (`class-failure-memory.ts`): generalised failure patterns across targets
5. **Safety broker**: external to any policy — a learned component cannot bypass safety checks
6. **Evaluation harness**: scenario-based evaluation with held-out seeds, policy comparison
7. **Live testing infrastructure** (`testing/live/`): Docker-based real Minecraft server, test scenarios

## Path to RL

The recommended order of operations:

1. **Validate live testing** — Run the Docker server, confirm connection, observation, and basic actions work against real Minecraft
2. **Collect real gameplay data** — Run the agent on the real server with episode recording + reward computation
3. **Validate reward function** — Compare computed rewards against human judgement on real episodes
4. **Enhance simulator** — Add 3D terrain, full crafting grid, storage interfaces (only what the data shows is needed)
5. **Implement learned policy advisor** — A small neural network that replaces `PolicyAdvisor.assess()`, trained on collected data
6. **Evaluate learned vs. baseline** — Use the existing evaluation harness to compare on held-out scenarios
7. **Promote learned policy** — Only after the gate passes with safety + performance + reward criteria

## Measurable Criteria for RL Introduction

Before starting RL training, ALL of these must be true:

- [ ] Live Minecraft server runs automated tests (connection, observation, movement)
- [ ] ≥500 real gameplay episodes recorded with reward breakdowns
- [ ] Reward function validated: human agrees with ≥80% of "high reward = good decision" judgements
- [ ] Fast training environment exists (≥1000 steps/second on the same mechanics the agent uses)
- [ ] At least one simulator-to-real transfer demonstrated (sim-trained component works on real server)
- [ ] Safety broker confirmed to block any learned policy's unsafe outputs
- [ ] Evaluation harness can compare learned vs. baseline on the same scenarios
