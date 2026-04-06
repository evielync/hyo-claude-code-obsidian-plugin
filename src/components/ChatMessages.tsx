import React, { useEffect, useRef } from "react";
import { ChatMessage } from "./ChatMessage";
import { StreamingMessage } from "./StreamingMessage";
import type { Message } from "../hooks/useChatEngine";

interface ChatMessagesProps {
  messages: Message[];
  scrollRef: React.MutableRefObject<{ nearBottom: boolean }>;
  onPermissionResponse: (requestId: string, allowed: boolean) => void;
  onQuestionAnswer: (questionId: string, answer: string) => void;
}

export function ChatMessages({
  messages,
  scrollRef,
  onPermissionResponse,
  onQuestionAnswer,
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
        if (msg.isCompaction) {
          return (
            <div key={`compact-${i}`} className="hyo-compaction-banner">
              Context compacted
            </div>
          );
        }

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

        return <ChatMessage key={`msg-${i}`} message={msg} />;
      })}
    </div>
  );
}
