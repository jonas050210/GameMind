// German for the Control Center, applied where text reaches the page.
//
// The page is written in English. Fixed text is translated where it reaches the DOM: `applyTranslations` walks
// the rendered document after every render, remembers the text it found on the node itself and writes the
// catalog's German instead; switching back restores exactly what the views wrote. That keeps the views free of
// translation calls for plain labels.
//
// Sentences built from values (`Updated 3s ago`, `12 seeds, disjoint from training: yes`) cannot be looked up
// after they were put together, so `PATTERNS` matches the rendered sentence and puts the captured values back
// in; a captured value that is itself a known sentence is matched once more, never deeper.
//
// The catalog also carries the short notes the host process writes into the panels (learning and failure
// explanations, the training state, world memory), because a reader cannot tell them apart from the page's own
// text. What is *not* translated, on purpose: the runtime's own catalog (action, skill, scenario and task
// descriptions and their labels), event-log lines, ids, codes, names and numbers, and code samples. Those are
// not in the catalog, so they pass through untouched.
//
// `test/ui-language.test.ts` fails when an interface string has no German entry, when a pattern is not
// anchored or would rewrite runtime text, and when a note the host writes stops being German.
import { GERMAN, PATTERNS } from "./i18n-de.js";

export const LANGUAGES = ["en", "de"];
export const DEFAULT_LANGUAGE = "en";

/** The language the page uses. Set by `setLanguage`, which the Control Center calls when the choice is made. */
let active = DEFAULT_LANGUAGE;

/** Elements whose text is runtime output or code, never interface text. */
const OPAQUE_TAGS = new Set(["SCRIPT", "STYLE", "CODE", "PRE"]);
/** Attributes that carry interface text a reader can see or a screen reader reads out. */
const TRANSLATABLE_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];

export function isLanguage(value) {
  return LANGUAGES.includes(value);
}

export function setLanguage(code) {
  if (isLanguage(code)) active = code;
}

export function language() {
  return active;
}

/** The German text for a whole node or attribute value, or `null` when the catalog does not know it. */
function lookup(text) {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const hit = GERMAN[trimmed];
  if (hit === undefined) return null;
  // Keep the surrounding whitespace: inline text often arrives as fragments of a sentence.
  return text.replace(trimmed, hit);
}

/**
 * A captured value from a sentence. Known words (`yes`, `none`) are looked up; at the top level a value may
 * itself be a composed sentence (`2 failed actions in a row`), which is matched once more — never deeper, so a
 * pattern can never feed itself.
 */
function translateValue(value, deeper) {
  return lookup(value) ?? (deeper ? sentence(value, false) : null) ?? value;
}

/** The German text for a sentence the interface composed, or `null` when no pattern matches it. */
function sentence(text, deeper = true) {
  for (const rule of PATTERNS) {
    const match = rule.from.exec(text);
    if (!match) continue;
    return rule.to.replace(/\$(\d)/g, (whole, index) => {
      const value = match[Number(index)];
      return value === undefined ? "" : translateValue(value, deeper);
    });
  }
  return null;
}

/** The German text for `text`, or `text` itself when neither the catalog nor a pattern knows it. */
export function translate(text) {
  if (active === "en" || typeof text !== "string") return text;
  return lookup(text) ?? sentence(text) ?? text;
}

/** How many strings the German catalog holds; the language test uses it to notice an empty catalog. */
export function catalogSize() {
  return Object.keys(GERMAN).length;
}

function sourceOf(node, current) {
  // The text a view wrote, remembered the first time this node is seen. When the renderer replaces the text
  // (a fresh number in a sentence), the remembered source no longer matches what we wrote, so it is re-read.
  if (node.__i18nSource === undefined || node.__i18nRendered !== current) node.__i18nSource = current;
  return node.__i18nSource;
}

function translateTextNode(node) {
  const current = node.data ?? "";
  const translated = translate(sourceOf(node, current));
  node.__i18nRendered = translated;
  if (current !== translated) node.data = translated;
}

function translateAttributes(element) {
  for (const name of TRANSLATABLE_ATTRIBUTES) {
    if (typeof element.hasAttribute !== "function" || !element.hasAttribute(name)) continue;
    const current = element.getAttribute(name) ?? "";
    const remembered = element.__i18nAttributes ?? {};
    const source = remembered[name] === undefined || remembered[name].rendered !== current ? current : remembered[name].source;
    const translated = translate(source);
    remembered[name] = { source, rendered: translated };
    element.__i18nAttributes = remembered;
    if (current !== translated) element.setAttribute(name, translated);
  }
}

/** Renders `root` (an element or a text node) in the active language; English restores the original text. */
export function applyTranslations(root) {
  if (!root) return;
  const visit = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeType === 3) translateTextNode(child);
      else if (child.nodeType === 1 && !OPAQUE_TAGS.has(child.tagName)) {
        translateAttributes(child);
        visit(child);
      }
    }
  };
  if (root.nodeType === 3) {
    translateTextNode(root);
    return;
  }
  if (root.nodeType !== 1 || OPAQUE_TAGS.has(root.tagName)) return;
  translateAttributes(root);
  visit(root);
}
