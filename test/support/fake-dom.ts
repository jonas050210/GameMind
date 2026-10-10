/**
 * A small stand-in for the browser, enough to run the real Control Center page (index.html + app.js + views) in Node.
 *
 * The sandbox that builds this project has no browser, so the page is exercised here instead: the real index.html is
 * parsed into this DOM, the real app.js boots against it, and events are dispatched the way a user would trigger them.
 * It implements only what the page uses (elements, text, attributes and reflected properties, form-control state,
 * selectors used by the page, event bubbling, a deterministic clock). It does not lay anything out or paint anything, so
 * it can show that the right text, controls and states are on the page but not how they look: see the visual caveat
 * in the project documentation.
 */

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target: FakeNode | null;
  currentTarget: FakeNode | FakeDocument | FakeWindow | null;
  defaultPrevented: boolean;
  key?: string;
  preventDefault(): void;
  stopPropagation(): void;
  [extra: string]: unknown;
}

export type FakeNode = FakeElement | FakeText;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}

export class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  [extra: string]: unknown;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
  set textContent(value: string) {
    this.data = value;
  }
}

class FakeStyle {
  private readonly properties = new Map<string, string>();
  [name: string]: unknown;
  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }
  removeProperty(name: string): void {
    this.properties.delete(name);
  }
  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? "";
  }
}

type Predicate = (element: FakeElement) => boolean;

function parseCompound(text: string): Predicate {
  const predicates: Predicate[] = [];
  let rest = text.trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) {
    const name = tag[0].toLowerCase();
    predicates.push((element) => element.tagName.toLowerCase() === name);
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    const id = /^#([\w-]+)/.exec(rest);
    const cls = /^\.([\w-]+)/.exec(rest);
    const attribute = /^\[([\w-]+)(?:=("[^"]*"|'[^']*'|[^\]]*))?\]/.exec(rest);
    if (id) {
      predicates.push((element) => element.getAttribute("id") === id[1]);
      rest = rest.slice(id[0].length);
    } else if (cls) {
      predicates.push((element) => (element.getAttribute("class") ?? "").split(/\s+/).includes(cls[1] as string));
      rest = rest.slice(cls[0].length);
    } else if (attribute) {
      const name = attribute[1] as string;
      const expected = attribute[2] === undefined ? null : attribute[2].replace(/^["']|["']$/g, "");
      predicates.push((element) => (expected === null ? element.hasAttribute(name) : element.getAttribute(name) === expected));
      rest = rest.slice(attribute[0].length);
    } else {
      throw new Error(`The fake DOM does not understand the selector part '${rest}' in '${text}'.`);
    }
  }
  return (element) => predicates.every((predicate) => predicate(element));
}

export function compileSelector(selector: string): Predicate {
  const alternatives = selector.split(",").map(parseCompound);
  return (element) => alternatives.some((predicate) => predicate(element));
}

const BOOLEAN_REFLECTED = ["hidden", "disabled", "required"] as const;
const STRING_REFLECTED = ["title", "name", "placeholder", "min", "max", "step", "href", "src", "lang", "role", "htmlFor"] as const;

export class FakeElement {
  readonly nodeType = 1;
  parentNode: FakeElement | null = null;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly attributes = new Map<string, string>();
  readonly style = new FakeStyle();
  private readonly listeners = new Map<string, Listener[]>();
  private valueText: string | null = null;
  private checkedState: boolean | null = null;
  private selectedState: boolean | null = null;
  [extra: string]: unknown;

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
    readonly namespaceURI: string | null = null,
  ) {
    for (const name of BOOLEAN_REFLECTED) {
      Object.defineProperty(this, name, {
        get: () => this.hasAttribute(name),
        set: (value: unknown) => (value ? this.setAttribute(name, "") : this.removeAttribute(name)),
        configurable: true,
      });
    }
    for (const name of STRING_REFLECTED) {
      const attribute = name === "htmlFor" ? "for" : name;
      Object.defineProperty(this, name, {
        get: () => this.getAttribute(attribute) ?? "",
        set: (value: unknown) => this.setAttribute(attribute, String(value)),
        configurable: true,
      });
    }
  }

  // ---- attributes and reflected properties ---------------------------------------------------------
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    this.ownerDocument.touch();
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
    this.ownerDocument.touch();
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  set id(value: string) {
    this.setAttribute("id", value);
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  set className(value: string) {
    this.setAttribute("class", value);
  }
  get type(): string {
    const declared = this.getAttribute("type");
    if (declared !== null) return declared.toLowerCase();
    return this.tagName.toLowerCase() === "button" ? "submit" : "text";
  }
  set type(value: string) {
    this.setAttribute("type", value);
  }
  get tabIndex(): number {
    const declared = this.getAttribute("tabindex");
    return declared === null ? -1 : Number(declared);
  }
  set tabIndex(value: number) {
    this.setAttribute("tabindex", String(value));
  }
  get dataset(): Record<string, string> {
    const element = this;
    return new Proxy({} as Record<string, string>, {
      get: (_target, property: string) => element.getAttribute(`data-${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`) ?? undefined,
      set: (_target, property: string, value: string) => {
        element.setAttribute(`data-${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, String(value));
        return true;
      },
    });
  }

  // ---- form-control state --------------------------------------------------------------------------
  get value(): string {
    const tag = this.tagName.toLowerCase();
    if (tag === "select") {
      const options = this.options;
      return (options.find((option) => option.selected) ?? options[0])?.value ?? "";
    }
    if (tag === "option") return this.valueText ?? this.getAttribute("value") ?? this.textContent;
    const fallback = this.type === "checkbox" || this.type === "radio" ? "on" : "";
    return this.valueText ?? this.getAttribute("value") ?? fallback;
  }
  set value(next: string) {
    const text = String(next);
    if (this.tagName.toLowerCase() === "select") {
      for (const option of this.options) option.selected = option.value === text;
      return;
    }
    this.valueText = text;
  }
  get checked(): boolean {
    return this.checkedState ?? this.hasAttribute("checked");
  }
  set checked(value: boolean) {
    this.checkedState = Boolean(value);
  }
  get selected(): boolean {
    return this.selectedState ?? this.hasAttribute("selected");
  }
  set selected(value: boolean) {
    this.selectedState = Boolean(value);
  }
  get options(): FakeElement[] {
    return this.descendants().filter((element) => element.tagName.toLowerCase() === "option");
  }

  // ---- tree ----------------------------------------------------------------------------------------
  get firstChild(): FakeElement | FakeText | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeElement | FakeText | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node.nodeType === 1);
  }
  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join("");
  }
  set textContent(value: string) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (value !== "") this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }

  appendChild<T extends FakeElement | FakeText>(node: T): T {
    return this.insertBefore(node, null);
  }
  insertBefore<T extends FakeElement | FakeText>(node: T, reference: FakeElement | FakeText | null): T {
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
    if (index < 0) throw new Error("insertBefore: the reference node is not a child of this element");
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    this.ownerDocument.touch();
    return node;
  }
  removeChild<T extends FakeElement | FakeText>(node: T): T {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error("removeChild: the node is not a child of this element");
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    this.ownerDocument.touch();
    return node;
  }
  descendants(): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.childNodes) {
      if (child.nodeType === 1) {
        found.push(child as FakeElement);
        found.push(...(child as FakeElement).descendants());
      }
    }
    return found;
  }
  matches(selector: string): boolean {
    return compileSelector(selector)(this);
  }
  closest(selector: string): FakeElement | null {
    const predicate = compileSelector(selector);
    for (let node: FakeElement | null = this; node; node = node.parentNode) if (predicate(node)) return node;
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const predicate = compileSelector(selector);
    return this.descendants().filter(predicate);
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  get form(): FakeElement | null {
    return this.closest("form");
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }

  // ---- events --------------------------------------------------------------------------------------
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
  }
  listenersFor(type: string): Listener[] {
    return [...(this.listeners.get(type) ?? [])];
  }
}

export class FakeDocument {
  readonly nodeType = 9;
  readonly documentElement: FakeElement;
  body: FakeElement;
  hidden = false;
  title = "";
  activeElement: FakeElement;
  private readonly listeners = new Map<string, Listener[]>();
  private version = 0;
  private indexVersion = -1;
  private index = new Map<string, FakeElement>();

  constructor() {
    this.documentElement = new FakeElement(this, "HTML");
    this.body = new FakeElement(this, "BODY");
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  touch(): void {
    this.version += 1;
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag.toUpperCase());
  }
  createElementNS(namespace: string, tag: string): FakeElement {
    return new FakeElement(this, tag, namespace);
  }
  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }
  getElementById(id: string): FakeElement | null {
    if (this.indexVersion !== this.version) {
      this.index = new Map();
      for (const element of [this.documentElement, ...this.documentElement.descendants()]) {
        const value = element.getAttribute("id");
        if (value !== null && !this.index.has(value)) this.index.set(value, element);
      }
      this.indexVersion = this.version;
    }
    const found = this.index.get(id) ?? null;
    return found && this.contains(found) ? found : null;
  }
  contains(element: FakeElement): boolean {
    for (let node: FakeElement | null = element; node; node = node.parentNode) if (node === this.documentElement) return true;
    return false;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
  }
  listenersFor(type: string): Listener[] {
    return [...(this.listeners.get(type) ?? [])];
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  /** Dispatches an event that bubbles from `target` up to the document, as a browser does. */
  dispatch(target: FakeNode, type: string, init: Record<string, unknown> = {}): FakeEvent {
    let stopped = false;
    const event: FakeEvent = {
      type,
      target,
      currentTarget: null,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
      ...init,
    };
    for (let node: FakeElement | null = target.nodeType === 1 ? (target as FakeElement) : target.parentNode; node && !stopped; node = node.parentNode) {
      event.currentTarget = node;
      for (const listener of node.listenersFor(type)) listener(event);
    }
    if (!stopped) {
      event.currentTarget = this as unknown as FakeDocument;
      for (const listener of this.listenersFor(type)) listener(event);
    }
    return event;
  }
}

export class FakeStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

export class FakeWindow {
  readonly location = { hash: "" };
  readonly localStorage = new FakeStorage();
  readonly console = { error: (..._args: unknown[]) => undefined, warn: (..._args: unknown[]) => undefined, errors: [] as unknown[] };
  private readonly listeners = new Map<string, Listener[]>();
  confirmations: string[] = [];
  confirmAnswer = true;
  prefersDark = false;
  constructor(readonly document: FakeDocument) {
    this.console.error = (...args: unknown[]) => {
      this.console.errors.push(args);
    };
  }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  confirm = (message: string): boolean => {
    this.confirmations.push(message);
    return this.confirmAnswer;
  };
  matchMedia = (_query: string): { matches: boolean } => ({ matches: this.prefersDark });
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type } as FakeEvent);
  }
}

/** Deterministic timers: nothing runs until the test advances the clock. */
export class FakeClock {
  nowMs = Date.parse("2026-10-10T12:00:00.000Z");
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  private sequence = 0;
  readonly now = (): number => this.nowMs;
  readonly setTimer = (run: () => void, ms: number): number => {
    this.sequence += 1;
    this.timers.set(this.sequence, { at: this.nowMs + ms, run });
    return this.sequence;
  };
  readonly clearTimer = (id: number): void => {
    this.timers.delete(id);
  };
  get pending(): number {
    return this.timers.size;
  }
  pendingDelays(): number[] {
    return [...this.timers.values()].map((timer) => timer.at - this.nowMs).sort((a, b) => a - b);
  }
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.nowMs = Math.max(this.nowMs, due[1].at);
      due[1].run();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.nowMs = target;
  }
}

// ---- HTML parsing -----------------------------------------------------------------------------------

const VOID_TAGS = new Set(["meta", "link", "input", "br", "hr", "img"]);

/** Parses well-formed HTML (the Control Center's own page) into `document`. */
export function parseHtml(document: FakeDocument, html: string): void {
  const stack: FakeElement[] = [document.documentElement];
  const top = (): FakeElement => stack[stack.length - 1] as FakeElement;
  let index = 0;
  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index);
      index = end < 0 ? html.length : end + 3;
    } else if (html.startsWith("<!", index)) {
      const end = html.indexOf(">", index);
      index = end < 0 ? html.length : end + 1;
    } else if (html.startsWith("</", index)) {
      const end = html.indexOf(">", index);
      const name = html.slice(index + 2, end < 0 ? html.length : end).trim().toLowerCase();
      index = end < 0 ? html.length : end + 1;
      if (name === "html" || name === "body") continue;
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if ((stack[depth] as FakeElement).tagName.toLowerCase() === name) {
          stack.length = depth;
          break;
        }
      }
    } else if (html[index] === "<" && /[a-zA-Z]/.test(html[index + 1] ?? "")) {
      const nameMatch = /^<([a-zA-Z][\w-]*)/.exec(html.slice(index)) as RegExpExecArray;
      const name = (nameMatch[1] as string).toLowerCase();
      let cursor = index + nameMatch[0].length;
      const attributes: Array<[string, string]> = [];
      let selfClosing = false;
      for (;;) {
        while (/\s/.test(html[cursor] ?? "")) cursor += 1;
        if (html[cursor] === ">") {
          cursor += 1;
          break;
        }
        if (html[cursor] === "/" && html[cursor + 1] === ">") {
          selfClosing = true;
          cursor += 2;
          break;
        }
        if (cursor >= html.length) break;
        const attribute = /^([^\s=>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/.exec(html.slice(cursor));
        if (!attribute) {
          cursor += 1;
          continue;
        }
        const raw = attribute[2];
        attributes.push([attribute[1] as string, raw === undefined ? "" : decodeEntities(raw.replace(/^["']|["']$/g, ""))]);
        cursor += attribute[0].length;
      }
      index = cursor;
      if (name === "html") {
        for (const [key, value] of attributes) document.documentElement.setAttribute(key, value);
        continue;
      }
      if (name === "body") {
        for (const [key, value] of attributes) document.body.setAttribute(key, value);
        stack.length = 0;
        stack.push(document.documentElement, document.body);
        continue;
      }
      const element = document.createElement(name);
      for (const [key, value] of attributes) element.setAttribute(key, value);
      if (name === "head") {
        document.documentElement.insertBefore(element, document.body);
        stack.push(element);
        continue;
      }
      if (name === "script" || name === "style") {
        const end = html.indexOf(`</${name}`, index);
        const text = html.slice(index, end < 0 ? html.length : end);
        top().appendChild(element);
        if (text.length > 0) element.appendChild(document.createTextNode(text));
        index = end < 0 ? html.length : html.indexOf(">", end) + 1;
        continue;
      }
      top().appendChild(element);
      if (!VOID_TAGS.has(name) && !selfClosing) stack.push(element);
    } else {
      const next = html.indexOf("<", index + 1);
      const end = next < 0 ? html.length : next;
      const text = html.slice(index, end);
      index = end;
      if (text.trim() !== "") top().appendChild(document.createTextNode(decodeEntities(text.replace(/\s+/g, " "))));
    }
  }
}

// ---- page: a parsed document with user-level helpers --------------------------------------------------

export interface PageOptions {
  readonly html: string;
}

export class Page {
  readonly document = new FakeDocument();
  readonly window: FakeWindow;
  readonly clock = new FakeClock();

  constructor(options: PageOptions) {
    parseHtml(this.document, options.html);
    this.window = new FakeWindow(this.document);
  }

  /** Makes the stand-in the page's global `document`/`window`, as the browser would. */
  install(): () => void {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = { document: globals.document, window: globals.window };
    globals.document = this.document;
    globals.window = this.window;
    return () => {
      globals.document = previous.document;
      globals.window = previous.window;
    };
  }

  byId(id: string): FakeElement {
    const element = this.document.getElementById(id);
    if (!element) throw new Error(`There is no element #${id} on the page.`);
    return element;
  }

  has(id: string): boolean {
    return this.document.getElementById(id) !== null;
  }

  /** What a person could read: text of everything not hidden. */
  visibleText(target: string | FakeElement | FakeText): string {
    const root = typeof target === "string" ? this.byId(target) : target;
    const parts: string[] = [];
    const walk = (node: FakeElement | FakeText): void => {
      if (node.nodeType === 3) {
        parts.push((node as FakeText).data);
        return;
      }
      const element = node as FakeElement;
      if (element.hasAttribute("hidden")) return;
      if (["script", "style"].includes(element.tagName.toLowerCase())) return;
      for (const child of element.childNodes) walk(child);
      if (["div", "p", "li", "section", "header", "tr", "h1", "h2", "h3", "h4", "h5", "dt", "dd", "button", "label", "option"].includes(element.tagName.toLowerCase())) parts.push(" ");
    };
    walk(root);
    return parts.join("").replace(/\s+/g, " ").trim();
  }

  /** All elements under `root` (or the whole page) matching a selector. */
  all(selector: string, root?: string): FakeElement[] {
    return (root ? this.byId(root) : this.document.documentElement).querySelectorAll(selector);
  }

  /** Elements a person could press, by their visible label. */
  buttons(root?: string): FakeElement[] {
    return this.all("button", root).filter((button) => !this.isHidden(button));
  }

  isHidden(element: FakeElement): boolean {
    for (let node: FakeElement | null = element; node; node = node.parentNode) if (node.hasAttribute("hidden")) return true;
    return false;
  }

  button(label: string | RegExp, root?: string): FakeElement {
    const matches = this.buttons(root).filter((button) => (typeof label === "string" ? this.visibleText(button) === label : label.test(this.visibleText(button))));
    if (matches.length === 0) throw new Error(`No visible button '${String(label)}'${root ? ` in #${root}` : ""}. Buttons there: ${this.buttons(root).map((button) => this.visibleText(button)).join(" | ")}`);
    return matches[0] as FakeElement;
  }

  // ---- user actions --------------------------------------------------------------------------------
  click(target: string | FakeElement): void {
    const element = typeof target === "string" ? this.byId(target) : target;
    if (this.isHidden(element)) throw new Error("A hidden control cannot be clicked.");
    if (element.hasAttribute("disabled")) return; // a disabled button does not fire click
    if (element.type === "radio") {
      this.setRadio(element);
      this.document.dispatch(element, "click");
      this.document.dispatch(element, "change");
      return;
    }
    if (element.type === "checkbox") {
      element.checked = !element.checked;
      this.document.dispatch(element, "click");
      this.document.dispatch(element, "input");
      this.document.dispatch(element, "change");
      return;
    }
    const event = this.document.dispatch(element, "click");
    if (element.tagName.toLowerCase() === "button" && element.type === "submit" && !event.defaultPrevented) {
      const form = element.form;
      if (form) this.document.dispatch(form, "submit");
    }
  }

  private setRadio(element: FakeElement): void {
    const group = element.getAttribute("name");
    const form = element.closest("form") ?? this.document.documentElement;
    for (const other of form.querySelectorAll("input")) if (other.type === "radio" && other.getAttribute("name") === group) other.checked = false;
    element.checked = true;
  }

  type(target: string | FakeElement, text: string): void {
    const element = typeof target === "string" ? this.byId(target) : target;
    element.focus();
    element.value = text;
    this.document.dispatch(element, "input");
    element.blur();
    this.document.dispatch(element, "change");
  }

  choose(target: string | FakeElement, value: string): void {
    const element = typeof target === "string" ? this.byId(target) : target;
    if (!element.options.some((option) => option.value === value)) throw new Error(`#${element.id} has no option '${value}'. Options: ${element.options.map((option) => option.value).join(", ")}`);
    element.value = value;
    this.document.dispatch(element, "change");
  }

  check(target: string | FakeElement, checked = true): void {
    const element = typeof target === "string" ? this.byId(target) : target;
    if (element.checked !== checked) this.click(element);
  }

  submit(form: string | FakeElement): FakeEvent {
    const element = typeof form === "string" ? this.byId(form) : form;
    return this.document.dispatch(element, "submit");
  }

  press(target: string | FakeElement, key: string): FakeEvent {
    const element = typeof target === "string" ? this.byId(target) : target;
    return this.document.dispatch(element, "keydown", { key });
  }

  setHidden(hidden: boolean): void {
    this.document.hidden = hidden;
    this.document.dispatch(this.document.body, "visibilitychange");
  }
}

/** Waits (real time) until `condition` holds; used where the page talks to a real HTTP server. */
export async function waitUntil(condition: () => boolean | Promise<boolean>, message: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting until ${message}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  }
}
