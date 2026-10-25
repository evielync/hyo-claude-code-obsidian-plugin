import React, { useEffect, useLayoutEffect, useRef } from "react";
import { ChatMessage } from "./ChatMessage";
import { StreamingMessage } from "./StreamingMessage";
import type { Message } from "../hooks/useChatEngine";
import type { ClaudeUpdateRunner } from "../../components/ClaudeUpdateCard";
import { VoiceCallLine } from "../../components/VoiceCallLine";
import type { VoiceCallRecord } from "../../voice/voice-call";

interface ChatMessagesProps {
  messages: Message[];
  scrollRef: React.MutableRefObject<{ nearBottom: boolean }>;
  onPermissionResponse: (requestId: string, behavior: "allow" | "allow_always" | "deny") => void;
  onQuestionAnswer: (questionId: string, answers: Record<string, string>) => void;
  onRecover?: () => void;
  onClaudeUpdate?: ClaudeUpdateRunner;
  /** Tapping a voice-call line opens its transcript. */
  onOpenCall?: (call: VoiceCallRecord) => void;
}

export function ChatMessages({
  messages,
  scrollRef,
  onPermissionResponse,
  onQuestionAnswer,
  onRecover,
  onClaudeUpdate,
  onOpenCall,
}: ChatMessagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Where she was reading. Kept only while the list is on screen, so it
  // survives Hyo being hidden.
  const saved = useRef({ top: 0, atBottom: true });

  // Opening Hyo lands on the latest message.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    scrollRef.current.nearBottom = true;
    saved.current = { top: el.scrollTop, atBottom: true };
  }, [scrollRef]);

  // Auto-scroll during streaming
  useEffect(() => {
    if (scrollRef.current.nearBottom && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, scrollRef]);

  // Track scroll position
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      // A hidden list reports a scroll of 0; that isn't her position.
      if (el.clientHeight === 0) return;
      const threshold = 150;
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      scrollRef.current.nearBottom = near;
      saved.current = { top: el.scrollTop, atBottom: near };
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef]);

  // Coming back to Hyo. When she switches to another view or app, Obsidian
  // hides this panel and the browser throws its scroll position away, so it
  // came back at the top of a long conversation. When the list reappears,
  // or the keyboard changes its height, put her back where she was: at the
  // latest message if that's where she was, otherwise the same spot.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (h > 0 && h !== lastHeight) {
        if (saved.current.atBottom) {
          el.scrollTop = el.scrollHeight;
        } else if (lastHeight === 0) {
          el.scrollTop = saved.current.top;
        }
      }
      lastHeight = h;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="hyo-messages" ref={containerRef}>
      {messages.map((msg, i) => {
        // Streaming compaction: show "Compacting…" animation via StreamingMessage
        if (msg.streaming) {
          return (
            <StreamingMessage
              key={`stream-${i}`}
              message={msg}
              onPermissionResponse={onPermissionResponse}
              onQuestionAnswer={onQuestionAnswer}
            />
          );
        }

        // Completed compaction: show static banner
        if (msg.isCompaction) {
          return (
            <div key={`compact-${i}`} className="hyo-compaction-banner">
              Context compacted
            </div>
          );
        }

        // A voice call: one line where it started; tap for the transcript.
        if (msg.voiceCall) {
          return <VoiceCallLine key={`call-${msg.voiceCall.id}`} call={msg.voiceCall} onOpen={(c) => onOpenCall?.(c)} />;
        }

        return (
          <ChatMessage
            key={`msg-${i}`}
            message={msg}
            onRecover={onRecover}
            onClaudeUpdate={onClaudeUpdate}
            onPermissionResponse={onPermissionResponse}
            onQuestionAnswer={onQuestionAnswer}
          />
        );
      })}
    </div>
  );
}
