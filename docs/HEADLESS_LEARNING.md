# Headless learning: audit, experiment, and what it does and does not show

Scope: the offline simulator only. Nothing in this document is a live Minecraft result.

## 1. Audit: what the training pipeline actually does

| Stage | What happens | Learns? |
|---|---|---|
| Observation → decision | `MinecraftTaskDecisionModel.decide` ranks candidates by a fixed score, then multiplies each *learnable* candidate by a learned multiplier from `PolicyAdvisor` (`rankCandidates`). | Only the multiplier is learned. |
| Action → experience | Every attempted action is recorded as an episode (`experience/episodes.jsonl`) with features and outcome. | Yes, as data. |
| Reward | `computeReward` is computed and totalled per episode. | **The reward is not used in the weight update.** |
| Policy update | `derivePolicyWeights` sets each context's weight from a shrunk success rate, clamped to [0.75, 1.25]. Contexts need ≥ 8 attempts. | A count-based table, not gradient optimisation. |
| Exploration | None before this change. The policy is greedy, so it only ever sees the option it prefers. | **Missing**, so it cannot learn that an alternative would have been better. |
| Checkpoint | Stores the weights with a SHA-256 digest; verified on load. | Persistence and integrity. |
| Evaluation | Baseline (no weights) and checkpoint on the same disjoint held-out seeds, through a gate. | Independent measurement. |

**Conclusion of the audit:** before this change the system could change its parameters, but it could not discover better choices, and its scripted curriculum offers almost no choices to discover. Its earlier "learning" claims were not supported by held-out evidence.

## 2. What was added

- `src/games/minecraft/training-exploration.ts`: seeded exploration. With probability ε, an eligible progress-band decision is switched to another progress-band alternative. Never a safety-band decision, never into a fight, deterministic per (seed, observation sequence), and every switch is recorded on the decision trace as `exploration`.
- `src/training/trainer.ts`: `explorationRate` option (default 0, so existing runs are unchanged). `--explore RATE` on `npm run train`.
- `src/training/experiment.ts` and `npm run train:experiment`: one reproducible experiment into a *new* directory under `data/experiments/`. It records per-episode reward, outcome and exploration count; measures parameter change against the untrained baseline; runs the held-out gate; and compares the chosen goal sequence of the trained and baseline policies on every held-out scenario and seed. Existing directories are refused, never overwritten.

## 3. Results (simulator, offline; 10 held-out seeds, 26 scenarios, 260 runs per comparison)

| Arm | Episodes | Env steps | Explorations | Weight entries changed (max Δ) | Held-out success base → trained | Runs with different goal sequence | Verdict |
|---|---|---|---|---|---|---|---|
| Exploration ε = 0.2 (`explore-0.2-run1`) | 60 | 250 | **0** | 11 of 11 (0.25) | 73.5% → 73.5% | 10 / 260 (3.8%) | not promotable |
| Greedy control (`greedy-control-run1`) | 60 | 250 | 0 | 11 of 11 (0.25) | 73.5% → 73.5% | 10 / 260 (3.8%) | not promotable |

Training throughput: about 52 episodes/s and 216 env steps/s on this sandbox (wall time 1.2 s). Checkpoints were all `verified`.

Per-episode reward rose from a first-quartile mean of 0.93 to a last-quartile mean of 2.80. **This is not evidence of learning**: the curriculum changes difficulty across stages, so the rise is confounded with the scenario mix, and the success rate was flat (0.8 → 0.8).

### Diagnostic: why exploration fired zero times (root cause found and fixed)

Measured on the simulator (`26 scenarios × 2 seeds`, progress-band decisions only):

| Build | Progress decisions | Decisions with an eligible alternative | Switches at ε = 0.2 | Switches at ε = 1 |
|---|---|---|---|---|
| Before fix | 149 | **2** | 0 | 3 (earlier diagnostic, 3 seeds) |
| After fix | 149 | **26** | 2 | 24 |

**Cause (code defect):** `exploreDecision` excluded every alternative whose `goalId` equalled the selected goal. Every block target of one resource shares a goal id (`collect:oak_log`, `mine:stone`), so each same-resource alternative was discarded. The real choice is the `(goal, target)` pair. The fix compares that pair; a regression test covers it (`test/training-exploration.test.ts`).

**Structural limit (not fixed):** 120 of the 149 progress decisions still have **no** alternative at all. Those decisions come from single-candidate branches (`record(null, x, [], …)`: inventory, pickup, exploration, shelter, flee). Exploration can only act where the planner ranks several candidates (gather and mine targets). This is a candidate for the further-improvement list.

### Results after the fix (held-out, paired, same seeds and scenarios)

Training: `npm run train:experiment -- --name NAME --out DIR --seeds 10 --explore RATE` (writes to `DIR`, never to the repo `data/`). The paired comparison was made with a temporary script that is **not committed**: it loads the checkpoint, runs each scenario and seed twice (no learner weights; then the checkpoint weights promoted into a fresh in-memory learner), and compares the paired results. 10 seeds × 26 scenarios = 260 paired runs.

| Training ε | Explorations during training | Held-out success base → trained | Mean progress base → trained | Deaths | Unsafe actions | Mean reward per run base → trained | Runs whose target choice differs | Runs whose outcome differs | Experiment verdict |
|---|---|---|---|---|---|---|---|---|---|
| 0.2 (default) | 2 | 73.5% → 73.5% | 0.786 → 0.786 | 0 → 0 | 0 → 0 | 1.933 → 1.933 | 10 / 260 (3.8%) | 0 | not promotable |
| 0.5 | 6 | 73.5% → 73.5% | 0.786 → 0.786 | 0 → 0 | 0 → 0 | 1.933 → 1.933 | 10 / 260 (3.8%) | 0 | not promotable |
| 1.0 | 17 | 73.5% → 73.5% | 0.786 → 0.786 | 0 → 0 | 0 → 0 | 1.933 → 1.933 | 10 / 260 (3.8%) | 0 | not promotable |

Notes:
- All three trained checkpoints changed 7 weight entries (max |Δ| 0.25). Training ran 36 episodes; the curriculum stops there regardless of ε.
- Trained and baseline policies differ on a few target choices (10 / 260), but never in outcome, progress, deaths, unsafe actions, or reward. The weights are multiplicative on candidate scores, so they reorder only near-equal candidates in these scenarios.
- The per-episode reward rise during training (first-quartile mean 1.08 → last-quartile 2.43) is confounded with the curriculum's scenario mix. It is not evidence of learning.

### Reward does not feed the weight update (code audit)

`derivePolicyWeights(stats, options)` takes only skill statistics (attempts, successes via `conservativeSuccessRate`, contradicted confirmations). `computeReward` output is accumulated into running means and an EWMA that are reported in the snapshot, but they never enter the weight calculation. So the reward signal does not influence learning updates. Making reward part of the update is a design change, listed in the further-improvements report, and was not made here.

### Interpretation (negative / inconclusive)

- The parameters **do** change during training, and the change **does** alter chosen goals on a few held-out runs (10/260). That shows the learned multiplier is wired into decisions.
- It does **not** change held-out success, and the gate correctly refuses to promote it.
- **No evidence of improved policy performance was obtained** across ε = 0.2, 0.5, and 1.0, 10 held-out seeds, and 26 scenarios. The experiment is inconclusive for learning, and negative for any claim that the current curriculum trains a better policy.

## 4. What is still missing for a real learning demonstration

1. **Choice-point scenarios.** The simulator needs worlds where two progress options have different cost and risk (e.g. a nearer resource behind a hostile versus a farther safe one), held out from training. Without these, no learner can show improvement.
2. **Reward in the update.** `derivePolicyWeights` uses success counts only; the per-episode reward should enter the update, with the same held-out gate.
3. **A stage-matched control.** The reward trend must be compared against a control trained on the same stage sequence, not read across stages.

## 5. Reproduce (offline, no server)

```bash
npm run train:experiment -- --name my-run --episodes-per-stage 20 --max-episodes 400 --explore 0.2 --seeds 10
npm run train:experiment -- --name my-control --episodes-per-stage 20 --max-episodes 400 --explore 0 --seeds 10
```

Outputs: `data/experiments/<name>/manifest.json` (config, git commit, parameter change, held-out verdict, behaviour comparison) and `episodes.jsonl` (per-episode reward, outcome, explorations). `data/` is gitignored.

## 6. Live verification

Not performed. The server at `127.0.0.1:61889` refused connections from the execution environment (`ECONNREFUSED`), and Docker and Java are unavailable here. See `docs/LIVE_VERIFICATION.md`, §16, for the exact commands and what each phase covers.
