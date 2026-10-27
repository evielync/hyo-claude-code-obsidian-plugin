import React, { useEffect, useRef } from "react";
import { ChatMessage } from "./ChatMessage";
import { PermissionRequest } from "./PermissionRequest";
import { waitingAsks } from "../background-jobs";
import { StreamingMessage } from "./StreamingMessage";
import { VoiceCallLine } from "./VoiceCallLine";
import type { Message } from "../hooks/useChatEngine";
import type { VoiceCallRecord } from "../voice/voice-call";
import type { ClaudeUpdateRunner } from "./ClaudeUpdateCard";
import type { ClaudeSignInRunner } from "./ClaudeSignInCard";

interface ChatMessagesProps {
  messages: Message[];
  scrollRef: React.MutableRefObject<{ nearBottom: boolean }>;
  onPermissionResponse: (requestId: string, behavior: "allow" | "allow_always" | "deny") => void;
  onQuestionAnswer: (questionId: string, answers: Record<string, string>) => void;
  onRecover?: () => void;
  onClaudeUpdate?: ClaudeUpdateRunner;
  onClaudeSignIn?: ClaudeSignInRunner;
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
  onClaudeSignIn,
  onOpenCall,
}: ChatMessagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);

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
      const threshold = 150;
      scrollRef.current.nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef]);

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
            onPermissionResponse={onPermissionResponse}
            onQuestionAnswer={onQuestionAnswer}
            onClaudeUpdate={onClaudeUpdate}
            onClaudeSignIn={onClaudeSignIn}
            isLast={i === messages.length - 1}
          />
        );
      })}
      {/* Asks still waiting that belong to a finished reply (a background
          job's, mostly): here at the bottom, where she'll see them. */}
      {waitingAsks(messages).map((request) => (
        <PermissionRequest key={`ask-${request.requestId}`} request={request} onRespond={onPermissionResponse} />
      ))}
    </div>
  );
}
