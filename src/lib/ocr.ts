import { createWorker, OEM, PSM, type Worker } from "tesseract.js";

export interface OcrResult {
  text: string;
  confidence: number;
  preprocessed: boolean;
}

// Vite rewrites BASE_URL when the app is served from a sub-path, so a GitHub Pages
// deployment finds these too. scripts/vendor-ocr.mjs puts the files here at build time.
const ASSET_BASE = `${import.meta.env.BASE_URL}tesseract/`;

// Tesseract loads a ~3 MB model and a WASM core on first use. Creating a worker per
// image would pay that on every label and blow Sarah Chen's five-second budget, so one
// worker is created lazily and reused for the life of the page.
let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker("eng", OEM.LSTM_ONLY, {
      workerPath: `${ASSET_BASE}worker.min.js`,
      corePath: ASSET_BASE,
      langPath: ASSET_BASE,
      gzip: true
    }).then(async (worker) => {
      // Tesseract.js defaults to SINGLE_BLOCK, which treats the whole label as one run of
      // uniform text and drops the brand name - the largest, most important word on the
      // artwork. AUTO runs real layout analysis and recovers it on every sample label.
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      return worker;
    });
  }
  return workerPromise;
}

/** Frees the model and core. Called when the queue is cleared. */
export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return;
  const worker = await workerPromise;
  workerPromise = null;
  await worker.terminate();
}

// Above this, OCR spends most of its time on pixels that carry no extra glyph detail.
const MAX_DIMENSION = 2000;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The image could not be decoded."));
    image.src = url;
  });
}

/**
 * Grayscale plus a contrast stretch across the observed intensity range.
 *
 * Jenny Park asked for tolerance of labels shot under bad lighting. Normalising the
 * range recovers text from images that are flatly under- or over-exposed, which is the
 * cheap half of that problem. Skew, perspective, and glare are not corrected here; those
 * need geometry work that this prototype does not attempt.
 */
function preprocess(image: HTMLImageElement): HTMLCanvasElement | null {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  context.drawImage(image, 0, 0, width, height);
  const frame = context.getImageData(0, 0, width, height);
  const pixels = frame.data;

  let min = 255;
  let max = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    // Rec. 601 luma: green carries most perceived brightness, blue the least.
    const luma = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    pixels[i] = luma;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
  }

  // A flat image has nothing to stretch, and dividing by that range would blow up noise.
  const range = max - min;
  const stretch = range > 32;
  for (let i = 0; i < pixels.length; i += 4) {
    const value = stretch ? ((pixels[i] - min) * 255) / range : pixels[i];
    pixels[i] = value;
    pixels[i + 1] = value;
    pixels[i + 2] = value;
  }

  context.putImageData(frame, 0, 0);
  return canvas;
}

/**
 * Reads printed text off a label image. Runs entirely in the browser: the worker, WASM
 * core, and language model are all served from this origin, so no request leaves the
 * network the app is opened on.
 */
export async function recognizeLabel(file: Blob): Promise<OcrResult> {
  const objectUrl = URL.createObjectURL(file);
  let source: HTMLCanvasElement | string = objectUrl;
  let preprocessed = false;
  try {
    try {
      const canvas = preprocess(await loadImage(objectUrl));
      if (canvas) {
        source = canvas;
        preprocessed = true;
      }
    } catch {
      // Preprocessing is an optimisation. If the browser cannot decode the image into a
      // canvas, hand the original file to Tesseract and let it report what it finds.
    }

    const worker = await getWorker();
    const { data } = await worker.recognize(source);
    return { text: data.text || "", confidence: (data.confidence ?? 0) / 100, preprocessed };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
