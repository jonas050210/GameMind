import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `tsc` only emits JavaScript, and the Control Center serves HTML/CSS/client-side JS from its own module
 * directory. This copies those non-TypeScript assets next to the compiled output so `npm start` and
 * `node dist/src/cli.js` serve the dashboard exactly like `npm run dev` does.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = ["src/control-center/public"];

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Every file below `directory` (sub-directories included), as sorted forward-slash paths relative to it. */
async function filesUnder(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

// The project emits to `dist/src/...`; check both layouts instead of guessing.
const outputRoots = ["dist/src", "dist"];
let copied = 0;
for (const relative of sources) {
  const from = path.join(root, relative);
  if (!(await exists(from))) {
    console.error(`copy-assets: ${relative} is missing; nothing to copy.`);
    process.exitCode = 1;
    continue;
  }
  for (const output of outputRoots) {
    if (!(await exists(path.join(root, output)))) continue;
    const candidate = path.join(root, output, relative.replace(/^src\//, ""));
    await mkdir(path.dirname(candidate), { recursive: true });
    // Declaration files exist only so TypeScript tests can type-check the browser modules; the browser never loads them.
    await cp(from, candidate, { recursive: true, force: true, filter: (source) => !source.endsWith(".d.ts") });
    // The page is a tree of ES modules: a file that did not arrive is a blank page, so a short copy fails the build.
    const expected = (await filesUnder(from)).filter((name) => !name.endsWith(".d.ts"));
    const present = new Set(await filesUnder(candidate));
    const missing = expected.filter((name) => !present.has(name));
    if (missing.length > 0) {
      console.error(`copy-assets: ${missing.length} file(s) did not reach ${path.relative(root, candidate)}: ${missing.join(", ")}`);
      process.exitCode = 1;
    }
    copied += expected.length - missing.length;
    console.log(`copy-assets: ${relative} -> ${path.relative(root, candidate)} (${expected.length - missing.length} of ${expected.length} files, sub-directories included)`);
    break;
  }
}
if (copied === 0 && !process.exitCode) {
  console.error("copy-assets: no output directory found; run tsc first.");
  process.exitCode = 1;
}
