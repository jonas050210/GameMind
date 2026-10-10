/**
 * The Control Center's building blocks, run in Node: the virtual DOM, formatting, the derivations that decide what a state
 * is called, the API client and the polling store. The page itself is covered in ui-page.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Page } from "./support/fake-dom.js";
import { loadUi } from "./support/ui-harness.js";

const ui = await loadUi();
const { h, mount, toHtml, textOf } = ui.h;

function withRoot<T>(run: (root: ReturnType<Page["byId"]>, page: Page) => T): T {
  const page = new Page({ html: '<html><body><div id="root"></div></body></html>' });
  const restore = page.install();
  try {
    return run(page.byId("root"), page);
  } finally {
    restore();
  }
}

// ---- virtual DOM ---------------------------------------------------------------------------------------

test("text from a game, a log line or an error message can never become markup", () => {
  withRoot((root) => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    mount(root, h("p", { class: "x" }, hostile, h("b", null, "&amp;")));
    assert.equal(root.querySelectorAll("img").length, 0);
    assert.equal(root.querySelectorAll("script").length, 0);
    assert.equal(root.textContent, `${hostile}&amp;`);
    assert.equal(toHtml(h("p", null, hostile)), "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;</p>");
  });
});

test("an unchanged render leaves the very same elements in place, and keyed lists move rather than rebuild", () => {
  withRoot((root) => {
    const list = (keys: string[]) => h("ul", null, keys.map((key) => h("li", { key }, key.toUpperCase())));
    mount(root, list(["a", "b"]));
    const [a, b] = root.querySelectorAll("li");
    const ul = root.querySelector("ul");
    mount(root, list(["a", "b"]));
    assert.equal(root.querySelector("ul"), ul);
    assert.deepEqual(root.querySelectorAll("li"), [a, b]);

    mount(root, list(["b", "a", "c"]));
    const after = root.querySelectorAll("li");
    assert.equal(after[0], b, "b keeps its element when it moves");
    assert.equal(after[1], a);
    assert.deepEqual(after.map((li) => li.textContent), ["B", "A", "C"]);

    mount(root, list(["a"]));
    assert.deepEqual(root.querySelectorAll("li"), [a]);
  });
});

test("a form built with h.stat is never patched while it is typed into, and is rebuilt only when its key changes", () => {
  withRoot((root) => {
    const form = (key: string, initial: string) => h.stat(key, h("form", null, h("input", { id: "field", type: "text", value: initial })));
    mount(root, h("div", null, form("v1", "server")));
    const input = root.querySelector("input");
    assert.ok(input);
    input.value = "typed by the operator";
    mount(root, h("div", null, form("v1", "something the server now says")));
    assert.equal(root.querySelector("input"), input, "same element");
    assert.equal(input.value, "typed by the operator");

    mount(root, h("div", null, form("v2", "fresh")));
    assert.notEqual(root.querySelector("input"), input, "a new key builds a new form");
    assert.equal(root.querySelector("input")?.value, "fresh");
  });
});

test("a focused input keeps what is being typed; once it loses focus the server value applies again", () => {
  withRoot((root, page) => {
    mount(root, h("input", { id: "q", type: "text", value: "a" }));
    const input = root.querySelector("input");
    assert.ok(input);
    input.value = "typing";
    input.focus();
    mount(root, h("input", { id: "q", type: "text", value: "from the server" }));
    assert.equal(input.value, "typing");
    input.blur();
    mount(root, h("input", { id: "q", type: "text", value: "from the server" }));
    assert.equal(input.value, "from the server");
    assert.equal(page.document.activeElement, page.document.body);
  });
});

test("boolean properties and removed props are cleared rather than left behind", () => {
  withRoot((root) => {
    mount(root, h("button", { disabled: true, class: "a", title: "t", "data-x": "1" }, "go"));
    const button = root.querySelector("button");
    assert.ok(button);
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute("title"), "t");
    mount(root, h("button", {}, "go"));
    assert.equal(root.querySelector("button"), button);
    assert.equal(button.disabled, false);
    assert.equal(button.hasAttribute("disabled"), false);
    assert.equal(button.getAttribute("class"), "");
    assert.equal(button.getAttribute("title"), null);
    assert.equal(button.getAttribute("data-x"), null);
  });
});

test("custom CSS properties go through the CSSOM and SVG gets its own namespace", () => {
  withRoot((root) => {
    mount(root, h("div", { style: { "--w": "40%" } }, h("svg", { viewBox: "0 0 2 2" }, h("polyline", { points: "0,0 1,1" }))));
    assert.equal(root.querySelector("div")?.style.getPropertyValue("--w"), "40%");
    const svg = root.querySelector("svg");
    const polyline = root.querySelector("polyline");
    assert.equal(svg?.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(polyline?.namespaceURI, "http://www.w3.org/2000/svg");
  });
});

test("textOf flattens a tree for assertions and ignores false, null and empty children", () => {
  assert.equal(textOf(h("div", null, "a", null, false, [h("b", null, "b"), "c"], 0)), "a b c 0");
});

// ---- formatting and honest unknowns --------------------------------------------------------------------

test("a missing measurement is shown as unknown and never as zero", () => {
  const f = ui.format;
  assert.equal(f.fmtPercent(null), "unknown");
  assert.equal(f.fmtPercent(undefined), "unknown");
  assert.equal(f.fmtPercent(Number.NaN), "unknown");
  assert.equal(f.fmtPercent(0), "0.0%");
  assert.equal(f.fmtNumber(null), "unknown");
  assert.equal(f.fmtNumber(0), "0");
  assert.equal(f.fmtSigned(null), "unknown");
  assert.equal(f.fmtSigned(0), "±0.0");
  assert.equal(f.fmtSigned(-2.5, 1, " pp"), "−2.5 pp");
  assert.equal(f.fmtDuration(-1), "unknown");
  assert.equal(f.fmtDuration(null), "unknown");
  assert.equal(f.fmtDuration(250), "250 ms");
  assert.equal(f.fmtDuration(61_000), "1 min 01 s");
  assert.equal(f.fmtDuration(3 * 3_600_000 + 5 * 60_000), "3 h 05 min");
  assert.equal(f.fmtAgo("not a date"), "unknown");
  assert.equal(f.fmtAgo("2026-10-10T12:00:00Z", Date.parse("2026-10-10T12:00:02Z")), "just now");
  assert.equal(f.fmtAgo("2026-10-10T12:00:00Z", Date.parse("2026-10-10T12:00:30Z")), "30 s ago");
  assert.equal(f.humanise("oak_log"), "oak log");
  assert.equal(f.humanise(null), "unknown");
  assert.equal(f.orUnknown(null), "unknown");
  assert.equal(f.orUnknown(7, (n: number) => `${n}!`), "7!");
});

test("presentational helpers: unknown values, progress, sparklines and tables never fake data", () => {
  const u = ui.ui;
  assert.equal(textOf(u.value(null)), "unknown");
  assert.equal(textOf(u.value(undefined)), "unknown");
  assert.equal(u.value(5, (n: number) => `${n} hp`), "5 hp");

  const unknownBar = u.progress(null, 20, "Health");
  assert.equal(textOf(unknownBar), "", "an unmeasurable bar carries no text, only an accessible 'unknown'");
  assert.equal(unknownBar.props["aria-label"], "Health: unknown");

  const bar = u.progress(15, 20, "Food");
  assert.equal(bar.props["aria-valuenow"], 15);
  assert.equal(bar.props["aria-valuemax"], 20);
  assert.equal(bar.children[0].props.style["--w"], "75.0%");
  assert.equal(u.progress(99, 20).children[0].props.style["--w"], "100.0%", "clamped, never overflowing");

  assert.match(textOf(u.sparkline([1])), /Not enough measured points/);
  assert.match(textOf(u.sparkline([null, null, 3])), /Not enough measured points/);
  const line = u.sparkline([1, 3, 2, null, 5]);
  assert.equal(line.tag, "svg");
  assert.equal(line.children[0].tag, "polyline");
  assert.equal(String(line.children[0].props.points).split(" ").length, 4, "nulls are skipped, not drawn as zero");

  const emptyTable = u.table({ columns: [{ label: "A", cell: () => "x" }], rows: [], empty: { title: "Nothing yet", detail: "Because." } });
  assert.match(textOf(emptyTable), /Nothing yet Because\./);
  const filled = u.table({ columns: [{ label: "A", cell: (r: { n: number }) => String(r.n) }], rows: [{ key: 1, value: { n: 1 } }, { key: 2, value: { n: 2 } }] });
  assert.equal(toHtml(filled).includes("<th scope=\"col\" class=\"\">A</th>"), true);

  const source = u.sourceBadge("simulated");
  assert.match(source.props.class, /source-simulated/);
  assert.equal(textOf(source), "SIMULATED");
  assert.equal(textOf(u.sourceBadge("something-else")), "UNAVAILABLE", "an unknown provenance reads as unavailable, not as live");

  const button = u.button("Go", { command: "startTask", payload: { a: 1 }, data: { confirm: "Sure?" }, disabled: true });
  assert.equal(button.props["data-command"], "startTask");
  assert.equal(button.props["data-payload"], '{"a":1}');
  assert.equal(button.props["data-confirm"], "Sure?");
  assert.equal(button.props.disabled, true);
});

// ---- what states are called ------------------------------------------------------------------------------

test("every lifecycle state has a plain-language label, and connected-idle differs from running and disconnected", () => {
  const { sessionInfo, botState, SESSION_STATES } = ui.model;
  assert.deepEqual(Object.keys(SESSION_STATES).sort(), ["connecting", "idle", "initializing", "none", "reconnecting", "running", "shutdown", "stopping"]);
  assert.equal(sessionInfo(null).label, "No session");
  assert.equal(sessionInfo({ state: "idle" }).label, "Connected · idle");
  assert.equal(sessionInfo({ state: "shutdown" }).label, "Disconnected");
  assert.equal(sessionInfo({ state: "mystery" }).label, "mystery", "an unknown state is shown as it is, not mapped to something nicer");
  assert.equal(botState({ state: "idle" }, { active: null }).label, "Connected · idle");
  assert.equal(botState({ state: "idle" }, { active: { label: "Gather logs" } }).label, "Running a task");
  assert.equal(botState({ state: "shutdown" }, { active: null }).label, "Disconnected");
});

test("data provenance: live, simulated, historical and unavailable are told apart", () => {
  const { worldSource } = ui.model;
  assert.equal(worldSource(null), "unavailable");
  assert.equal(worldSource({ session: { state: "none" } }), "unavailable");
  assert.equal(worldSource({ session: { state: "idle", source: "simulated" }, world: { provenance: { source: "simulated" } } }), "simulated");
  assert.equal(worldSource({ session: { state: "idle", source: "live" }, world: { provenance: { source: "live-observation" } } }), "live");
  assert.equal(worldSource({ session: { state: "shutdown", source: "live" }, world: { provenance: { source: "live-observation" } } }), "historical", "after disconnect the last world is history, not live");
  assert.equal(worldSource({ session: { state: "idle", source: "live" }, world: { provenance: { source: "world-memory" } } }), "historical");
  assert.equal(worldSource({ session: { state: "idle", source: "live" }, world: { provenance: { source: "none" } } }), "unavailable");
});

test("PASS, FAIL and SKIPPED come only from measured statuses", () => {
  const { statusInfo } = ui.model;
  assert.deepEqual(statusInfo("succeeded"), { label: "PASS", tone: "good" });
  assert.deepEqual(statusInfo("passed"), { label: "PASS", tone: "good" });
  assert.deepEqual(statusInfo("failed"), { label: "FAIL", tone: "bad" });
  assert.deepEqual(statusInfo("timed_out"), { label: "FAIL", tone: "bad" });
  assert.deepEqual(statusInfo("skipped"), { label: "SKIPPED", tone: "neutral" });
  assert.deepEqual(statusInfo("not-run"), { label: "NOT RUN", tone: "neutral" });
  assert.deepEqual(statusInfo("blocked"), { label: "BLOCKED", tone: "warn" });
  assert.deepEqual(statusInfo("aborted"), { label: "STOPPED", tone: "warn" });
  assert.equal(statusInfo("accepted").label, "ACCEPTED", "an unfamiliar status is not promoted to a pass");
  assert.equal(statusInfo(undefined).label, "UNKNOWN");
});

test("starting or queueing a task always comes with the reason when it is not possible", () => {
  const { taskBlocker, queueExplanation } = ui.model;
  const base = { session: { state: "idle" }, safety: { paused: false, tripped: false }, scheduler: { active: null, queue: [], limits: { maxQueue: 5 } } };
  assert.equal(taskBlocker(base), null);
  assert.match(taskBlocker({ ...base, session: { state: "none" } }), /no session/i);
  assert.match(taskBlocker({ ...base, session: { state: "shutdown" } }), /session has ended/i);
  assert.match(taskBlocker({ ...base, session: { state: "connecting" } }), /connecting/);
  assert.match(taskBlocker({ ...base, session: { state: "reconnecting" } }), /reconnecting/i);
  assert.match(taskBlocker({ ...base, session: { state: "stopping" } }), /stopping/);
  assert.match(taskBlocker({ ...base, safety: { paused: false, tripped: true } }), /safety trip/i);
  assert.match(taskBlocker({ ...base, safety: { paused: true, tripped: false } }), /paused/i);
  assert.match(taskBlocker({ ...base, scheduler: null }), /no task scheduler/i);

  assert.equal(queueExplanation(base).available, true);
  assert.match(queueExplanation(base).text, /starts immediately/);
  const busy = { ...base, scheduler: { active: { label: "Gather logs" }, queue: [{}, {}], limits: { maxQueue: 5 } } };
  assert.match(queueExplanation(busy).text, /Gather logs/);
  assert.match(queueExplanation(busy).text, /queue 2\/5/);
  assert.equal(queueExplanation({ ...base, session: { state: "none" } }).available, false);
});

test("progress is a fraction only when the task reports a measurable goal", () => {
  const { activeProgress } = ui.model;
  assert.equal(activeProgress({}), null);
  assert.equal(activeProgress({ goal: { progress: { have: 1, of: 0, unit: "logs" } } }), null, "a goal of zero is not a measurement");
  assert.deepEqual(activeProgress({ goal: { progress: { have: 3, of: 4, unit: "logs" } } }), { have: 3, of: 4, unit: "logs", fraction: 0.75 });
  assert.equal(activeProgress({ goal: { progress: { have: 9, of: 4, unit: "logs" } } }).fraction, 1);
});

// ---- API client ----------------------------------------------------------------------------------------

test("the API client uses relative URLs, sends the token only on commands and reports refusals as results", async () => {
  const seen: Array<{ url: string; init: Record<string, unknown> | undefined }> = [];
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const api = ui.api.createApi({
    token: "secret-token",
    fetch: async (url: string, init?: Record<string, unknown>) => {
      seen.push({ url, init });
      if (url.includes("api/command")) return respond(409, { ok: false, message: "A task is already running." });
      if (url.includes("api/learning")) return respond(200, { enabled: true });
      return respond(200, { generatedAt: "now" });
    },
  });
  assert.deepEqual(await api.snapshot(), { generatedAt: "now" });
  assert.equal(seen[0]?.url, "./api/snapshot");
  assert.equal((await api.snapshot({ fresh: true }), seen[1]?.url), "./api/snapshot?fresh=1");
  await api.query("learning", { store: "simulated", empty: "", missing: undefined, gone: null });
  assert.equal(seen[2]?.url, "./api/learning?store=simulated", "empty parameters are not sent");
  assert.equal((seen[0]?.init?.headers as Record<string, string>)["x-gamemind-token"], undefined, "reads carry no token");

  const refused = await api.command("startTask", { kind: "gather-logs" });
  assert.deepEqual({ ok: refused.ok, status: refused.status, message: refused.message }, { ok: false, status: 409, message: "A task is already running." });
  const headers = seen[3]?.init?.headers as Record<string, string>;
  assert.equal(headers["x-gamemind-token"], "secret-token");
  assert.equal(seen[3]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(seen[3]?.init?.body)), { type: "startTask", payload: { kind: "gather-logs" } });
  await api.command("pause");
  assert.deepEqual(JSON.parse(String(seen[4]?.init?.body)), { type: "pause" }, "no payload key when there is none");
});

test("an unreachable server is an error the page can show, not a silent success", async () => {
  const down = ui.api.createApi({ fetch: async () => Promise.reject(new TypeError("fetch failed")) });
  await assert.rejects(() => down.snapshot(), (error: Error & { status: number }) => error.name === "ApiError" && error.status === 0 && /Could not reach GameMind/.test(error.message));
  await assert.rejects(() => down.command("pause"), /Could not reach GameMind/);
  const broken = ui.api.createApi({ fetch: async () => new Response("<html>nope</html>", { status: 502 }) });
  await assert.rejects(() => broken.snapshot(), (error: Error & { status: number }) => error.status === 502 && /502/.test(error.message));
});

// ---- polling store -------------------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

test("polling never overlaps: a slow server is asked once, not once per tick", async () => {
  const pending = deferred<{ n: number }>();
  let calls = 0;
  const store = ui.store.createStore({ api: { snapshot: () => { calls += 1; return pending.promise; }, query: async () => ({}) } });
  const first = store.tick();
  const second = store.tick();
  assert.equal(calls, 1, "the second tick joins the first instead of asking again");
  pending.resolve({ n: 1 });
  await Promise.all([first, second]);
  assert.deepEqual(store.state.snapshot, { n: 1 });
  await store.tick();
  assert.equal(calls, 2);
});

test("an older answer that arrives late never replaces a newer one", async () => {
  const slow = deferred<{ n: number }>();
  const fast = deferred<{ n: number }>();
  const queue = [slow, fast];
  const store = ui.store.createStore({ api: { snapshot: () => (queue.shift() as typeof slow).promise, query: async () => ({}) } });
  const older = store.refreshSnapshot();
  const newer = store.refreshSnapshot();
  fast.resolve({ n: 2 });
  await newer;
  assert.deepEqual(store.state.snapshot, { n: 2 });
  slow.resolve({ n: 1 });
  assert.equal(await older, false, "the stale answer is reported as not applied");
  assert.deepEqual(store.state.snapshot, { n: 2 });
});

test("contact is reported lost after repeated failures, the last data stays, and recovery clears it", async () => {
  let failing = false;
  const store = ui.store.createStore({
    api: {
      snapshot: async () => {
        if (failing) throw new Error("Could not reach GameMind (fetch failed)");
        return { n: 1 };
      },
      query: async () => ({}),
    },
  });
  await store.tick();
  assert.equal(store.state.lost, false);
  failing = true;
  await store.tick();
  assert.equal(store.state.lost, false, "one failure is a blip");
  await store.tick();
  assert.equal(store.state.lost, true);
  assert.match(store.state.snapshotError, /Could not reach GameMind/);
  assert.deepEqual(store.state.snapshot, { n: 1 }, "the last good data is kept so the page can show it as out of date");
  failing = false;
  await store.tick();
  assert.equal(store.state.lost, false);
  assert.equal(store.state.snapshotError, null);
});

test("polling slows down while the page is hidden and speeds up again when it is not", async () => {
  const timers: Array<{ ms: number }> = [];
  let hidden = false;
  const store = ui.store.createStore({
    api: { snapshot: async () => ({ n: 1 }), query: async () => ({}) },
    setTimer: (_run: () => void, ms: number) => {
      timers.push({ ms });
      return timers.length;
    },
    clearTimer: () => undefined,
    isHidden: () => hidden,
  });
  store.start();
  await store.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timers.at(-1)?.ms, ui.store.POLL_VISIBLE_MS);
  hidden = true;
  store.nudge();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timers.at(-1)?.ms, ui.store.POLL_HIDDEN_MS);
  assert.ok(ui.store.POLL_HIDDEN_MS >= 5 * ui.store.POLL_VISIBLE_MS, "an unwatched page costs the agent next to nothing");
  store.stop();
  assert.equal(store.isRunning, false);
});

test("detail queries are fetched when stale or when their parameters change, and a search keeps its old results while loading", async () => {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const now = { value: 1_000 };
  let wanted: Array<Record<string, unknown>> = [{ name: "events", params: { q: "" }, everyMs: 2_000, keep: true }, { name: "learning", params: { store: "live" }, everyMs: 5_000 }];
  const store = ui.store.createStore({
    api: { snapshot: async () => ({}), query: async (name: string, params: Record<string, unknown>) => { calls.push({ name, params }); return { name, params }; } },
    now: () => now.value,
    wanted: () => wanted,
  });
  await store.tick();
  assert.equal(calls.length, 2);
  await store.tick();
  assert.equal(calls.length, 2, "fresh results are not fetched again");
  now.value += 2_500;
  await store.tick();
  assert.deepEqual(calls.slice(2).map((call) => call.name), ["events"], "only the stale one is refreshed");

  wanted = [{ name: "events", params: { q: "zombie" }, everyMs: 2_000, keep: true }, { name: "learning", params: { store: "simulated" }, everyMs: 5_000 }];
  const refresh = store.tick();
  assert.equal(store.resource("events").status, "ok", "a search keeps showing the previous list while the new one loads");
  assert.equal(store.resource("learning").status, "loading", "a different data set is not shown as the old one");
  await refresh;
  assert.deepEqual(store.resource("events").value.params, { q: "zombie" });
  assert.deepEqual(store.resource("learning").value.params, { store: "simulated" });
});

test("a failing detail query is recorded as an error with its message, and one answer never hides another", async () => {
  const store = ui.store.createStore({
    api: {
      snapshot: async () => ({}),
      query: async (name: string) => {
        if (name === "learning") throw new Error("learning answered 500");
        return { fine: true };
      },
    },
    wanted: () => [{ name: "learning", everyMs: 1 }, { name: "memory", everyMs: 1 }],
  });
  await store.tick();
  assert.equal(store.resource("learning").status, "error");
  assert.equal(store.resource("learning").error, "learning answered 500");
  assert.equal(store.resource("memory").status, "ok");
});

test("nudge polls at once and stop clears the pending timer", async () => {
  const cleared: number[] = [];
  let calls = 0;
  const store = ui.store.createStore({
    api: { snapshot: async () => { calls += 1; return {}; }, query: async () => ({}) },
    setTimer: () => 7,
    clearTimer: (id: number) => cleared.push(id),
  });
  store.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const before = calls;
  store.nudge();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, before + 1);
  store.stop();
  assert.ok(cleared.includes(7));
  store.nudge();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, before + 1, "a stopped store stays stopped");
});
