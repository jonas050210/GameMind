// Small presentational components built on h(). They carry no state; each takes the facts it shows.
import { h } from "./h.js";
import { SOURCES, statusInfo } from "./model.js";
import { UNKNOWN } from "./format.js";

export function badge(text, tone = "neutral", title) {
  return h("span", { class: `badge tone-${tone}`, ...(title ? { title } : {}) }, text);
}

export function statusBadge(status) {
  const info = statusInfo(status);
  return badge(info.label, info.tone);
}

/** LIVE / SIMULATED / OFFLINE / HISTORICAL / UNAVAILABLE: the provenance of whatever sits next to it. */
export function sourceBadge(source) {
  const info = SOURCES[source] ?? SOURCES.unavailable;
  return h("span", { class: `badge source source-${source in SOURCES ? source : "unavailable"}`, title: info.title }, info.label);
}

export function unknown(note) {
  return h("span", { class: "unknown", ...(note ? { title: note } : {}) }, UNKNOWN);
}

export function value(content, formatter) {
  if (content === null || content === undefined || (typeof content === "number" && !Number.isFinite(content))) return unknown();
  return formatter ? formatter(content) : String(content);
}

export function card({ title, subtitle, actions, tone, id, class: extra } = {}, ...body) {
  return h(
    "section",
    { class: `card${tone ? ` tone-${tone}` : ""}${extra ? ` ${extra}` : ""}`, ...(id ? { id } : {}) },
    title || actions
      ? h("header", { class: "card-head" }, h("div", null, title ? h("h3", null, title) : null, subtitle ? h("p", { class: "muted small" }, subtitle) : null), actions ? h("div", { class: "card-actions" }, actions) : null)
      : null,
    h("div", { class: "card-body" }, ...body),
  );
}

export function kv(rows) {
  return h(
    "dl",
    { class: "kv" },
    rows
      .filter((row) => row)
      .map(([label, content, hint]) => [h("dt", hint ? { title: hint } : null, label), h("dd", null, content === null || content === undefined || content === "" ? unknown() : content)]),
  );
}

export function empty(title, detail) {
  return h("div", { class: "empty" }, h("strong", null, title), detail ? h("p", { class: "muted" }, detail) : null);
}

export function notice(tone, title, ...body) {
  return h("div", { class: `notice tone-${tone}`, role: tone === "bad" ? "alert" : "note" }, h("strong", null, title), body.length ? h("div", null, ...body) : null);
}

export function progress(valueNow, max, label) {
  if (!(typeof valueNow === "number" && typeof max === "number" && max > 0)) return h("div", { class: "progress unknown-progress", role: "img", "aria-label": label ? `${label}: unknown` : "unknown", title: "Progress cannot be measured" });
  const percent = Math.max(0, Math.min(100, (valueNow / max) * 100));
  return h(
    "div",
    { class: "progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": max, "aria-valuenow": valueNow, ...(label ? { "aria-label": label } : {}) },
    h("span", { class: "progress-fill", style: { "--w": `${percent.toFixed(1)}%` } }),
  );
}

export function table({ columns, rows, empty: emptyText, caption, dense }) {
  if (!rows.length) return empty(emptyText?.title ?? "Nothing to show", emptyText?.detail);
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: `table${dense ? " dense" : ""}` },
      caption ? h("caption", { class: "sr-only" }, caption) : null,
      h("thead", null, h("tr", null, columns.map((column) => h("th", { scope: "col", class: column.align === "right" ? "num" : "" }, column.label)))),
      h(
        "tbody",
        null,
        rows.map((row, index) =>
          h(
            "tr",
            { key: row.key ?? index },
            columns.map((column) => h("td", { class: column.align === "right" ? "num" : "" }, column.cell(row.value ?? row))),
          ),
        ),
      ),
    ),
  );
}

/** A real series as a line. Fewer than two points draws nothing: no placeholder shapes. */
export function sparkline(values, { width = 220, height = 44, label } = {}) {
  const points = values.map((entry, index) => ({ entry, index })).filter((point) => typeof point.entry === "number" && Number.isFinite(point.entry));
  if (points.length < 2) return h("p", { class: "muted small" }, "Not enough measured points to draw a trend yet.");
  const min = Math.min(...points.map((point) => point.entry));
  const max = Math.max(...points.map((point) => point.entry));
  const span = max - min || 1;
  const step = width / Math.max(1, values.length - 1);
  const coordinates = points.map((point) => `${(point.index * step).toFixed(1)},${(height - 4 - ((point.entry - min) / span) * (height - 8)).toFixed(1)}`).join(" ");
  return h(
    "svg",
    { class: "sparkline", viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": label ?? "trend" },
    h("polyline", { points: coordinates, fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linejoin": "round", "stroke-linecap": "round" }),
  );
}

export function chips(items, tone = "neutral") {
  return h("div", { class: "chips" }, items.map((item) => badge(item, tone)));
}

export function button(label, { action, command, payload, tone = "", disabled = false, title, data = {}, type = "button" } = {}) {
  const attributes = { type, class: `btn${tone ? ` ${tone}` : ""}`, ...(disabled ? { disabled: true } : {}), ...(title ? { title } : {}) };
  if (action) attributes["data-action"] = action;
  if (command) attributes["data-command"] = command;
  if (payload !== undefined) attributes["data-payload"] = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const [name, entry] of Object.entries(data)) attributes[`data-${name}`] = entry;
  return h("button", attributes, label);
}
