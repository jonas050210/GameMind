/**
 * Static check of the browser code in src/control-center/public.
 *
 * The page is plain JavaScript that no compiler builds, so a misspelled name, a stale import or a variable used before its
 * `const` only shows up as a blank page or a ReferenceError in someone's browser (the agent's own `host` crash was exactly a
 * temporal-dead-zone error of that kind). The TypeScript compiler can read the same files with `checkJs`; the diagnostics
 * that mean "this throws or refuses to load" fail the test. Inference noise from untyped JavaScript is deliberately not
 * asserted on.
 *
 * A canary project proves the check can see each kind of defect, so a broken tsconfig cannot make the real check pass by
 * looking at nothing.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const TSC = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const PUBLIC = fileURLToPath(new URL("../src/control-center/public/", import.meta.url)).replace(/[\\/]$/, "");

/** Diagnostics that mean the browser would throw, refuse to link a module, or carry code nobody calls. */
const FATAL: ReadonlyMap<number, string> = new Map([
  [2304, "undeclared name (ReferenceError in the browser)"],
  [2552, "undeclared name that looks like a typo"],
  [2307, "import of a file that does not exist"],
  [2305, "import of a name the module does not export (the module fails to link)"],
  [2724, "import of a name the module does not export (the module fails to link)"],
  [2614, "named import of something that is only a default export (the module fails to link)"],
  [2459, "import of a name the module declares but does not export"],
  [2460, "import of a name the module declares but does not export"],
  [2448, "variable used before its declaration (temporal dead zone)"],
  [2454, "variable used before it was assigned"],
  [2551, "property name that looks like a typo"],
  [2451, "duplicate let/const/class name (SyntaxError)"],
  [2300, "duplicate identifier"],
  [2393, "duplicate function implementation"],
  [6133, "declared but never used (dead code or an unfinished edit)"],
]);

interface Finding {
  readonly file: string | null;
  readonly line: number;
  readonly code: number;
  readonly message: string;
}

/** Syntax errors (1xxx), TypeScript-only syntax in a .js file (8xxx), and a checker that could not run (no file). */
function reason(finding: Finding): string | null {
  if (finding.file === null) return "the checker itself could not run";
  if (finding.code < 2000) return "syntax error";
  if (finding.code >= 8000 && finding.code < 9000) return "TypeScript-only syntax in a JavaScript file";
  return FATAL.get(finding.code) ?? null;
}

interface Checked {
  readonly findings: readonly Finding[];
  /** Files of the project under `directory` that the compiler read, relative to it with forward slashes. */
  readonly files: readonly string[];
}

const forward = (value: string): string => value.split(path.sep).join("/");

async function check(directory: string): Promise<Checked> {
  const workspace = await mkdtemp(path.join(tmpdir(), "gamemind-ui-check-"));
  try {
    const root = forward(directory);
    const configuration = path.join(workspace, "tsconfig.json");
    await writeFile(
      configuration,
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          noEmit: true,
          noUnusedLocals: true,
          strictNullChecks: true,
          noUncheckedSideEffectImports: true,
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          types: [],
          skipLibCheck: true,
        },
        // Only .js roots: a .d.ts beside a .js (policy.d.ts, for the TypeScript tests) would otherwise replace it, and the browser loads the .js.
        include: [`${root}/**/*.js`],
      }),
    );
    const outcome = await execute(process.execPath, [TSC, "-p", configuration, "--pretty", "false", "--listFiles"], { cwd: workspace, maxBuffer: 64 * 1024 * 1024 }).then(
      (done) => done.stdout,
      (failed: { stdout?: string }) => failed.stdout ?? "", // tsc exits non-zero when it finds anything
    );
    const findings: Finding[] = [];
    const files: string[] = [];
    for (const line of outcome.split(/\r?\n/)) {
      const found = /^(?:(.+?)\((\d+),\d+\): )?error TS(\d+): (.*)$/.exec(line);
      if (found) {
        findings.push({ file: found[1] === undefined ? null : forward(path.resolve(workspace, found[1])), line: Number(found[2] ?? 0), code: Number(found[3]), message: found[4] ?? "" });
        continue;
      }
      const listed = forward(line.trim());
      if (listed.startsWith(`${root}/`) && /\.(?:js|d\.ts)$/.test(listed)) files.push(listed.slice(root.length + 1));
    }
    return { findings: findings.map((finding) => ({ ...finding, file: finding.file === null ? null : finding.file.startsWith(`${root}/`) ? finding.file.slice(root.length + 1) : finding.file })), files: files.sort() };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

let shipped: Promise<Checked> | undefined;
const shippedCheck = (): Promise<Checked> => (shipped ??= check(PUBLIC));

test("the Control Center page code has no undeclared names, broken imports, duplicate or unused declarations or syntax errors", async () => {
  const { findings } = await shippedCheck();
  const fatal = findings.flatMap((finding) => {
    const why = reason(finding);
    return why === null ? [] : [`${finding.file ?? "(checker)"}:${finding.line} TS${finding.code} ${why}: ${finding.message}`];
  });
  assert.deepEqual(fatal, [], "these would throw, fail to load, or be dead code in the browser");
});

test("the check reads every JavaScript module of the page, including modules added later", async () => {
  const { files } = await shippedCheck();
  const onDisk = (await readdir(PUBLIC, { recursive: true })).map(forward).filter((name) => name.endsWith(".js")).sort();
  assert.ok(onDisk.includes("app.js"), "the controller is part of the page");
  assert.ok(onDisk.some((name) => name.startsWith("views/")) && onDisk.some((name) => name.startsWith("lib/")), "views and libraries are part of the page");
  assert.deepEqual(files.filter((name) => name.endsWith(".js")), onDisk, "a module the compiler never reads could hide any of these defects");
});

async function withProject<T>(files: Readonly<Record<string, string>>, run: (project: string) => Promise<T>): Promise<T> {
  const project = await mkdtemp(path.join(tmpdir(), "gamemind-ui-canary-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(project, name)), { recursive: true });
      await writeFile(path.join(project, name), contents);
    }
    return await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

test("canary: the check reports each kind of defect it exists to catch", async () => {
  await withProject(
    {
      "lib/helper.js": "export const exists = 1;\n",
      "canary.js": [
        'import { missing } from "./lib/helper.js";',
        'import * as unused from "./lib/helper.js";',
        'import "./lib/not-there.js";',
        "export function undeclared() { return notDefinedAnywhere + 1; }",
        "export function beforeDeclaration() { const total = later + 1; const later = 2; return total; }",
        "export function typo() { return [1, 2].lenght; }",
        "export function unassigned() { /** @type {number} */ let value; return value + 1; }",
        "export function duplicate() { const same = 1; const same = 2; return same; }",
        "export const keep = [missing];",
        "",
      ].join("\n"),
    },
    async (project) => {
      const { findings, files } = await check(project);
      assert.deepEqual(files, ["canary.js", "lib/helper.js"], "the canary project was read");
      const reported = new Set(findings.filter((finding) => reason(finding) !== null).map((finding) => finding.code));
      const expectOne = (label: string, ...codes: number[]): void =>
        assert.ok(codes.some((code) => reported.has(code)), `${label} should be reported (one of TS${codes.join(", TS")}); got ${[...reported].map((code) => `TS${code}`).join(", ")}`);
      expectOne("an import of a name that is not exported", 2305, 2724);
      expectOne("an import of a missing file", 2307);
      expectOne("an unused import", 6133);
      expectOne("an undeclared name", 2304, 2552);
      expectOne("a use before the declaration", 2448);
      expectOne("a misspelled property", 2551);
      expectOne("a use before assignment", 2454);
      expectOne("a duplicate declaration", 2451);
    },
  );
});

test("canary: a syntax error is reported (the compiler then skips every other check, so it is its own project)", async () => {
  await withProject({ "broken.js": "export const broken = ;\n" }, async (project) => {
    const { findings } = await check(project);
    assert.ok(findings.some((finding) => finding.file === "broken.js" && finding.code < 2000 && reason(finding) === "syntax error"), JSON.stringify(findings));
  });
});

test("canary: a project the compiler cannot read at all fails the check instead of passing it", async () => {
  await withProject({ "notes.txt": "no JavaScript here\n" }, async (project) => {
    const { findings, files } = await check(project);
    assert.deepEqual(files, []);
    assert.ok(findings.some((finding) => reason(finding) === "the checker itself could not run"), JSON.stringify(findings));
  });
});
