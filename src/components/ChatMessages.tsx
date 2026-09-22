import React, { useEffect, useRef } from "react";
import { ChatMessage } from "./ChatMessage";
import { StreamingMessage } from "./StreamingMessage";
import type { Message } from "../hooks/useChatEngine";
import type { ClaudeUpdateRunner } from "./ClaudeUpdateCard";

interface ChatMessagesProps {
  messages: Message[];
  scrollRef: React.MutableRefObject<{ nearBottom: boolean }>;
  onPermissionResponse: (requestId: string, behavior: "allow" | "allow_always" | "deny") => void;
  onQuestionAnswer: (questionId: string, answers: Record<string, string>) => void;
  onRecover?: () => void;
  onClaudeUpdate?: ClaudeUpdateRunner;
}

export function ChatMessages({
  messages,
  scrollRef,
  onPermissionResponse,
  onQuestionAnswer,
  onRecover,
  onClaudeUpdate,
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

        // Claude's reply to a live-call hand-off: the voice spoke the words
        // (its own turn follows), so show only the work.
        const hideProse = msg.role === "assistant" && !!messages[i - 1]?.handoff;
        return (
          <ChatMessage
            key={`msg-${i}`}
            message={msg}
            onRecover={onRecover}
            onPermissionResponse={onPermissionResponse}
            onQuestionAnswer={onQuestionAnswer}
            hideProse={hideProse}
            onClaudeUpdate={onClaudeUpdate}
            isLast={i === messages.length - 1}
          />
        );
      })}
    </div>
  );
}
