// Page state and polling. No DOM here: timers, visibility and the API are injected, so the rules (never overlap requests, never
// apply an older answer over a newer one, back off while hidden, surface lost contact) are tested in Node.

export const POLL_VISIBLE_MS = 1500;
export const POLL_HIDDEN_MS = 15000;
export const LOST_AFTER_FAILURES = 2;

const EMPTY_RESOURCE = () => ({ status: "idle", value: null, error: null, at: null, params: null });

export function createStore({ api, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), isHidden = () => false, wanted = () => [], onChange = () => {} }) {
  const state = {
    snapshot: null,
    snapshotAt: null,
    snapshotError: null,
    failures: 0,
    lost: false,
    resources: {},
  };
  const sequences = new Map();
  let timer = null;
  let running = false;
  let inFlight = null;

  const resource = (name) => (state.resources[name] ??= EMPTY_RESOURCE());
  const next = (key) => {
    const value = (sequences.get(key) ?? 0) + 1;
    sequences.set(key, value);
    return value;
  };

  async function refreshSnapshot() {
    const sequence = next("snapshot");
    try {
      const snapshot = await api.snapshot();
      if (sequence < (sequences.get("snapshot") ?? 0)) return false;
      state.snapshot = snapshot;
      state.snapshotAt = now();
      state.snapshotError = null;
      state.failures = 0;
      state.lost = false;
      return true;
    } catch (error) {
      if (sequence < (sequences.get("snapshot") ?? 0)) return false;
      state.failures += 1;
      state.snapshotError = error instanceof Error ? error.message : String(error);
      if (state.failures >= LOST_AFTER_FAILURES) state.lost = true;
      return false;
    }
  }

  /**
   * Fetches one detail resource. `params` are remembered so a periodic refresh asks for the same thing. `keep` serves the
   * previous value while a changed query loads (a search box), instead of flashing a loading state per keystroke.
   */
  async function refreshResource(name, params = resource(name).params ?? {}, { keep = false } = {}) {
    const entry = resource(name);
    const sequence = next(`resource:${name}`);
    const changedParams = JSON.stringify(entry.params ?? {}) !== JSON.stringify(params);
    entry.params = params;
    if (entry.status === "idle" || (changedParams && !(keep && entry.value !== null))) entry.status = "loading";
    try {
      const value = await api.query(name, params);
      if (sequence < (sequences.get(`resource:${name}`) ?? 0)) return false;
      entry.status = "ok";
      entry.value = value;
      entry.error = null;
      entry.at = now();
      return true;
    } catch (error) {
      if (sequence < (sequences.get(`resource:${name}`) ?? 0)) return false;
      entry.status = "error";
      entry.error = error instanceof Error ? error.message : String(error);
      entry.at = now();
      return false;
    }
  }

  async function tick() {
    // One round at a time: a slow server must never see requests pile up behind each other.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const jobs = [refreshSnapshot()];
      for (const wish of wanted()) {
        const entry = resource(wish.name);
        const stale = entry.at === null || now() - entry.at >= wish.everyMs || JSON.stringify(entry.params ?? {}) !== JSON.stringify(wish.params ?? {});
        if (stale) jobs.push(refreshResource(wish.name, wish.params ?? {}, { keep: wish.keep === true }));
      }
      await Promise.all(jobs);
      onChange();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function schedule() {
    if (!running) return;
    timer = setTimer(async () => {
      timer = null;
      await tick();
      schedule();
    }, isHidden() ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
  }

  return {
    state,
    resource,
    tick,
    refreshSnapshot,
    refreshResource,
    start() {
      if (running) return;
      running = true;
      void tick().then(schedule);
    },
    stop() {
      running = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    /** Poll sooner (after a command) without waiting for the next period. */
    nudge() {
      if (!running) return;
      if (timer !== null) clearTimer(timer);
      timer = null;
      void tick().then(schedule);
    },
    get isRunning() {
      return running;
    },
  };
}
