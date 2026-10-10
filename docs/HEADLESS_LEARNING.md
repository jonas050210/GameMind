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

### Diagnostic: why exploration fired zero times

Forcing ε = 1 on every evaluation scenario with three seeds produced **3 switches in total**, all in one scenario (`mine-pickup-cobblestone`). The simulated worlds almost never offer two competing progress-band options, so there is almost nothing for exploration or learning to act on.

### Interpretation (negative / inconclusive)

- The parameters **do** change during training, and the change **does** alter chosen goals on a few held-out runs (10/260). That shows the learned multiplier is wired into decisions.
- It does **not** change held-out success, and the gate correctly refuses to promote it.
- **No evidence of improved policy performance was obtained.** The experiment is inconclusive for learning, and negative for any claim that the current curriculum trains a better policy.

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
