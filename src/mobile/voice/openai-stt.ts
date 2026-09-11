import { requestUrl } from "obsidian";
import { STT_TIMEOUT_ERROR, STT_TIMEOUT_MS } from "./elevenlabs-api";

/**
 * Transcribe a dictation with OpenAI (`/v1/audio/transcriptions`). Used when
 * the voice engine is GPT-Live, so one OpenAI key covers both the live call
 * and dictation on the phone.
 *
 * Model verified against Ev's key on 11 Sep 2026: `gpt-4o-transcribe`.
 * Obsidian's `requestUrl` doesn't take FormData, so the multipart body is
 * built by hand, the same way the ElevenLabs path does it.
 */
const STT_MODEL = "gpt-4o-transcribe";

export async function openAiSpeechToText(
  apiKey: string,
  audioData: ArrayBuffer,
  mimeType: string = "audio/webm"
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
    timer = setTimeout(() => reject(new Error(STT_TIMEOUT_ERROR)), STT_TIMEOUT_MS);
  });

  try {
    const res = await Promise.race([reqPromise, timeout]);
    return res.json?.text || "";
  } finally {
    clearTimeout(timer!);
  }
}
