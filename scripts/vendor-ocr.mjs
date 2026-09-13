// Copies the Tesseract worker, WASM cores, and English model out of node_modules and
// into public/tesseract so the browser loads them from our own origin.
//
// Tesseract.js otherwise fetches these from a public CDN at recognize() time. Marcus
// Williams' interview notes say the TTB network blocks outbound traffic to most domains
// and that the previous vendor pilot failed for exactly that reason, so OCR here has to
// work with no egress at all. Running this at build time keeps ~20 MB of binaries out of
// git while still shipping them with the deployed app.
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "tesseract");

const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

await mkdir(outDir, { recursive: true });

// The worker script tesseract.js spawns.
await copyFile(join(pkgDir("tesseract.js"), "dist", "worker.min.js"), join(outDir, "worker.min.js"));

// The worker picks a core at runtime from the browser's SIMD support, so all three
// support levels have to be present. Only the "-lstm" builds are copied because
// src/lib/ocr.ts pins the engine to LSTM_ONLY; carrying the legacy cores as well would
// roughly double the deployed asset size for a mode we never request.
const coreDir = pkgDir("tesseract.js-core");
const cores = (await readdir(coreDir)).filter(
  (f) => /-lstm\.wasm(\.js)?$/.test(f)
);
await Promise.all(cores.map((f) => copyFile(join(coreDir, f), join(outDir, f))));

// "best_int" is the integer-quantised model: ~2.9 MB against ~11 MB for the float build,
// with the accuracy we need on printed label text.
await copyFile(
  join(pkgDir("@tesseract.js-data/eng"), "4.0.0_best_int", "eng.traineddata.gz"),
  join(outDir, "eng.traineddata.gz")
);

console.log(`vendored OCR runtime -> public/tesseract (${cores.length} cores, worker, eng model)`);
