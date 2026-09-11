import { debug } from "../debug";
import { Notice } from "obsidian";
import { useState, useCallback, useRef } from "react";
import type { MicVAD as MicVADInstance } from "@ricky0123/vad-web";
import {
  textToSpeech,
  speechToText,
} from "../voice/elevenlabs-api";
import { loadSmartTurn, turnEndProbability } from "../voice/smart-turn";
import {
  GptLiveSession,
  buildLiveInstructions,
  buildLiveHistory,
  readAgentIdentity,
  liveLog,
  type GptLiveHistoryItem,
} from "../voice/gpt-live";
import type { VoiceEngine } from "../settings";
import type { Message } from "./useChatEngine";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

const VOICE_SPEEDS = [1.0, 1.25, 1.5, 2.0];

interface UseVoiceModeOptions {
  /** Which engine runs the call. Everything ElevenLabs-specific below is ignored on gpt-live. */
  engine: VoiceEngine;
  apiKey: string;
  voiceId: string;
  playbackSpeed: number;
  isVoiceMode: boolean;
  autoSpeak: boolean;
  onTranscript: (text: string) => void;
  /** Base URL (Obsidian resource path) where the VAD/ORT assets are served. */
  vadAssetBase: string;
  /** Ensures the model assets exist locally (downloads on first use). */
  ensureAssets: () => Promise<void>;
  // GPT-Live
  openAiApiKey: string;
  gptLiveVoice: string;
  /** What the voice starts the call knowing: the tab's agent, the personality paragraph, the open conversation. */
  getLiveContext: () => { agent: string; personality: string; messages: Message[] };
  /** A finished spoken turn on the call, for the thread. */
  onVoiceTurn: (side: "user" | "agent", text: string) => void;
  /** Sandbox diagnostics: log every live event to a file. */
  debugLog?: boolean;
}

export function useVoiceMode({
  engine,
  apiKey,
  voiceId,
  playbackSpeed,
  isVoiceMode,
  autoSpeak: autoSpeakEnabled,
  onTranscript,
  vadAssetBase,
  ensureAssets,
  openAiApiKey,
  gptLiveVoice,
  getLiveContext,
  onVoiceTurn,
  debugLog,
}: UseVoiceModeOptions) {
  const isLive = engine === "gpt-live";
  // GPT-Live session + the hand-offs Claude is answering, oldest first.
  // Claude answers one at a time, so a finished reply belongs to the oldest;
  // if a newer one is already waiting, that reply is out of date for the voice.
  const liveRef = useRef<GptLiveSession | null>(null);
  const liveDelegationRef = useRef<string | null>(null);
  const handoffQueueRef = useRef<string[]>([]);
  const nudgeTimerRef = useRef<number | null>(null);
  // Who's talking and how loud — drives the Blob on a live call.
  const [liveSide, setLiveSide] = useState<"user" | "agent" | null>(null);
  const [liveLevel, setLiveLevel] = useState(0);
  const liveLevelRef = useRef<{ user: number; agent: number }>({ user: 0, agent: 0 });
  // Where the call is up to, for the line under the Blob: connecting → the
  // session is up (greeting on its way) → the voice has spoken.
  const [liveStatus, setLiveStatus] = useState<"off" | "connecting" | "connected" | "live">("off");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [isPaused, setIsPaused] = useState(false);
  const [hasLastAudio, setHasLastAudio] = useState(false);
  const [currentSpeed, setCurrentSpeed] = useState(playbackSpeed);
  const [conversationActive, setConversationActive] = useState(false);
  const [micMuted, setMicMuted] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastAudioUrlRef = useRef<string | null>(null);
  const processingRef = useRef(false);

  // Streaming-TTS queue state.
  const speechQueueRef = useRef<string[]>([]);
  const runnerRef = useRef(false);
  const stopSpeechRef = useRef(false);
  const prefetchRef = useRef<{ text: string; p: Promise<ArrayBuffer | null> } | null>(
    null
  );
  const noVoiceWarnedRef = useRef(false);
  // Lets stopAudio force the in-flight clip's play promise to resolve — pausing
  // alone never fires `onended`, which would otherwise hang the runner.
  const currentResolveRef = useRef<(() => void) | null>(null);

  // Hands-free conversation state. An always-on mic + energy VAD auto-detects
  // when you stop talking and sends; half-duplex mutes capture while Chad speaks
  // or works, so his voice never gets picked up as your turn.
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadTimerRef = useRef<number | null>(null);
  const convActiveRef = useRef(false);
  const mutedRef = useRef(false);
  const busyRef = useRef(false); // Chad is generating (set from ChatPanel)
  const busyEndedAtRef = useRef(0); // when the last generation finished
  const suspendedPrevRef = useRef(false);
  const hfRecorderRef = useRef<MediaRecorder | null>(null);
  const hfChunksRef = useRef<Blob[]>([]);
  const hfHasSpeechRef = useRef(false);
  const hfLastVoiceRef = useRef(0);
  const hfDiscardRef = useRef(false);
  const hfActiveRecRef = useRef(false);
  const hfListeningRef = useRef(false);
  const vadRef = useRef<MicVADInstance | null>(null);
  // Smart Turn accumulation: utterance segments across pauses, and a fallback
  // timer that sends anyway if the model keeps saying "not finished" but she's
  // actually stopped.
  const turnSegmentsRef = useRef<Float32Array[]>([]);
  const forceTimerRef = useRef<number | null>(null);
  // Rolling buffer of RAW audio frames (speech + pauses as captured) for Smart
  // Turn — it needs natural audio with the trailing pause, not Silero's
  // silence-trimmed speech segments.
  const rawFramesRef = useRef<Float32Array[]>([]);
  const rawTotalRef = useRef(0);
  const firstWaitAtRef = useRef(0);

  // --- Recording ---

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        await processRecording();
      };

      recorderRef.current = recorder;
      recorder.start();
      setVoiceState("listening");
    } catch (err) {
      console.error("[hyo-voice] Microphone access denied:", err);
      setVoiceState("idle");
      new Notice(
        "Hyo voice: couldn't access the microphone. Grant Obsidian mic access in System Settings → Privacy & Security → Microphone, then restart Obsidian.",
        8000
      );
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
    }
  }, []);

  // Process recording → transcribe → send
  const processRecording = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    setVoiceState("thinking");

    try {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      debug("[hyo-voice] Recorded blob size:", blob.size);

      if (blob.size < 1000) {
        debug("[hyo-voice] Recording too short");
        setVoiceState("idle");
        new Notice("Hyo voice: didn't catch anything — hold the mic a touch longer.", 5000);
        return;
      }

      // Convert blob to ArrayBuffer for the API
      const arrayBuffer = await blob.arrayBuffer();
      const transcript = await speechToText(apiKey, arrayBuffer);
      debug("[hyo-voice] Transcript:", JSON.stringify(transcript));

      if (transcript && transcript.trim()) {
        onTranscript(transcript);
      } else {
        new Notice("Hyo voice: didn't catch that — try again.", 4000);
      }
      setVoiceState("idle");
    } catch (err) {
      console.error("[hyo-voice] Transcription error:", err);
      setVoiceState("idle");
      new Notice(
        `Hyo voice: transcription failed — ${
          err instanceof Error ? err.message : "unknown error"
        }`,
        6000
      );
    } finally {
      processingRef.current = false;
    }
  }, [apiKey, onTranscript]);

  // Transcribe a captured utterance and send it. Returns whether it sent.
  const transcribeAndSend = useCallback(
    async (blob: Blob): Promise<boolean> => {
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const transcript = await speechToText(apiKey, arrayBuffer);
        debug("[hyo-voice] HF transcript:", JSON.stringify(transcript));
        if (transcript && transcript.trim()) {
          onTranscript(transcript);
          return true;
        }
      } catch (err) {
        console.error("[hyo-voice] HF transcription error:", err);
        new Notice(
          `Hyo voice: transcription failed — ${
            err instanceof Error ? err.message : "unknown error"
          }`,
          6000
        );
      }
      return false;
    },
    [apiKey, onTranscript]
  );

  // --- Record button handler ---

  const handleRecordClick = useCallback(() => {
    if (voiceState === "speaking") {
      stopAudio();
      return;
    }
    if (voiceState === "listening") {
      stopRecording();
      return;
    }
    if (voiceState === "idle") {
      startRecording();
    }
  }, [voiceState, stopRecording, startRecording]);

  // --- Streaming TTS ---
  // A speech queue that speaks Chad's reply as it streams, instead of waiting
  // for the whole turn. Text chunks (sentences) are enqueued as they arrive; a
  // single runner turns each into audio — prefetching the next chunk's audio
  // while the current one plays, to close the gap — and plays them back-to-back.
  // stopAudio() clears everything (barge-in / new turn).

  const fetchTTS = useCallback(
    (text: string): Promise<ArrayBuffer | null> =>
      textToSpeech(apiKey, voiceId, text).catch((err) => {
        console.error("[hyo-voice] TTS error:", err);
        return null;
      }),
    [apiKey, voiceId]
  );

  const playBuffer = useCallback(
    (buffer: ArrayBuffer): Promise<void> =>
      new Promise((resolve) => {
        const done = () => {
          if (currentResolveRef.current) currentResolveRef.current = null;
          resolve();
        };
        currentResolveRef.current = done;
        const blob = new Blob([buffer], { type: "audio/mpeg" });
        if (lastAudioUrlRef.current) URL.revokeObjectURL(lastAudioUrlRef.current);
        lastAudioUrlRef.current = URL.createObjectURL(blob);
        setHasLastAudio(true);
        const audio = new Audio(lastAudioUrlRef.current);
        audio.playbackRate = currentSpeed;
        audioRef.current = audio;
        audio.onended = done;
        audio.onerror = done;
        audio.play().catch(done);
      }),
    [currentSpeed]
  );

  const runQueue = useCallback(async () => {
    if (runnerRef.current) return;
    runnerRef.current = true;
    stopSpeechRef.current = false;
    setVoiceState("speaking");

    while (speechQueueRef.current.length && !stopSpeechRef.current) {
      const text = speechQueueRef.current.shift() as string;

      // Use the prefetched audio if it's for this chunk, else fetch now.
      let buffer: ArrayBuffer | null;
      if (prefetchRef.current && prefetchRef.current.text === text) {
        buffer = await prefetchRef.current.p;
        prefetchRef.current = null;
      } else {
        buffer = await fetchTTS(text);
      }

      // Kick off the next chunk's fetch while this one plays.
      if (speechQueueRef.current.length && !stopSpeechRef.current) {
        const nextText = speechQueueRef.current[0];
        prefetchRef.current = { text: nextText, p: fetchTTS(nextText) };
      }

      if (stopSpeechRef.current) break;
      if (buffer) await playBuffer(buffer);
    }

    runnerRef.current = false;
    prefetchRef.current = null;
    audioRef.current = null;
    // Don't stomp on a recording that started during playback.
    setVoiceState((s) => (s === "speaking" ? "idle" : s));
  }, [fetchTTS, playBuffer]);

  const enqueueSpeech = useCallback(
    (text: string) => {
      const t = (text || "").trim();
      if (!t) return;
      // GPT-Live: Claude's reply goes to the voice as commentary; it speaks it
      // in its own words, tied to the hand-off it asked for.
      if (isLive) {
        liveRef.current?.appendCommentary(t, liveDelegationRef.current);
        return;
      }
      if (!apiKey) return;
      if (!voiceId) {
        if (!noVoiceWarnedRef.current) {
          noVoiceWarnedRef.current = true;
          new Notice(
            "Hyo voice: no voice selected — pick one in Settings → Hyo → Voice to hear Hyo speak.",
            6000
          );
        }
        return;
      }
      speechQueueRef.current.push(t);
      void runQueue();
    },
    [apiKey, voiceId, runQueue, isLive]
  );

  // --- Audio controls ---

  const stopAudio = useCallback(() => {
    // On a live call the voice model owns playback; nothing queued here to stop.
    if (isLive) return;
    stopSpeechRef.current = true;
    speechQueueRef.current = [];
    prefetchRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    // Unblock the runner's await on the clip we just paused.
    if (currentResolveRef.current) currentResolveRef.current();
    runnerRef.current = false;
    setVoiceState("idle");
    setIsPaused(false);
  }, [isLive]);

  // --- GPT-Live call ---
  // The voice model runs the whole conversation. We only (1) hand its
  // delegations to Claude, (2) feed Claude's reply back as commentary, and
  // (3) mirror its state onto the Blob.

  const startLive = useCallback(async () => {
    if (liveRef.current) return;
    if (!openAiApiKey) {
      new Notice("Hyo voice: add your OpenAI API key in Settings → Hyo → Voice to start a call.", 6000);
      return;
    }
    const { agent, personality, messages } = getLiveContext();
    handoffQueueRef.current = [];
    const makeSession = (transport: "webrtc" | "ws") => new GptLiveSession({
      transport,
      debugLog,
      greet: true,
      apiKey: openAiApiKey,
      voice: gptLiveVoice,
      instructions: buildLiveInstructions(personality, readAgentIdentity(agent)),
      history: buildLiveHistory(messages),
      onState: (s) => {
        setVoiceState(
          s === "connecting" ? "thinking" : s === "closed" ? "idle" : s
        );
        if (s === "connecting") setLiveStatus("connecting");
        else if (s === "closed") setLiveStatus("off");
        else setLiveStatus((prev) => (prev === "live" ? "live" : "connected"));
      },
      // Every spoken turn goes in the thread, both sides — it's what was
      // actually heard. Claude's written reply to a hand-off shows only its
      // tool calls and screens, so nothing appears twice.
      onTurn: (side, text) => onVoiceTurn(side, text),
      onLevel: (side, level) => {
        const lv = liveLevelRef.current;
        lv[side] = level;
        // Whoever is louder owns the Blob; below a floor nobody does.
        const top = lv.user >= lv.agent ? "user" : "agent";
        const val = Math.max(lv.user, lv.agent);
        setLiveLevel(val);
        setLiveSide(val > 0.05 ? top : null);
      },
      // The voice's first words (the greeting): the call is live, the
      // "Connecting…" line goes.
      onFirstSpeech: () => setLiveStatus("live"),
      onDelegation: (id, text) => {
        liveDelegationRef.current = id;
        debug("[hyo-voice] live delegation", id, JSON.stringify(text));
        const s = liveRef.current;
        if (!text) {
          s?.appendThinking("No request text was heard for this hand-off; ask the user to say it again.", id);
          return;
        }
        handoffQueueRef.current.push(id);
        onTranscript(text);
        // Docs: silent progress notes while the backend works, a spoken one
        // only when the delay starts to matter.
        s?.appendThinking("The backend agent has started on this. No result yet.", id);
        if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
        nudgeTimerRef.current = window.setTimeout(() => {
          nudgeTimerRef.current = null;
          if (handoffQueueRef.current.includes(id)) {
            liveRef.current?.appendCommentary("Still working on it; it's taking a little longer than usual.", id);
          }
        }, 25000);
      },
      onError: (msg) => {
        console.error("[hyo-voice] GPT-Live:", msg);
        new Notice(`Hyo voice: ${msg}`, 7000);
      },
    });
    convActiveRef.current = true;
    setConversationActive(true);
    mutedRef.current = false;
    setMicMuted(false);
    // WebRTC first (proper echo cancellation); if the peer connection can't be
    // set up here, fall back to the WebSocket path rather than no call at all.
    let session = makeSession("webrtc");
    liveRef.current = session;
    try {
      await session.start();
    } catch (err) {
      console.warn("[hyo-voice] WebRTC call failed, trying WebSocket:", err);
      liveLog(`!! webrtc failed: ${err instanceof Error ? err.message : String(err)}`);
      session.stop();
      session = makeSession("ws");
      liveRef.current = session;
      try {
        await session.start();
      } catch (err2) {
        console.error("[hyo-voice] GPT-Live start failed:", err2);
        new Notice(
          `Hyo voice: couldn't start the call — ${err2 instanceof Error ? err2.message : "error"}`,
          8000
        );
        session.stop();
        liveRef.current = null;
        convActiveRef.current = false;
        setConversationActive(false);
        setVoiceState("idle");
      }
    }
  }, [openAiApiKey, gptLiveVoice, getLiveContext, onTranscript, onVoiceTurn, debugLog]);

  const stopLive = useCallback(() => {
    liveRef.current?.stop();
    liveRef.current = null;
    liveDelegationRef.current = null;
    handoffQueueRef.current = [];
    if (nudgeTimerRef.current) {
      clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = null;
    }
    convActiveRef.current = false;
    setConversationActive(false);
    setVoiceState("idle");
    setLiveSide(null);
    setLiveLevel(0);
    setLiveStatus("off");
  }, []);

  /** Tell the voice something happened on screen (permission ask, question). */
  const notifyAttention = useCallback((text: string) => {
    liveRef.current?.appendThinking(text, liveDelegationRef.current);
  }, []);

  /**
   * Claude has finished a hand-off. Give the voice the whole spoken reply in
   * one go, then a note that it's complete — the API has no "delegation done"
   * signal, so without this the voice can go on thinking work is still running.
   */
  const finishHandoff = useCallback((spoken: string) => {
    const s = liveRef.current;
    if (!s) return;
    // The finished reply answers the oldest hand-off still open.
    const id = handoffQueueRef.current.shift() ?? liveDelegationRef.current;
    if (nudgeTimerRef.current) {
      clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = null;
    }
    if (handoffQueueRef.current.length > 0) {
      // A newer request is already waiting: this result is out of date for
      // the voice (docs: "discard an outdated result"). Keep it as silent
      // context — it's still in the thread — and let the newer one speak.
      s.appendThinking(`Earlier result, now superseded: ${spoken}`, id);
      return;
    }
    // Commentary only — Claude's words, in one piece. A trailing "that's
    // complete" thinking note was tried and made things worse: the voice
    // answered the note instead of saying the result.
    s.appendCommentary(spoken, id);
    liveDelegationRef.current = null;
  }, []);

  /** Silent progress note while Claude works: "the agent is checking the calendar". */
  const notifyProgress = useCallback((doing: string) => {
    const id = handoffQueueRef.current[0] ?? liveDelegationRef.current;
    liveRef.current?.appendThinking(`The backend agent is ${doing}. No result yet.`, id);
  }, []);

  // --- Hands-free conversation loop (neural VAD) ---
  // Silero VAD (via MicVAD) classifies speech vs background noise and hands back
  // each finished utterance as Float32 audio — no more energy thresholds firing
  // on noise. Half-duplex: the VAD is paused while Chad works or speaks, so his
  // own voice is never captured. (Stage 2 will add Smart Turn for "am I actually
  // finished" endpointing; for now the endpoint is Silero's silence redemption.)

  const startConversation = useCallback(async () => {
    if (convActiveRef.current) return;
    if (isLive) {
      await startLive();
      return;
    }
    if (!vadAssetBase) {
      new Notice("Hyo voice: voice-model assets path missing — can't start.", 6000);
      return;
    }
    try {
      // Make sure the model assets are on disk (downloads ~50MB on first use).
      try {
        await ensureAssets();
      } catch (err) {
        console.error("[hyo-voice] asset download failed:", err);
        new Notice(
          "Hyo voice: couldn't download the voice models — check your connection and try again.",
          8000
        );
        return;
      }

      // Lazy-load the ML runtime so a failure here can't take down the rest of
      // Hyo — only voice mode depends on it.
      const { MicVAD, utils } = await import("@ricky0123/vad-web");
      const ort = await import("onnxruntime-web");

      // Obsidian isn't cross-origin isolated, so SharedArrayBuffer/threads are
      // unavailable — force single-threaded wasm and point ORT at the bundled
      // .wasm files.
      ort.env.wasm.numThreads = 1;
      (ort.env.wasm as any).proxy = false;
      ort.env.wasm.wasmPaths = vadAssetBase;

      // Smart Turn endpointing — decides "is she actually finished?" so a long
      // thinking pause doesn't cut her off.
      const TURN_THRESHOLD = 0.5; // P(END_OF_TURN) at/above this = finished
      const RECHECK_MS = 700; // re-ask Smart Turn as the silence grows
      const HARD_CAP_MS = 6000; // send regardless this long after she first paused
      const MAX_BUFFER = 16000 * 25; // bound the buffer to ~25s of audio
      const RAW_WINDOW = 16000 * 8; // Smart Turn's 8s window of raw audio

      const getRawWindow = (): Float32Array => {
        const frames = rawFramesRef.current;
        const total = frames.reduce((n, f) => n + f.length, 0);
        const out = new Float32Array(total);
        let o = 0;
        for (const f of frames) {
          out.set(f, o);
          o += f.length;
        }
        return out;
      };

      const clearForceTimer = () => {
        if (forceTimerRef.current) {
          clearTimeout(forceTimerRef.current);
          forceTimerRef.current = null;
        }
      };
      const concatSegments = (): Float32Array => {
        const segs = turnSegmentsRef.current;
        const total = segs.reduce((n, s) => n + s.length, 0);
        const out = new Float32Array(total);
        let o = 0;
        for (const s of segs) {
          out.set(s, o);
          o += s.length;
        }
        return out;
      };
      const sendBuffer = async () => {
        clearForceTimer();
        firstWaitAtRef.current = 0;
        const full = concatSegments();
        turnSegmentsRef.current = [];
        rawFramesRef.current = [];
        rawTotalRef.current = 0;
        if (!full.length) {
          setVoiceState("listening");
          return;
        }
        try {
          const wav = utils.encodeWAV(full, 1, 16000, 1, 16);
          const transcript = await speechToText(apiKey, wav, "audio/wav");
          const cleaned = (transcript || "")
            .replace(/\([^)]*\)/g, "")
            .replace(/\[[^\]]*\]/g, "")
            .replace(/\s+/g, " ")
            .trim();
          if (cleaned) onTranscript(cleaned);
          else setVoiceState("listening");
        } catch (err) {
          console.error("[hyo-voice] STT error:", err);
          new Notice(
            `Hyo voice: transcription failed — ${
              err instanceof Error ? err.message : "error"
            }`,
            6000
          );
          setVoiceState("listening");
        }
      };

      // Decide whether she's finished — re-checking as the trailing silence
      // grows, since Smart Turn gets more confident the longer she stays quiet.
      const evalTurn = async () => {
        if (mutedRef.current || busyRef.current || runnerRef.current) return;
        const p = await turnEndProbability(getRawWindow());
        if (mutedRef.current || busyRef.current || runnerRef.current) return;
        if (p >= TURN_THRESHOLD) {
          await sendBuffer();
          return;
        }
        // Not finished yet. Keep listening; re-ask as silence grows, but send
        // regardless once the hard cap from her first pause is hit.
        setVoiceState("listening");
        if (!firstWaitAtRef.current) firstWaitAtRef.current = performance.now();
        clearForceTimer();
        if (performance.now() - firstWaitAtRef.current >= HARD_CAP_MS) {
          await sendBuffer();
          return;
        }
        forceTimerRef.current = window.setTimeout(() => {
          forceTimerRef.current = null;
          void evalTurn();
        }, RECHECK_MS);
      };

      // Warm up Smart Turn so it's ready by the first pause (fails open).
      void loadSmartTurn(vadAssetBase);

      const vad = await MicVAD.new({
        baseAssetPath: vadAssetBase,
        onnxWASMBasePath: vadAssetBase,
        model: "v5",
        // ScriptProcessor avoids needing the AudioWorklet module to load over a
        // URL — one fewer asset that can fail in Obsidian's environment.
        processorType: "ScriptProcessor",
        positiveSpeechThreshold: 0.6,
        negativeSpeechThreshold: 0.45,
        minSpeechMs: 150,
        preSpeechPadMs: 250,
        redemptionMs: 900, // silence before ending the turn (tunable)
        onFrameProcessed: (_p: unknown, frame: Float32Array) => {
          // Keep the last ~8s of raw audio (frame is reused, so copy it).
          rawFramesRef.current.push(frame.slice());
          rawTotalRef.current += frame.length;
          while (
            rawTotalRef.current > RAW_WINDOW &&
            rawFramesRef.current.length > 1
          ) {
            rawTotalRef.current -= rawFramesRef.current.shift()!.length;
          }
        },
        onSpeechStart: () => {
          // She's talking again — cancel the pending re-check and restart the
          // "first pause" clock; this is a continuation, not a finished turn.
          clearForceTimer();
          firstWaitAtRef.current = 0;
          if (!mutedRef.current && !busyRef.current && !runnerRef.current) {
            setVoiceState("listening");
          }
        },
        onSpeechEnd: async (audio: Float32Array) => {
          if (mutedRef.current || busyRef.current || runnerRef.current) return;
          turnSegmentsRef.current.push(audio);
          // Bound the buffer — drop the oldest segments past ~25s.
          let tot = turnSegmentsRef.current.reduce((n, s) => n + s.length, 0);
          while (tot > MAX_BUFFER && turnSegmentsRef.current.length > 1) {
            tot -= turnSegmentsRef.current.shift()!.length;
          }
          setVoiceState("thinking");
          await evalTurn();
        },
        onVADMisfire: () => {},
      });
      vadRef.current = vad;
      convActiveRef.current = true;
      setConversationActive(true);
      mutedRef.current = false;
      setMicMuted(false);
      suspendedPrevRef.current = false;
      setVoiceState("listening");
      await vad.start();
      debug("[hyo-voice] MicVAD loaded and listening");

      // Half-duplex monitor: pause the VAD while Chad works or speaks.
      vadTimerRef.current = window.setInterval(() => {
        const suspended =
          mutedRef.current || busyRef.current || runnerRef.current;
        if (suspended === suspendedPrevRef.current) return;
        suspendedPrevRef.current = suspended;
        const v = vadRef.current;
        if (!v) return;
        if (suspended) {
          void v.pause();
        } else {
          void v.start();
          if (!mutedRef.current) setVoiceState("listening");
        }
      }, 150);
    } catch (err) {
      console.error("[hyo-voice] VAD init failed:", err);
      new Notice(
        `Hyo voice: the turn-detection model failed to load — check the console. ${
          err instanceof Error ? err.message : ""
        }`,
        9000
      );
    }
  }, [vadAssetBase, apiKey, onTranscript, ensureAssets, isLive, startLive]);

  const stopConversation = useCallback(() => {
    if (liveRef.current) {
      stopLive();
      return;
    }
    convActiveRef.current = false;
    setConversationActive(false);
    if (vadTimerRef.current) {
      clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    const v = vadRef.current;
    vadRef.current = null;
    if (v) {
      void v.pause();
      void v.destroy();
    }
    if (forceTimerRef.current) {
      clearTimeout(forceTimerRef.current);
      forceTimerRef.current = null;
    }
    turnSegmentsRef.current = [];
    rawFramesRef.current = [];
    rawTotalRef.current = 0;
    stopAudio();
    suspendedPrevRef.current = false;
    setVoiceState("idle");
  }, [stopAudio, stopLive]);

  const toggleMute = useCallback(() => {
    mutedRef.current = !mutedRef.current;
    setMicMuted(mutedRef.current);
    if (liveRef.current) {
      liveRef.current.setMuted(mutedRef.current);
      return;
    }
    const v = vadRef.current;
    if (mutedRef.current) {
      // Pause: stop listening and cancel any pending auto-send, but KEEP the
      // buffer so she can pick the thought back up when she resumes.
      if (forceTimerRef.current) {
        clearTimeout(forceTimerRef.current);
        forceTimerRef.current = null;
      }
      if (v) void v.pause();
      setVoiceState("idle");
    } else if (
      convActiveRef.current &&
      !busyRef.current &&
      !runnerRef.current
    ) {
      if (v) void v.start();
      setVoiceState("listening");
    }
  }, []);

  // Called from ChatPanel so the loop knows to stay muted while Chad works.
  const setBusy = useCallback((b: boolean) => {
    if (busyRef.current && !b) busyEndedAtRef.current = performance.now();
    busyRef.current = b;
  }, []);

  const togglePause = useCallback(() => {
    if (!audioRef.current) return;
    if (audioRef.current.paused) {
      audioRef.current.play();
      setIsPaused(false);
    } else {
      audioRef.current.pause();
      setIsPaused(true);
    }
  }, []);

  const replay = useCallback(() => {
    if (!lastAudioUrlRef.current) return;
    if (audioRef.current) {
      audioRef.current.pause();
    }
    const audio = new Audio(lastAudioUrlRef.current);
    audio.playbackRate = currentSpeed;
    audioRef.current = audio;
    audio.onended = () => {
      setVoiceState("idle");
      setIsPaused(false);
    };
    setVoiceState("speaking");
    audio.play();
  }, [currentSpeed]);

  const cycleSpeed = useCallback(() => {
    setCurrentSpeed((prev) => {
      const idx = VOICE_SPEEDS.indexOf(prev);
      const next = VOICE_SPEEDS[(idx + 1) % VOICE_SPEEDS.length];
      if (audioRef.current) audioRef.current.playbackRate = next;
      return next;
    });
  }, []);

  return {
    voiceState,
    isPaused,
    hasLastAudio,
    currentSpeed,
    handleRecordClick,
    stopAudio,
    togglePause,
    replay,
    cycleSpeed,
    enqueueSpeech,
    // hands-free
    conversationActive,
    micMuted,
    startConversation,
    stopConversation,
    toggleMute,
    setBusy,
    notifyAttention,
    finishHandoff,
    notifyProgress,
    // live call
    isLive,
    liveSide,
    liveLevel,
    liveStatus,
  };
}
