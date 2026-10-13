# Live protocol

One fixed list of steps for testing GameMind against a real Minecraft server, and one result file per session.

**Running these steps is not authorized by this document.** As in [`LIVE_VERIFICATION.md`](./LIVE_VERIFICATION.md),
connecting to or changing a live Minecraft world needs separate explicit approval, a server you are allowed to
operate, and a disposable world. Five steps change the world; do not run them anywhere else.

Two layers exist, and they answer different questions:

| Layer | Command | What it can prove |
| --- | --- | --- |
| Automated | `npm run test:live -- --host <ip>` | Connection, observation, decisions, action checks, episode recording. Runs without you in the game. |
| Operator protocol | `npm run protocol` | Everything that needs a person: chat commands, priority, night behaviour, fights, the numbers in the Control Center. |

The automated report lands in `test-results/live-verification-report.json`, which is gitignored. A protocol
result is evidence and is meant to be kept: `docs/live-results/`.

## Before the session

- A Minecraft **1.20.4** server you can afford to change. Five steps are marked *changes the world*
  (`shelter-seals-at-night`, `shelter-breaks-out`, `combat-opt-in-kills`): run those on a disposable world.
- The checkout **inside WSL**, not under `/mnt/c/...` (`npm run setup:check` tells you).
- `npm ci` once inside WSL, then `npm run start` / the Control Center on port 8080.
- Your in-game name is the configured operator (`MINECRAFT_OPERATOR`); the bot only answers that exact name.
- Combat armed **only** for the two steps that need it (`--allow-combat` or the Control Center switch).

## Workflow

```bash
npm run protocol -- print                                          # read the 15 steps
npm run protocol -- template data/live/2026-10-13.json --server "127.0.0.1:25565" --operator "YourName"
# play the session, fill in one outcome per step as you go
npm run protocol -- check data/live/2026-10-13.json                # refuses an unfounded result
mv data/live/2026-10-13.json docs/live-results/                    # keep it as evidence
```

`check` exits non-zero and lists every problem. It is strict about exactly one thing: a step may not say
`verified` without the observation and the values it asks for.

## What makes a result count

1. Every step has an outcome: `verified`, `failed`, `skipped` or still `pending`.
2. `verified` needs `observed` (what you actually saw) plus every listed value.
3. `skipped` needs `skippedReason`. `failed` needs `observed` — what happened instead.
4. **A failed step is a result.** Write it down as failed; do not retry until it passes and report the passing
   run as the whole truth.
5. **"I sent the command" is not a result.** Only what you observed counts. This is the rule that
   [LIVE_FINDINGS.md](./LIVE_FINDINGS.md) §5 exists to remind us of.
6. The file names the server, the version, the operator and the time — so nobody later reads one session as
   "live verified" in general.

## The steps

`npm run protocol -- print` prints the full wording. The values in the last column are the ones `check`
insists on for a `verified` step.

### Chat

| Step | Say / do | Expect | Write down |
| --- | --- | --- | --- |
| `chat-help` | `hilfe` | One readable line per command group, within about a second | `secondsToReply` |
| `chat-suggestion` | `sttaus` | Asks `Meintest du „status“?` and runs nothing | what you saw |
| `chat-status-while-busy` | `hol noch 5 diamanten`, then `status` | Answer arrives immediately, names the active order | `secondsToReply` |
| `chat-come-while-busy` | `hol noch 5 diamanten`, then `komm` | Starts coming at once; says `nicht gestartet` if the order had not begun | `secondsToCome`, `saidOrderNotStarted` |
| `chat-follow-distance` | `folge mir`, walk ~20 blocks | Follows, keeps its preferred distance, does not drift | `maxDistanceBlocks` |
| `chat-stop-holds` | `stopp` during a task | Task ends, holds position, starts nothing new | `secondsToStop`, `newTaskStarted` |
| `chat-latency-panel` | Control Center → Bots → *Chat response* | Queue wait, handling, first reply, helper model as p95 vs targets; counts; one log line per answer | `firstReplyP95Ms`, `queueWaitP95Ms`, `messagesAnswered` |
| `chat-still-answers-later` | `status` at the end of a ≥10 min mixed session | The last message is answered. If not: the last command before the silence and how long you waited | `commandsSent`, `secondsToReply`, `silenceObserved` |

### Combat

| Step | Say / do | Expect | Write down |
| --- | --- | --- | --- |
| `combat-opt-in-kills` | Combat armed, sword carried, one zombie nearby, health above 14 | Equips the sword, fights in the weapon's rhythm, the zombie dies; never fights at health ≤14; never a second hostile while one is engaged | `combatArmed`, `healthBefore`, `healthAfter`, `hostileDied`, `secondsToKill` |
| `combat-denied-by-default` | Combat **not** armed, hostile nearby | No attack at all; the ledger says combat is not enabled | `attacksObserved` |
| `combat-creeper-avoided` | Combat armed, creeper within ~6 blocks | Never swings at it, keeps distance (enderman likewise) | `combatArmed`, `attacksObserved`, `minDistanceBlocks` |

### Survival

| Step | Say / do | Expect | Write down |
| --- | --- | --- | --- |
| `food-raw-meat` | Hunger ≤14, raw meat in the inventory or nearby | Eats it and hunger rises; never rotten flesh; raw chicken only when nothing else is available | `hungerBefore`, `hungerAfter`, `itemEaten` |

### Shelter and night

| Step | Say / do | Expect | Write down |
| --- | --- | --- | --- |
| `shelter-seals-at-night` | `baue ein shelter` shortly before dusk | Builds and closes the sides before full dark; reports honestly when blocks or time run out | `sidesClosed`, `blocksPlaced`, `sealedBeforeDark` |
| `shelter-breaks-out` | Inside a shelter it sealed itself, then `komm` | Digs its own blocks out and reaches you instead of standing in a sealed box | `blocksBroken`, `secondsToExit`, `reachedOperator` |

### Metrics

| Step | Say / do | Expect | Write down |
| --- | --- | --- | --- |
| `metrics-loop-targets` | Control Center → Bots → *Agent loop*, after ≥2 min | Observation rate, observation age and the p95 targets, each marked met or missed | `observationAgeMs`, `decisionP95Ms`, `reactionP95Ms` |

## After the session

- `npm run protocol -- check <file>` must pass before the file is treated as a result.
- Move it to `docs/live-results/` and say in the pull request what passed and what failed.
- Anything that failed and is a *gap in the code* belongs in the roadmap:
  `npm run roadmap -- act <fingerprint> prioritize --note "live protocol <date>: <what failed>"`.
- The automated verifier still has to be run separately: `npm run test:live -- --host <ip> --actions`.
