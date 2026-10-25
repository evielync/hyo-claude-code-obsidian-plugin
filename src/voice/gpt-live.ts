import { Platform } from "obsidian";
import { TranscriptGrouper } from "openai/helpers/live";
import type { Message } from "../hooks/useChatEngine";
import { parseVoiceResponse } from "./voice-persona";
import { plainForVoice, type VoiceCallRecord } from "./voice-call";

/**
 * GPT-Live engine — a full-duplex call with OpenAI's `gpt-live-1` voice model,
 * with Claude as the backend it delegates to. Built to OpenAI's GPT-Live
 * guides (Getting started, Delegation and tools, Prompting, Managing
 * sessions, WebRTC) and the migration guide's "From a text agent" adapter;
 * see the audit doc in EV-HQ, "GPT-Live in Hyo — audit against OpenAI's
 * documentation".
 *
 * How the two halves fit together:
 *   - The voice model owns the call: ears, mouth, turn-taking, interruptions,
 *     small talk. Its prompt is short, per the docs: a personality paragraph
 *     the user can edit, the situation, and the labelled policies from
 *     OpenAI's template. It starts with the Hyo conversation as history.
 *   - When it judges a turn needs real work it emits `session.delegation.created`
 *     (an id, no text). LiveCall (live-call.ts) hands Claude everything the
 *     user said since the last hand-off, sends short silent progress notes
 *     while Claude works, and returns the spoken part of the finished reply
 *     as `session.commentary.append`, which the voice says in its own words.
 *   - No greeting: the call opens with a chime once it can hear, and the
 *     voice waits for the user.
 *
 * Two transports, same events:
 *   - **WebRTC** (default). Mic and speaker are media tracks; events ride the
 *     "oai-events" data channel; echo cancellation is the browser's WebRTC
 *     stack, so barge-in on speakers works. `exchangeSdp` turns the offer
 *     into OpenAI's answer — on desktop a direct POST with the user's key; on
 *     the phone, a request to the desktop gateway, which holds the key.
 *   - **WebSocket** (fallback, desktop only). Base64 PCM16 24 kHz both ways.
 */

export type GptLiveState = "connecting" | "listening" | "speaking" | "closed";
export type LiveSide = "user" | "agent";
export type LiveTransport = "webrtc" | "ws";

export interface GptLiveHistoryItem {
  role: "user" | "assistant";
  text: string;
}

/** The session object sent at creation (identical for both transports). */
export interface LiveSessionConfig {
  model: "gpt-live-1";
  delegation: { type: "client" };
  instructions: string;
  input: Array<{
    type: "message";
    role: "user" | "assistant";
    content: Array<{ type: "input_text" | "output_text"; text: string }>;
  }>;
  audio: {
    format?: { type: "audio/pcm"; rate: 24000 };
    /** A built-in voice name, or `{ id }` for a custom voice (SDK: CustomVoice). */
    output: { voice: string | { id: string } };
  };
}

/**
 * Headless audio, for the call bank only (scripts/call-bank): the WebSocket
 * path without a microphone or speakers. `start` gets a function that sends
 * base64 PCM16 24 kHz to the session and returns a stop function.
 */
export interface HeadlessAudio {
  start: (send: (b64: string) => void) => () => void;
  onOutput?: (b64: string) => void;
}

export interface GptLiveOptions {
  apiKey: string;
  voice: string | { id: string };
  instructions: string;
  history: GptLiveHistoryItem[];
  transport?: LiveTransport;
  /** Call bank only: no microphone or speakers (WebSocket transport). */
  headless?: HeadlessAudio;
  /**
   * WebRTC only: turn the local SDP offer into OpenAI's answer. Defaults to a
   * direct POST with `apiKey`. The phone passes one that asks the gateway.
   */
  exchangeSdp?: (offerSdp: string, session: LiveSessionConfig) => Promise<{ sdp: string }>;
  onState: (state: GptLiveState) => void;
  /** A spoken turn on the call, grouped by the SDK's TranscriptGrouper. */
  onTurn: (side: LiveSide, text: string) => void;
  /** Loudness 0–1 of whoever is talking right now, ~12×/s. */
  onLevel: (side: LiveSide, level: number) => void;
  /** The voice has started saying its first words (first output transcript). */
  onFirstSpeech?: () => void;
  /**
   * The voice wants the backend. `text` = the user's words still being
   * transcribed (may be empty); their finished turns came through onTurn.
   */
  onDelegation: (delegationId: string, text: string) => void;
  onError: (message: string) => void;
  /** Diagnostics (sandbox only): every event in and out to ~/Dropbox/chad/hyo-live.log. */
  debugLog?: boolean;
}

let logPath: string | null = null;
/** Desktop-only file log; a no-op unless the session was started with debugLog. */
export function liveLog(line: string): void {
  if (!logPath) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("fs").appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

const LIVE_HTTP_URL = "https://api.openai.com/v1/live/sessions";
const LIVE_WS_URL = "wss://api.openai.com/v1/live/sessions";
const SAMPLE_RATE = 24000;
/**
 * Every append is capped at 500 tokens (SDK: CommentaryAppendEvent /
 * ThinkingAppendEvent). 1,200 characters is ≈ 300–400 tokens. Longer text is
 * split into pieces of this size, never cut.
 */
export const MAX_APPEND_CHARS = 1200;
const SPEAKING_HOLD_MS = 350;
const SPEAKING_RMS = 0.008;
const LEVEL_GAIN = 6; // speech RMS is small; scale so normal talk reads ~0.5–0.8
const LEVEL_TICK_MS = 80;
const ICE_TIMEOUT_MS = 10000;
/**
 * Silent notes are paced: one session.thinking.append in flight at a time
 * (the next after its acknowledgement), and none while the user is
 * speaking. Each append takes time on the session timeline in proportion to
 * its length (docs: "Understand when context reaches the model").
 */
export const SPEECH_QUIET_MS = 700;
const USER_SPEECH_LEVEL = 0.06;
const THINK_ACK_TIMEOUT_MS = 3000;
const CLOSE_TIMEOUT_MS = 5000;

let eventSeq = 0;
const nextEventId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${++eventSeq}`;

export class GptLiveSession {
  private transport: LiveTransport;
  // WebSocket path
  private ws: any = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private nextPlayAt = 0;
  // WebRTC path
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private agentAnalyser: AnalyserNode | null = null;
  private levelTimer: number | null = null;
  // Shared
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private lastVoiceAt = 0;
  private speakTimer: number | null = null;
  private closeTimer: number | null = null;
  private state: GptLiveState = "connecting";
  private muted = false;
  private started = false;
  private closing = false;
  private closed = false;
  private grouper: TranscriptGrouper | null = null;
  private latestUserText = "";
  private spokenYet = false;
  // WebRTC: the media path is connected (the session can actually hear).
  private mediaUp = false;
  private stopHeadless: (() => void) | null = null;
  // Commentary appends in flight, so a rejection can be surfaced by name.
  private pendingCommentary = new Set<string>();
  // Paced silent notes (see SPEECH_QUIET_MS).
  private thinkQueue: Array<{ event_id: string; content: string; delegation_id: string | null }> = [];
  private thinkInFlight: string | null = null;
  private thinkTimer: number | null = null;
  private lastUserSpeechAt = 0;

  /** What the user is saying right now, not yet closed into a turn. */
  get openUserText(): string {
    return this.latestUserText.replace(/\s+/g, " ").trim();
  }

  constructor(private opts: GptLiveOptions) {
    this.transport = opts.transport || "webrtc";
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.setState("connecting");
    if (this.opts.debugLog && Platform.isDesktop) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const os = require("os");
        logPath = `${os.homedir()}/Dropbox/chad/hyo-live.log`;
      } catch {}
      liveLog(`=== call start (${this.transport}) voice=${JSON.stringify(this.opts.voice)} history=${this.opts.history.length} instructions=${this.opts.instructions.length}ch`);
    } else {
      logPath = null;
    }

    // Spoken turns for the thread, grouped the way the SDK does it: by
    // speaker, closing on inactivity, with short backchannels ("mm", "yeah")
    // folded in rather than becoming turns of their own.
    this.grouper = new TranscriptGrouper();
    this.grouper.on("segment.updated", (seg) => {
      if (seg.speaker === "user") this.latestUserText = seg.text;
    });
    this.grouper.on("segment.closed", ({ segment }) => {
      // A closed user turn goes to the record; what's "open" is only what's still being said.
      if (segment.speaker === "user") this.latestUserText = "";
      const text = segment.text.replace(/\s+/g, " ").trim();
      if (!/[\p{L}\p{N}]/u.test(text)) return;
      const side: LiveSide = segment.speaker === "user" ? "user" : "agent";
      liveLog(`   turn ${side}: ${text}`);
      this.opts.onTurn(side, text);
    });

    if (!this.opts.headless) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    }
    if (this.transport === "webrtc") await this.startWebRTC();
    else await this.startWebSocket();

    this.speakTimer = window.setInterval(() => {
      if (this.closed || !this.isReady()) return;
      const speaking = performance.now() - this.lastVoiceAt < SPEAKING_HOLD_MS;
      this.setState(speaking ? "speaking" : "listening");
    }, 100);
  }

  private sessionConfig(): LiveSessionConfig {
    return {
      model: "gpt-live-1",
      delegation: { type: "client" },
      instructions: this.opts.instructions,
      input: this.opts.history.map((h) => ({
        type: "message",
        role: h.role,
        content: [{ type: h.role === "user" ? "input_text" : "output_text", text: h.text }],
      })),
      audio: {
        ...(this.transport === "ws" ? { format: { type: "audio/pcm", rate: SAMPLE_RATE } } : {}),
        output: { voice: this.opts.voice || "marin" },
      },
    };
  }

  // ---- WebRTC ---------------------------------------------------------------

  private async startWebRTC(): Promise<void> {
    if (typeof RTCPeerConnection === "undefined") {
      throw new Error("WebRTC isn't available here.");
    }
    const pc = new RTCPeerConnection();
    this.pc = pc;
    const micTrack = this.stream!.getAudioTracks()[0];
    pc.addTrack(micTrack, this.stream!);

    // Remote audio plays through a hidden <audio> element — that's what gives
    // the WebRTC echo canceller its reference signal.
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.style.display = "none";
    document.body.appendChild(audio);
    this.remoteAudio = audio;

    this.ctx = new AudioContext();
    this.micAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream!).connect(this.micAnalyser);

    pc.ontrack = (e) => {
      const remote = e.streams[0] || new MediaStream([e.track]);
      audio.srcObject = remote;
      void audio.play().catch(() => {});
      if (this.ctx) {
        this.agentAnalyser = this.ctx.createAnalyser();
        this.agentAnalyser.fftSize = 1024;
        this.ctx.createMediaStreamSource(remote).connect(this.agentAnalyser);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if ((pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") && !this.mediaUp) {
        this.mediaUp = true;
        liveLog(`   media ${pc.iceConnectionState}`);
        this.becomeReady();
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected" && !this.mediaUp) {
        this.mediaUp = true;
        liveLog("   media connected");
        this.becomeReady();
      }
      if (!this.closed && !this.closing && (pc.connectionState === "failed" || pc.connectionState === "disconnected")) {
        this.opts.onError(`GPT-Live call ${pc.connectionState}`);
        this.teardown();
      }
    };

    // Data channel and its listeners before the offer (docs: connection sequence).
    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onmessage = (e) => {
      try {
        this.handle(JSON.parse(String(e.data)));
      } catch (err) {
        liveLog(`!! event handling failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    dc.onclose = () => {
      if (this.closed) return;
      // Hanging up: the channel closing is the end we asked for, not a drop.
      if (!this.closing) this.opts.onError("GPT-Live call ended before the session finalised");
      this.closed = true;
      this.teardown();
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Wait for ICE gathering so the offer carries the candidates (docs step 3).
    if (pc.iceGatheringState !== "complete") {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pc.removeEventListener("icegatheringstatechange", onState);
          reject(new Error("Timed out gathering network candidates"));
        }, ICE_TIMEOUT_MS);
        const onState = () => {
          if (pc.iceGatheringState !== "complete") return;
          clearTimeout(timeout);
          pc.removeEventListener("icegatheringstatechange", onState);
          resolve();
        };
        pc.addEventListener("icegatheringstatechange", onState);
        onState();
      });
    }
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error("No local SDP offer");
    const exchange = this.opts.exchangeSdp || this.defaultExchangeSdp;
    const answer = await exchange(sdp, this.sessionConfig());
    await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    // The HTTP request started the session; session.start is not sent here.

    // Levels from the analysers, both sides.
    const buf = new Float32Array(1024);
    const rmsOf = (an: AnalyserNode | null): number => {
      if (!an) return 0;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      return Math.sqrt(sum / buf.length);
    };
    this.levelTimer = window.setInterval(() => {
      if (this.closed) return;
      const mic = this.muted ? 0 : rmsOf(this.micAnalyser);
      const agent = rmsOf(this.agentAnalyser);
      if (mic * LEVEL_GAIN > USER_SPEECH_LEVEL) this.lastUserSpeechAt = performance.now();
      this.pumpThinking();
      if (agent > SPEAKING_RMS) this.lastVoiceAt = performance.now();
      this.opts.onLevel("user", Math.min(1, mic * LEVEL_GAIN));
      this.opts.onLevel("agent", Math.min(1, agent * LEVEL_GAIN));
    }, LEVEL_TICK_MS);
  }

  /** Desktop default: the plugin holds the key, so it signs the offer itself. */
  private defaultExchangeSdp = async (
    offerSdp: string,
    session: LiveSessionConfig
  ): Promise<{ sdp: string }> => {
    const res = await fetch(LIVE_HTTP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session, transport: { type: "webrtc", sdp: offerSdp } }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = j?.error?.message || "";
      } catch {}
      throw new Error(`OpenAI refused the call (${res.status})${detail ? ": " + detail : ""}`);
    }
    const data = await res.json();
    if (!data?.transport?.sdp) throw new Error("OpenAI returned no SDP answer");
    liveLog(`   webrtc session ${data?.session?.id}`);
    return { sdp: data.transport.sdp };
  };

  // ---- WebSocket (fallback) -------------------------------------------------

  private async startWebSocket(): Promise<void> {
    if (!Platform.isDesktop) {
      throw new Error("The WebSocket voice path is desktop-only.");
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WS = require("ws");
    this.ws = new WS(LIVE_WS_URL, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    });
    this.ws.on("open", () => {
      this.send({ type: "session.start", session: this.sessionConfig() });
    });
    this.ws.on("message", (data: any) => {
      try {
        this.handle(JSON.parse(String(data)));
      } catch (err) {
        liveLog(`!! event handling failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    this.ws.on("error", (e: any) => {
      this.opts.onError(e?.message || "GPT-Live connection error");
    });
    this.ws.on("close", (code: number, reason: any) => {
      if (!this.closed && !this.closing) {
        this.opts.onError(
          `GPT-Live call ended (${code}${reason ? ": " + String(reason) : ""})`
        );
      }
      this.teardown();
    });

    if (this.opts.headless) {
      this.stopHeadless = this.opts.headless.start((b64) => {
        if (!this.started || this.muted || this.closed) return;
        this.send({ type: "session.input_audio.append", audio: b64 });
      });
      return;
    }

    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.source = this.ctx.createMediaStreamSource(this.stream!);
    // 2048 frames @ 24 kHz ≈ 85 ms per packet.
    this.processor = this.ctx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (!this.started || this.muted || this.closed) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      let sum = 0;
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sum += s * s;
      }
      const userLevel = Math.min(1, Math.sqrt(sum / Math.max(1, f32.length)) * LEVEL_GAIN);
      if (userLevel > USER_SPEECH_LEVEL) this.lastUserSpeechAt = performance.now();
      this.opts.onLevel("user", userLevel);
      this.pumpThinking();
      this.send({
        type: "session.input_audio.append",
        audio: Buffer.from(i16.buffer).toString("base64"),
      });
    };
    this.source.connect(this.processor);
    // ScriptProcessor needs a sink to run; a silent gain keeps the mic inaudible.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.processor.connect(sink);
    sink.connect(this.ctx.destination);
  }

  private playPcm(b64: string): void {
    if (this.opts.headless) {
      this.opts.headless.onOutput?.(b64);
      return;
    }
    if (!this.ctx || this.closed) return;
    const bytes = Buffer.from(b64, "base64");
    const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const f32 = new Float32Array(i16.length);
    let sum = 0;
    for (let i = 0; i < i16.length; i++) {
      const v = i16[i] / 0x8000;
      f32[i] = v;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, i16.length));
    if (rms > SPEAKING_RMS) this.lastVoiceAt = performance.now();
    this.opts.onLevel("agent", Math.min(1, rms * LEVEL_GAIN));
    const buf = this.ctx.createBuffer(1, f32.length, SAMPLE_RATE);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    const at = Math.max(now + 0.02, this.nextPlayAt);
    src.start(at);
    this.nextPlayAt = at + buf.duration;
  }

  // ---------------------------------------------------------------------------
  // Events (identical on both transports)
  // ---------------------------------------------------------------------------

  private handle(ev: any): void {
    if (ev.type !== "session.output_audio.delta") {
      liveLog(`<- ${ev.type} ${JSON.stringify(ev).slice(0, 300)}`);
    }
    // stop() closes the grouper (flushing the last turns into the record),
    // and a closed grouper throws on push. Hanging up used to throw here on
    // the server's session.closed, so the call was never marked closed and
    // the channel shutting looked like a dropped call ("ended before the
    // session finalised"). Only feed it while it's open.
    if (this.grouper && !this.closing) {
      try {
        this.grouper.push(ev);
      } catch (e) {
        liveLog(`!! transcript grouper: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    switch (ev.type) {
      case "session.started":
        this.started = true;
        liveLog(`   session id=${ev.session?.id} voice=${JSON.stringify(ev.session?.audio?.output?.voice)}`);
        this.becomeReady();
        return;
      case "session.output_audio.delta":
        if (this.transport === "ws") this.playPcm(ev.delta);
        return;
      case "session.output_transcript.delta":
        if (!this.spokenYet && String(ev.delta || "").trim()) {
          this.spokenYet = true;
          this.opts.onFirstSpeech?.();
        }
        return;
      case "session.input_transcript.delta":
        this.lastUserSpeechAt = performance.now();
        return;
      case "session.delegation.created": {
        // The event carries no text. Pass what the user is still saying (if
        // anything); their finished turns are in the call record, and
        // LiveCall builds the request from both (docs: "use transcript
        // events and application state to work out what the user wants").
        const text = this.latestUserText.replace(/\s+/g, " ").trim();
        this.opts.onDelegation(ev.delegation?.id, text);
        return;
      }
      case "session.commentary.appended":
      case "session.thinking.appended":
      case "session.instructions.appended":
        if (ev.client_event_id) this.pendingCommentary.delete(ev.client_event_id);
        if (ev.type === "session.thinking.appended" && ev.client_event_id && ev.client_event_id === this.thinkInFlight) {
          this.thinkInFlight = null;
          this.pumpThinking();
        }
        return;
      case "error": {
        const id = ev.error?.client_event_id;
        const msg = ev.error?.message || "GPT-Live error";
        if (id && id === this.thinkInFlight) {
          this.thinkInFlight = null;
          this.pumpThinking();
        }
        if (id && this.pendingCommentary.has(id)) {
          this.pendingCommentary.delete(id);
          this.opts.onError(`the result couldn't be given to the voice — ${msg}`);
        } else if (ev.error?.type !== "invalid_request_error" || !id) {
          this.opts.onError(msg);
        } else {
          liveLog(`!! command ${id} rejected: ${msg}`);
        }
        return;
      }
      case "session.closed":
        liveLog(`   closed reason=${ev.reason} seconds=${ev.usage?.seconds}`);
        this.closed = true;
        this.teardown();
        return;
      default:
        return;
    }
  }

  /**
   * The call is live once the session has started and (on WebRTC) the media
   * path is connected, so the chime only plays when it can really hear.
   */
  private isReady(): boolean {
    return this.started && (this.transport === "ws" || this.mediaUp);
  }

  private becomeReady(): void {
    if (this.closed || this.closing || !this.isReady()) return;
    if (this.state === "connecting") {
      liveLog("   ready: listening");
      this.setState("listening");
    }
    this.pumpThinking();
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /** Hand Claude's finished reply to the voice to say (paraphrased). */
  appendCommentary(text: string, delegationId: string | null): void {
    for (const piece of splitForAppend(text)) {
      const event_id = nextEventId("say");
      this.pendingCommentary.add(event_id);
      this.send({ type: "session.commentary.append", event_id, content: piece, delegation_id: delegationId });
    }
  }

  /**
   * Give the voice something to know without saying it (progress, a
   * permission answered on screen). Split into pieces under the append cap,
   * never cut, and paced (see SPEECH_QUIET_MS).
   */
  appendThinking(text: string, delegationId: string | null = null): void {
    for (const piece of splitForAppend(text)) {
      this.thinkQueue.push({ event_id: nextEventId("note"), content: piece, delegation_id: delegationId });
    }
    this.pumpThinking();
  }

  /** Send the next silent note if none is in flight and the user isn't speaking. */
  private pumpThinking(): void {
    if (!this.started || this.closing || this.closed || this.thinkInFlight || !this.thinkQueue.length) return;
    if (performance.now() - this.lastUserSpeechAt < SPEECH_QUIET_MS) return;
    const next = this.thinkQueue.shift()!;
    this.thinkInFlight = next.event_id;
    this.send({ type: "session.thinking.append", ...next });
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    this.thinkTimer = window.setTimeout(() => {
      // No acknowledgement: don't stall the queue for ever.
      if (this.thinkInFlight === next.event_id) {
        this.thinkInFlight = null;
        this.pumpThinking();
      }
    }, THINK_ACK_TIMEOUT_MS);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const track = this.stream?.getAudioTracks()[0];
    if (track) track.enabled = !muted;
    this.send({
      type: muted ? "session.input_audio.mute" : "session.input_audio.unmute",
      event_id: nextEventId(muted ? "mute" : "unmute"),
    });
  }

  /**
   * End the call the documented way: send session.close, keep the transport
   * up until session.closed arrives (or a timeout), then release everything.
   */
  stop(): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    try {
      this.grouper?.close();
    } catch {}
    this.send({ type: "session.close", event_id: nextEventId("close") });
    this.closeTimer = window.setTimeout(() => {
      if (!this.closed) {
        liveLog("!! no session.closed within timeout; releasing");
        this.closed = true;
        this.teardown();
      }
    }, CLOSE_TIMEOUT_MS);
  }

  private teardown(): void {
    for (const t of [this.speakTimer, this.levelTimer, this.closeTimer, this.thinkTimer]) if (t) clearTimeout(t);
    this.speakTimer = null;
    this.levelTimer = null;
    this.closeTimer = null;
    this.thinkTimer = null;
    this.thinkQueue = [];
    try {
      this.stopHeadless?.();
    } catch {}
    this.stopHeadless = null;
    try {
      this.grouper?.close();
    } catch {}
    this.grouper = null;
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
    } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try {
      this.dc?.close();
      this.pc?.close();
    } catch {}
    this.dc = null;
    this.pc = null;
    if (this.remoteAudio) {
      try {
        this.remoteAudio.pause();
        this.remoteAudio.srcObject = null;
        this.remoteAudio.remove();
      } catch {}
      this.remoteAudio = null;
    }
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.started = false;
    this.closed = true;
    this.setState("closed");
  }

  private send(ev: unknown): void {
    const json = JSON.stringify(ev);
    const type = (ev as any)?.type;
    if (type !== "session.input_audio.append") {
      liveLog(`-> ${type} ${json.slice(0, 400)}`);
    }
    if (this.transport === "webrtc") {
      if (this.dc && this.dc.readyState === "open") this.dc.send(json);
      else liveLog(`!! dropped ${type}: data channel ${this.dc?.readyState ?? "missing"}`);
      return;
    }
    if (!this.ws || this.ws.readyState !== 1) {
      liveLog(`!! dropped ${type}: socket ${this.ws?.readyState ?? "missing"}`);
      return;
    }
    this.ws.send(json);
  }

  private setState(s: GptLiveState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState(s);
  }
}

/**
 * Play a short sample in a Live voice, for the settings picker. The new Live
 * voices aren't on the ordinary speech endpoint, so this opens a brief Live
 * WebSocket session with no microphone, has it say one line, plays the audio,
 * and closes. Desktop only. Resolves when playback ends.
 */
export async function playVoiceSample(apiKey: string, voice: string | { id: string }): Promise<void> {
  if (!Platform.isDesktop) throw new Error("Samples play on desktop only.");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WS = require("ws");
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  let nextAt = 0;
  let lastAudioAt = 0;
  let gotAudio = false;
  const ws = new WS(LIVE_WS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  const send = (ev: unknown) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(ev));
  };
  await new Promise<void>((resolve, reject) => {
    const fail = (msg: string) => {
      try {
        ws.close();
      } catch {}
      reject(new Error(msg));
    };
    const watchdog = window.setTimeout(() => fail("The sample took too long."), 20000);
    // Finish once audio has stopped for a moment after it started.
    const poll = window.setInterval(() => {
      if (gotAudio && performance.now() - lastAudioAt > 900 && ctx.currentTime >= nextAt - 0.05) {
        clearInterval(poll);
        clearTimeout(watchdog);
        send({ type: "session.close" });
        window.setTimeout(() => {
          try {
            ws.close();
          } catch {}
          resolve();
        }, 300);
      }
    }, 100);
    ws.on("open", () => {
      send({
        type: "session.start",
        session: {
          model: "gpt-live-1",
          delegation: { type: "client" },
          instructions: "You are a voice assistant giving a one-line voice sample. Say exactly what you're given, warmly, then stop.",
          audio: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, output: { voice } },
        },
      });
    });
    ws.on("message", (data: any) => {
      let ev: any;
      try {
        ev = JSON.parse(String(data));
      } catch {
        return;
      }
      if (ev.type === "session.started") {
        send({
          type: "session.commentary.append",
          event_id: "sample",
          delegation_id: null,
          content: "Hi, this is what I sound like. Nice to meet you.",
        });
        // The model needs an input stream to run; feed silence.
        const silence = Buffer.alloc(4800).toString("base64");
        const feed = window.setInterval(() => {
          if (ws.readyState !== 1) return clearInterval(feed);
          send({ type: "session.input_audio.append", audio: silence });
        }, 100);
      } else if (ev.type === "session.output_audio.delta") {
        const bytes = Buffer.from(ev.delta, "base64");
        const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
        const f32 = new Float32Array(i16.length);
        let sum = 0;
        for (let i = 0; i < i16.length; i++) {
          f32[i] = i16[i] / 0x8000;
          sum += f32[i] * f32[i];
        }
        if (Math.sqrt(sum / Math.max(1, i16.length)) > SPEAKING_RMS) {
          gotAudio = true;
          lastAudioAt = performance.now();
        }
        const buf = ctx.createBuffer(1, f32.length, SAMPLE_RATE);
        buf.copyToChannel(f32, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        const at = Math.max(ctx.currentTime + 0.02, nextAt);
        src.start(at);
        nextAt = at + buf.duration;
      } else if (ev.type === "error") {
        clearInterval(poll);
        clearTimeout(watchdog);
        fail(ev.error?.message || "OpenAI refused the sample");
      }
    });
    ws.on("error", (e: any) => {
      clearInterval(poll);
      clearTimeout(watchdog);
      fail(e?.message || "Couldn't connect for the sample");
    });
  }).finally(() => {
    void ctx.close().catch(() => {});
  });
}

/**
 * Break text into pieces of at most MAX_APPEND_CHARS, on sentence (then
 * word) boundaries. Nothing is dropped: a sentence longer than a piece is
 * split on words, and a word longer than a piece is split hard.
 */
export function splitForAppend(text: string, max: number = MAX_APPEND_CHARS): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const units: string[] = [];
  for (const sentence of t.split(/(?<=[.!?])\s+/)) {
    if (sentence.length <= max) {
      units.push(sentence);
      continue;
    }
    let cur = "";
    for (const word of sentence.split(/\s+/)) {
      let w = word;
      while (w.length > max) {
        if (cur) {
          units.push(cur);
          cur = "";
        }
        units.push(w.slice(0, max));
        w = w.slice(max);
      }
      if (cur && (cur + " " + w).length > max) {
        units.push(cur);
        cur = w;
      } else {
        cur = cur ? `${cur} ${w}` : w;
      }
    }
    if (cur) units.push(cur);
  }
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && (cur + " " + u).length > max) {
      out.push(cur);
      cur = u;
    } else {
      cur = cur ? `${cur} ${u}` : u;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Session instructions — OpenAI's template, labels intact
// ---------------------------------------------------------------------------

/** What a user gets before they've written anything in the personality box. */
export const DEFAULT_VOICE_PERSONALITY =
  "Warm, direct and natural. You talk to the user the way a good colleague who knows them would.";

/** Who the voice is, from the tab's agent: the `name` and `description` lines of its agent file. */
export interface AgentIdentity {
  name: string;
  description: string;
}

/**
 * Read `name` and `description` from `~/.claude/agents/<agent>.md` frontmatter.
 * Desktop only; empty when there's no agent or no file, which makes the voice
 * "the user's agent" with no other change.
 */
export function readAgentIdentity(agent: string): AgentIdentity | null {
  if (!agent || !Platform.isDesktop) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require("os");
    const p = path.join(os.homedir(), ".claude", "agents", `${agent}.md`);
    if (!fs.existsSync(p)) return null;
    const head = String(fs.readFileSync(p, "utf8")).slice(0, 4000);
    const fm = head.match(/^---\s*\n([\s\S]*?)\n---/);
    const block = fm ? fm[1] : "";
    const pick = (key: string) => {
      const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
    };
    const name = pick("name") || agent;
    return { name: name.charAt(0).toUpperCase() + name.slice(1), description: pick("description") };
  } catch {
    return null;
  }
}

/** About you is bounded so it can never crowd the instructions (16,384-token cap). */
export const MAX_ABOUT_YOU_CHARS = 6000;

export interface LiveInstructionExtras {
  /** The description a custom voice was made from (OpenAI's custom voices guide: keep it in the instructions). */
  voiceDescription?: string;
  /** Settings → Voice → About you: typed text, or the chosen note read at call start. */
  aboutYou?: string;
}

/**
 * The voice's instructions, in the shape OpenAI's prompting guide gives:
 * who it is (from the agent file), the personality box, the situation, then
 * the three labelled policies with the `Generate <|SpawnThinking|>` wording
 * the guide requires for gpt-live-1. Everything procedural stays with Claude.
 * About you and a custom voice's description are the only additions, both
 * here at the start (docs: "Put any context the model needs from the start
 * in `input`" / instructions), never appended after go-live.
 */
export function buildLiveInstructions(
  personality: string,
  identity: AgentIdentity | null = null,
  extras: LiveInstructionExtras = {}
): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "the user's local time";
  const when = now.toLocaleString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
  });
  const whoLine = identity
    ? `You are ${identity.name}${identity.description ? `, ${identity.description.replace(/\.$/, "")}` : ""}. You are on a call with the user.`
    : "You are the user's agent, on a call with them.";
  const manner = (personality || "").trim() || DEFAULT_VOICE_PERSONALITY;
  const voice = (extras.voiceDescription || "").trim();
  let about = (extras.aboutYou || "").trim();
  if (about.length > MAX_ABOUT_YOU_CHARS) about = about.slice(0, MAX_ABOUT_YOU_CHARS).replace(/\s+\S*$/, "") + " …";
  return `${whoLine}
${manner}${voice ? `\nYour speaking voice: ${voice}` : ""}
${about ? `\nAbout the user (what they have told you about themselves):\n${about}\n` : ""}
Situation: It is ${when} (${tz}). The user is at their computer in Obsidian, with the chat open beside the call. The call opens with a short chime; don't greet them, wait for them to speak first. Anything long or detailed the backend produces appears in the chat, so refer to it rather than reading it out.

Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- The user's notes, tasks, projects and files in their vault.
- Their calendar and email, where connected.
- Real work: drafting, editing, research, changing files, running jobs.
- Looking anything up.

Generate <|SpawnThinking|> when:
- The request needs any of those, or careful reasoning.
- The user asks for specifics: names, dates, numbers, what's on their list.
- A correction changes work already requested.

Do not generate <|SpawnThinking|> when:
- You can answer from the conversation or a result you already have.
- You need a brief clarification to understand the request.
- The user is only answering you or agreeing ("done", "yes", "go ahead") while work is already running.

Generate <|SpawnThinking|> before giving an answer that depends on backend work.
Do not guess the result while waiting. If asked how it's going, say it's still being worked on.
When a result says something is on screen, tell the user it's in the chat rather than reading it out.`;
}

const MAX_HISTORY_CHARS = 20000; // history cap is 8,192 tokens; the live model's context is small
const MAX_HISTORY_ITEMS = 60; // API cap is 128

/**
 * The open Hyo conversation as text-only history, most recent kept, trimmed
 * to the API's limits. Earlier calls come in as what was said on them;
 * hand-off prompts are skipped (the call's own turns hold the request), and
 * Claude's replies keep only their spoken part ([SCREEN] detail stays in the chat).
 */
export function buildLiveHistory(
  messages: Array<Pick<Message, "role" | "content" | "displayText" | "isCompaction" | "handoff"> & { voiceCall?: VoiceCallRecord }>
): GptLiveHistoryItem[] {
  // Flatten to (role, text) in thread order, then keep the newest that fit.
  const flat: GptLiveHistoryItem[] = [];
  for (const m of messages) {
    if (m.voiceCall) {
      for (const t of m.voiceCall.turns) flat.push({ role: t.side === "user" ? "user" : "assistant", text: t.text });
      continue;
    }
    if (m.isCompaction || (m.role !== "user" && m.role !== "assistant")) continue;
    if (m.handoff) continue;
    const text =
      m.role === "user" ? m.displayText || m.content || "" : plainForVoice(parseVoiceResponse(m.content || "").spoken);
    if (text.trim()) flat.push({ role: m.role, text: text.trim() });
  }
  const items: GptLiveHistoryItem[] = [];
  let total = 0;
  for (let i = flat.length - 1; i >= 0; i--) {
    let text = flat[i].text;
    if (total + text.length > MAX_HISTORY_CHARS) {
      const room = MAX_HISTORY_CHARS - total;
      if (room < 200) break;
      text = "…" + text.slice(text.length - room);
    }
    items.push({ role: flat[i].role, text });
    total += text.length;
    if (items.length >= MAX_HISTORY_ITEMS || total >= MAX_HISTORY_CHARS) break;
  }
  return items.reverse();
}
