// GameMind Control Center: the page controller.
//
// views/*.js turn data into markup, lib/store.js fetches and polls, and this file wires them to the page: tabs, forms,
// commands and toasts. It never starts or restarts anything by itself: reloading the page only reads, and every change
// goes through an explicit command the operator triggered.
import { h, mount } from "./lib/h.js";
import { createApi } from "./lib/api.js";
import { POLL_HIDDEN_MS, POLL_VISIBLE_MS, createStore } from "./lib/store.js";
import { SOURCES, queueExplanation, sessionInfo, taskBlocker, worldSource } from "./lib/model.js";
import { fmtDuration, fmtNumber, humanise } from "./lib/format.js";
import { DEFAULT_LANGUAGE, LANGUAGES, applyTranslations, isLanguage, setLanguage as applyLanguage, translate } from "./lib/i18n.js";
import { card, notice } from "./lib/ui.js";
import { renderOverview } from "./views/overview.js";
import { renderBots } from "./views/bots.js";
import { renderTasks } from "./views/tasks.js";
import { renderEvaluation } from "./views/evaluation.js";
import { renderLearning } from "./views/learning.js";
import { renderMemory, EVENT_CATEGORIES } from "./views/memory.js";

export const TABS = ["overview", "bots", "tasks", "evaluation", "learning", "memory"];

const VIEWS = {
  overview: renderOverview,
  bots: renderBots,
  tasks: renderTasks,
  evaluation: renderEvaluation,
  learning: renderLearning,
  memory: renderMemory,
};

const THEME_KEY = "gamemind.theme";
const LANGUAGE_KEY = "gamemind.language";
const EVENT_LIMIT = 300;

export function tabFromHash(hash) {
  const name = String(hash ?? "").replace(/^#\/?/, "");
  return TABS.includes(name) ? name : null;
}

/** The detail queries the page needs for a tab, with how often each is worth asking again. */
export function wantedResources(ui) {
  const list = [{ name: "tasks", everyMs: 30000 }];
  if (ui.tab === "bots") {
    list.push({ name: "diagnostics", everyMs: 30000 });
    list.push({ name: "testServer", everyMs: 4000 });
  }
  if (ui.tab === "evaluation") list.push({ name: "evaluation", everyMs: 4000 });
  if (ui.tab === "learning") list.push({ name: "learning", params: { store: ui.learningStore }, everyMs: 5000 });
  if (ui.tab === "memory") {
    list.push({ name: "memory", everyMs: 6000 });
    if (!ui.eventsPaused) list.push({ name: "events", params: eventQuery(ui.eventFilters), everyMs: 2000, keep: true });
  }
  return list;
}

export function eventQuery(filters) {
  return {
    ...(filters.q ? { q: filters.q } : {}),
    // Always explicit: the server's own default is "everything", while this form's default reads "info and above".
    ...(filters.level ? { level: filters.level } : {}),
    ...(filters.scope && filters.scope !== "all" ? { scope: filters.scope } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.categories.length ? { category: filters.categories.join(",") } : {}),
    limit: EVENT_LIMIT,
  };
}

/** A command payload attached to a button: JSON for objects and arrays, the raw text otherwise. */
export function readPayload(text) {
  if (text === undefined || text === null || text === "") return undefined;
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export function boot(env = {}) {
  const win = env.window ?? globalThis.window;
  const document = env.document ?? win.document;
  const now = env.now ?? (() => Date.now());
  const setTimer = env.setTimer ?? ((fn, ms) => win.setTimeout(fn, ms));
  const clearTimer = env.clearTimer ?? ((id) => win.clearTimeout(id));
  const ask = env.confirm ?? ((message) => win.confirm(message));
  const storage = env.storage ?? (() => {
    try {
      return win.localStorage;
    } catch {
      return null;
    }
  })();

  const el = (id) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`The page is missing the element #${id}.`);
    return node;
  };
  const regionEl = (id) => document.getElementById(id);

  const bootData = (() => {
    try {
      return JSON.parse(el("boot-data").textContent ?? "{}");
    } catch {
      return {};
    }
  })();
  const real = (text) => (typeof text === "string" && text.length > 0 && !text.startsWith("__") ? text : "");

  const api = createApi({ fetch: env.fetch ?? win.fetch?.bind(win), token: real(bootData.token) });
  /** @type {{ tab: string, evalReportIndex: number, roadmapShowClosed: boolean, eventsPaused: boolean, learningStore: string, language: string, eventFilters: { q: string, level: string, scope: string, source: string, categories: string[] } }} */
  const ui = {
    tab: "overview",
    evalReportIndex: 0,
    roadmapShowClosed: false,
    eventsPaused: false,
    learningStore: "live",
    language: DEFAULT_LANGUAGE,
    eventFilters: { q: "", level: "info", scope: "all", source: "", categories: [] },
  };
  let shutdownRequested = false;
  let taskFormKind = null;
  let renderQueued = false;
  let debounceTimer = null;
  const sending = new Set();

  // ---- small DOM helpers --------------------------------------------------------------------------
  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };
  const setAttr = (node, name, value) => {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  };
  const setOptions = (select, options) => {
    const key = JSON.stringify(options);
    if (select.__optionsKey === key) return false;
    const current = select.value;
    while (select.firstChild) select.removeChild(select.firstChild);
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    }
    select.__optionsKey = key;
    if (options.some((option) => option.value === current)) select.value = current;
    return true;
  };
  const numberOrUndefined = (id) => {
    const text = el(id).value.trim();
    if (text === "") return undefined;
    const value = Number(text);
    return Number.isFinite(value) ? value : Number.NaN;
  };
  const textOrUndefined = (id) => {
    const text = el(id).value.trim();
    return text === "" ? undefined : text;
  };

  // ---- store ---------------------------------------------------------------------------------------
  const store = createStore({
    api,
    now,
    setTimer,
    clearTimer,
    isHidden: () => document.hidden === true,
    wanted: () => wantedResources(ui),
    onChange: () => render(),
  });


  function context() {
    const { state } = store;
    const data = (name) => state.resources[name] ?? { status: "idle", value: null, error: null };
    return {
      snapshot: state.snapshot,
      data: {
        learning: data("learning"),
        memory: data("memory"),
        evaluation: data("evaluation"),
        tasks: data("tasks"),
        events: data("events"),
        diagnostics: data("diagnostics"),
        testServer: data("testServer"),
      },
      ui,
      now: now(),
      lost: state.lost || shutdownRequested,
    };
  }

  // ---- toasts --------------------------------------------------------------------------------------
  function toast(tone, message, title) {
    const container = el("toasts");
    const node = document.createElement("div");
    node.className = `toast ${tone}`;
    if (title) {
      const heading = document.createElement("strong");
      heading.textContent = title;
      node.appendChild(heading);
    }
    node.appendChild(document.createTextNode(message));
    container.appendChild(node);
    while (container.childNodes.length > 4) container.removeChild(container.firstChild);
    setTimer(() => {
      if (node.parentNode === container) container.removeChild(node);
    }, tone === "bad" ? 10000 : 5000);
  }

  // ---- shell: header, banners, tabs ----------------------------------------------------------------
  function renderShell(ctx) {
    const { snapshot, lost } = ctx;
    const info = sessionInfo(snapshot?.session);
    let tone = info.tone;
    let text = info.label;
    if (!snapshot) {
      tone = "neutral";
      text = lost ? "No contact with GameMind" : "Connecting to GameMind…";
    }
    if (lost) {
      tone = "bad";
      text = shutdownRequested ? "GameMind has shut down" : "No contact with GameMind";
    }
    setAttr(el("session-pill"), "data-tone", tone);
    setText(el("session-pill-text"), text);
    document.title = snapshot && !lost ? `${translate(info.label)} · GameMind` : "GameMind";

    const source = lost || !snapshot ? "unavailable" : worldSource(snapshot);
    const sourceInfo = SOURCES[source] ?? SOURCES.unavailable;
    const badge = el("source-badge");
    badge.className = `badge source source-${source}`;
    setText(badge, sourceInfo.label);
    setAttr(badge, "title", sourceInfo.title);

    const updated = el("updated");
    if (store.state.snapshotAt === null) setText(updated, "—");
    else {
      const age = Math.max(0, now() - store.state.snapshotAt);
      setText(updated, lost ? `No contact for ${fmtDuration(age)}` : age < 3000 ? "Updated just now" : `Updated ${fmtDuration(age)} ago`);
    }

    const active = snapshot?.session ? snapshot.session.state !== "none" && snapshot.session.state !== "shutdown" : false;
    el("panic-btn").disabled = !active || lost;

    const banner = el("banner");
    const simulated = snapshot?.session?.source === "simulated" && !lost;
    const bannerText = simulated ? "This session is simulated. Nothing shown as running here happens in a real Minecraft world." : real(bootData.banner);
    banner.hidden = bannerText === "";
    setText(banner, bannerText);
    banner.className = `banner${simulated ? " simulated" : ""}`;

    const lostBanner = el("lost");
    lostBanner.hidden = !lost;
    if (lost) {
      setText(
        el("lost-detail"),
        shutdownRequested
          ? " GameMind was shut down from this page. Start it again with python3 main.py; this page does not reconnect on its own."
          : ` ${store.state.snapshotError ?? "The process may have been stopped."} This page keeps retrying and shows the last data it received as out of date.`,
      );
    }

    const title = real(bootData.title);
    if (title) setText(el("title"), title);
    for (const id of TABS) {
      const tab = el(`tab-${id}`);
      const selected = id === ui.tab;
      setAttr(tab, "aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const code of LANGUAGES) {
      const control = document.getElementById(`lang-${code}`);
      if (control) setAttr(control, "aria-pressed", String(ui.language === code));
    }
    const currentTab = document.getElementById("tools-current-tab");
    if (currentTab) setText(currentTab, el(`tab-${ui.tab}`).textContent?.trim() ?? "Overview");
    setAttr(el("roadmap-toggle-closed"), "aria-pressed", String(ui.roadmapShowClosed));
    setText(el("roadmap-toggle-closed"), ui.roadmapShowClosed ? "Hide closed items" : "Show closed items");
  }

  /**
   * Switches the interface language. The choice is remembered per browser and applied again by `render()`,
   * which translates the page after every render.
   */
  function setLanguage(next) {
    const code = isLanguage(next) ? next : DEFAULT_LANGUAGE;
    ui.language = code;
    applyLanguage(code);
    document.documentElement.setAttribute("lang", code);
    try {
      storage?.setItem(LANGUAGE_KEY, code);
    } catch {
      // the choice just is not remembered
    }
    render();
  }

  function renderPanels(ctx) {
    const loading = el("panel-loading");
    const errorBox = el("render-error");
    if (!ctx.snapshot) {
      loading.hidden = false;
      for (const id of TABS) el(`panel-${id}`).hidden = true;
      setText(el("loading-text"), ctx.lost ? "Cannot reach GameMind. This page keeps retrying." : "Contacting GameMind…");
      mount(errorBox, []);
      return;
    }
    loading.hidden = true;
    for (const id of TABS) el(`panel-${id}`).hidden = id !== ui.tab;
    let regions;
    try {
      regions = VIEWS[ui.tab](ctx);
      mount(errorBox, []);
    } catch (error) {
      // A view that cannot draw must say so; the rest of the page keeps working.
      win.console?.error?.(error);
      mount(errorBox, card({ title: "This section could not be drawn" }, notice("bad", "Something in the data was not what this page expected", error instanceof Error ? error.message : String(error))));
      return;
    }
    for (const [id, vnode] of Object.entries(regions)) {
      const target = regionEl(id);
      if (target) mount(target, vnode ?? []);
    }
  }

  // ---- static forms: options, enabled state and explanations ---------------------------------------
  function syncConnectForm(ctx) {
    const source = el("connect-source").value;
    el("connect-live-fields").hidden = source !== "live";
    el("connect-sim-fields").hidden = source !== "simulated";
    const session = ctx.snapshot?.session ?? null;
    const canConnect = session ? session.canConnect : false;
    const unsupported = !session;
    el("connect-submit").disabled = !canConnect || ctx.lost;
    setText(
      el("connect-hint"),
      unsupported
        ? "This run has no session manager, so it cannot connect from here."
        : canConnect
          ? ""
          : `A session is ${sessionInfo(session).label.toLowerCase()}. Stop it from the Overview before connecting somewhere else.`,
    );
    const catalog = ctx.data.tasks.value;
    if (catalog?.simulatedScenarios) {
      const first = setOptions(el("connect-scenario"), catalog.simulatedScenarios.map((scenario) => ({ value: scenario.id, label: `${scenario.id} — ${scenario.description}` })));
      if (first && catalog.defaultSimulatedScenario) el("connect-scenario").value = catalog.defaultSimulatedScenario;
    }
    const windows = ctx.data.diagnostics.value?.windowsHost;
    const address = windows?.addresses?.[0] ?? null;
    el("connect-wsl-hint").hidden = !(address && source === "live");
    if (address) setText(el("connect-wsl-text"), `Running in WSL: a server on the Windows side is usually reachable at ${address}, not 127.0.0.1.`);
    el("connect-use-windows").setAttribute("data-host", address ?? "");
  }

  function applyTaskKind(task, { reset }) {
    const resource = task.parameters?.resource ?? null;
    const count = task.parameters?.count ?? null;
    el("task-resource-row").hidden = !resource;
    el("task-count-row").hidden = !count;
    if (resource) {
      setOptions(el("task-resource"), resource.options.map((name) => ({ value: name, label: humanise(name) })));
      if (reset && task.defaultResource) el("task-resource").value = task.defaultResource;
      setText(el("task-resource-label"), task.kind === "craft-wooden-pickaxe" ? "Item to craft" : task.kind === "gather-logs" ? "Log type" : "Block type");
    }
    if (count) {
      const input = el("task-count");
      input.min = String(count.min);
      input.max = String(count.max);
      if (reset) input.value = String(task.defaultCount ?? count.min);
      setText(el("task-count-label"), `Amount (${count.unit}, ${count.min}–${count.max})`);
    }
    setText(el("task-description"), task.description);
    setText(el("task-needs"), task.needs?.length ? `Needs: ${task.needs.join("; ")}.` : "");
    const limits = task.limits ?? {};
    const rows = [
      ["Action budget", limits.maxActions !== undefined ? `${fmtNumber(limits.maxActions)} actions` : null],
      ["Time limit", typeof limits.maxDurationMs === "number" ? fmtDuration(limits.maxDurationMs) : null],
      ["Stops after", limits.maxConsecutiveFailures !== undefined ? `${limits.maxConsecutiveFailures} failed actions in a row` : null],
      ["Danger radius", limits.dangerRadius !== undefined ? `${limits.dangerRadius} blocks` : null],
      ["Reach for targets", limits.maxTargetDistance !== undefined ? `${limits.maxTargetDistance} blocks` : null],
      ["Exploration", limits.maxExplorationLegs !== undefined ? `${limits.maxExplorationLegs} legs, radius ${limits.explorationRadius ?? "?"}` : null],
    ].filter(([, value]) => value !== null);
    mount(el("task-limits"), rows.length ? h("div", null, h("strong", null, "Limits for this task (fixed by the agent)"), h("ul", null, rows.map(([label, value]) => h("li", null, `${label}: ${value}`)))) : []);
  }

  function syncTaskForm(ctx) {
    const catalog = ctx.data.tasks.value;
    if (catalog?.tasks?.length) {
      setOptions(el("task-kind"), catalog.tasks.map((task) => ({ value: task.kind, label: task.label })));
      const task = catalog.tasks.find((entry) => entry.kind === el("task-kind").value) ?? catalog.tasks[0];
      if (task.kind !== taskFormKind) {
        taskFormKind = task.kind;
        applyTaskKind(task, { reset: true });
      }
    }
    const snapshot = ctx.snapshot;
    const queueChecked = el("task-queue").checked;
    let disabled = false;
    let text;
    const blocker = taskBlocker(snapshot);
    if (blocker) {
      disabled = true;
      text = blocker;
    } else if (snapshot.scheduler.active && snapshot.scheduler.queue.length >= snapshot.scheduler.limits.maxQueue) {
      disabled = true;
      text = `A task is running and the queue is full (${snapshot.scheduler.queue.length}/${snapshot.scheduler.limits.maxQueue}). Wait for one to finish or clear the queue.`;
    } else if (snapshot.scheduler.active && !queueChecked) {
      disabled = true;
      text = `A task is running (${snapshot.scheduler.active.label}). Tick “queue” to run this one right after it; two tasks never run at the same time.`;
    } else {
      text = queueExplanation(snapshot).text;
    }
    if (!catalog?.tasks?.length) {
      disabled = true;
      text = ctx.data.tasks.status === "error" ? `The task list could not be loaded: ${ctx.data.tasks.error}` : "Loading the task list…";
    }
    el("task-submit").disabled = disabled || ctx.lost;
    setText(el("task-submit"), snapshot?.scheduler?.active && queueChecked ? "Queue task" : "Start task");
    setText(el("task-hint"), text);
  }

  function syncEvalForm(ctx) {
    const busy = ctx.snapshot?.jobs?.busy === true;
    const available = Boolean(ctx.snapshot?.jobs);
    const blocked = busy || !available || ctx.lost;
    const scenarios = ctx.data.tasks.value?.simulatedScenarios;
    if (scenarios) setOptions(el("eval-scenario"), [{ value: "", label: "all scenarios" }, ...scenarios.map((scenario) => ({ value: scenario.id, label: scenario.id }))]);
    el("run-tests").disabled = blocked;
    el("run-eval").disabled = blocked;
    setText(el("eval-hint"), !available ? "Jobs are not available in this run." : busy ? "A job is running. Cancel it or wait for it to finish; one runs at a time." : "");
  }

  function liveTarget() {
    const host = el("live-host").value.trim() || "the default host";
    const port = el("live-port").value.trim() || "the default port";
    const name = el("live-username").value.trim() || "the default name";
    return `${host}:${port} as ${name}`;
  }

  function syncLiveForm(ctx) {
    const defaults = ctx.data.evaluation.value?.live?.defaults;
    if (defaults && el("live-form").getAttribute("data-filled") !== "yes") {
      el("live-host").value = String(defaults.host ?? "");
      el("live-port").value = String(defaults.port ?? "");
      el("live-username").value = String(defaults.username ?? "");
      el("live-form").setAttribute("data-filled", "yes");
    }
    const changesWorld = el("live-allow-dig").checked || el("live-allow-combat").checked;
    el("live-confirm-world-row").hidden = !changesWorld;
    if (!changesWorld) el("live-confirm-world").checked = false;
    setText(el("live-confirm-text"), `I confirm a verification bot may connect to ${liveTarget()}.`);
    const busy = ctx.snapshot?.jobs?.busy === true;
    const ready = el("live-confirm").checked && (!changesWorld || el("live-confirm-world").checked);
    el("live-submit").disabled = !ready || busy || ctx.lost || !ctx.snapshot?.jobs;
    setText(el("live-hint"), busy ? "A job is running; wait for it to finish." : !el("live-confirm").checked ? "Confirm the connection above to enable this." : changesWorld && !el("live-confirm-world").checked ? "Confirm the world changes above to enable this." : "");
  }

  function syncSeedForm(ctx) {
    const input = el("seed-input");
    if (document.activeElement !== input && !input.__edited) {
      const value = ctx.snapshot?.worldSeed?.value ?? "";
      if (input.value !== value) input.value = value;
    }
  }

  function syncEventForm() {
    const box = el("event-categories");
    if (box.__built) return;
    for (const category of EVENT_CATEGORIES) {
      const label = document.createElement("label");
      label.className = "choice";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = category;
      input.id = `event-category-${category}`;
      input.setAttribute("data-category", category);
      const text = document.createElement("span");
      text.textContent = humanise(category);
      label.appendChild(input);
      label.appendChild(document.createTextNode(" "));
      label.appendChild(text);
      box.appendChild(label);
    }
    box.__built = true;
  }

  function syncForms(ctx) {
    syncEventForm();
    if (!ctx.snapshot) return;
    syncConnectForm(ctx);
    syncTaskForm(ctx);
    syncEvalForm(ctx);
    syncLiveForm(ctx);
    syncSeedForm(ctx);
  }

  function render() {
    renderQueued = false;
    const ctx = context();
    try {
      renderShell(ctx);
      renderPanels(ctx);
      syncForms(ctx);
      // Last, so every panel is in the DOM: the switch is a property of the page, not of any one view.
      applyTranslations(document.body ?? document.documentElement);
    } catch (error) {
      win.console?.error?.(error);
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    Promise.resolve().then(() => {
      if (renderQueued) render();
    });
  }

  // ---- commands ------------------------------------------------------------------------------------
  async function runCommand(type, payload, { silent = false } = {}) {
    const key = `${type}:${typeof payload === "string" ? payload : JSON.stringify(payload ?? null)}`;
    if (sending.has(key)) return null;
    sending.add(key);
    try {
      const result = await api.command(type, payload);
      if (!silent || !result.ok) toast(result.ok ? "good" : "bad", result.message, result.ok ? undefined : "Not done");
      if (result.ok && type === "shutdownApp") {
        shutdownRequested = true;
        store.stop();
      }
      return result;
    } catch (error) {
      toast("bad", error instanceof Error ? error.message : String(error), "Could not reach GameMind");
      return null;
    } finally {
      sending.delete(key);
      store.nudge();
      scheduleRender();
    }
  }

  // ---- navigation ----------------------------------------------------------------------------------
  function selectTab(id, { updateHash = true, focus = false } = {}) {
    if (!TABS.includes(id)) return;
    const changed = ui.tab !== id;
    ui.tab = id;
    const navigation = document.getElementById("tools-navigation");
    if (navigation && !focus) navigation.open = false;
    if (updateHash && win.location && win.location.hash !== `#/${id}`) win.location.hash = `#/${id}`;
    render();
    if (focus) el(`tab-${id}`).focus?.();
    if (changed) store.nudge();
  }

  // ---- event handlers ------------------------------------------------------------------------------
  function toggleTheme() {
    const attribute = document.documentElement.getAttribute("data-theme");
    const dark = attribute === "dark" || (attribute !== "light" && win.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true);
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      storage?.setItem(THEME_KEY, next);
    } catch {
      // the choice just is not remembered
    }
  }

  async function handleAction(name, control) {
    switch (name) {
      case "toggle-theme":
        toggleTheme();
        break;
      case "set-language":
        setLanguage(control.getAttribute("data-language") ?? DEFAULT_LANGUAGE);
        break;
      case "goto-tab":
        selectTab(control.getAttribute("data-tab") ?? "", { focus: false });
        break;
      case "pick-report":
        ui.evalReportIndex = Number(control.getAttribute("data-index") ?? 0) || 0;
        render();
        break;
      case "learning-store":
        ui.learningStore = control.getAttribute("data-store") === "simulated" ? "simulated" : "live";
        store.refreshResource("learning", { store: ui.learningStore }).then(render);
        render();
        break;
      case "events-pause":
        ui.eventsPaused = true;
        render();
        break;
      case "events-live":
        ui.eventsPaused = false;
        store.refreshResource("events", eventQuery(ui.eventFilters), { keep: true }).then(render);
        render();
        break;
      case "roadmap-toggle-closed":
        ui.roadmapShowClosed = !ui.roadmapShowClosed;
        render();
        break;
      case "use-windows-host": {
        const host = control.getAttribute("data-host");
        if (host) el("connect-host").value = host;
        break;
      }
      case "check-port": {
        const host = (el("connect-host").value || "127.0.0.1").trim();
        const port = Number(el("connect-port").value || 25565);
        setText(el("connect-probe"), "Checking…");
        const result = await runCommand("probeServer", { host, port }, { silent: true });
        setText(el("connect-probe"), result ? result.message : "The check could not be sent.");
        break;
      }
      case "use-test-server":
        el("connect-host").value = "127.0.0.1";
        el("connect-port").value = "25565";
        el("connect-username").value = el("connect-username").value || "GameMind";
        el("connect-version").value = "1.20.4";
        el("connect-auth").value = "offline";
        setText(el("connect-probe"), "Filled in for the offline test server. Press Connect.");
        break;
      case "seed-clear":
        el("seed-input").value = "";
        void runCommand("setWorldSeed", null);
        break;
      default:
        break;
    }
  }

  function onClick(event) {
    const control = event.target?.closest?.("[data-command],[data-action],[role=tab]");
    if (!control || control.disabled) return;
    const action = control.getAttribute("data-action");
    if (action) {
      void handleAction(action, control);
      return;
    }
    if (control.getAttribute("role") === "tab") {
      selectTab(control.getAttribute("data-tab") ?? "");
      return;
    }
    const command = control.getAttribute("data-command");
    if (!command) return;
    const confirmation = control.getAttribute("data-confirm");
    if (confirmation && !ask(confirmation)) return;
    void runCommand(command, readPayload(control.getAttribute("data-payload") ?? undefined));
  }

  function onKeydown(event) {
    const tab = event.target?.closest?.("[role=tab]");
    if (!tab) return;
    const index = TABS.indexOf(tab.getAttribute("data-tab") ?? "");
    let next = null;
    if (event.key === "ArrowRight") next = TABS[(index + 1) % TABS.length];
    else if (event.key === "ArrowLeft") next = TABS[(index - 1 + TABS.length) % TABS.length];
    else if (event.key === "Home") next = TABS[0];
    else if (event.key === "End") next = TABS[TABS.length - 1];
    if (next) {
      event.preventDefault?.();
      selectTab(next, { focus: true });
    }
  }

  function connectPayload() {
    const source = el("connect-source").value === "simulated" ? "simulated" : "live";
    const payload = { source, mode: el("connect-mode").value, autonomy: el("connect-autonomy").checked };
    if (source === "simulated") {
      payload.scenarioId = el("connect-scenario").value;
      return payload;
    }
    const port = numberOrUndefined("connect-port");
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return { error: "The port must be a whole number from 1 to 65535." };
    const host = textOrUndefined("connect-host");
    const username = textOrUndefined("connect-username");
    const version = textOrUndefined("connect-version");
    const auth = textOrUndefined("connect-auth");
    return { ...payload, ...(host ? { host } : {}), ...(port !== undefined ? { port } : {}), ...(username ? { username } : {}), ...(version ? { version } : {}), ...(auth ? { auth } : {}) };
  }

  function taskPayload() {
    const payload = { kind: el("task-kind").value, queue: el("task-queue").checked };
    if (!el("task-resource-row").hidden && el("task-resource").value) payload.resource = el("task-resource").value;
    if (!el("task-count-row").hidden) {
      const count = numberOrUndefined("task-count");
      const low = Number(el("task-count").min || 1);
      const high = Number(el("task-count").max || 64);
      if (count !== undefined && (!Number.isInteger(count) || count < low || count > high)) return { error: `The amount must be a whole number from ${low} to ${high}.` };
      if (count !== undefined) payload.count = count;
    }
    return payload;
  }

  /** @typedef {{ error: string } | { scope: string, allowDig: boolean, allowCombat: boolean, confirmed: boolean, confirmedWorldChanges: boolean, host?: string, port?: number, username?: string }} LivePayload */

  /** @returns {LivePayload} */
  function livePayload() {
    const port = numberOrUndefined("live-port");
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return { error: "The port must be a whole number from 1 to 65535." };
    return {
      ...(textOrUndefined("live-host") ? { host: textOrUndefined("live-host") } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(textOrUndefined("live-username") ? { username: textOrUndefined("live-username") } : {}),
      scope: el("live-scope-actions").checked ? "actions" : "read-only",
      allowDig: el("live-allow-dig").checked,
      allowCombat: el("live-allow-combat").checked,
      confirmed: el("live-confirm").checked,
      confirmedWorldChanges: el("live-confirm-world").checked,
    };
  }

  function libraryPayload(form) {
    const params = {};
    for (const control of form.querySelectorAll("[data-param]")) {
      const name = control.getAttribute("data-param");
      const type = control.getAttribute("data-type");
      if (type === "boolean") params[name] = control.checked === true;
      else if (type === "integer" || type === "number") {
        const text = String(control.value ?? "").trim();
        if (text === "") continue;
        const value = Number(text);
        if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) return { error: `${control.getAttribute("aria-label") ?? name} must be ${type === "integer" ? "a whole number" : "a number"}.` };
        params[name] = value;
      } else {
        const text = String(control.value ?? "").trim();
        if (text !== "") params[name] = text;
      }
    }
    return { id: form.getAttribute("data-library-id"), params };
  }

  async function onSubmit(event) {
    event.preventDefault?.();
    const form = event.target;
    const id = form?.id ?? "";
    const send = async (type, payload) => {
      if (payload && typeof payload === "object" && "error" in payload && Object.keys(payload).length === 1) {
        toast("bad", payload.error, "Check the form");
        return;
      }
      await runCommand(type, payload);
    };
    if (form?.getAttribute?.("data-library-id")) return send("libraryExecute", libraryPayload(form));
    switch (id) {
      case "connect-form":
        return send("connectSession", connectPayload());
      case "task-form":
        return send("startTask", taskPayload());
      case "eval-form": {
        const seeds = numberOrUndefined("eval-seeds");
        if (seeds !== undefined && (!Number.isInteger(seeds) || seeds < 1 || seeds > 200)) return send("runOfflineEvaluation", { error: "Seeds per scenario must be a whole number from 1 to 200." });
        return send("runOfflineEvaluation", { ...(seeds !== undefined ? { seeds } : {}), ...(textOrUndefined("eval-scenario") ? { scenarioId: textOrUndefined("eval-scenario") } : {}) });
      }
      case "live-form": {
        const payload = livePayload();
        // The union is discriminated by the presence of `error`: a payload the form could not fill is sent back
        // unchanged so the operator sees the reason instead of a half-built command.
        if ("error" in payload) return send("runLiveVerification", payload);
        if ((payload.allowDig || payload.allowCombat) && !ask(`This lets a verification bot ${[payload.allowDig ? "dig a block" : null, payload.allowCombat ? "attack a hostile mob" : null].filter(Boolean).join(" and ")} on ${liveTarget()}. This changes the world on that server. Continue?`)) return;
        return send("runLiveVerification", payload);
      }
      case "seed-form":
        el("seed-input").__edited = false;
        return send("setWorldSeed", el("seed-input").value.trim() === "" ? null : el("seed-input").value.trim());
      default:
        return undefined;
    }
  }

  function readEventFilters() {
    const categories = EVENT_CATEGORIES.filter((category) => el(`event-category-${category}`).checked);
    ui.eventFilters = { q: el("event-q").value.trim(), level: el("event-level").value, scope: el("event-scope").value, source: el("event-source").value, categories };
  }

  function refreshEvents() {
    readEventFilters();
    ui.eventsPaused = false;
    return store.refreshResource("events", eventQuery(ui.eventFilters), { keep: true }).then(render);
  }

  function onChange(event) {
    const target = event.target;
    const id = target?.id ?? "";
    if (id === "connect-source") render();
    else if (id === "task-kind") {
      taskFormKind = null;
      render();
    } else if (id === "task-queue" || id.startsWith("live-")) render();
    else if (id.startsWith("event-") && id !== "event-q") void refreshEvents();
  }

  function onInput(event) {
    const id = event.target?.id ?? "";
    if (id === "event-q") {
      if (debounceTimer !== null) clearTimer(debounceTimer);
      debounceTimer = setTimer(() => {
        debounceTimer = null;
        void refreshEvents();
      }, 250);
    } else if (id === "seed-input") event.target.__edited = true;
    else if (id.startsWith("live-")) render();
  }

  // ---- start ---------------------------------------------------------------------------------------
  const savedTheme = (() => {
    try {
      return storage?.getItem(THEME_KEY) ?? null;
    } catch {
      return null;
    }
  })();
  if (savedTheme === "light" || savedTheme === "dark") document.documentElement.setAttribute("data-theme", savedTheme);

  const savedLanguage = (() => {
    try {
      return storage?.getItem(LANGUAGE_KEY) ?? null;
    } catch {
      return null;
    }
  })();
  ui.language = isLanguage(savedLanguage) ? savedLanguage : DEFAULT_LANGUAGE;
  applyLanguage(ui.language);
  document.documentElement.setAttribute("lang", ui.language);

  ui.tab = tabFromHash(win.location?.hash) ?? "overview";
  document.addEventListener("click", onClick);
  document.addEventListener("submit", onSubmit);
  document.addEventListener("change", onChange);
  document.addEventListener("input", onInput);
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("visibilitychange", () => {
    // Coming back to a hidden tab refreshes at once instead of showing minutes-old numbers.
    if (!document.hidden) store.nudge();
  });
  win.addEventListener?.("hashchange", () => {
    const tab = tabFromHash(win.location?.hash);
    if (tab && tab !== ui.tab) selectTab(tab, { updateHash: false });
  });

  render();
  store.start();

  return {
    store,
    ui,
    render,
    setLanguage,
    selectTab,
    runCommand,
    toast,
    pollIntervals: { visible: POLL_VISIBLE_MS, hidden: POLL_HIDDEN_MS },
    stop() {
      store.stop();
    },
  };
}

if (typeof document !== "undefined" && typeof window !== "undefined" && document.getElementById("boot-data")) {
  boot({ window, document });
}
