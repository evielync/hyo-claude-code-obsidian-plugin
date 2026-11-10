import { requestUrl } from "obsidian";
import { STT_TIMEOUT_ERROR, STT_TIMEOUT_MS } from "./elevenlabs-api";

/**
 * Transcribe a dictation with OpenAI (`/v1/audio/transcriptions`). Used when
 * the voice engine is GPT-Live, so one OpenAI key covers both the live call
 * and dictation on the phone.
 *
 * `gpt-transcribe` writes down every word as spoken. Tested against Ev's own
 * recorded voice on 10 Nov 2026, three runs per clip:
 *
 *   clip   gpt-4o-transcribe   gpt-transcribe   (ElevenLabs Scribe, for reference)
 *   8s     23 / 15 / 17 words  32 / 32 / 32     31
 *   20s    23 / 56 / 23        60 / 60 / 60     61
 *   30s    15 / 15 / 15        76 / 76 / 76     77
 *   90s    302                 304              299
 *
 * `gpt-4o-transcribe` keeps long notes whole but reduces a short dictation
 * to roughly one sentence, so it must not be used here.
 *
 * Obsidian's `requestUrl` doesn't take FormData, so the multipart body is
 * built by hand, the same way the ElevenLabs path does it.
 */
const STT_MODEL = "gpt-transcribe";

export async function openAiSpeechToText(
  apiKey: string,
  audioData: ArrayBuffer,
  mimeType: string = "audio/webm",
  timeoutMs: number = STT_TIMEOUT_MS
): Promise<string> {
  const boundary = "----HyoVoiceBoundary" + Date.now();
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();

  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${STT_MODEL}\r\n`
    )
  );
  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`
    )
  );

  // The file extension has to match the real container format.
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
  parts.push(encoder.encode(`--${boundary}--\r\n`));

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }

  const reqPromise = requestUrl({
    url: "https://api.openai.com/v1/audio/transcriptions",
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: body.buffer,
  });
  reqPromise.catch(() => {});

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(STT_TIMEOUT_ERROR)), timeoutMs);
  });

  try {
    const res = await Promise.race([reqPromise, timeout]);
    return res.json?.text || "";
  } finally {
    clearTimeout(timer!);
  }
}
