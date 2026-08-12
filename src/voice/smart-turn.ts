import { debug } from "../debug";
import { computeMelFeatures, MEL_DIMS } from "./whisper-mel";

/**
 * Smart Turn v3 — semantic endpointing. Reads the waveform of what's been said
 * so far and predicts whether the speaker is actually finished (vs just pausing
 * mid-thought) — the fix for "it cut me off" that silence-based VAD can't do.
 *
 * Preprocessing (Whisper log-mel) is done by our own `whisper-mel` port —
 * verified byte-identical to Transformers.js — so nothing but onnxruntime-web
 * (already proven to load in Obsidian) is needed at runtime. Lazy-loaded and
 * fails open: if it can't load, every pause is treated as end-of-turn (i.e. it
 * falls back to Silero timing) so the loop never gets stuck.
 */

const MODEL_ID = "onnx-community/smart-turn-v3-ONNX";
const WINDOW_SAMPLES = 16000 * 8; // the model only sees the last 8 seconds

let session: any = null;
let loadPromise: Promise<void> | null = null;
let failed = false;

/** `assetBase` is the Obsidian resource-path base for `vad-assets/` (trailing slash). */
export function loadSmartTurn(assetBase: string): Promise<void> {
  if (session) return Promise.resolve();
  if (loadPromise) return loadPromise;
  console.log("[hyo-voice] Smart Turn loading…");
  loadPromise = (async () => {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    (ort.env.wasm as any).proxy = false;
    ort.env.wasm.wasmPaths = assetBase;
    session = await ort.InferenceSession.create(
      `${assetBase}models/${MODEL_ID}/onnx/model_quantized.onnx`,
      { executionProviders: ["wasm"] }
    );
    console.log("[hyo-voice] Smart Turn loaded ✓");
  })().catch((err) => {
    failed = true;
    console.error("[hyo-voice] Smart Turn failed to load:", err);
  });
  return loadPromise;
}

/**
 * Probability (0–1) that the speaker has finished their turn. Returns 1 (treat
 * as finished) if the model isn't available, so the loop never gets stuck.
 */
export async function turnEndProbability(audio: Float32Array): Promise<number> {
  if (failed || !session) {
    console.log(
      "[hyo-voice] Smart Turn not ready → treating pause as finished"
    );
    return 1;
  }
  try {
    const ort = await import("onnxruntime-web");
    // Judge on the MOST RECENT 8 seconds — what she just said and the pause
    // after it — not the stale start of a long buffer.
    const clip =
      audio.length > WINDOW_SAMPLES
        ? audio.subarray(audio.length - WINDOW_SAMPLES)
        : audio;
    const features = computeMelFeatures(clip); // [1,80,800]
    const feeds: Record<string, any> = {};
    feeds[session.inputNames[0]] = new ort.Tensor("float32", features, MEL_DIMS);
    const res = await session.run(feeds);
    const logit = (res[session.outputNames[0]].data as Float32Array)[0];
    return 1 / (1 + Math.exp(-logit));
  } catch (err) {
    console.error("[hyo-voice] Smart Turn inference error:", err);
    return 1;
  }
}
