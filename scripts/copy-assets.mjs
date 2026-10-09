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
    await cp(from, candidate, { recursive: true, force: true });
    const files = await readdir(candidate);
    copied += files.length;
    console.log(`copy-assets: ${relative} -> ${path.relative(root, candidate)} (${files.length} files)`);
    break;
  }
}
if (copied === 0 && !process.exitCode) {
  console.error("copy-assets: no output directory found; run tsc first.");
  process.exitCode = 1;
}
