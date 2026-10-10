/**
 * The page against a real GameMindApp: the HTML is fetched from the real server (so it carries the real control token), the
 * page's own fetch talks to the real HTTP API, and the session behind it is the offline simulator. Nothing here involves a
 * Minecraft server; it shows that the page and the app agree on every route, command and shape.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { FakeElement } from "./support/fake-dom.js";
import { PUBLIC_DIRECTORY, bootPage, loadUi, serverFetch, servedHtml, waitUntil, type BootedPage } from "./support/ui-harness.js";
import { SIMULATED_CONNECT, startUiApp, type UiApp } from "./support/ui-fixtures.js";

const modules = await loadUi();

interface Logged {
  readonly method: string;
  readonly url: string;
  readonly type?: string;
  readonly status: number;
  readonly message?: string;
}

/** A fetch against the real server that remembers every request and the status it got. */
function recordingFetch(base: string, log: Logged[]): (input: string, init?: any) => Promise<Response> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const inner = serverFetch(base);
  return async (input, init) => {
    const response = await inner(input, init);
    const method = init?.method ?? "GET";
    let type: string | undefined;
    let message: string | undefined;
    if (method === "POST") {
      type = (JSON.parse(String(init?.body)) as { type: string }).type;
      message = ((await response.clone().json()) as { message?: string }).message;
    }
    log.push({ method, url: String(input), ...(type ? { type } : {}), status: response.status, ...(message ? { message } : {}) });
    return response;
  };
}

/** Read through a function so TypeScript does not narrow the live session from an earlier assertion. */
function sessionOf(fixture: UiApp): UiApp["app"]["session"] {
  return fixture.app.session;
}

async function openPage(fixture: UiApp, log: Logged[] = []): Promise<BootedPage> {
  return bootPage({ fetch: recordingFetch(fixture.base, log), html: await servedHtml(fixture.base) });
}

/** Polls until the page shows what is expected (the server's snapshot is briefly cached, so one poll may be a moment behind). */
async function until(booted: BootedPage, condition: () => boolean, message: string): Promise<void> {
  await waitUntil(async () => {
    await booted.settle();
    return condition();
  }, message);
}

async function openTab(booted: BootedPage, tab: string): Promise<void> {
  booted.page.click(`tab-${tab}`);
  await booted.settle();
  await booted.settle();
}

test("end to end: connect a simulated session from the page, run a task, reload without restarting anything, stop, and connect again", async () => {
  const fixture = await startUiApp();
  const log: Logged[] = [];
  let booted: BootedPage | null = null;
  try {
    booted = await openPage(fixture, log);
    const { page } = booted;
    assert.equal(sessionOf(fixture), null, "the Control Center is up before any session exists");
    assert.equal(page.visibleText("session-pill-text"), "No session");

    // Connect through the real form.
    await openTab(booted, "bots");
    page.choose("connect-source", "simulated");
    page.check("connect-autonomy", false);
    page.click("connect-submit");
    await waitUntil(() => sessionOf(fixture)?.state === "idle", "the session became idle");
    await until(booted, () => page.visibleText("session-pill-text") === "Connected · idle", "the pill shows connected · idle");
    assert.equal(page.visibleText("source-badge"), "SIMULATED");
    assert.match(page.visibleText("banner"), /simulated/i);
    assert.match(page.visibleText("bots-list"), /Simulated bot.*Connected · idle/);
    const firstSessionId = sessionOf(fixture)?.view().id;
    assert.ok(firstSessionId);

    // Run a task through the real form; the scheduler runs it and the page reports the measured outcome.
    await openTab(booted, "tasks");
    await until(booted, () => !page.byId("task-submit").disabled, "the task form is enabled");
    page.choose("task-kind", "gather-logs");
    page.type("task-count", "1");
    page.click("task-submit");
    await until(booted, () => /Gather 1 oak_log.*PASS/.test(page.visibleText("tasks-history")), "the finished task is listed as PASS");
    assert.match(page.visibleText("tasks-history"), /Gather 1 oak_log.*PASS/);
    await openTab(booted, "bots");
    assert.match(page.visibleText("bots-history"), /PASS/);
    assert.match(page.visibleText("bots-list"), /Last task\s*PASS/);
    assert.equal(sessionOf(fixture)?.state, "idle", "the task finished and the session stayed connected");

    // Reloading the page (a second page on the same server) restarts nothing and opens no browser.
    const commandsBefore = log.filter((entry) => entry.method === "POST").length;
    const opened = fixture.spawned.length;
    const reloadLog: Logged[] = [];
    const reloaded = await openPage(fixture, reloadLog);
    try {
      await until(reloaded, () => reloaded.page.visibleText("session-pill-text") === "Connected · idle", "the reloaded page shows the same session");
      assert.deepEqual(reloadLog.filter((entry) => entry.method !== "GET"), [], "reloading sends no command");
      assert.equal(sessionOf(fixture)?.view().id, firstSessionId, "the session is the one that was already running");
      assert.equal(fixture.spawned.length, opened, "reloading never opens another browser tab");
      assert.equal(log.filter((entry) => entry.method === "POST").length, commandsBefore);
    } finally {
      reloaded.app.stop();
      reloaded.restore();
    }

    // Stop it from the Overview: confirmed, the session ends and the Control Center stays up.
    await openTab(booted, "overview");
    page.window.confirmAnswer = true;
    page.click(page.button("Stop session", "ov-controls"));
    await waitUntil(() => sessionOf(fixture)?.state === "shutdown", "the session shut down");
    await until(booted, () => page.visibleText("session-pill-text") === "Disconnected", "the pill shows disconnected");
    assert.equal((await fixture.get<{ ok: boolean }>("api/health")).ok, true, "the Control Center is still serving");
    assert.equal(page.byId("panic-btn").disabled, true);
    await openTab(booted, "bots");
    await until(booted, () => !page.byId("connect-submit").disabled, "connecting is possible again");

    // And connect again: a new session under the same Control Center.
    page.choose("connect-source", "simulated");
    page.check("connect-autonomy", false);
    page.click("connect-submit");
    await waitUntil(() => sessionOf(fixture)?.state === "idle" && sessionOf(fixture)?.view().id !== firstSessionId, "a second session became idle");
    await until(booted, () => page.visibleText("session-pill-text") === "Connected · idle", "connected again");

    assert.deepEqual(page.window.console.errors, [], "the page reported no errors");
    const refusals = log.filter((entry) => entry.method === "POST" && entry.status >= 400);
    assert.deepEqual(refusals, [], "every command the page sent was accepted");
  } finally {
    booted?.app.stop();
    booted?.restore();
    await fixture.close();
  }
});

test("every tab of a real session draws without error, and the regions each view fills all exist on the page", async () => {
  const fixture = await startUiApp();
  let booted: BootedPage | null = null;
  try {
    const connected = await fixture.command("connectSession", SIMULATED_CONNECT);
    assert.equal(connected.status, 200, connected.body.message);
    await waitUntil(() => sessionOf(fixture)?.state === "idle", "idle");
    booted = await openPage(fixture);
    const { page } = booted;
    const tabs = ["overview", "training", "bots", "tasks", "evaluation", "learning", "memory"] as const;
    for (const tab of tabs) {
      await openTab(booted, tab);
      assert.equal(page.visibleText("render-error"), "", `${tab} drew without an error`);
      const ctx = {
        snapshot: booted.app.store.state.snapshot,
        data: { learning: booted.app.store.resource("learning"), memory: booted.app.store.resource("memory"), evaluation: booted.app.store.resource("evaluation"), tasks: booted.app.store.resource("tasks"), events: booted.app.store.resource("events"), preflight: booted.app.store.resource("training-preflight"), diagnostics: booted.app.store.resource("diagnostics") },
        ui: booted.app.ui,
        now: Date.now(),
        lost: false,
      };
      const render = modules.views[tab][`render${tab[0]?.toUpperCase()}${tab.slice(1)}`] as (ctx: unknown) => Record<string, unknown>;
      const regions = Object.keys(render(ctx));
      assert.ok(regions.length >= 3, `${tab} fills several regions`);
      const panel = page.byId(`panel-${tab}`);
      for (const id of regions) {
        const target = page.document.getElementById(id);
        assert.ok(target, `${tab}: the region #${id} exists on the page`);
        assert.ok(panel.descendants().includes(target as FakeElement), `${tab}: #${id} is inside its own panel`);
        assert.ok(page.visibleText(target as FakeElement).length > 0 || tab === "learning" || id === "training-reward", `${tab}: #${id} shows something (an empty state counts)`);
      }
    }
    assert.deepEqual(page.window.console.errors, []);
  } finally {
    booted?.app.stop();
    booted?.restore();
    await fixture.close();
  }
});

test("the page's controls and the app agree: every command the page can send exists, and nothing sends a command that is not listed", async () => {
  const fixture = await startUiApp();
  try {
    const sources: Record<string, string> = { "index.html": await readFile(path.join(PUBLIC_DIRECTORY, "index.html"), "utf8") };
    for (const directory of ["", "lib", "views"]) {
      for (const name of await readdir(path.join(PUBLIC_DIRECTORY, directory))) {
        if (name.endsWith(".js")) sources[path.join(directory, name)] = await readFile(path.join(PUBLIC_DIRECTORY, directory, name), "utf8");
      }
    }
    const found = new Set<string>();
    for (const [name, text] of Object.entries(sources)) {
      if (name.endsWith("model.js")) continue; // the list under test
      for (const match of text.matchAll(/data-command="(\w+)"/g)) found.add(match[1] as string);
      for (const match of text.matchAll(/\bcommand:\s*"(\w+)"/g)) found.add(match[1] as string);
      for (const match of text.matchAll(/\b(?:runCommand|send)\(\s*"(\w+)"/g)) found.add(match[1] as string);
      for (const match of text.matchAll(/\bsend\(\s*(?:[\w.]+\s*\?\s*)?"(\w+)"/g)) found.add(match[1] as string);
    }
    const listed = new Set<string>(modules.model.COMMANDS_USED);
    assert.deepEqual([...found].filter((command) => !listed.has(command)), [], "a command the page sends is missing from COMMANDS_USED");
    assert.deepEqual([...listed].filter((command) => !found.has(command)), [], "COMMANDS_USED lists a command nothing in the page sends");
    const served = new Set(fixture.app.commandNames);
    assert.deepEqual([...listed].filter((command) => !served.has(command)), [], "the page sends a command the app does not answer");
  } finally {
    await fixture.close();
  }
});

test("the controls that are enabled on a real idle session are all accepted by the app (no unknown command, no malformed payload)", async () => {
  const fixture = await startUiApp();
  const log: Logged[] = [];
  let booted: BootedPage | null = null;
  try {
    const connected = await fixture.command("connectSession", SIMULATED_CONNECT);
    assert.equal(connected.status, 200, connected.body.message);
    await waitUntil(() => sessionOf(fixture)?.state === "idle", "idle");
    booted = await openPage(fixture, log);
    const { page } = booted;
    // These start child processes, end the session or the app, or trip safety for the rest of the run: they are exercised
    // by their own tests (training-safety, app, lifecycle), not clicked here.
    const SKIPPED = new Set(["shutdownApp", "stopSession", "panic", "runUnitTests", "runOfflineEvaluation", "runLiveVerification", "startTraining", "evaluateTraining", "resumeTraining"]);
    const clicked = new Set<string>();
    page.window.confirmAnswer = true;
    for (const tab of ["overview", "bots", "tasks", "training", "evaluation", "learning", "memory"]) {
      await openTab(booted, tab);
      const controls = page.all("[data-command]").filter((button) => !page.isHidden(button) && !button.disabled);
      for (const control of controls) {
        const command = control.getAttribute("data-command") as string;
        const key = `${command}:${control.getAttribute("data-payload") ?? ""}`;
        if (SKIPPED.has(command) || clicked.has(key)) continue;
        clicked.add(key);
        page.click(control);
        await booted.settle();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    assert.ok(clicked.size >= 5, `several enabled controls were exercised (${[...clicked].join(", ")})`);
    const posts = log.filter((entry) => entry.method === "POST");
    assert.ok(posts.length >= 5);
    for (const entry of posts) {
      assert.notEqual(entry.status, 501, `${entry.type}: the app did not recognise the command (${entry.message})`);
      assert.notEqual(entry.status, 403, `${entry.type}: the page's token was refused`);
      assert.ok(entry.status === 200 || entry.status === 409, `${entry.type}: answered ${entry.status} (${entry.message}); only success or a stated refusal are expected`);
      assert.doesNotMatch(entry.message ?? "", /not available in this run|Unknown command|is not a valid/i, `${entry.type}: ${entry.message}`);
    }
    assert.deepEqual(page.window.console.errors, []);
  } finally {
    booted?.app.stop();
    booted?.restore();
    await fixture.close();
  }
});

test("the commands that start processes parse the exact payloads the page builds: invalid values are refused with a reason, not accepted", async () => {
  const fixture = await startUiApp();
  try {
    // The page builds these shapes (see ui-page.test.ts); out-of-range values must hit the server's own validation.
    const training = await fixture.command("startTraining", { directory: "training", fresh: false, confirmFresh: false, maxMinutes: 0 });
    assert.equal(training.status, 409);
    assert.match(training.body.message ?? "", /Time budget \(minutes\) must be a whole number/);
    const evaluation = await fixture.command("runOfflineEvaluation", { seeds: 0, scenarioId: "explore-remote-log" });
    assert.equal(evaluation.status, 409);
    const unknownScenario = await fixture.command("runOfflineEvaluation", { scenarioId: "no-such-scenario" });
    assert.equal(unknownScenario.status, 409);
    const live = await fixture.command("runLiveVerification", { host: "127.0.0.1", port: 25565, username: "GameMindCheck", scope: "actions", allowDig: true, allowCombat: false, confirmed: true, confirmedWorldChanges: false });
    assert.equal(live.status, 409);
    assert.match(live.body.message ?? "", /digging blocks changes the world/);
    assert.equal(fixture.app.jobs.busy, false, "the refused requests started nothing");
    assert.equal((await fixture.command("selectTrainingDirectory", "roadmap")).status, 409, "a folder GameMind keeps for something else is refused");
  } finally {
    await fixture.close();
  }
});
