// A very small virtual-DOM: views describe what the page should look like, `mount` makes the page match.
//
// It exists for three reasons the page needs and plain innerHTML cannot give:
//  - text always goes in through textContent, so nothing a game, a log line or an error message says can become markup;
//  - an element that is unchanged is left alone, so a poll every second does not reset scroll positions, text selections or
//    open <details> elements;
//  - `h.stat(key, node)` marks a subtree (a form) that is built once and never patched, so typing into it is never
//    interrupted by a refresh. It is rebuilt only when its key changes.
//
// It touches `document` only inside functions, so it can be loaded and tested in Node with a stand-in DOM.

const SVG_NS = "http://www.w3.org/2000/svg";
const BOOLEAN_PROPS = new Set(["disabled", "checked", "selected", "hidden", "open", "required", "readOnly", "multiple"]);
const PROPERTY_PROPS = new Set(["value", "checked", "selected", "disabled", "hidden", "open", "readOnly"]);

function flatten(children, out = []) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) flatten(child, out);
    else out.push(typeof child === "object" ? child : String(child));
  }
  return out;
}

/** h("div", { class: "x" }, "text", h("span", null, "more")) */
export function h(tag, props, ...children) {
  return { tag, props: props ?? {}, children: flatten(children) };
}

/** A subtree that is created once for `key` and then left alone (forms). */
h.stat = function stat(key, node) {
  return { tag: "#static", key, node, props: {}, children: [] };
};

function isSvg(tag, inSvg) {
  return inSvg || tag === "svg";
}

function create(vnode, inSvg) {
  if (typeof vnode === "string") return document.createTextNode(vnode);
  if (vnode.tag === "#static") {
    const node = create(vnode.node, inSvg);
    node.__staticKey = vnode.key;
    return node;
  }
  const svg = isSvg(vnode.tag, inSvg);
  const element = svg ? document.createElementNS(SVG_NS, vnode.tag) : document.createElement(vnode.tag);
  element.__props = {};
  applyProps(element, vnode.props, svg);
  for (const child of vnode.children) element.appendChild(create(child, svg && vnode.tag !== "foreignObject"));
  if (vnode.props.key !== undefined) element.__key = String(vnode.props.key);
  return element;
}

function setProp(element, name, value, svg) {
  if (name === "key" || name === "children") return;
  if (name === "class") {
    if (svg) element.setAttribute("class", value ?? "");
    else element.className = value ?? "";
    return;
  }
  if (name === "style" && value && typeof value === "object") {
    for (const [property, entry] of Object.entries(value)) {
      if (property.startsWith("--")) element.style.setProperty(property, String(entry));
      else element.style[property] = entry;
    }
    return;
  }
  if (PROPERTY_PROPS.has(name) && !svg) {
    if (name === "value") {
      const next = value === null || value === undefined ? "" : String(value);
      if (element.value !== next && !(typeof document !== "undefined" && document.activeElement === element)) element.value = next;
      return;
    }
    element[name] = Boolean(value);
    return;
  }
  if (value === null || value === undefined || value === false) {
    element.removeAttribute(name);
    return;
  }
  element.setAttribute(name, value === true ? "" : String(value));
}

function applyProps(element, props, svg) {
  const previous = element.__props ?? {};
  for (const name of Object.keys(previous)) {
    if (!(name in props) && name !== "key") {
      if (name === "class") element.className = "";
      else if (name === "style") element.removeAttribute("style");
      else if (PROPERTY_PROPS.has(name) && !svg) element[name] = name === "value" ? "" : false;
      else element.removeAttribute(name);
    }
  }
  for (const [name, value] of Object.entries(props)) {
    if (previous[name] === value && name !== "value" && typeof value !== "object") continue;
    setProp(element, name, value, svg);
  }
  element.__props = { ...props };
}

function sameKind(node, vnode) {
  if (typeof vnode === "string") return node.nodeType === 3;
  if (vnode.tag === "#static") return node.__staticKey === vnode.key;
  if (node.nodeType !== 1) return false;
  if (node.tagName.toLowerCase() !== vnode.tag.toLowerCase()) return false;
  const key = vnode.props.key === undefined ? undefined : String(vnode.props.key);
  return key === undefined ? node.__key === undefined : node.__key === key;
}

function reconcile(parent, vnodes, inSvg) {
  const existing = Array.from(parent.childNodes);
  const byKey = new Map();
  for (const node of existing) if (node.__key !== undefined) byKey.set(node.__key, node);
  const used = new Set();
  const wanted = [];
  vnodes.forEach((vnode, index) => {
    let node = null;
    if (typeof vnode !== "string" && vnode.tag !== "#static" && vnode.props.key !== undefined) {
      const candidate = byKey.get(String(vnode.props.key));
      if (candidate && sameKind(candidate, vnode) && !used.has(candidate)) node = candidate;
    } else {
      const candidate = existing[index];
      if (candidate && !used.has(candidate) && sameKind(candidate, vnode)) node = candidate;
    }
    if (node) {
      used.add(node);
      patch(node, vnode, inSvg);
    } else {
      node = create(vnode, inSvg);
      used.add(node);
    }
    wanted.push(node);
  });
  for (const node of existing) if (!used.has(node)) parent.removeChild(node);
  wanted.forEach((node, index) => {
    if (parent.childNodes[index] !== node) parent.insertBefore(node, parent.childNodes[index] ?? null);
  });
}

function patch(node, vnode, inSvg) {
  if (typeof vnode === "string") {
    if (node.data !== vnode) node.data = vnode;
    return;
  }
  if (vnode.tag === "#static") return;
  const svg = isSvg(vnode.tag, inSvg);
  applyProps(node, vnode.props, svg);
  reconcile(node, vnode.children, svg && vnode.tag !== "foreignObject");
}

/** Makes the children of `container` match `vnodes` (one vnode or an array). */
export function mount(container, vnodes) {
  reconcile(container, flatten([vnodes]), false);
}

/** Serialises a vnode tree to HTML text; used by tests and never by the page. */
export function toHtml(vnode) {
  if (typeof vnode === "string") return vnode.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  if (vnode.tag === "#static") return toHtml(vnode.node);
  const attributes = Object.entries(vnode.props)
    .filter(([name, value]) => name !== "key" && value !== null && value !== undefined && value !== false)
    .map(([name, value]) => (value === true ? name : `${name}="${toHtml(String(typeof value === "object" ? JSON.stringify(value) : value))}"`))
    .join(" ");
  const inner = vnode.children.map(toHtml).join("");
  return `<${vnode.tag}${attributes ? ` ${attributes}` : ""}>${inner}</${vnode.tag}>`;
}

/** Plain text of a vnode tree, for assertions. */
export function textOf(vnode) {
  if (typeof vnode === "string") return vnode;
  if (vnode.tag === "#static") return textOf(vnode.node);
  return vnode.children.map(textOf).join(" ").replace(/\s+/g, " ").trim();
}
