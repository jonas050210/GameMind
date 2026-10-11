/**
 * The Control Center in German: the switch itself, what it remembers, and that the catalog really covers the
 * interface. The translation is applied where text reaches the DOM, so these tests read the rendered page the
 * same way a person would — no view has to know about languages.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PUBLIC_DIRECTORY, bootPage, loadUi, stubServer, type BootedPage, type StubServer } from "./support/ui-harness.js";
import { capturedData, clone } from "./support/ui-fixtures.js";

await loadUi();
const real = await capturedData();

type Snapshot = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function server(change: (snapshot: Snapshot) => void = () => undefined): StubServer {
  const snapshot = clone(real.snapshot);
  change(snapshot);
  return stubServer(snapshot, clone(real.queries));
}

async function withPage(
  stub: StubServer,
  run: (booted: BootedPage) => Promise<void>,
  options: { storedLanguage?: string; storedTheme?: string } = {},
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

// ---- the switch ----------------------------------------------------------------------------------------------

test("the switch turns the interface German, remembers the choice, and switching back restores the English text", async () => {
  await withPage(server(), async ({ page }) => {
    assert.equal(page.document.documentElement.getAttribute("lang"), "en");
    const englishTitle = page.document.title;
    page.click("tools-navigation-summary"); // reveal the tabs the way a person does
    assert.equal(page.visibleText("tab-overview"), "Overview");
    assert.equal(page.byId("lang-en").getAttribute("aria-pressed"), "true", "the switch shows which language is on");
    assert.equal(page.byId("lang-de").getAttribute("aria-pressed"), "false");

    page.click("lang-de");

    assert.equal(page.document.documentElement.getAttribute("lang"), "de");
    assert.equal(page.window.localStorage.getItem("gamemind.language"), "de");
    assert.equal(page.visibleText("tab-overview"), "Übersicht", "text from index.html is translated");
    assert.equal(page.visibleText("tab-bots"), "Bots", "a word German spells the same stays as it is");
    assert.equal(page.byId("lang-de").getAttribute("aria-pressed"), "true");
    assert.equal(page.visibleText("tab-training"), "Training");
    assert.match(page.visibleText("updated"), /^(Gerade aktualisiert|Vor .* aktualisiert)$/, "text the shell composed is translated");
    assert.match(page.document.title, /· GameMind$/, "the browser tab title keeps its shape");
    assert.notEqual(page.document.title, englishTitle, "the browser tab title follows the interface");

    page.click("lang-en");

    assert.equal(page.document.documentElement.getAttribute("lang"), "en");
    assert.equal(page.visibleText("tab-overview"), "Overview", "the English text comes back exactly");
    assert.match(page.visibleText("updated"), /^(Updated just now|Updated .* ago)$/);
    assert.equal(page.document.title, englishTitle);
  });
});

test("panels rendered later are German too, and a remembered language is applied at boot", async () => {
  await withPage(
    server((snapshot) => {
      snapshot.session.state = "idle";
    }),
    async ({ page }) => {
      page.click("lang-de");
      if (!page.byId("tools-navigation").open) page.click("tools-navigation-summary");
      page.click("tab-bots");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(page.visibleText("session-pill-text"), "Verbunden · Leerlauf", "the pill in the header is German");
      const bots = page.visibleText("panel-bots");
      assert.match(bots, /Sitzung/, "the panel that was drawn after the switch is German");
      assert.doesNotMatch(bots, /Connection status|Connection details|Controls/, "no English heading is left in the panel");
    },
    { storedLanguage: "de" },
  );
});

test("an unknown stored value falls back to English", async () => {
  await withPage(
    server(),
    async ({ page }) => {
      page.click("tools-navigation-summary");
      assert.equal(page.visibleText("tab-overview"), "Overview");
      assert.equal(page.byId("lang-en").getAttribute("aria-pressed"), "true");
    },
    { storedLanguage: "fr" },
  );
});

// ---- the catalog ---------------------------------------------------------------------------------------------

/** Words German writes the same way; they are deliberately not in the catalog. */
const IDENTICAL_IN_GERMAN = new Set([
  "Bots",
  "Control Center",
  "Deutsch",
  "Exploration",
  "GameMind",
  "Host",
  "Pause",
  "Port",
  "Status",
  "Training",
  "Version",
  // filter values that name runtime ids, not interface words
  "any",
  "default",
  "live",
  "microsoft",
  "offline",
  "system",
]);

/** Interface prose in a module: a letter, four characters or more, and none of the code punctuation. */
function looksLikeText(value: string): boolean {
  return value.length >= 4 && /[A-Za-zÄÖÜäöüß]/.test(value) && /^[A-ZÄÖÜ0-9–-]/.test(value) && !/[<>{}\[\]/\\_=;|`~^$*#@%&]/.test(value);
}

/** The same for text nodes in the page itself: a label may start lowercase (`info and above`). */
function looksLikeLabel(value: string): boolean {
  return value.length >= 4 && /[A-Za-zÄÖÜäöüß]{2}/.test(value) && !/[<>{}\[\]/\\_=;|`~^$*#@%&]/.test(value);
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }[name] ?? whole;
  });
}

/** Every quoted string in a module, skipping comments, template literals and regex literals. */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  let previous = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i] ?? "";
    if (char === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === "`") {
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "`") break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let buffer = "";
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          buffer += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (source[i] === quote || source[i] === "\n") break;
        buffer += source[i] ?? "";
        i += 1;
      }
      out.push(buffer);
      i += 1;
      continue;
    }
    if (char === "/" && "(,=:[!&|?{};+".includes(previous)) {
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "/" || source[i] === "\n") break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (!/\s/.test(char)) previous = char;
    i += 1;
  }
  return out;
}

/** Every string the page can render that is not already in the catalog. */
async function catalogGaps(catalog: Record<string, string>): Promise<string[]> {
  const html = await readFile(path.join(PUBLIC_DIRECTORY, "index.html"), "utf8");
  const withoutCode = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  const candidates = new Set<string>();
  for (const match of withoutCode.matchAll(/>([^<>]+)</g)) {
    const text = decodeEntities(match[1] ?? "").trim();
    if (looksLikeLabel(text)) candidates.add(text);
  }
  for (const match of withoutCode.matchAll(/\b(title|aria-label|placeholder|alt)="([^"]*)"/g)) {
    const text = decodeEntities(match[2] ?? "").trim();
    if (looksLikeLabel(text)) candidates.add(text);
  }
  const modules = await readdir(PUBLIC_DIRECTORY, { recursive: true });
  for (const relative of modules.filter((name) => name.endsWith(".js") && !name.includes("i18n"))) {
    const source = await readFile(path.join(PUBLIC_DIRECTORY, relative), "utf8");
    for (const text of stringLiterals(source)) {
      // The lookup trims, so the catalog is keyed by the trimmed text.
      const trimmed = text.trim();
      if (trimmed.includes(" ") && looksLikeText(trimmed)) candidates.add(trimmed);
    }
  }
  return [...candidates].filter((text) => !(text in catalog) && !IDENTICAL_IN_GERMAN.has(text)).sort();
}

test("the catalog has no gaps and the pattern table stays honest", async () => {
  const { german, i18n } = await loadUi();
  assert.ok(Object.keys(german.GERMAN).length > 500, "the catalog holds the interface");
  assert.deepEqual(await catalogGaps(german.GERMAN), [], "every fixed interface string has a German entry");
  assert.ok(german.PATTERNS.length >= 50, "sentences composed from values have patterns");
  for (const rule of german.PATTERNS) {
    assert.match(rule.from.source, /^\^\S*[\s\S]*\$$/, `anchored so it cannot fire inside a sentence: ${rule.from.source}`);
    const groups = (rule.from.source.match(/\((?!\?)/g) ?? []).length;
    for (const used of rule.to.matchAll(/\$(\d)/g)) {
      assert.ok(Number(used[1]) <= groups, `${rule.from.source} uses $${used[1]} but has ${groups} group(s)`);
    }
  }
  // Values the runtime produced must survive both directions untouched.
  const runtimeValues = ["mine_block", "obs-42", "STALE_OBSERVATION", "/home/user/GameMind/data", "minecraft:overworld", "1.20.4", "12/14"];
  for (const value of runtimeValues) assert.equal(i18n.translate(value), value, `${value} is left alone in English`);
  i18n.setLanguage("de");
  try {
    for (const value of runtimeValues) assert.equal(i18n.translate(value), value, `${value} is left alone in German`);
  } finally {
    i18n.setLanguage("en");
  }
});
