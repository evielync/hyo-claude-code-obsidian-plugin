import { Notice } from "obsidian";
import { debug } from "../debug";
import { useState, useCallback, useRef, useEffect } from "react";
import {
  textToSpeech,
  speechToText,
  STT_TIMEOUT_ERROR,
  sttTimeoutFor,
} from "../voice/elevenlabs-api";
import type { RecordingStore, RecordingMeta, SegmentMeta } from "../voice/recording-store";
import { openAiSpeechToText } from "../voice/openai-stt";
import type { GptLiveHistoryItem } from "../../voice/gpt-live";
import { playChime, CONNECT_CHIME, HANGUP_CHIME } from "../../voice/chimes";
import { LiveCall } from "../../voice/live-call";
import type { VoiceCallRecord, CallEndReason } from "../../voice/voice-call";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "error";

const VOICE_SPEEDS = [1.0, 1.25, 1.5, 2.0];

interface UseVoiceModeOptions {
  apiKey: string;
  /**
   * Who transcribes a dictation. Follows the voice engine, so one key covers
   * everything: OpenAI when the engine is GPT-Live, ElevenLabs otherwise.
   */
  stt: { provider: "elevenlabs" | "openai"; apiKey: string };
  voiceId: string;
  playbackSpeed: number;
  isVoiceMode: boolean;
  autoSpeak: boolean;
  onTranscript: (text: string) => void;
  /** Where dictations are kept on disk until their transcript has landed. */
  store?: RecordingStore | null;
  /**
   * GPT-Live call over WebRTC. The desktop gateway signs the offer and builds
   * the session (its key, voice, personality, the tab's agent), so the phone
   * only supplies the offer, the tab's agent name and the conversation so far.
   */
  live?: {
    enabled: boolean;
    exchangeSdp: (offerSdp: string, agent: string, history: GptLiveHistoryItem[]) => Promise<{ sdp: string }>;
    /** The tab's agent, the conversation so far, and where the call's line goes. */
    getContext: () => { agent: string; history: GptLiveHistoryItem[]; after: number };
    /** A job from the live call: the whole request for Claude, and the user's words for the record. */
    onHandoff: (prompt: string, said: string) => void;

    onVoiceTurn?: (side: "user" | "agent", text: string) => void;
    /** The call is over. `record` is null when nothing happened on it. */
    onCallEnded: (record: VoiceCallRecord | null, reason: CallEndReason) => void;
  };
}

export function useVoiceMode({
  apiKey,
  stt,
  voiceId,
  playbackSpeed,
  isVoiceMode,
  autoSpeak: autoSpeakEnabled,
  onTranscript,
  store,
  live,
}: UseVoiceModeOptions) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  // ---- GPT-Live call (full duplex) ----
  const isLive = !!live?.enabled;
  // Session, record and hand-offs live in LiveCall — the same code as desktop.
  const liveRef = useRef<LiveCall | null>(null);
  const [liveSide, setLiveSide] = useState<"user" | "agent" | null>(null);
  const [liveLevel, setLiveLevel] = useState(0);
  const [liveStatus, setLiveStatus] = useState<"off" | "connecting" | "connected" | "live">("off");
  const liveOptsRef = useRef(live);
  liveOptsRef.current = live;

  const stopLive = useCallback(() => {
    const call = liveRef.current;
    liveRef.current = null;
    call?.hangUp();
    liveMutedRef.current = false;
    setLiveMuted(false);
    setVoiceState("idle");
    setLiveSide(null);
    setLiveLevel(0);
    setLiveStatus("off");
  }, []);

  const startLive = useCallback(async () => {
    const opts = liveOptsRef.current;
    if (!opts?.enabled || liveRef.current) return;
    const { agent, history, after } = opts.getContext();
    const call: LiveCall = new LiveCall({
      transports: ["webrtc"],
      after,
      session: {
        apiKey: "", // the desktop signs; the phone never holds the key
        voice: "",
        instructions: "",
        history,
        exchangeSdp: (offerSdp) => opts.exchangeSdp(offerSdp, agent, history),
      },
      onHandoff: (prompt, said) => liveOptsRef.current?.onHandoff(prompt, said),
      onTurn: (side, text) => liveOptsRef.current?.onVoiceTurn?.(side, text),
      onUi: (ui) => {
        setLiveStatus(ui.status);
        setLiveSide(ui.side);
        setLiveLevel(ui.level);
        // voiceState is the dictation mic's; a live call shows in the call bar.
      },
      // A chime instead of a spoken greeting, once it can really hear.
      onLive: () => playChime(CONNECT_CHIME),
      onEnded: (record, reason) => {
        if (reason === "hung-up") playChime(HANGUP_CHIME);
        if (liveRef.current === call) liveRef.current = null;
        liveOptsRef.current?.onCallEnded(record, reason);
      },
      onError: (msg) => {
        console.error("[hyo-voice] GPT-Live:", msg);
        new Notice(`Hyo voice: ${msg}`, 7000);
      },
    });
    liveRef.current = call;
    await call.start();
  }, []);

  /** Claude finished a reply: the answer to the open hand-off, or something typed in the chat. */
  const finishReply = useCallback((markdown: string, selfStarted?: boolean) => {
    liveRef.current?.finishReply(markdown, selfStarted);
  }, []);

  const noteSilently = useCallback((text: string) => {
    liveRef.current?.note(text);
  }, []);

  /** A permission ask was answered on screen: the voice knows without her saying so. */
  const notifyPermissionAnswered = useCallback((allowed: boolean) => {
    liveRef.current?.permissionAnswered(allowed);
  }, []);

  /** Hyo showed an error in the chat: the voice knows what it said. */
  const notifyErrorShown = useCallback((text: string) => {
    liveRef.current?.errorShown(text);
  }, []);

  /** A step Claude is taking, in plain words: a short silent progress note. */
  const notifyProgress = useCallback((label: string | null) => {
    liveRef.current?.step(label);
  }, []);


  /** The live call that's on now, if any (its record grows as it goes). */
  const currentCall = useCallback((): VoiceCallRecord | null => liveRef.current?.callRecord ?? null, []);

  /** Something on screen needs the user (permission ask, question). */
  const notifyAttention = useCallback((text: string) => {
    liveRef.current?.notifyAttention(text);
  }, []);

  const toggleLiveMute = useCallback(() => {
    const s = liveRef.current;
    if (!s) return;
    liveMutedRef.current = !liveMutedRef.current;
    s.setMuted(liveMutedRef.current);
    setLiveMuted(liveMutedRef.current);
  }, []);
  const liveMutedRef = useRef(false);
  const [liveMuted, setLiveMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [isPaused, setIsPaused] = useState(false);
  const [hasLastAudio, setHasLastAudio] = useState(false);
  const [currentSpeed, setCurrentSpeed] = useState(playbackSpeed);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastAudioUrlRef = useRef<string | null>(null);

  // Live waveform off the mic input — a trust signal so you can see it's
  // actually hearing you while recording. Non-critical: guarded everywhere,
  // and getWaveform falls back to a flat line if the analyser never came up.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const freqRef = useRef<Uint8Array | null>(null);

  const teardownAnalyser = useCallback(() => {
    analyserRef.current = null;
    freqRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== "closed") {
      ctx.close().catch(() => {});
    }
  }, []);

  // Normalised bar heights (0..1) sampled across the spectrum. Stable — reads
  // through refs — so the UI can call it every animation frame.
  const getWaveform = useCallback((bars: number): number[] => {
    const analyser = analyserRef.current;
    const freq = freqRef.current;
    if (!analyser || !freq) return new Array(bars).fill(0);
    analyser.getByteFrequencyData(freq);
    const out: number[] = [];
    const n = freq.length;
    for (let i = 0; i < bars; i++) {
      out.push(freq[Math.floor((i / bars) * n)] / 255);
    }
    return out;
  }, []);

  // Always-latest refs. The recording chain (`startRecording` → `onstop` →
  // `processRecording`) is created once at mount with stable `[]` deps so the
  // MediaRecorder callbacks never go stale. But that means it would otherwise
  // capture the FIRST render's `onTranscript` and `apiKey` — and `onTranscript`
  // closes over `activeTabId`, so every transcript would be delivered to
  // whatever conversation was open when the panel first loaded, not the one
  // the user is actually recording in. Reading these through refs keeps the
  // chain stable AND always current.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;
  const sttRef = useRef(stt);
  sttRef.current = stt;

  // --- Recording ---
  //
  // A dictation is recorded in pieces. While the user talks, the recording is
  // cut at a natural pause roughly every minute or two, and each finished
  // piece is sent off to be transcribed straight away, while they keep
  // talking. By the time they stop, most of it is already text, so even a
  // twenty-minute note lands in a few seconds. No single request ever carries
  // more than a couple of minutes of audio, which is what used to blow the
  // timeout on long notes over a phone connection.
  //
  // Every chunk of audio is written to disk as it arrives (RecordingStore), so
  // a failed transcription, a closed app or a crash never loses what was said.
  // If a piece fails it is retried on its own, and anything left unfinished is
  // offered back the next time Hyo opens.

  const storeRef = useRef(store ?? null);
  storeRef.current = store ?? null;

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  /** Recorders that have been started and haven't delivered their last chunk yet. */
  const openRecordersRef = useRef<Set<MediaRecorder>>(new Set());
  const metaRef = useRef<RecordingMeta | null>(null);
  /** Audio held in memory per piece, so the live path never reads back from disk. */
  const segAudioRef = useRef<Map<number, Blob[]>>(new Map());
  /** Pieces whose recorder has stopped, so their audio is complete. */
  const closedSegsRef = useRef<Set<number>>(new Set());
  const segStartRef = useRef(0);
  const recorderSegRef = useRef<WeakMap<MediaRecorder, number>>(new WeakMap());
  const mimeTypeRef = useRef("");
  /** The user has pressed stop (or this is a recording offered back after a restart). */
  const finalisingRef = useRef(false);
  const pumpingRef = useRef(false);
  const lastFailureRef = useRef<"timeout" | "failed" | null>(null);
  const monitorRef = useRef<number | null>(null);
  const silenceAnalyserRef = useRef<AnalyserNode | null>(null);

  const resetRecording = useCallback(() => {
    if (monitorRef.current) window.clearInterval(monitorRef.current);
    monitorRef.current = null;
    silenceAnalyserRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    openRecordersRef.current.clear();
    metaRef.current = null;
    segAudioRef.current = new Map();
    closedSegsRef.current = new Set();
    finalisingRef.current = false;
    lastFailureRef.current = null;
  }, []);

  /** Transcribe one piece, trying three times before giving up on it for now. */
  const transcribeSegment = useCallback(async (meta: RecordingMeta, seg: SegmentMeta) => {
    let audio: ArrayBuffer | null = null;
    const held = segAudioRef.current.get(seg.index);
    if (held && held.length) {
      audio = await new Blob(held, { type: meta.mimeType }).arrayBuffer();
    } else if (storeRef.current) {
      audio = await storeRef.current.readSegment(meta.id, seg.index);
    }
    // Nothing (or next to nothing) recorded in this piece: nothing to say.
    if (!audio || audio.byteLength < 1000) return "";

    // A piece recovered after a crash may never have had its length written;
    // give it the longest wait rather than the shortest.
    const timeoutMs = sttTimeoutFor(seg.durationMs || 10 * 60 * 1000);
    const { provider, apiKey: sttKey } = sttRef.current;
    const backoff = [0, 2000, 5000];
    let lastErr: unknown;
    for (const wait of backoff) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        return provider === "openai"
          ? await openAiSpeechToText(sttKey, audio, meta.mimeType, timeoutMs)
          : await speechToText(sttKey, audio, meta.mimeType, timeoutMs);
      } catch (err) {
        lastErr = err;
        console.error(`[hyo-voice] Piece ${seg.index + 1} failed to transcribe:`, err);
      }
    }
    throw lastErr;
  }, []);

  const finishIfDone = useCallback(async () => {
    const meta = metaRef.current;
    if (!meta || !finalisingRef.current || pumpingRef.current) return;
    if (openRecordersRef.current.size > 0) return;

    const pending = meta.segments.filter((s) => s.text === null);
    if (pending.length > 0) {
      const done = meta.segments.length - pending.length;
      const what =
        lastFailureRef.current === "timeout" ? "Transcription timed out" : "Transcription failed";
      const msg =
        meta.segments.length > 1
          ? `${what} (${done} of ${meta.segments.length} parts done, your recording is saved)`
          : `${what} (your recording is saved)`;
      new Notice(`${msg} — tap the mic to try again.`);
      setErrorMessage(msg);
      setVoiceState("error");
      return;
    }

    const transcript = meta.segments
      .map((s) => (s.text ?? "").trim())
      .filter(Boolean)
      .join(" ");
    if (!transcript) {
      // Came back empty. Keep the audio and show the retry state rather than
      // silently dropping to idle with nothing in the box.
      meta.segments.forEach((s) => (s.text = null));
      new Notice("Didn't catch anything — tap the mic to try again.");
      setErrorMessage("Didn't catch anything");
      setVoiceState("error");
      return;
    }

    onTranscriptRef.current(transcript);
    await storeRef.current?.remove(meta.id).catch((e) =>
      console.error("[hyo-voice] Couldn't clear the saved recording:", e)
    );
    resetRecording();
    setErrorMessage("");
    setVoiceState("idle");
  }, [resetRecording]);

  /** Work through every finished piece that hasn't been transcribed yet, in order. */
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    lastFailureRef.current = null;
    const failedThisRound = new Set<number>();
    try {
      for (;;) {
        const meta = metaRef.current;
        if (!meta) break;
        const seg = meta.segments.find(
          (s) =>
            s.text === null &&
            closedSegsRef.current.has(s.index) &&
            !failedThisRound.has(s.index)
        );
        if (!seg) break;
        try {
          seg.text = await transcribeSegment(meta, seg);
          segAudioRef.current.delete(seg.index);
          storeRef.current?.saveMeta(meta).catch(() => {});
        } catch (err) {
          lastFailureRef.current =
            err instanceof Error && err.message === STT_TIMEOUT_ERROR ? "timeout" : "failed";
          // Leave it for the next round (the next cut while recording, or the
          // user's retry tap) and carry on with the pieces after it.
          failedThisRound.add(seg.index);
        }
      }
    } finally {
      pumpingRef.current = false;
    }
    await finishIfDone();
  }, [transcribeSegment, finishIfDone]);

  /** Start recording a new piece on the open mic. */
  const startSegment = useCallback((stream: MediaStream, mimeType: string) => {
    const meta = metaRef.current!;
    const index = meta.segments.length;
    meta.segments.push({ index, durationMs: 0, text: null });
    storeRef.current?.saveMeta(meta).catch(() => {});

    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    const startedAt = Date.now();
    let chunkNo = 0;
    segAudioRef.current.set(index, []);

    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      debug(`[hyo-voice] piece ${index + 1}, chunk ${chunkNo + 1}: ${e.data.size} bytes`);
      segAudioRef.current.get(index)?.push(e.data);
      storeRef.current
        ?.writeChunk(meta.id, index, chunkNo, e.data)
        .catch((err) => console.error("[hyo-voice] Couldn't save audio chunk:", err));
      chunkNo++;
    };

    recorder.onstop = () => {
      const seg = meta.segments[index];
      if (seg) seg.durationMs = Date.now() - startedAt;
      storeRef.current?.saveMeta(meta).catch(() => {});
      openRecordersRef.current.delete(recorder);
      closedSegsRef.current.add(index);
      if (finalisingRef.current && openRecordersRef.current.size === 0) {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        teardownAnalyser();
      }
      void pump();
    };

    openRecordersRef.current.add(recorder);
    recorderSegRef.current.set(recorder, index);
    recorderRef.current = recorder;
    segStartRef.current = startedAt;
    // A chunk every five seconds, each written to disk as it arrives.
    recorder.start(5000);
    return recorder;
  }, [pump, teardownAnalyser]);

  /** Cut the recording here: the next piece starts before this one stops, so nothing is missed. */
  const cutSegment = useCallback(() => {
    const stream = streamRef.current;
    const old = recorderRef.current;
    const meta = metaRef.current;
    if (!stream || !old || !meta || finalisingRef.current) return;
    startSegment(stream, mimeTypeRef.current);
    window.setTimeout(() => {
      if (old.state === "recording") old.stop();
    }, 250);
  }, [startSegment]);

  // Where to cut: after a minute, at the first pause of about half a second;
  // after two and a half minutes, wherever we are. The pause is judged against
  // the room's own background level, so a noisy café still finds the gaps.
  const MIN_PIECE_MS = 60_000;
  const MAX_PIECE_MS = 150_000;
  const PAUSE_MS = 450;

  const startSilenceMonitor = useCallback(() => {
    const analyser = silenceAnalyserRef.current;
    const buf = analyser ? new Uint8Array(new ArrayBuffer(analyser.fftSize)) : null;
    let quietFor = 0;
    let floor = 1;
    let last = Date.now();
    monitorRef.current = window.setInterval(() => {
      const now = Date.now();
      const step = now - last;
      last = now;
      const elapsed = now - segStartRef.current;
      if (analyser && buf) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        // The floor follows the quietest level heard, creeping up slowly so a
        // room that gets noisier is followed too.
        floor = Math.min(rms, floor * 1.003 + 0.00001);
        const quiet = rms < floor * 2 + 0.006;
        quietFor = quiet ? quietFor + step : 0;
        if (elapsed >= MIN_PIECE_MS && quietFor >= PAUSE_MS) {
          quietFor = 0;
          cutSegment();
          return;
        }
      }
      if (elapsed >= MAX_PIECE_MS) {
        quietFor = 0;
        cutSegment();
      }
    }, 100);
  }, [cutSegment]);

  const startRecording = useCallback(async () => {
    resetRecording();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Wire up the live-waveform analyser off the same stream, plus a second
      // one with a longer window for spotting pauses. Guarded — if Web Audio
      // isn't available the recording still works, just without bars, and
      // long notes are cut on time alone.
      try {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new Ctx();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.75;
        src.connect(analyser);
        const silence = ctx.createAnalyser();
        silence.fftSize = 2048;
        src.connect(silence);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        silenceAnalyserRef.current = silence;
        freqRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      } catch {
        /* waveform is optional */
      }

      // iOS Safari/WebKit (Obsidian's mobile webview) does not support webm
      // recording at all — MediaRecorder.isTypeSupported correctly reports
      // false, so this falls through to mp4 there. Whatever we pick MUST be
      // carried through to the Blob + the STT API call (a real mp4 labelled
      // as webm silently fails to transcribe).
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
      debug(`[hyo-voice] Using mimeType: "${mimeType || "(browser default)"}"`);

      mimeTypeRef.current = mimeType;
      streamRef.current = stream;
      const meta: RecordingMeta = {
        id: `rec-${Date.now()}`,
        mimeType: mimeType || "audio/webm",
        createdAt: Date.now(),
        segments: [],
      };
      metaRef.current = meta;
      await storeRef.current?.create(meta).catch((err) =>
        console.error("[hyo-voice] Couldn't create the recording folder:", err)
      );

      startSegment(stream, mimeType);
      startSilenceMonitor();
      setErrorMessage("");
      setVoiceState("listening");
    } catch (err) {
      console.error("[hyo-voice] Microphone access denied:", err);
      new Notice("Couldn't access the microphone — check mic permission for Obsidian.");
      teardownAnalyser();
      resetRecording();
      setVoiceState("idle");
    }
  }, [resetRecording, startSegment, startSilenceMonitor, teardownAnalyser]);

  const stopRecording = useCallback(() => {
    if (monitorRef.current) window.clearInterval(monitorRef.current);
    monitorRef.current = null;
    finalisingRef.current = true;
    // A recorder iOS has already wedged (webview suspended mid-record) will
    // never fire onstop; count it as done so the rest can still land.
    for (const r of Array.from(openRecordersRef.current)) {
      if (r.state === "inactive") {
        openRecordersRef.current.delete(r);
        const i = recorderSegRef.current.get(r);
        if (i !== undefined) closedSegsRef.current.add(i);
      }
    }
    const rec = recorderRef.current;
    if (!metaRef.current) {
      teardownAnalyser();
      setVoiceState("idle");
      return;
    }
    setVoiceState("thinking");
    if (rec && rec.state === "recording") {
      rec.stop();
    } else {
      // Nothing left recording: mark every piece as complete and finish.
      metaRef.current.segments.forEach((s) => closedSegsRef.current.add(s.index));
      streamRef.current?.getTracks().forEach((t) => t.stop());
      teardownAnalyser();
      void pump();
    }
  }, [pump, teardownAnalyser]);

  // A recording left over from last time (app closed, crash, or a failure
  // the user never retried) is offered back: it shows as the usual "tap the
  // mic to retry" state, and one tap finishes transcribing it.
  const offerLeftover = useCallback(async () => {
    const s = storeRef.current;
    if (!s || metaRef.current) return;
    let leftovers: RecordingMeta[] = [];
    try {
      leftovers = await s.listUnfinished();
    } catch (err) {
      console.error("[hyo-voice] Couldn't check for saved recordings:", err);
      return;
    }
    const meta = leftovers[0];
    if (!meta || metaRef.current) return;
    if (meta.segments.length === 0) {
      await s.remove(meta.id).catch(() => {});
      return;
    }
    metaRef.current = meta;
    finalisingRef.current = true;
    meta.segments.forEach((seg) => closedSegsRef.current.add(seg.index));
    const when = new Date(meta.createdAt).toLocaleString([], {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    setErrorMessage(`Your recording from ${when} hasn't been transcribed yet`);
    setVoiceState("error");
  }, []);

  useEffect(() => {
    if (store) void offerLeftover();
  }, [store, offerLeftover]);

  // --- Record button handler ---

  const handleRecordClick = useCallback(() => {
    if (voiceState === "speaking") {
      stopAudio();
      return;
    }
    if (voiceState === "error") {
      // Retry the SAME recording — every piece is still held (in memory and on
      // disk), and only the ones without text get sent again.
      setErrorMessage("");
      setVoiceState("thinking");
      void pump();
      return;
    }
    if (voiceState === "thinking") {
      // Busy transcribing — ignore taps.
      return;
    }
    if (voiceState === "listening") {
      stopRecording();
      return;
    }
    if (voiceState === "idle") {
      startRecording();
    }
  }, [voiceState, stopRecording, startRecording, pump]);

  // Discard a failed recording and return to a clean idle state — the escape
  // hatch when the user wants to start a fresh note instead of retrying.
  const dismissError = useCallback(() => {
    const meta = metaRef.current;
    if (meta) storeRef.current?.remove(meta.id).catch(() => {});
    resetRecording();
    setErrorMessage("");
    setVoiceState("idle");
    // If there's another saved recording waiting, offer it next.
    void offerLeftover();
  }, [resetRecording, offerLeftover]);

  // --- TTS Playback ---

  const speakResponse = useCallback(
    async (text: string) => {
      if (!text || !apiKey || !voiceId) return;
      setVoiceState("speaking");

      try {
        const audioBuffer = await textToSpeech(apiKey, voiceId, text);

        // Create playable URL from the audio data
        const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
        if (lastAudioUrlRef.current) URL.revokeObjectURL(lastAudioUrlRef.current);
        lastAudioUrlRef.current = URL.createObjectURL(blob);
        setHasLastAudio(true);

        const audio = new Audio(lastAudioUrlRef.current);
        audio.playbackRate = currentSpeed;
        audioRef.current = audio;

        audio.onended = () => {
          setVoiceState("idle");
          setIsPaused(false);
        };

        await audio.play();
      } catch (err) {
        console.error("[hyo-voice] TTS error:", err);
        setVoiceState("idle");
      }
    },
    [apiKey, voiceId, currentSpeed]
  );

  // --- Audio controls ---

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    setVoiceState("idle");
    setIsPaused(false);
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

  // Auto-speak when response completes (called externally)
  const autoSpeak = useCallback(
    (text: string) => {
      if (isVoiceMode && autoSpeakEnabled && text) {
        speakResponse(text);
      }
    },
    [isVoiceMode, autoSpeakEnabled, speakResponse]
  );

  return {
    voiceState,
    errorMessage,
    dismissError,
    isPaused,
    hasLastAudio,
    currentSpeed,
    handleRecordClick,
    startRecording,
    stopRecording,
    getWaveform,
    stopAudio,
    togglePause,
    replay,
    cycleSpeed,
    speakResponse,
    autoSpeak,
    // GPT-Live call
    isLive,
    startLive,
    stopLive,
    finishReply,
    notifyProgress,
    notifyPermissionAnswered,
    notifyErrorShown,
    noteSilently,
    currentCall,
    notifyAttention,
    toggleLiveMute,
    liveMuted,
    liveSide,
    liveLevel,
    liveStatus,
  };
}
