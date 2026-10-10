import { h } from "../lib/h.js";
import { badge, button, card, empty, kv, notice, sourceBadge, table, unknown } from "../lib/ui.js";
import { fmtAgo, fmtDateTime, fmtNumber, fmtTime, humanise } from "../lib/format.js";
import { worldSource } from "../lib/model.js";
import { eventRow } from "./overview.js";

export const EVENT_CATEGORIES = ["session", "connection", "task", "decision", "action", "safety", "training", "evaluation", "learning", "memory", "browser", "shutdown", "app", "error"];

function identity(ctx) {
  const { snapshot } = ctx;
  const session = snapshot.session;
  const world = snapshot.world;
  const source = worldSource(snapshot);
  return card(
    { title: "World identity", actions: sourceBadge(source) },
    kv([
      ["World key", session?.worldKey ?? null, "Memory is filed under this identity: server, port and dimension."],
      ["Server", session?.target ? `${session.target.host}:${session.target.port}` : session?.source === "simulated" ? "built-in simulator" : null],
      ["Minecraft version", session?.target?.version ?? snapshot.connection?.gameVersion ?? null],
      ["Dimension", world.dimension ?? null],
      ["Game mode", world.gameMode ?? null],
      ["World seed", snapshot.worldSeed?.value ? h("span", null, snapshot.worldSeed.value, " ", badge("entered by hand, not verified", "warn")) : snapshot.worldSeed ? "not set" : null],
      ["Explored cells in this session", snapshot.world.exploredCells ? fmtNumber(snapshot.world.exploredCells) : source === "unavailable" ? null : "0"],
    ]),
    snapshot.worldSeed ? h("p", { class: "small muted" }, snapshot.worldSeed.note) : null,
  );
}

function heat(grid) {
  if (!grid) return h("p", { class: "muted small" }, "Nothing explored yet.");
  const cells = [];
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      const count = grid.counts[row * grid.columns + column] ?? 0;
      cells.push(h("i", { class: `heat-cell${count ? "" : " empty"}`, style: { "--level": count === 0 ? "0" : (0.2 + 0.8 * (count / grid.max)).toFixed(2) }, title: `${count} explored cell(s)` }));
    }
  }
  return h("div", { class: "heat", style: { "--columns": String(grid.columns) }, role: "img", "aria-label": "Explored area, north at the top" }, cells);
}

function worlds(ctx) {
  const resource = ctx.data.memory;
  if (!resource || resource.status === "idle" || resource.status === "loading") return card({ title: "World memory" }, h("p", { class: "muted" }, "Loading…"));
  if (resource.status === "error") return card({ title: "World memory" }, notice("bad", "Could not load world memory", resource.error));
  const data = resource.value;
  return card(
    { title: "World memory", subtitle: `Folder: ${data.directory}`, actions: sourceBadge("historical") },
    h("p", { class: "small muted" }, data.note),
    data.live ? notice("info", "Live session memory", `${fmtNumber(data.live.observations)} observations, ${fmtNumber(data.live.exploredCells)} explored cells, ${fmtNumber(data.live.landmarks)} landmarks so far (saved to the file after tasks and at shutdown).`) : null,
    data.worlds.length
      ? data.worlds.map((world) =>
          h(
            "article",
            { class: `memory-world${world.current ? " current" : ""}`, key: world.file },
            h("header", null, h("h4", null, world.worldKey), world.current ? badge("current session", "good") : null),
            kv([
              ["Saved", world.savedAt ? `${fmtDateTime(world.savedAt)} (${fmtAgo(world.savedAt, ctx.now)})` : null],
              ["Observations", fmtNumber(world.observations)],
              ["Explored cells", `${fmtNumber(world.exploredCells)}${world.bounds ? ` · x ${world.bounds.minX}…${world.bounds.maxX}, z ${world.bounds.minZ}…${world.bounds.maxZ}` : ""}`],
              ["Remembered mineable blocks", fmtNumber(world.minableBlocks)],
              ["Landmarks", fmtNumber(world.landmarkTotal)],
            ]),
            h("div", { class: "memory-grid" }, heat(world.grid), world.grid ? h("p", { class: "small muted" }, `One square is up to ${fmtNumber(world.grid.cellsPerBucket)} cells; darker means more explored.`) : null),
            Object.keys(world.resources).length ? h("div", null, h("h5", null, "Resource observations"), h("ul", { class: "chips" }, Object.entries(world.resources).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([name, count]) => h("li", { class: "badge tone-neutral" }, `${humanise(name)} ×${fmtNumber(count)}`)))) : null,
            world.landmarks.length ? h("details", null, h("summary", null, `Landmarks (${world.landmarkTotal})`), table({ dense: true, columns: [{ label: "Type", cell: (l) => l.type }, { label: "Label", cell: (l) => l.label }, { label: "Position", cell: (l) => `${l.position.x}, ${l.position.y}, ${l.position.z}` }, { label: "Recorded", cell: (l) => fmtTime(l.createdAt) }], rows: world.landmarks.map((value) => ({ key: value.id, value })) })) : null,
          ),
        )
      : empty("No world memory has been saved yet", "Memory is written while a session observes a world. Nothing is shown here until there is something real to show."),
  );
}

function events(ctx) {
  const resource = ctx.data.events;
  if (!resource || resource.status === "idle" || resource.status === "loading") return card({ title: "Event log" }, h("p", { class: "muted" }, "Loading…"));
  if (resource.status === "error") return card({ title: "Event log" }, notice("bad", "Could not load the event log", resource.error));
  const data = resource.value;
  return card(
    { title: "Event log", subtitle: `${fmtNumber(data.matched)} matching of ${fmtNumber(data.total)} recorded${data.truncated ? " (showing the newest)" : ""}`, actions: ctx.ui.eventsPaused ? button("Resume live view", { action: "events-live" }) : button("Pause live view", { action: "events-pause" }) },
    data.events.length
      ? h("ol", { class: "event-list large" }, [...data.events].reverse().map(eventRow))
      : empty("No events match", "Change the filters, or wait: events appear here as connections, decisions, actions, task changes, errors and shutdown reasons happen."),
    h("p", { class: "small muted" }, "Paths and credentials are removed from every message before it is stored. Events from earlier runs of GameMind are marked as previous."),
  );
}

export function renderMemory(ctx) {
  return { "mem-identity": identity(ctx), "mem-worlds": worlds(ctx), "mem-events": events(ctx) };
}

export { unknown };
