import { Notice } from "obsidian";
import { debug } from "../debug";
import { useState, useCallback, useRef } from "react";
import {
  textToSpeech,
  speechToText,
  STT_TIMEOUT_ERROR,
} from "../voice/elevenlabs-api";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "error";

const VOICE_SPEEDS = [1.0, 1.25, 1.5, 2.0];

interface UseVoiceModeOptions {
  apiKey: string;
  voiceId: string;
  playbackSpeed: number;
  isVoiceMode: boolean;
  autoSpeak: boolean;
  onTranscript: (text: string) => void;
}

export function useVoiceMode({
  apiKey,
  voiceId,
  playbackSpeed,
  isVoiceMode,
  autoSpeak: autoSpeakEnabled,
  onTranscript,
}: UseVoiceModeOptions) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [isPaused, setIsPaused] = useState(false);
  const [hasLastAudio, setHasLastAudio] = useState(false);
  const [currentSpeed, setCurrentSpeed] = useState(playbackSpeed);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingMimeTypeRef = useRef<string>("audio/webm");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastAudioUrlRef = useRef<string | null>(null);
  const processingRef = useRef(false);

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

  // --- Recording ---

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Wire up the live-waveform analyser off the same stream. Guarded — if
      // Web Audio isn't available the recording still works, just without bars.
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
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        freqRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      } catch {
        /* waveform is optional */
      }

      // iOS Safari/WebKit (Obsidian's mobile webview) does not support webm
      // recording at all — MediaRecorder.isTypeSupported correctly reports
      // false, so this falls through to mp4 there. Whatever we pick MUST be
      // carried through to the Blob + the STT API call below (previously
      // both were hardcoded to "audio/webm", so on iOS the real mp4 audio
      // was mislabelled as webm and ElevenLabs silently failed to transcribe
      // it — recording looked fine, nothing ever landed in the input box).
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
      debug(`[hyo-voice] Using mimeType: "${mimeType || "(browser default)"}"`);
      recordingMimeTypeRef.current = mimeType || "audio/webm";
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        debug(`[hyo-voice] chunk received: ${e.data.size} bytes`);
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        teardownAnalyser();
        await processRecording();
      };

      recorderRef.current = recorder;
      recorder.start();
      setErrorMessage("");
      setVoiceState("listening");
    } catch (err) {
      console.error("[hyo-voice] Microphone access denied:", err);
      new Notice("Couldn't access the microphone — check mic permission for Obsidian.");
      teardownAnalyser();
      setVoiceState("idle");
    }
  }, []);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") {
      rec.stop();
    } else {
      // Recorder is missing or already inactive (e.g. iOS suspended the
      // webview mid-record and wedged it). Don't leave the button stuck in
      // "listening" with no way back — recover to idle.
      teardownAnalyser();
      setVoiceState("idle");
    }
  }, []);

  // Process recording → transcribe → send
  const processRecording = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    setVoiceState("thinking");

    try {
      const mimeType = recordingMimeTypeRef.current;
      const blob = new Blob(chunksRef.current, { type: mimeType });

      if (blob.size < 1000) {
        debug("[hyo-voice] Recording too short");
        new Notice("Didn't catch that — recording was too short. Try again and hold a beat longer.");
        setVoiceState("idle");
        return;
      }

      // Convert blob to ArrayBuffer for the API. Pass the REAL mime type
      // through — ElevenLabs needs to know the actual container format,
      // not an assumed one (see the note in startRecording above).
      const arrayBuffer = await blob.arrayBuffer();
      const transcript = await speechToText(apiKeyRef.current, arrayBuffer, mimeType);

      if (transcript) {
        onTranscriptRef.current(transcript);
        setErrorMessage("");
        chunksRef.current = [];
        setVoiceState("idle");
      } else {
        // Came back empty. Rather than silently dropping to idle with nothing
        // in the box (which reads as "it just didn't work"), keep the audio
        // and surface the same visible retry state as a failure — so there is
        // never a dead end where nothing appears and there's no way forward.
        new Notice("Didn't catch anything — tap the mic to try again.");
        setErrorMessage("Didn't catch anything");
        setVoiceState("error");
      }
    } catch (err) {
      // Network failure or timeout. The audio is still held in chunksRef, so
      // we do NOT clear it and do NOT drop to idle — we enter a persistent,
      // tappable "error" state. The spoken note is not lost: one tap re-sends
      // the exact same recording (see handleRecordClick).
      console.error("[hyo-voice] Transcription error:", err);
      const timedOut =
        err instanceof Error && err.message === STT_TIMEOUT_ERROR;
      const msg = timedOut ? "Transcription timed out" : "Transcription failed";
      new Notice(`${msg} — tap the mic to try again.`);
      setErrorMessage(msg);
      setVoiceState("error");
    } finally {
      processingRef.current = false;
    }
    // Stable — reads `apiKey`/`onTranscript` through always-latest refs, so it
    // never needs to be re-created (which is what kept the MediaRecorder
    // `onstop` closure from going stale and misdelivering transcripts).
  }, []);

  // --- Record button handler ---

  const handleRecordClick = useCallback(() => {
    if (voiceState === "speaking") {
      stopAudio();
      return;
    }
    if (voiceState === "error") {
      // Retry the SAME recording — the audio is still held in chunksRef, so
      // this re-sends the note the user already spoke rather than recording
      // a new one.
      processRecording();
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
  }, [voiceState, stopRecording, startRecording, processRecording]);

  // Discard a failed recording and return to a clean idle state — the escape
  // hatch when the user wants to start a fresh note instead of retrying.
  const dismissError = useCallback(() => {
    chunksRef.current = [];
    setErrorMessage("");
    setVoiceState("idle");
  }, []);

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
  };
}
