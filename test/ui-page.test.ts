/**
 * The Control Center page as a person uses it: the real index.html and app.js, run in a fake DOM, fed the genuine shape of
 * every snapshot and query (captured from a real app) through a stubbed server that records each request.
 *
 * This shows that the right text, controls and states are on the page and that every control sends what it should. It cannot
 * show how the page looks; nobody has seen it in a browser from this build environment.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MinecraftTaskDecisionModel } from "../src/games/minecraft/decision-model.js";
import { buildShelterTaskSchema, gatherResourceTaskSchema } from "../src/games/minecraft/task.js";
import type { FakeElement } from "./support/fake-dom.js";
import { block, observationAt } from "./support/observations.js";
import { bootPage, loadUi, stubServer, type BootedPage, type StubServer } from "./support/ui-harness.js";
import { capturedData, clone } from "./support/ui-fixtures.js";

await loadUi();
const real = await capturedData();

type Snapshot = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function snapshotWith(change: (snapshot: Snapshot) => void = () => undefined): Snapshot {
  const snapshot = clone(real.snapshot);
  change(snapshot);
  return snapshot;
}

function server(change?: (snapshot: Snapshot) => void, queries: Record<string, unknown> = {}): StubServer {
  return stubServer(snapshotWith(change), { ...clone(real.queries), ...queries });
}

async function openTab(booted: BootedPage, tab: string): Promise<void> {
  booted.page.click(`tab-${tab}`);
  await booted.settle();
  await booted.settle();
}

async function withPage(
  stub: StubServer,
  run: (booted: BootedPage) => Promise<void>,
  options: { hash?: string; storedTheme?: string } = {},
): Promise<void> {
  const booted = await bootPage({ fetch: stub.fetch, ...options });
  try {
    await run(booted);
    assert.deepEqual(booted.page.window.console.errors, [], "the page reported no errors to the console");
  } finally {
    booted.app.stop();
    booted.restore();
  }
}

const idleSession = (snapshot: Snapshot): void => {
  snapshot.session.state = "idle";
  snapshot.session.canConnect = false;
  snapshot.session.canStop = true;
};

// ---- boot, loading, routing ----------------------------------------------------------------------------------

test("the page shows a loading state until the first snapshot arrives, then the tab", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stub = server();
  const delayed: StubServer["fetch"] = async (input, init) => {
    if (input.endsWith("api/snapshot")) await gate;
    return stub.fetch(input, init);
  };
  const booted = await bootPage({ fetch: delayed, settle: false });
  try {
    const { page } = booted;
    assert.equal(page.byId("panel-loading").hasAttribute("hidden"), false);
    assert.match(page.visibleText("loading-text"), /Contacting GameMind/);
    for (const tab of ["overview", "training", "bots", "tasks", "evaluation", "learning", "memory"]) {
      assert.equal(page.byId(`panel-${tab}`).hasAttribute("hidden"), true, `${tab} is not shown before there is data`);
    }
    assert.equal(page.visibleText("session-pill-text"), "Connecting to GameMind…");
    assert.equal(page.visibleText("source-badge"), "UNAVAILABLE");
    release();
    await booted.settle();
    assert.equal(page.byId("panel-loading").hasAttribute("hidden"), true);
    assert.equal(page.byId("panel-overview").hasAttribute("hidden"), false);
    assert.match(page.visibleText("ov-session"), /Session/);
  } finally {
    booted.app.stop();
    booted.restore();
  }
});

test("reloading the page only reads: booting sends no command, however many times it happens", async () => {
  const stub = server();
  for (let reload = 0; reload < 2; reload += 1) {
    await withPage(stub, async (booted) => {
      await openTab(booted, "bots");
      await openTab(booted, "overview");
    });
  }
  assert.ok(stub.requests.length > 4);
  assert.deepEqual(stub.requests.filter((request) => request.method !== "GET"), [], "nothing but reads was sent");
  assert.deepEqual(stub.commands(), []);
});

test("tabs: the hash picks the tab, clicks and arrow keys move between them, and an unknown hash falls back to the overview", async () => {
  await withPage(server(), async ({ page, settle }) => {
    assert.equal(page.byId("tab-overview").getAttribute("aria-selected"), "true");
    assert.equal(page.byId("panel-overview").hasAttribute("hidden"), false);
    assert.equal(page.byId("panel-bots").hasAttribute("hidden"), true);
    page.click("tab-bots");
    await settle();
    assert.equal(page.window.location.hash, "#/bots");
    assert.equal(page.byId("tab-bots").getAttribute("aria-selected"), "true");
    assert.equal(page.byId("tab-overview").getAttribute("aria-selected"), "false");
    assert.equal(page.byId("tab-overview").tabIndex, -1, "only the selected tab is in the tab order");
    assert.equal(page.byId("panel-bots").hasAttribute("hidden"), false);
    assert.equal(page.byId("panel-overview").hasAttribute("hidden"), true);

    page.press("tab-bots", "ArrowRight");
    assert.equal(page.byId("tab-tasks").getAttribute("aria-selected"), "true");
    page.press("tab-tasks", "End");
    assert.equal(page.byId("tab-memory").getAttribute("aria-selected"), "true");
    page.press("tab-memory", "ArrowRight");
    assert.equal(page.byId("tab-overview").getAttribute("aria-selected"), "true", "the arrows wrap around");
    page.press("tab-overview", "ArrowLeft");
    assert.equal(page.byId("tab-memory").getAttribute("aria-selected"), "true");

    page.window.location.hash = "#/learning";
    page.window.fire("hashchange");
    assert.equal(page.byId("tab-learning").getAttribute("aria-selected"), "true");
    page.window.location.hash = "#/not-a-tab";
    page.window.fire("hashchange");
    assert.equal(page.byId("tab-learning").getAttribute("aria-selected"), "true", "a bad hash changes nothing");
  });
  await withPage(server(), async ({ page }) => assert.equal(page.byId("tab-training").getAttribute("aria-selected"), "true"), { hash: "#/training" });
  await withPage(server(), async ({ page }) => assert.equal(page.byId("tab-overview").getAttribute("aria-selected"), "true"), { hash: "#/bogus" });
});

test("only the open tab's detail queries are polled, so an idle page costs the agent little", async () => {
  const stub = server();
  await withPage(stub, async (booted) => {
    const asked = () => new Set(stub.requests.map((request) => /api\/([\w-]+)/.exec(request.url)?.[1]));
    assert.deepEqual([...asked()].sort(), ["snapshot", "tasks"], "the overview needs the snapshot and the task catalog only");
    await openTab(booted, "memory");
    assert.ok(asked().has("memory") && asked().has("events"));
    assert.ok(!asked().has("learning") && !asked().has("evaluation") && !asked().has("training-preflight"));
    await openTab(booted, "learning");
    assert.ok(asked().has("learning"));
    await openTab(booted, "evaluation");
    assert.ok(asked().has("evaluation"));
    await openTab(booted, "training");
    assert.ok(asked().has("training-preflight"));
    await openTab(booted, "bots");
    assert.ok(asked().has("diagnostics"));
    const learning = stub.requests.find((request) => request.url.includes("api/learning"));
    assert.match(learning?.url ?? "", /store=live/);
  });
});

test("losing the server is shown, the last data is kept and labelled out of date, and recovery clears it", async () => {
  const stub = server(idleSession);
  await withPage(stub, async ({ page, settle, clock }) => {
    assert.equal(page.visibleText("session-pill-text"), "Connected · idle");
    assert.equal(page.byId("lost").hasAttribute("hidden"), true);
    stub.failSnapshot = true;
    await clock.advance(30_000);
    await settle();
    await settle();
    assert.equal(page.byId("lost").hasAttribute("hidden"), false);
    assert.match(page.visibleText("lost"), /Lost contact|No contact|lost/i);
    assert.equal(page.visibleText("session-pill-text"), "No contact with GameMind");
    assert.equal(page.visibleText("source-badge"), "UNAVAILABLE", "stale data is not presented as live or simulated");
    assert.match(page.visibleText("updated"), /No contact for/);
    assert.match(page.visibleText("ov-session"), /Connected · idle/, "the last data stays on the page");
    assert.equal(page.byId("panic-btn").disabled, true, "no emergency stop is offered into the void");

    stub.failSnapshot = false;
    await settle();
    assert.equal(page.byId("lost").hasAttribute("hidden"), true);
    assert.equal(page.visibleText("session-pill-text"), "Connected · idle");
    assert.match(page.visibleText("updated"), /Updated/);
  });
});

test("polling slows right down while the tab is hidden and catches up at once when it returns", async () => {
  const stub = server();
  await withPage(stub, async ({ page, clock, app, settle }) => {
    await app.store.tick();
    const visibleDelay = clock.pendingDelays()[0] ?? 0;
    assert.ok(visibleDelay <= 2_000, `visible polling is brisk (${visibleDelay} ms)`);
    page.setHidden(true);
    await clock.advance(2_000); // the poll that was already scheduled still fires; the one after it is slow
    await settle();
    assert.ok(Math.max(...clock.pendingDelays()) >= 10_000, `hidden polling is slow (${clock.pendingDelays().join(", ")} ms)`);
    const before = stub.requests.length;
    page.setHidden(false);
    await settle();
    assert.ok(stub.requests.length > before, "returning to the tab refreshes immediately");
  });
});

test("the theme toggle flips light and dark, remembers the choice, and a remembered choice is applied at boot", async () => {
  await withPage(server(), async ({ page }) => {
    assert.equal(page.document.documentElement.getAttribute("data-theme"), "auto", "no choice yet: the page follows the system");
    page.click("theme-toggle");
    assert.equal(page.document.documentElement.getAttribute("data-theme"), "dark");
    assert.equal(page.window.localStorage.getItem("gamemind.theme"), "dark");
    page.click("theme-toggle");
    assert.equal(page.document.documentElement.getAttribute("data-theme"), "light");
    assert.equal(page.window.localStorage.getItem("gamemind.theme"), "light");
  });
  await withPage(server(), async ({ page }) => assert.equal(page.document.documentElement.getAttribute("data-theme"), "dark"), { storedTheme: "dark" });
});

test("a section that cannot be drawn says so on the page and the rest keeps working", async () => {
  const stub = server((snapshot) => {
    snapshot.events = { items: "not a list" };
  });
  await withPage(
    stub,
    async ({ page, settle }) => {
      assert.match(page.visibleText("render-error"), /could not be drawn/);
      assert.equal(page.visibleText("session-pill-text").length > 0, true, "the header still updates");
      assert.equal(page.window.console.errors.length > 0, true, "the failure is also reported to the console for debugging");
      page.window.console.errors.length = 0;
      page.click("tab-bots");
      await settle();
      assert.equal(page.visibleText("render-error"), "", "another tab draws fine");
      assert.match(page.visibleText("bots-list"), /Simulated bot/);
    },
  );
});

// ---- header: honest status ------------------------------------------------------------------------------

test("a simulated session is announced on every tab and never reads as a real Minecraft world", async () => {
  await withPage(server(idleSession), async ({ page }) => {
    assert.equal(page.byId("banner").hasAttribute("hidden"), false);
    assert.match(page.visibleText("banner"), /simulated/i);
    assert.equal(page.visibleText("source-badge"), "SIMULATED");
    assert.match(page.byId("source-badge").className, /source-simulated/);
  });
});

test("a live session is labelled live and carries no simulated banner", async () => {
  const stub = server((snapshot) => {
    idleSession(snapshot);
    snapshot.session.source = "live";
    snapshot.session.target = { host: "127.0.0.1", port: 25565, version: "1.20.4", username: "GameMind", auth: "offline" };
    snapshot.world.provenance = { ...snapshot.world.provenance, source: "live-observation" };
  });
  await withPage(stub, async ({ page }) => {
    assert.equal(page.byId("banner").hasAttribute("hidden"), true);
    assert.equal(page.visibleText("source-badge"), "LIVE");
    assert.match(page.visibleText("ov-session"), /127\.0\.0\.1:25565/);
    assert.match(page.visibleText("ov-session"), /1\.20\.4/);
  });
});

function liveObservation(freshness: Record<string, unknown>): (snapshot: Snapshot) => void {
  return (snapshot) => {
    idleSession(snapshot);
    snapshot.session.source = "live";
    snapshot.world.provenance = { ...snapshot.world.provenance, source: "live-observation" };
    snapshot.world.health = 14;
    snapshot.world.food = 17;
    snapshot.world.freshness = freshness;
  };
}

test("a stale live observation is called out with its consequence, not shown as if it were current", async () => {
  const observedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const stub = server(liveObservation({ sequence: 41, observedAt, ageMs: 5 * 60_000, stale: true, reason: "stale" }));
  await withPage(stub, async ({ page }) => {
    const vitals = page.visibleText("ov-vitals");
    assert.match(vitals, /The latest observation is stale/);
    assert.match(vitals, /read 5 min \d\d s ago/, "says how old the observation is");
    assert.match(vitals, /STALE_OBSERVATION/, "names the safety rule that applies");
    assert.match(vitals, /read-only actions still run/);
    assert.match(vitals, /Observation #41 · 5 min \d\d s ago · stale/, "the card subtitle agrees");
    assert.match(vitals, /Health\s*14 \/ 20/, "the last known values stay visible next to the warning");
  });
});

test("a fresh live observation carries no stale notice", async () => {
  const observedAt = new Date(Date.now() - 2_000).toISOString();
  const stub = server(liveObservation({ sequence: 42, observedAt, ageMs: 2_000, stale: false, reason: "fresh" }));
  await withPage(stub, async ({ page }) => {
    const vitals = page.visibleText("ov-vitals");
    assert.doesNotMatch(vitals, /stale/i);
    assert.doesNotMatch(vitals, /STALE_OBSERVATION/);
    assert.match(vitals, /Observation #42 · just now/);
  });
});

test("when nothing is being observed the page says that, rather than calling an absent observation stale", async () => {
  const stub = server((snapshot) => {
    idleSession(snapshot);
    snapshot.session.source = "live";
    snapshot.world.provenance = { source: "world-memory", note: "No live observation is available." };
    snapshot.world.freshness = { sequence: null, observedAt: null, ageMs: null, stale: true, reason: "no-observation" };
  });
  await withPage(stub, async ({ page }) => {
    const vitals = page.visibleText("ov-vitals");
    assert.match(vitals, /Nothing is being observed/);
    assert.match(vitals, /No observation yet/);
    assert.doesNotMatch(vitals, /The latest observation is stale/);
  });
});

test("with no session nothing is invented: the world is unknown, not a default", async () => {
  const stub = server((snapshot) => {
    snapshot.session = { ...snapshot.session, state: "none", source: null, target: null, worldKey: null, connectedAt: null, runtimeMs: null, canConnect: true, canStop: false };
    snapshot.world = { ...snapshot.world, health: null, food: null, position: null, dimension: null, gameMode: null, alive: null, inventory: [], provenance: { source: "none" }, freshness: { reason: "no-observation", ageMs: null } };
    snapshot.scheduler = null;
  });
  await withPage(stub, async ({ page }) => {
    assert.equal(page.visibleText("session-pill-text"), "No session");
    assert.equal(page.visibleText("source-badge"), "UNAVAILABLE");
    const vitals = page.visibleText("ov-vitals");
    assert.match(vitals, /Health\s*unknown/);
    assert.match(vitals, /Food\s*unknown/);
    assert.match(vitals, /Position\s*unknown/);
    assert.doesNotMatch(vitals, /Health\s*0|Food\s*0|20 \/ 20/);
    assert.equal(page.byId("panic-btn").disabled, true);
  });
});

// ---- commands -----------------------------------------------------------------------------------------

test("a destructive button asks first, and declining sends nothing", async () => {
  const stub = server(idleSession);
  await withPage(stub, async ({ page, settle }) => {
    const stop = page.button("Stop session", "ov-controls");
    page.window.confirmAnswer = false;
    page.click(stop);
    await settle();
    assert.deepEqual(stub.commands(), []);
    assert.match(page.window.confirmations.at(-1) ?? "", /Stop the session/);
    page.window.confirmAnswer = true;
    page.click(page.button("Stop session", "ov-controls"));
    await settle();
    assert.deepEqual(stub.commands().map((c) => c.type), ["stopSession"]);
  });
});

test("the same command is not sent twice while it is in flight, and its answer becomes a toast", async () => {
  const stub = server(idleSession);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = stub.fetch;
  const slow: StubServer["fetch"] = async (input, init) => {
    if (init?.method === "POST") await gate;
    return original(input, init);
  };
  const booted = await bootPage({ fetch: slow });
  try {
    const { page } = booted;
    const pause = page.button("Pause", "ov-controls");
    page.click(pause);
    page.click(pause);
    release();
    await booted.settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(stub.commands().map((c) => c.type), ["pause"], "one request for two clicks");
    assert.match(page.visibleText("toasts"), /pause accepted/i);
    assert.match(page.byId("toasts").children[0]?.className ?? "", /good/);
  } finally {
    booted.app.stop();
    booted.restore();
  }
});

test("a refused command is shown as a refusal with the server's reason", async () => {
  const stub = server((snapshot) => {
    idleSession(snapshot);
    snapshot.scheduler.active = { ticketId: "t1", label: "Gather logs", origin: "control-center", status: "running", startedAt: new Date().toISOString() };
  });
  stub.commandResults.stopTask = { status: 409, body: { ok: false, message: "The task already finished." } };
  await withPage(stub, async ({ page, settle }) => {
    page.click(page.button("Stop task", "ov-controls"));
    await settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(page.visibleText("toasts"), /Not done.*The task already finished\./);
    assert.match(page.byId("toasts").children[0]?.className ?? "", /bad/);
  });
});

test("quitting the app stops the page from polling a process that is gone and says how to start it again", async () => {
  const stub = server(idleSession);
  await withPage(stub, async ({ page, settle, app }) => {
    page.click("footer-quit");
    await settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(stub.commands().map((c) => c.type), ["shutdownApp"]);
    assert.equal(page.window.confirmations.length > 0, true, "quitting is confirmed first");
    assert.equal(app.store.isRunning, false, "polling stopped");
    assert.equal(page.byId("lost").hasAttribute("hidden"), false);
    assert.match(page.visibleText("lost"), /python3 main\.py/);
    assert.equal(page.visibleText("session-pill-text"), "GameMind has shut down");
  });
});

test("the emergency stop is only offered when there is something to stop", async () => {
  const idle = server(idleSession);
  await withPage(idle, async ({ page, settle }) => {
    assert.equal(page.byId("panic-btn").disabled, false);
    page.click("panic-btn");
    await settle();
    assert.deepEqual(idle.commands().map((c) => c.type), ["panic"]);
  });
  await withPage(server((snapshot) => {
    snapshot.session.state = "shutdown";
  }), async ({ page }) => {
    assert.equal(page.byId("panic-btn").disabled, true);
  });
});

// ---- connect form ----------------------------------------------------------------------------------------

async function openBots(stub: StubServer, run: (booted: BootedPage) => Promise<void>): Promise<void> {
  await withPage(stub, async (booted) => {
    await openTab(booted, "bots");
    await run(booted);
  });
}

test("connecting to a live server sends only what was typed, with numbers as numbers", async () => {
  const stub = server((snapshot) => {
    snapshot.session.state = "none";
    snapshot.session.canConnect = true;
  });
  await openBots(stub, async ({ page, settle }) => {
    assert.equal(page.byId("connect-source").value, "live");
    assert.equal(page.byId("connect-live-fields").hasAttribute("hidden"), false);
    assert.equal(page.byId("connect-sim-fields").hasAttribute("hidden"), true);
    page.type("connect-host", "192.168.1.50");
    page.type("connect-port", "25570");
    page.type("connect-username", "Scout");
    page.choose("connect-mode", "persistent");
    page.click("connect-submit");
    await settle();
    assert.deepEqual(stub.commands(), [{ type: "connectSession", payload: { source: "live", mode: "persistent", autonomy: true, host: "192.168.1.50", port: 25570, username: "Scout" } }]);
  });
});

test("the connect form refuses a bad port before sending anything", async () => {
  const stub = server((snapshot) => {
    snapshot.session.state = "none";
    snapshot.session.canConnect = true;
  });
  await openBots(stub, async ({ page, settle }) => {
    for (const bad of ["0", "70000", "25.5", "abc"]) {
      page.type("connect-port", bad);
      page.click("connect-submit");
      await settle();
    }
    assert.deepEqual(stub.commands(), []);
    assert.match(page.visibleText("toasts"), /port must be a whole number from 1 to 65535/);
  });
});

test("the simulator is offered as its own choice, with every scenario, and says it involves no server", async () => {
  const stub = server((snapshot) => {
    snapshot.session.state = "none";
    snapshot.session.canConnect = true;
  });
  await openBots(stub, async ({ page, settle }) => {
    page.choose("connect-source", "simulated");
    assert.equal(page.byId("connect-sim-fields").hasAttribute("hidden"), false);
    assert.equal(page.byId("connect-live-fields").hasAttribute("hidden"), true);
    const scenarios = page.byId("connect-scenario").options;
    assert.ok(scenarios.length >= 20, `scenarios come from the agent's own list (${scenarios.length})`);
    assert.equal(page.byId("connect-scenario").value, "explore-remote-log");
    page.choose("connect-scenario", "food-dropped-bread");
    page.check("connect-autonomy", false);
    page.click("connect-submit");
    await settle();
    assert.deepEqual(stub.commands(), [{ type: "connectSession", payload: { source: "simulated", mode: "persistent", autonomy: false, scenarioId: "food-dropped-bread" } }]);
  });
});

test("while a session exists the connect form is disabled and says why", async () => {
  await openBots(server(idleSession), async ({ page }) => {
    assert.equal(page.byId("connect-submit").disabled, true);
    assert.match(page.visibleText("connect-hint"), /session is connected · idle.*Stop it/i);
  });
});

test("under WSL the form suggests the Windows host instead of loopback", async () => {
  const stub = server(
    (snapshot) => {
      snapshot.session.state = "none";
      snapshot.session.canConnect = true;
    },
    { diagnostics: { ...(real.queries.diagnostics as object), windowsHost: { addresses: ["172.29.208.1"], gateway: "172.29.208.1", nameserver: null } } },
  );
  await openBots(stub, async ({ page, settle }) => {
    assert.equal(page.byId("connect-wsl-hint").hasAttribute("hidden"), false);
    assert.match(page.visibleText("connect-wsl-hint"), /Windows side.*172\.29\.208\.1/);
    page.click("connect-use-windows");
    assert.equal(page.byId("connect-host").value, "172.29.208.1");
    page.click("connect-submit");
    await settle();
    assert.equal((stub.commands()[0]?.payload as { host: string }).host, "172.29.208.1");
  });
});

// ---- task form -------------------------------------------------------------------------------------------

async function openTasks(stub: StubServer, run: (booted: BootedPage) => Promise<void>): Promise<void> {
  await withPage(stub, async (booted) => {
    await openTab(booted, "tasks");
    await run(booted);
  });
}

test("the task form offers exactly the implemented tasks and shows each one's fixed limits", async () => {
  await openTasks(server(idleSession), async ({ page }) => {
    const kinds = page.byId("task-kind").options.map((option) => option.value);
    assert.deepEqual(kinds, (real.queries.tasks as { tasks: Array<{ kind: string }> }).tasks.map((task) => task.kind));
    assert.ok(kinds.includes("gather-logs") && kinds.includes("craft-wooden-pickaxe"));
    assert.match(page.visibleText("task-limits"), /Action budget: \d+ actions/);
    assert.match(page.visibleText("task-limits"), /Time limit:/);
    assert.match(page.visibleText("task-limits"), /Stops after: \d+ failed actions in a row/);
    assert.equal(page.byId("task-resource-row").hasAttribute("hidden"), false);
    page.choose("task-kind", "build-shelter");
    assert.equal(page.byId("task-resource-row").hasAttribute("hidden"), true, "a shelter has no resource to choose");
    assert.equal(page.byId("task-count-row").hasAttribute("hidden"), true);
    page.choose("task-kind", "craft-wooden-pickaxe");
    assert.match(page.visibleText("task-resource-label"), /Item to craft/);
    assert.ok(page.byId("task-resource").options.length > 0);
  });
});

test("starting a task sends the chosen kind, resource and amount, and refuses an amount outside the limits", async () => {
  const stub = server(idleSession);
  await openTasks(stub, async ({ page, settle }) => {
    page.choose("task-kind", "gather-logs");
    page.choose("task-resource", "birch_log");
    const max = Number(page.byId("task-count").max);
    page.type("task-count", String(max + 1));
    page.click("task-submit");
    await settle();
    assert.deepEqual(stub.commands(), [], "above the limit: nothing is sent");
    assert.match(page.visibleText("toasts"), /amount must be a whole number from 1 to/);
    page.type("task-count", "3");
    page.click("task-submit");
    await settle();
    assert.deepEqual(stub.commands(), [{ type: "startTask", payload: { kind: "gather-logs", queue: false, resource: "birch_log", count: 3 } }]);
  });
});

test("while a task runs a second one cannot overlap: it is blocked unless queued, and a full queue says so", async () => {
  const running = (snapshot: Snapshot): void => {
    idleSession(snapshot);
    snapshot.session.state = "running";
    snapshot.scheduler.active = { ticketId: "t1", label: "Gather logs", origin: "control-center", status: "running", startedAt: new Date().toISOString() };
  };
  await openTasks(server(running), async ({ page, settle }) => {
    assert.equal(page.byId("task-submit").disabled, true);
    assert.match(page.visibleText("task-hint"), /A task is running \(Gather logs\).*queue.*never run at the same time/);
    page.check("task-queue", true);
    await settle();
    assert.equal(page.byId("task-submit").disabled, false);
    assert.equal(page.visibleText("task-submit"), "Queue task");
  });
  const stub = server(running);
  await openTasks(stub, async ({ page, settle }) => {
    page.check("task-queue", true);
    page.click("task-submit");
    await settle();
    assert.equal((stub.commands()[0]?.payload as { queue: boolean }).queue, true);
  });
  const full = (snapshot: Snapshot): void => {
    running(snapshot);
    snapshot.scheduler.queue = Array.from({ length: snapshot.scheduler.limits.maxQueue }, (_, index) => ({ ticketId: `q${index}`, label: `Queued ${index}`, origin: "control-center", status: "queued", position: index + 1 }));
  };
  await openTasks(server(full), async ({ page }) => {
    page.check("task-queue", true);
    assert.equal(page.byId("task-submit").disabled, true);
    assert.match(page.visibleText("task-hint"), /queue is full/);
  });
});

test("when no task can start the form says exactly why", async () => {
  const cases: Array<[string, (snapshot: Snapshot) => void, RegExp]> = [
    ["no session", (s) => { s.session.state = "none"; s.scheduler = null; }, /no session/i],
    ["connecting", (s) => { s.session.state = "connecting"; }, /connecting/],
    ["ended", (s) => { s.session.state = "shutdown"; }, /session has ended/i],
    ["safety trip", (s) => { idleSession(s); s.safety.tripped = true; }, /safety trip/i],
    ["paused", (s) => { idleSession(s); s.safety.paused = true; }, /paused/i],
  ];
  for (const [name, change, expected] of cases) {
    await openTasks(server(change), async ({ page }) => {
      assert.equal(page.byId("task-submit").disabled, true, name);
      assert.match(page.visibleText("task-hint"), expected, name);
    });
  }
});

// ---- training form ----------------------------------------------------------------------------------------

const preflightWith = (overrides: Record<string, unknown> = {}, existing: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...(clone(real.queries["training-preflight"]) as Record<string, unknown>),
  directoryName: "training",
  directories: ["roadmap-run", "training"],
  ...overrides,
  existing: { ...((real.queries["training-preflight"] as { existing: object }).existing), ...existing },
});

async function openTraining(stub: StubServer, run: (booted: BootedPage) => Promise<void>): Promise<void> {
  await withPage(stub, async (booted) => {
    await openTab(booted, "training");
    await run(booted);
  });
}

// ---- decisions ------------------------------------------------------------------------------------------------

const decisionSkills = new Set([
  "minecraft.navigate", "minecraft.collect-log", "minecraft.mine-block", "minecraft.place-block", "minecraft.build-shelter",
  "minecraft.eat-food", "minecraft.pickup-item", "minecraft.rest", "minecraft.orient", "minecraft.inspect-block",
]);

interface DecisionData {
  summary: string;
  blockingCode?: string | null;
  selected: { goalId: string; targetKey: string | null; input: unknown; rationale: string } | null;
  alternatives: Array<{ targetKey: string | null }>;
  rejected: Array<{ reason: string; detail: string; targetKey: string | null }>;
}

/** A decision from the real decision model, shaped as the snapshot carries it (the trace event's view). */
function realDecision(state: Parameters<MinecraftTaskDecisionModel["decide"]>[0], task: Parameters<MinecraftTaskDecisionModel["decide"]>[1]): { event: Record<string, unknown>; data: DecisionData } {
  const record = new MinecraftTaskDecisionModel().decide(state, task, { excludedTargets: new Set<string>(), previousFailureCode: null, availableSkills: decisionSkills }, 1);
  const data = JSON.parse(JSON.stringify(record)) as DecisionData;
  return { event: { traceId: "trace-1", eventType: "decision.made", timestamp: new Date().toISOString(), correlationId: null, data }, data };
}

test("the Tasks tab explains the latest decision: what was chosen, what was rejected and why, and no block coordinates", async () => {
  const lava = observationAt({ x: 0.5, y: 64, z: 0.5 }, { nearbyBlocks: [block("lava", 1, 64, 0), block("grass_block", 0, 63, 0), block("oak_log", 5, 64, 0)] });
  const { event, data } = realDecision(lava, gatherResourceTaskSchema.parse({ id: "t", resourceName: "oak_log", targetCount: 1, maxActions: 10 }));
  assert.equal(data.selected?.goalId, "avoid-hazard", "the fixture is the real model's answer, not a hand-written one");
  const overtaken = data.rejected.find((entry) => entry.reason === "lower_band");
  assert.ok(overtaken, "the real record explains the goal it put aside");
  await openTasks(server((snapshot) => { idleSession(snapshot); snapshot.recentDecisions = [event]; }), async ({ page }) => {
    const text = page.visibleText("tasks-decision");
    assert.match(text, /Latest decision/);
    assert.ok(text.includes(data.summary), "the model's own summary is shown");
    assert.match(text, /avoid-hazard/);
    assert.match(text, /Safety \(band 0\)/);
    assert.ok(text.includes(data.selected?.rationale ?? "missing"), "the reason it chose this is shown verbatim");
    assert.match(text, /Rejected candidates \(1\)/);
    assert.match(text, /lower band/);
    assert.ok(text.includes(overtaken.detail), "the reason each candidate was dropped is the model's own detail text");
    assert.match(text, /survival · single-source/, "the game mode the decision was made under is shown with its evidence");
    assert.ok(!text.includes(data.selected?.targetKey ?? "missing"), "a target key holds block coordinates and is not shown");
    assert.ok(!/"x"|"z"|\bx:|-4,64,5/.test(text), "a candidate's input is not dumped onto the page");
  });
});

test("a decision that stopped the task shows its blocking code and reason, and a verdict the record lacks reads unknown", async () => {
  const bare = observationAt({ x: 0.5, y: 64, z: 0.5 }, { nearbyBlocks: [block("grass_block", 0, 63, 0)], inventory: [] });
  const { event, data } = realDecision(bare, buildShelterTaskSchema.parse({ id: "t-shelter", maxBlocks: 4, maxActions: 10 }));
  assert.equal(data.selected, null);
  assert.equal(data.blockingCode, "TASK_BLOCKED_SHELTER");
  await openTasks(server((snapshot) => { idleSession(snapshot); snapshot.recentDecisions = [event]; }), async ({ page }) => {
    const text = page.visibleText("tasks-decision");
    assert.ok(text.includes("TASK_BLOCKED_SHELTER"), "the blocking code is a badge on the card");
    assert.ok(text.includes(data.summary));
    assert.match(text, /None: the model stopped without choosing/);
    assert.ok(text.includes(data.rejected[0]?.detail ?? "missing"), "why the only candidate was dropped");
    assert.match(text, /Safety verdict\s*unknown/, "no verdict was recorded, and the page does not make one up");
    assert.ok(!/Exploration switch/.test(text), "a row that does not apply is left out rather than shown as unknown");
  });
});

test("with no decision recorded the card says so instead of showing an empty table", async () => {
  await openTasks(server((snapshot) => { idleSession(snapshot); snapshot.recentDecisions = []; }), async ({ page }) => {
    const text = page.visibleText("tasks-decision");
    assert.match(text, /No decision recorded yet/);
    assert.ok(!/Alternatives considered|Rejected candidates/.test(text));
  });
});

test("training defaults to resume, and a fresh start explains what it archives and waits for a confirmation", async () => {
  const stub = server(undefined, {
    "training-preflight": preflightWith(
      {
        busy: false,
        resume: { possible: true, summary: "Resumes at episode 40 in stage 2." },
        fresh: { needsConfirmation: true, wouldArchive: ["state.json", "checkpoints"], summary: "Archives the saved run.", consequences: ["The policy starts empty again.", "Nothing is deleted: the old run is moved aside."] },
      },
      { hasRun: true, status: "stopped", episodes: 40, stageId: "tools", checkpoints: 2, experienceFiles: 1, evaluations: 0, stageIds: null, updatedAt: null },
    ),
  });
  await openTraining(stub, async ({ page, settle }) => {
    assert.equal(page.byId("training-mode-resume").checked, true, "resume is the default");
    assert.equal(page.byId("training-mode-fresh").checked, false);
    assert.equal(page.byId("training-confirm-row").hasAttribute("hidden"), true);
    assert.equal(page.byId("training-start").disabled, false);
    assert.match(page.visibleText("training-preflight"), /Resumes at episode 40/);

    page.click("training-mode-fresh");
    await settle();
    assert.equal(page.byId("training-confirm-row").hasAttribute("hidden"), false, "a fresh start over an existing run needs its own confirmation");
    assert.match(page.visibleText("training-preflight"), /policy starts empty again/);
    assert.match(page.visibleText("training-preflight"), /Nothing is deleted/);
    assert.equal(page.byId("training-start").disabled, true);
    assert.match(page.visibleText("training-start-hint"), /confirm the fresh start/);

    page.click("training-confirm-fresh");
    assert.equal(page.byId("training-start").disabled, false);
    page.window.confirmAnswer = false;
    page.click("training-start");
    await settle();
    assert.deepEqual(stub.commands(), [], "declining the final question sends nothing");
    assert.match(page.window.confirmations.at(-1) ?? "", /archived first \(nothing is deleted\)/);
    page.window.confirmAnswer = true;
    page.click("training-start");
    await settle();
    assert.deepEqual(stub.commands(), [{ type: "startTraining", payload: { directory: "training", fresh: true, confirmFresh: true } }]);
  });
});

test("an empty folder starts a new run without any confirmation, and resume is what is sent by default", async () => {
  const stub = server(undefined, { "training-preflight": preflightWith({ resume: { possible: false, summary: "No saved run." }, fresh: { needsConfirmation: false, wouldArchive: [], summary: "", consequences: [] } }, { hasRun: false }) });
  await openTraining(stub, async ({ page, settle }) => {
    page.type("training-max-episodes", "24");
    page.type("training-minutes", "10");
    page.type("training-explore", "0.2");
    page.click("training-start");
    await settle();
    assert.deepEqual(stub.commands(), [{ type: "startTraining", payload: { directory: "training", fresh: false, confirmFresh: false, maxEpisodes: 24, maxMinutes: 10, explorationRate: 0.2 } }]);
    assert.deepEqual(page.window.confirmations, [], "no confirmation is asked when nothing can be lost");
  });
});

test("training budgets outside their limits are refused on the page, and stages are chosen only for a new run", async () => {
  const stub = server(undefined, { "training-preflight": preflightWith({ resume: { possible: false, summary: "" }, fresh: { needsConfirmation: false, wouldArchive: [], summary: "", consequences: [] } }, { hasRun: false }) });
  await openTraining(stub, async ({ page, settle }) => {
    const limit = Number(page.byId("training-max-episodes").max);
    for (const [id, bad] of [["training-max-episodes", String(limit + 1)], ["training-max-episodes", "0"], ["training-max-episodes", "1.5"], ["training-minutes", "100000"], ["training-explore", "3"]] as const) {
      page.type(id, bad);
      page.click("training-start");
      await settle();
      page.type(id, "");
    }
    assert.deepEqual(stub.commands(), []);
    assert.match(page.visibleText("toasts"), /must be (a whole number|a number) from/);

    const stages = page.all("input", "training-stages");
    assert.ok(stages.length >= 3, "stages come from the runner's own curriculum");
    assert.ok(stages.every((stage) => stage.checked && !stage.disabled));
    for (const stage of stages) page.check(stage, false);
    page.click("training-start");
    await settle();
    assert.match(page.visibleText("toasts"), /Choose at least one curriculum stage/);
    assert.deepEqual(stub.commands(), []);
    page.check(stages[1] as FakeElement, true);
    page.click("training-start");
    await settle();
    assert.deepEqual((stub.commands()[0]?.payload as { stageIds: string[] }).stageIds, [stages[1]?.value]);
  });
});

test("while a run is active the form cannot start another and pause, resume and stop follow the real state", async () => {
  const states: Array<[string, Record<string, unknown>, Record<string, boolean>]> = [
    ["running", { status: "running", processAlive: true, pid: 4242 }, { start: true, pause: false, resume: true, stop: false }],
    ["paused", { status: "paused", processAlive: true, pid: 4242 }, { start: true, pause: true, resume: false, stop: false }],
    ["interrupted", { status: "interrupted", processAlive: false, pid: null }, { start: false, pause: true, resume: false, stop: true }],
    ["idle", { status: "idle", processAlive: false, pid: null }, { start: false, pause: true, resume: true, stop: true }],
  ];
  for (const [name, training, disabled] of states) {
    const stub = server((snapshot) => {
      Object.assign(snapshot.training, training);
    }, { "training-preflight": preflightWith({ busy: training.processAlive === true, resume: { possible: true, summary: "Resumes the saved run." } }, { hasRun: true }) });
    await openTraining(stub, async ({ page }) => {
      assert.equal(page.byId("training-start").disabled, disabled.start, `${name}: start disabled`);
      assert.equal(page.byId("training-pause").disabled, disabled.pause, `${name}: pause disabled`);
      assert.equal(page.byId("training-resume").disabled, disabled.resume, `${name}: resume disabled`);
      assert.equal(page.byId("training-stop").disabled, disabled.stop, `${name}: stop disabled`);
    });
  }
});

test("the buttons send the real training commands, and the folder picker selects through the server", async () => {
  const stub = server((snapshot) => {
    Object.assign(snapshot.training, { status: "paused", processAlive: true, pid: 4242 });
  }, { "training-preflight": (params: URLSearchParams) => preflightWith({ directoryName: params.get("directory") ?? "training", directories: ["other-run", "training"], busy: true }) });
  await openTraining(stub, async ({ page, settle }) => {
    page.click("training-resume");
    await settle();
    page.window.confirmAnswer = true;
    assert.deepEqual(stub.commands().map((c) => c.type), ["resumeTraining"]);
    const folders = page.byId("training-directory").options.map((option) => option.value);
    assert.deepEqual(folders, ["other-run", "training", "__new__"]);
    page.choose("training-directory", "other-run");
    await settle();
    await settle();
    assert.deepEqual(stub.commands().slice(1), [{ type: "selectTrainingDirectory", payload: "other-run" }]);
    assert.ok(stub.requests.some((request) => request.url.includes("api/training-preflight?directory=other-run")), "the preflight is asked about the chosen folder");

    page.choose("training-directory", "__new__");
    assert.equal(page.byId("training-new-directory").hasAttribute("hidden"), false);
    assert.equal(page.byId("training-start").disabled, true, "a new folder needs a name");
  });
});

// ---- evaluation and live verification ----------------------------------------------------------------------

async function openEvaluation(stub: StubServer, run: (booted: BootedPage) => Promise<void>): Promise<void> {
  await withPage(stub, async (booted) => {
    await openTab(booted, "evaluation");
    await run(booted);
  });
}

test("offline checks start through the job runner, one at a time, with the reason when they cannot", async () => {
  const stub = server();
  await openEvaluation(stub, async ({ page, settle }) => {
    page.click("run-tests");
    await settle();
    page.type("eval-seeds", "5");
    page.choose("eval-scenario", "explore-remote-log");
    page.click("run-eval");
    await settle();
    assert.deepEqual(stub.commands(), [
      { type: "runUnitTests", payload: undefined },
      { type: "runOfflineEvaluation", payload: { seeds: 5, scenarioId: "explore-remote-log" } },
    ]);
    page.type("eval-seeds", "0");
    page.click("run-eval");
    await settle();
    assert.match(page.visibleText("toasts"), /Seeds per scenario must be a whole number from 1 to 200/);
  });
  const busy = server((snapshot) => {
    snapshot.jobs = { busy: true, items: [{ id: "job-1", kind: "unit-tests", label: "Unit tests", status: "running", startedAt: new Date().toISOString(), outputTail: [] }] };
  });
  await openEvaluation(busy, async ({ page }) => {
    assert.equal(page.byId("run-tests").disabled, true);
    assert.equal(page.byId("run-eval").disabled, true);
    assert.match(page.visibleText("eval-hint"), /A job is running/);
  });
});

function checkpointReport(evaluationSet: Record<string, unknown> | null): Record<string, unknown> {
  const measure = (successRate: number, wasted: number) => ({ successRate, runs: 260, interval: { low: 0.68, high: 0.78 }, meanWastedActions: wasted, medianActions: 5 });
  return {
    checkpointId: "ckpt-000003",
    generatedAt: "2026-10-09T10:00:00.000Z",
    verdict: "not-promotable",
    conclusion: "identical-behaviour",
    weightsId: "w-1",
    learnedContexts: 2,
    evaluationSet,
    baseline: measure(0.7346, 0.64),
    candidate: measure(0.7346, 0.64),
    deltas: { successRate: 0, medianActions: 0, meanWastedActions: 0, unsafeActions: 0, deaths: 0 },
    behaviour: { pairedRuns: 260, runsWithDifferentChoices: 0, scenariosWithDifferentChoices: 0 },
    paired: { candidateBetter: 0, baselineBetter: 0, tied: 260 },
    baselineStability: { evaluationSetId: "abc", stable: true, firstRecordedAt: "2026-10-09T10:00:00.000Z", note: "First baseline recorded for this evaluation set; later evaluations must reproduce it." },
    reasons: ["No measured gain."],
    heldOut: { seeds: 10, disjointFromTraining: true, note: "Held-out worlds." },
    scenarios: [],
  };
}

test("the checkpoint comparison says which definition of progress and waste its figures use, and flags reports that predate it", async () => {
  const withDefinition = server(undefined, {
    evaluation: { ...clone(real.queries.evaluation as object), offline: { checkpointReports: [checkpointReport({ id: "aaa111", scenarios: 26, seedsPerScenario: 10, runs: 260, decisionModel: "m", progressDefinition: "verified-world-progress.v2" })] } },
  });
  await openEvaluation(withDefinition, async ({ page }) => {
    const text = page.visibleText("eval-compare");
    assert.match(text, /Progress definition\s*verified-world-progress\.v2/);
    assert.match(text, /no item or food gained, no new ground explored, not closer to the target, no healing, no retreat/, "the wasted-action note describes the current rules");
    assert.doesNotMatch(text, /no inventory or hunger gain/, "the old definition is not described as current");
    assert.match(text, /26 scenarios × 10 seeds = 260 runs \(id aaa111\)/);
  });
  const legacy = server(undefined, {
    evaluation: { ...clone(real.queries.evaluation as object), offline: { checkpointReports: [checkpointReport({ id: "bbb222", scenarios: 26, seedsPerScenario: 10, runs: 260, decisionModel: "m" })] } },
  });
  await openEvaluation(legacy, async ({ page }) => {
    const text = page.visibleText("eval-compare");
    assert.match(text, /Progress definition\s*v1 · item and food gains only/);
    assert.match(text, /not comparable with newer reports/);
  });
});

test("live verification stays disabled until the operator confirms, and world-changing checks need a second confirmation", async () => {
  const stub = server();
  await openEvaluation(stub, async ({ page, settle }) => {
    assert.equal(page.byId("live-host").value, "127.0.0.1", "defaults come from the server");
    assert.equal(page.byId("live-submit").disabled, true);
    assert.match(page.visibleText("live-hint"), /Confirm the connection/);
    assert.equal(page.byId("live-confirm-world-row").hasAttribute("hidden"), true);

    page.type("live-host", "10.0.0.5");
    page.type("live-port", "25599");
    assert.match(page.visibleText("live-confirm-text"), /10\.0\.0\.5:25599/, "the confirmation names the server it applies to");
    page.click("live-confirm");
    assert.equal(page.byId("live-submit").disabled, false, "a read-only check needs only the connection confirmation");
    page.click("live-scope-actions");
    page.click("live-allow-dig");
    assert.equal(page.byId("live-confirm-world-row").hasAttribute("hidden"), false);
    assert.equal(page.byId("live-submit").disabled, true, "digging changes the world: a second confirmation is required");
    assert.match(page.visibleText("live-hint"), /Confirm the world changes/);
    page.click("live-confirm-world");
    assert.equal(page.byId("live-submit").disabled, false);

    page.window.confirmAnswer = false;
    page.click("live-submit");
    await settle();
    assert.deepEqual(stub.commands(), [], "declining the last question sends nothing");
    assert.match(page.window.confirmations.at(-1) ?? "", /dig a block.*changes the world on that server/);
    page.window.confirmAnswer = true;
    page.click("live-submit");
    await settle();
    const payload = stub.commands()[0]?.payload as Record<string, unknown>;
    assert.equal(stub.commands()[0]?.type, "runLiveVerification");
    assert.deepEqual(payload, { host: "10.0.0.5", port: 25599, username: (real.queries.evaluation as { live: { defaults: { username: string } } }).live.defaults.username, scope: "actions", allowDig: true, allowCombat: false, confirmed: true, confirmedWorldChanges: true });

    page.click("live-allow-dig");
    assert.equal(page.byId("live-confirm-world").checked, false, "withdrawing the risky option withdraws its confirmation");
  });
});

test("an offline result is never worded as live: the page keeps them in separate, labelled cards", async () => {
  await openEvaluation(server(), async ({ page }) => {
    assert.match(page.visibleText("eval-notice"), /Offline and live results are kept apart/);
    assert.match(page.visibleText("eval-live"), /NOT VERIFIED LIVE|not been run|no live/i);
    assert.match(page.visibleText("eval-compare"), /OFFLINE/);
    assert.doesNotMatch(page.visibleText("eval-compare"), /\bLIVE\b/);
  });
});

// ---- memory and events ------------------------------------------------------------------------------------

async function openMemory(stub: StubServer, run: (booted: BootedPage) => Promise<void>): Promise<void> {
  await withPage(stub, async (booted) => {
    await openTab(booted, "memory");
    await run(booted);
  });
}

test("the event log search is debounced, sends its filters explicitly, and the live view can be paused", async () => {
  const stub = server();
  await openMemory(stub, async ({ page, settle, clock }) => {
    const eventRequests = () => stub.requests.filter((request) => request.url.includes("api/events")).map((request) => new URL(request.url, "http://x/").searchParams);
    assert.equal(eventRequests().at(-1)?.get("level"), "info", "the default 'info and above' is sent, not left to a server default");
    assert.ok(page.all("input", "event-categories").length >= 10, "categories are built from the event vocabulary");

    const before = eventRequests().length;
    page.document.dispatch(page.byId("event-q"), "input");
    page.byId("event-q").value = "zomb";
    page.document.dispatch(page.byId("event-q"), "input");
    page.byId("event-q").value = "zombie";
    page.document.dispatch(page.byId("event-q"), "input");
    await clock.advance(100);
    assert.equal(eventRequests().length, before, "typing does not query on every keystroke");
    await clock.advance(200);
    await settle();
    assert.equal(eventRequests().length, before + 1, "one query after the pause in typing");
    assert.equal(eventRequests().at(-1)?.get("q"), "zombie");

    page.choose("event-level", "error");
    page.choose("event-scope", "current");
    page.check(page.all("input", "event-categories")[0] as FakeElement, true);
    await settle();
    const last = eventRequests().at(-1);
    assert.equal(last?.get("level"), "error");
    assert.equal(last?.get("scope"), "current");
    assert.ok((last?.get("category") ?? "").length > 0);

    page.click(page.button(/Pause live view/));
    await settle();
    const paused = eventRequests().length;
    await clock.advance(60_000);
    await settle();
    await settle();
    assert.equal(eventRequests().length, paused, "a paused log is not polled");
    page.click(page.button(/Resume live view|Go live|Live/));
    await settle();
    assert.ok(eventRequests().length > paused);
  });
});

test("event text from the game or a server can never inject markup into the page", async () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const stub = server((snapshot) => {
    snapshot.events = { latestSeq: 1, total: 1, items: [{ boot: "b", seq: 1, at: new Date().toISOString(), level: "warn", category: "error", code: "X", message: hostile, source: "live", data: {} }] };
  }, {
    events: { total: 1, matched: 1, latestSeq: 1, events: [{ boot: "b", seq: 1, at: new Date().toISOString(), level: "warn", category: "error", code: "X", message: hostile, source: "live", data: {} }] },
  });
  await withPage(stub, async (booted) => {
    const { page } = booted;
    assert.equal(page.all("img").length, 0);
    assert.match(page.visibleText("ov-activity"), /<img src=x onerror="alert\(1\)">/, "shown as text");
    await openTab(booted, "memory");
    assert.equal(page.all("img").length, 0);
    assert.equal(page.all("script").filter((script) => script.getAttribute("type") !== "module" && script.getAttribute("type") !== "application/json").length, 0);
    assert.match(page.visibleText("mem-events"), /<img src=x/);
  });
});

test("the world seed is saved or cleared through the real command, and typing into it is never overwritten by a poll", async () => {
  const stub = server();
  await openMemory(stub, async ({ page, settle, app }) => {
    page.document.dispatch(page.byId("seed-input"), "input");
    page.byId("seed-input").value = "12345";
    page.document.dispatch(page.byId("seed-input"), "input");
    await app.store.tick();
    assert.equal(page.byId("seed-input").value, "12345", "a poll did not reset what is being typed");
    page.click(page.button("Save seed"));
    await settle();
    page.click("seed-clear");
    await settle();
    assert.deepEqual(stub.commands(), [{ type: "setWorldSeed", payload: "12345" }, { type: "setWorldSeed", payload: null }]);
  });
});

// ---- library entries with parameters ----------------------------------------------------------------------

test("a Library action with parameters gets an inline form that survives polling and submits typed values", async () => {
  const entry = {
    id: "navigation.goto",
    category: "Movement",
    title: "Walk to a position",
    description: "Walks to a nearby coordinate.",
    status: "implemented",
    statusReason: null,
    requiresConnection: true,
    params: [
      { name: "x", label: "X", type: "integer", required: true },
      { name: "z", label: "Z", type: "integer", required: true, min: -500, max: 500 },
      { name: "sprint", label: "Sprint", type: "boolean", required: false, def: false },
      { name: "note", label: "Note", type: "string", required: false, maxLength: 20 },
      { name: "mode", label: "Mode", type: "select", required: true, def: "careful", options: [{ value: "careful", label: "Careful" }, { value: "fast", label: "Fast" }] },
    ],
  };
  const stub = server((snapshot) => {
    idleSession(snapshot);
    snapshot.library = { catalog: [entry], operations: [] };
  });
  await openBots(stub, async ({ page, settle, app }) => {
    const form = page.all("form[data-library-id]")[0];
    assert.ok(form, "the entry has its own form");
    page.type("lib-navigation.goto-x", "10");
    page.type("lib-navigation.goto-z", "-4");
    page.check("lib-navigation.goto-sprint", true);
    await app.store.tick();
    await settle();
    assert.equal(page.byId("lib-navigation.goto-x").value, "10", "typed values survive a refresh");
    assert.equal(page.all("form[data-library-id]")[0], form, "the form is the same element after a refresh");
    page.type("lib-navigation.goto-note", "  hello  ");
    page.choose("lib-navigation.goto-mode", "fast");
    page.click(page.button("Run", "bots-library"));
    await settle();
    assert.deepEqual(stub.commands(), [{ type: "libraryExecute", payload: { id: "navigation.goto", params: { x: 10, z: -4, sprint: true, note: "hello", mode: "fast" } } }]);

    page.type("lib-navigation.goto-x", "1.5");
    page.click(page.button("Run", "bots-library"));
    await settle();
    assert.equal(stub.commands().length, 1, "a non-integer for an integer field is refused on the page");
    assert.match(page.visibleText("toasts"), /X must be a whole number/);
  });
});
