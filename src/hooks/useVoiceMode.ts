import { useState, useCallback, useRef } from "react";
import {
  textToSpeech,
  speechToText,
} from "../voice/elevenlabs-api";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

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
  const [isPaused, setIsPaused] = useState(false);
  const [hasLastAudio, setHasLastAudio] = useState(false);
  const [currentSpeed, setCurrentSpeed] = useState(playbackSpeed);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastAudioUrlRef = useRef<string | null>(null);
  const processingRef = useRef(false);

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

      if (blob.size < 1000) {
        console.log("[hyo-voice] Recording too short");
        setVoiceState("idle");
        return;
      }

      // Convert blob to ArrayBuffer for the API
      const arrayBuffer = await blob.arrayBuffer();
      const transcript = await speechToText(apiKey, arrayBuffer);

      if (transcript) {
        onTranscript(transcript);
      }
      setVoiceState("idle");
    } catch (err) {
      console.error("[hyo-voice] Transcription error:", err);
      setVoiceState("idle");
    } finally {
      processingRef.current = false;
    }
  }, [apiKey, onTranscript]);

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
    isPaused,
    hasLastAudio,
    currentSpeed,
    handleRecordClick,
    stopAudio,
    togglePause,
    replay,
    cycleSpeed,
    speakResponse,
    autoSpeak,
  };
}
