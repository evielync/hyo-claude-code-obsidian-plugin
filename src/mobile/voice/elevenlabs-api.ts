import { requestUrl } from "obsidian";
import { isRecord } from "../../types/json";

/** Dictation on the phone, transcribed by ElevenLabs Scribe. */

const STT_MODEL = "scribe_v2";

// How long we'll wait for a transcription before giving up. Obsidian's
// `requestUrl` has no built-in timeout, so on a flaky mobile connection a hung
// request would otherwise leave the mic stuck in "thinking" forever. The wait
// grows with the audio: a short note gets 30 seconds, and every second of
// recording adds a second and a half on top, up to five minutes. Long
// recordings are split into pieces before they get here (see useVoiceMode), so
// no single request carries more than a couple of minutes of audio.
export const STT_TIMEOUT_MS = 30000;
const STT_TIMEOUT_MAX_MS = 300000;

export function sttTimeoutFor(durationMs: number): number {
  return Math.min(STT_TIMEOUT_MAX_MS, STT_TIMEOUT_MS + Math.max(0, durationMs) * 1.5);
}
export const STT_TIMEOUT_ERROR = "hyo-stt-timeout";

/** `text` from a transcription response, or "". */
export function transcriptText(json: unknown): string {
  return isRecord(json) && typeof json.text === "string" ? json.text : "";
}

/**
 * Transcribe audio using ElevenLabs Scribe (STT) API.
 * Accepts a WebM audio blob and returns the transcript text.
 *
 * Obsidian's `requestUrl` doesn't support FormData, so we construct
 * the multipart body manually.
 */
export async function speechToText(
  apiKey: string,
  audioData: ArrayBuffer,
  mimeType: string = "audio/webm",
  timeoutMs: number = STT_TIMEOUT_MS
): Promise<string> {
  const boundary = "----HyoVoiceBoundary" + Date.now();

  // Build multipart body manually
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();

  // model_id field
  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\n${STT_MODEL}\r\n`
    )
  );

  // file field — extension MUST match the real container format (mimeType),
  // not just default to "wav". Mismatched extension vs Content-Type has been
  // known to confuse format-sniffing on the receiving end.
  const ext = mimeType.includes("webm")
    ? "webm"
    : mimeType.includes("mp4")
    ? "mp4"
    : mimeType.includes("ogg")
    ? "ogg"
    : mimeType.includes("wav")
    ? "wav"
    : "webm";
  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    )
  );
  parts.push(new Uint8Array(audioData));
  parts.push(encoder.encode("\r\n"));

  // closing boundary
  parts.push(encoder.encode(`--${boundary}--\r\n`));

  // Combine into single ArrayBuffer
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }

  const reqPromise = requestUrl({
    url: "https://api.elevenlabs.io/v1/speech-to-text",
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: body.buffer,
  });
  // Swallow a late rejection if the timeout has already won, so it doesn't
  // surface as an unhandled rejection after we've recovered the UI.
  reqPromise.catch(() => undefined);

  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(STT_TIMEOUT_ERROR)), timeoutMs);
  });

  try {
    const res = await Promise.race([reqPromise, timeout]);
    return transcriptText(res.json);
  } finally {
    window.clearTimeout(timer);
  }
}
