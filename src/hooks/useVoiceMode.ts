import { Notice } from "obsidian";
import { useState, useCallback, useRef } from "react";
import { buildLiveInstructions, buildLiveHistory, readAgentIdentity } from "../voice/gpt-live";
import { directSdpExchange } from "../voice/live-sdp";
import { playChime, CONNECT_CHIME, HANGUP_CHIME } from "../voice/chimes";
import { LiveCall } from "../voice/live-call";
import type { VoiceCallRecord, CallEndReason } from "../voice/voice-call";
import type { Message } from "./useChatEngine";

interface UseVoiceModeOptions {
  openAiApiKey: string;
  /** Built-in name or `{ id }` for a custom voice, and that voice's description. */
  gptLiveVoice: string | { id: string };
  gptLiveVoiceDescription?: string;
  /** Settings → Voice → About you: the typed text, or the chosen note read now (fresh each call). */
  getAboutYou?: () => Promise<string>;
  /**
   * What the voice starts the call knowing: the tab's agent, the personality
   * paragraph, the open conversation, and where the call's line goes
   * (Claude messages so far).
   */
  getLiveContext: () => {
    agent: string;
    personality: string;
    messages: Message[];
    after: number;
  };
  /** A job from the live call: the whole request for Claude, and the user's words for the record. */
  onLiveHandoff: (prompt: string, said: string) => void;
  /** A finished spoken turn. */
  onVoiceTurn?: (side: "user" | "agent", text: string) => void;
  /** The call is over. `record` is null when nothing happened on it. */
  onCallEnded: (record: VoiceCallRecord | null, reason: CallEndReason) => void;
  /** Sandbox diagnostics: log every live event to a file. */
  debugLog?: boolean;
}

/** The desktop's voice call: GPT-Live, with OpenAI's key held here. */
export function useVoiceMode({
  openAiApiKey,
  gptLiveVoice,
  gptLiveVoiceDescription,
  getAboutYou,
  getLiveContext,
  onVoiceTurn,
  onCallEnded,
  onLiveHandoff,
  debugLog,
}: UseVoiceModeOptions) {
  // Session, record and hand-offs all live in LiveCall; this hook renders it.
  const liveRef = useRef<LiveCall | null>(null);
  const [liveSide, setLiveSide] = useState<"user" | "agent" | null>(null);
  const [liveLevel, setLiveLevel] = useState(0);
  // connecting → the session is up (greeting on its way) → the voice has spoken.
  const [liveStatus, setLiveStatus] = useState<"off" | "connecting" | "connected" | "live">("off");
  const onCallEndedRef = useRef(onCallEnded);
  onCallEndedRef.current = onCallEnded;
  const [micMuted, setMicMuted] = useState(false);
  // A call is starting or on: hanging up while About you is still being read
  // clears it, so the call never starts.
  const convActiveRef = useRef(false);
  const mutedRef = useRef(false);

  const startConversation = useCallback(async () => {
    if (convActiveRef.current || liveRef.current) return;
    if (!openAiApiKey) {
      new Notice("Hyo voice: add your OpenAI API key in Settings → Hyo → Voice to start a call.", 6000);
      return;
    }
    const { agent, personality, messages, after } = getLiveContext();
    const identity = readAgentIdentity(agent);
    convActiveRef.current = true;
    mutedRef.current = false;
    setMicMuted(false);
    // About you goes into the starting instructions, read fresh now (a note
    // is a local read; capped so a slow read never holds up the call).
    const aboutYou = getAboutYou
      ? await Promise.race([getAboutYou().catch(() => ""), new Promise<string>((r) => window.setTimeout(() => r(""), 1500))])
      : "";
    if (!convActiveRef.current) return; // hung up while reading
    const call: LiveCall = new LiveCall({
      // WebRTC first (proper echo cancellation); the WebSocket path if the
      // peer connection can't be set up here.
      transports: ["webrtc", "ws"],
      after,
      session: {
        debugLog,
        apiKey: openAiApiKey,
        // The desktop holds the key, so it signs the WebRTC offer itself.
        exchangeSdp: directSdpExchange(openAiApiKey),
        voice: gptLiveVoice,
        instructions: buildLiveInstructions(personality, identity, { voiceDescription: gptLiveVoiceDescription, aboutYou }),
        history: buildLiveHistory(messages),
      },
      onHandoff: (prompt, said) => onLiveHandoff(prompt, said),
      onTurn: (side, text) => onVoiceTurn?.(side, text),
      onUi: (ui) => {
        setLiveStatus(ui.status);
        setLiveSide(ui.side);
        setLiveLevel(ui.level);
      },
      // A chime instead of a spoken greeting, once it can really hear.
      onLive: () => playChime(CONNECT_CHIME),
      onEnded: (record, reason) => {
        if (reason === "hung-up") playChime(HANGUP_CHIME);
        if (liveRef.current === call) liveRef.current = null;
        convActiveRef.current = false;
        onCallEndedRef.current(record, reason);
      },
      onError: (msg) => {
        console.error("[hyo-voice] GPT-Live:", msg);
        new Notice(`Hyo voice: ${msg}`, 7000);
      },
    });
    liveRef.current = call;
    await call.start();
  }, [getAboutYou, openAiApiKey, gptLiveVoice, gptLiveVoiceDescription, getLiveContext, onLiveHandoff, onVoiceTurn, debugLog]);

  const stopConversation = useCallback(() => {
    const call = liveRef.current;
    liveRef.current = null;
    call?.hangUp();
    convActiveRef.current = false;
    setLiveSide(null);
    setLiveLevel(0);
    setLiveStatus("off");
  }, []);

  const toggleMute = useCallback(() => {
    mutedRef.current = !mutedRef.current;
    setMicMuted(mutedRef.current);
    liveRef.current?.setMuted(mutedRef.current);
  }, []);

  /** Something on screen needs the user (permission ask, question): the voice knows. */
  const notifyAttention = useCallback((text: string) => {
    liveRef.current?.notifyAttention(text);
  }, []);

  /** Claude finished a reply: the answer to the open hand-off, or something typed in the chat. */
  const finishReply = useCallback((markdown: string, selfStarted?: boolean) => {
    liveRef.current?.finishReply(markdown, selfStarted);
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

  /** The call that's on now (its record grows as it goes). */
  const currentCall = useCallback((): VoiceCallRecord | null => liveRef.current?.callRecord ?? null, []);

  return {
    micMuted,
    startConversation,
    stopConversation,
    toggleMute,
    notifyAttention,
    finishReply,
    notifyProgress,
    notifyPermissionAnswered,
    notifyErrorShown,
    currentCall,
    liveSide,
    liveLevel,
    liveStatus,
  };
}
