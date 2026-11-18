import { requestUrl } from "obsidian";
import { liveLog, type LiveSessionConfig } from "./gpt-live";
import { isRecord } from "../types/json";

/**
 * The desktop's WebRTC SDP exchange for a GPT-Live call. The plugin holds the
 * user's OpenAI key, so it signs the offer itself: one POST to
 * /v1/live/sessions with the session config and the offer, answered with
 * OpenAI's SDP. (The phone has no key; it asks the desktop gateway instead.)
 *
 * Kept apart from gpt-live.ts so the session code stays free of Obsidian's
 * network API, which the unit tests don't stand in for.
 */

const LIVE_HTTP_URL = "https://api.openai.com/v1/live/sessions";


/** The parts of the POST /v1/live/sessions (WebRTC) response that Hyo reads. */
function sdpAnswerOf(body: unknown): { sdp: string; sessionId?: string } | null {
  if (!isRecord(body) || !isRecord(body.transport) || typeof body.transport.sdp !== "string" || !body.transport.sdp) {
    return null;
  }
  const sessionId = isRecord(body.session) && typeof body.session.id === "string" ? body.session.id : undefined;
  return { sdp: body.transport.sdp, sessionId };
}

/** `error.message` from an OpenAI error body, or "". */
function errorMessageOf(body: unknown): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  return "";
}

/** An `exchangeSdp` for GptLiveOptions that POSTs the offer to OpenAI with `apiKey`. */
export function directSdpExchange(
  apiKey: string
): (offerSdp: string, session: LiveSessionConfig) => Promise<{ sdp: string }> {
  return async (offerSdp, session) => {
    const res = await requestUrl({
      url: LIVE_HTTP_URL,
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      contentType: "application/json",
      body: JSON.stringify({ session, transport: { type: "webrtc", sdp: offerSdp } }),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      let detail = "";
      try {
        detail = errorMessageOf(res.json);
      } catch {
        // Not JSON: the status alone says what happened.
      }
      throw new Error(`OpenAI refused the call (${res.status})${detail ? ": " + detail : ""}`);
    }
    const answer = sdpAnswerOf(res.json);
    if (!answer) throw new Error("OpenAI returned no SDP answer");
    liveLog(`   webrtc session ${answer.sessionId}`);
    return { sdp: answer.sdp };
  };
}
