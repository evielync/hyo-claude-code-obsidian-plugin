import { requestUrl } from "obsidian";

const TTS_MODEL = "eleven_flash_v2_5";
const STT_MODEL = "scribe_v2";
const MAX_TTS_CHARS = 4000;

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

/**
 * Fetch available voices from the user's ElevenLabs account.
 * Filters out premade voices — only returns cloned/custom voices.
 */
export async function listVoices(
  apiKey: string
): Promise<ElevenLabsVoice[]> {
  const res = await requestUrl({
    url: "https://api.elevenlabs.io/v1/voices",
    method: "GET",
    headers: { "xi-api-key": apiKey },
  });
  const data = res.json;
  if (!data?.voices) throw new Error("Invalid response from ElevenLabs");
  return (data.voices as ElevenLabsVoice[])
    .filter((v) => v.category !== "premade")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Strip markdown formatting from text to make it cleaner for TTS.
 * Removes headers, bold, italic, code blocks, links, images, etc.
 */
function stripMarkdown(text: string): string {
  return text
    // Remove code blocks (```...```)
    .replace(/```[\s\S]*?```/g, "")
    // Remove inline code (`...`)
    .replace(/`[^`]+`/g, "")
    // Remove images ![alt](url)
    .replace(/!\[.*?\]\(.*?\)/g, "")
    // Convert links [text](url) to just text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Remove headers (## ...)
    .replace(/^#{1,6}\s+/gm, "")
    // Remove bold/italic (**text** or *text* or __text__ or _text_)
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // Remove bullet points and numbered lists markers
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    // Remove blockquotes
    .replace(/^\s*>\s+/gm, "")
    // Remove HTML tags
    .replace(/<[^>]+>/g, "")
    // Collapse multiple newlines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert text to speech using ElevenLabs streaming TTS endpoint.
 * Uses native fetch for streaming response (faster than requestUrl).
 * Returns raw MP3 audio as an ArrayBuffer.
 */
export async function textToSpeech(
  apiKey: string,
  voiceId: string,
  text: string
): Promise<ArrayBuffer> {
  // Strip markdown and truncate
  let ttsText = stripMarkdown(text);
  if (ttsText.length > MAX_TTS_CHARS) {
    ttsText = ttsText.substring(0, MAX_TTS_CHARS) + "... response truncated for speech.";
  }

  // Use native fetch with the streaming endpoint for lower latency
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: ttsText,
        model_id: TTS_MODEL,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`ElevenLabs TTS error: ${res.status}`);
  }

  return await res.arrayBuffer();
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
  mimeType: string = "audio/webm"
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

  // file field
  const ext = mimeType.includes("webm") ? "webm" : "wav";
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

  const res = await requestUrl({
    url: "https://api.elevenlabs.io/v1/speech-to-text",
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: body.buffer,
  });

  const data = res.json;
  return data?.text || "";
}

/**
 * Quick validation — checks if an API key can reach ElevenLabs.
 * Returns true if the key is valid, false otherwise.
 */
export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    await requestUrl({
      url: "https://api.elevenlabs.io/v1/voices",
      method: "GET",
      headers: { "xi-api-key": apiKey },
    });
    return true;
  } catch {
    return false;
  }
}
