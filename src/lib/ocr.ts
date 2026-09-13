import { createWorker, OEM, PSM, type Worker } from "tesseract.js";

export interface OcrResult {
  text: string;
  /** Mean per-character confidence, 0-1. */
  confidence: number;
}

// Served from this origin: scripts/vendor-ocr.mjs copies the worker, WASM core, and model
// here at build time, so recognition works on a network that blocks outbound traffic.
const ASSET_BASE = `${import.meta.env.BASE_URL}tesseract/`;

// Above this, OCR spends most of its time on pixels that carry no extra glyph detail.
const MAX_DIMENSION = 2000;

// Loading the ~3 MB model per image would blow Sarah Chen's five-second budget, so one
// worker is created lazily and reused for the life of the page.
let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: `${ASSET_BASE}worker.min.js`,
    corePath: ASSET_BASE,
    langPath: ASSET_BASE,
    gzip: true
  })
    .then(async (worker) => {
      // The default SINGLE_BLOCK mode treats the label as one uniform run of text and drops
      // the brand name, the largest word on the artwork. AUTO runs real layout analysis.
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      return worker;
    })
    .catch((error: unknown) => {
      // Forget a failed start so the next label retries instead of failing forever.
      workerPromise = null;
      throw error;
    });
  return workerPromise;
}

/** Frees the model and WASM core. Called when the workspace is reset. */
export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return;
  const worker = await workerPromise.catch(() => null);
  workerPromise = null;
  await worker?.terminate();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The image could not be decoded."));
    image.src = url;
  });
}

/**
 * Grayscale plus a contrast stretch across the observed intensity range, which recovers
 * text from flatly under- or over-exposed photographs (Jenny Park's bad-lighting case).
 * Skew, perspective, and glare need geometry work that this prototype does not attempt.
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
    // Rec. 601 luma.
    const luma = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    pixels[i] = luma;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
  }

  // A near-flat image has nothing to stretch, and dividing by that range would amplify noise.
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

/** Reads printed text off a label image, entirely in the browser. */
export async function recognizeLabel(file: Blob): Promise<OcrResult> {
  const objectUrl = URL.createObjectURL(file);
  try {
    let source: HTMLCanvasElement | string = objectUrl;
    try {
      source = preprocess(await loadImage(objectUrl)) ?? objectUrl;
    } catch {
      // Preprocessing is an optimisation. If the browser cannot decode the image into a
      // canvas, Tesseract gets the original file and reports what it finds.
    }
    const { data } = await (await getWorker()).recognize(source);
    return { text: data.text || "", confidence: (data.confidence ?? 0) / 100 };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
