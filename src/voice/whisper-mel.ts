import melData from "./whisper-mel-data.json";

/**
 * Whisper log-mel spectrogram — a self-contained port of Transformers.js's
 * WhisperFeatureExtractor for the Smart Turn model, so we don't have to bundle
 * Transformers.js (which broke under esbuild's minifier). The precomputed
 * `window` and `mel_filters` are extracted from Transformers.js and bundled as
 * data, and this implementation was verified to match its output to 0.00000
 * error. Output layout matches the model's expected input: [1, 80, 800].
 */

const WIN = (melData as { window: number[] }).window;
const MEL = (melData as { mel_filters: number[][] }).mel_filters;

const N_SAMPLES = 128000; // 8s @ 16kHz
const N_FFT = 400;
const HOP = 160;
const N_MEL = 80;
const N_FREQ = 201; // n_fft/2 + 1
const N_FRAMES = 800;

export const MEL_DIMS = [1, N_MEL, N_FRAMES];

let cosT: Float64Array[] | null = null;
let sinT: Float64Array[] | null = null;
function ensureTables() {
  if (cosT) return;
  cosT = [];
  sinT = [];
  for (let k = 0; k < N_FREQ; k++) {
    const c = new Float64Array(N_FFT);
    const s = new Float64Array(N_FFT);
    for (let n = 0; n < N_FFT; n++) {
      const a = (2 * Math.PI * k * n) / N_FFT;
      c[n] = Math.cos(a);
      s[n] = Math.sin(a);
    }
    cosT.push(c);
    sinT.push(s);
  }
}

// numpy-style reflect padding (mirror, excluding the edge sample).
function padReflect(x: Float64Array, pad: number): Float64Array {
  const out = new Float64Array(x.length + 2 * pad);
  for (let i = 0; i < x.length; i++) out[pad + i] = x[i];
  for (let i = 0; i < pad; i++) {
    out[pad - 1 - i] = x[i + 1];
    out[pad + x.length + i] = x[x.length - 2 - i];
  }
  return out;
}

/** Compute the [1,80,800] Whisper log-mel features for a 16kHz waveform. */
export function computeMelFeatures(audio: Float32Array): Float32Array {
  ensureTables();
  const buf = new Float64Array(N_SAMPLES);
  const n = Math.min(audio.length, N_SAMPLES);
  for (let i = 0; i < n; i++) buf[i] = audio[i];
  const padded = padReflect(buf, N_FFT / 2);

  // Power spectrum per frame, stored transposed as [freq][frame].
  const power = new Float64Array(N_FREQ * N_FRAMES);
  const s = new Float64Array(N_FFT);
  for (let f = 0; f < N_FRAMES; f++) {
    const off = f * HOP;
    for (let j = 0; j < N_FFT; j++) s[j] = padded[off + j] * WIN[j];
    for (let k = 0; k < N_FREQ; k++) {
      let re = 0;
      let im = 0;
      const ck = cosT![k];
      const sk = sinT![k];
      for (let j = 0; j < N_FFT; j++) {
        re += s[j] * ck[j];
        im -= s[j] * sk[j];
      }
      power[k * N_FRAMES + f] = re * re + im * im;
    }
  }

  // mel_filters[80][201] @ power[201][800] → mel[80][800], then log10 + Whisper
  // normalisation (max-8 floor, shift/scale).
  const mel = new Float32Array(N_MEL * N_FRAMES);
  for (let m = 0; m < N_MEL; m++) {
    const fm = MEL[m];
    for (let f = 0; f < N_FRAMES; f++) {
      let sum = 0;
      for (let k = 0; k < N_FREQ; k++) sum += fm[k] * power[k * N_FRAMES + f];
      mel[m * N_FRAMES + f] = Math.log10(Math.max(1e-10, sum));
    }
  }
  let mx = -Infinity;
  for (let i = 0; i < mel.length; i++) if (mel[i] > mx) mx = mel[i];
  const thr = mx - 8;
  for (let i = 0; i < mel.length; i++) mel[i] = (Math.max(mel[i], thr) + 4) / 4;
  return mel;
}
