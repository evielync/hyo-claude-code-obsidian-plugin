import React, { useState, useCallback } from "react";
import { ToolCall } from "./ToolCall";
import { MarkdownBlock, stripInlineThinkingTags } from "./MarkdownBlock";
import type { Message } from "../hooks/useChatEngine";
import { HIDDEN_TOOLS } from "../hooks/useChatEngine";
import { THINKING_BLOCK_ERROR_RE } from "../session-repair";

interface ChatMessageProps {
  message: Message;
  onRecover?: () => void;
}

export function ChatMessage({ message, onRecover }: ChatMessageProps) {
  if (message.isCompaction) {
    return <CompactionMessage message={message} />;
  }
  if (message.role === "user") {
    return <UserMessage message={message} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessage message={message} onRecover={onRecover} />;
  }
  return null;
}

function CompactionMessage({ message }: { message: Message }) {
  const done = !message.streaming;
  return (
    <div className="hyo-compaction-line">
      <span className="hyo-compaction-rule" />
      <span className="hyo-compaction-label">
        {done ? "✓ Compacted" : "Compacting…"}
      </span>
      <span className="hyo-compaction-rule" />
    </div>
  );
}

function UserMessage({ message }: { message: Message }) {
  // Use stored metadata when available (messages sent with file attachments).
  // displayText holds exactly what the user typed; attachments holds file names.
  // Fall back to raw content for messages sent before this change.
  const fileChips = (message.attachments || []).filter((a) => a.type === "file");
  const displayText = message.displayText ?? message.content;

  return (
    <div className="hyo-message hyo-message-user">
      <div className="hyo-message-content">
        {fileChips.length > 0 && (
          <div className="hyo-message-file-chips">
            {fileChips.map((a) => (
              <div key={a.name} className="hyo-message-file-chip">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span>{a.name}</span>
              </div>
            ))}
          </div>
        )}
        {displayText && <div className="hyo-message-text">{displayText}</div>}
      </div>
    </div>
  );
}

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const text = getText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard not available
    }
  }, [getText]);

  return (
    <button
      className="hyo-copy-btn"
      title="Copy message"
      onClick={handleCopy}
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function RecoverBanner({ onRecover }: { onRecover: () => void }) {
  return (
    <div className="hyo-recover-banner">
      <div className="hyo-recover-banner-text">
        This session hit a known issue (output cap left an orphaned thinking block). Click to clean it up and resume from your last message.
      </div>
      <button className="hyo-recover-button" onClick={onRecover}>
        Recover session and continue
      </button>
    </div>
  );
}

function isThinkingBlockErrorContent(text: string): boolean {
  return THINKING_BLOCK_ERROR_RE.test(text);
}

function AssistantMessage({ message, onRecover }: { message: Message; onRecover?: () => void }) {
  const blocks = message.orderedBlocks || [];
  const toolCalls = message.toolCalls || [];

  // Detect the thinking-block API error from the message content so we can
  // surface the recovery button. The error arrives as plain text in either
  // `message.content` or as a text block.
  const fullText =
    (message.content || "") +
    "\n" +
    blocks
      .filter((b) => b.type === "text")
      .map((b) => b.content || "")
      .join("\n");
  const showRecover =
    !message.streaming && !!onRecover && isThinkingBlockErrorContent(fullText);

  // Any text block at the same turn index as a Skill tool call is skill content — hide it.
  const skillTurnIndices = new Set(
    blocks
      .filter((b) => b.type === "tool" && toolCalls.find((t) => t.id === b.toolId)?.name === "Skill")
      .map((b) => b.turnIndex)
  );

  const getTextContent = useCallback(() => {
    if (blocks.length === 0) return stripInlineThinkingTags(message.content || "");
    return blocks
      .filter((b) => b.type === "text" && !skillTurnIndices.has(b.turnIndex))
      .map((b) => stripInlineThinkingTags(b.content || ""))
      .join("\n\n");
  }, [blocks, message.content]);

  if (blocks.length === 0 && message.content) {
    return (
      <div className="hyo-message hyo-message-assistant">
        <div className="hyo-message-content">
          <MarkdownBlock content={message.content} />
        </div>
        {showRecover && onRecover && <RecoverBanner onRecover={onRecover} />}
        {!message.streaming && (
          <div className="hyo-message-actions">
            <CopyButton getText={getTextContent} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="hyo-message hyo-message-assistant">
      <div className="hyo-message-content">
        {blocks.map((block, i) => {
          if (block.type === "thinking") {
            return (
              <details key={i} className="hyo-thinking-block">
                <summary>Thinking...</summary>
                <div className="hyo-thinking-content">{block.content}</div>
              </details>
            );
          }
          if (block.type === "text") {
            if (block.isSkillOutput || skillTurnIndices.has(block.turnIndex)) return null;
            return <MarkdownBlock key={i} content={block.content || ""} />;
          }
          if (block.type === "tool") {
            const tool = toolCalls.find((t) => t.id === block.toolId);
            if (!tool || HIDDEN_TOOLS.has(tool.name)) return null;
            return <ToolCall key={i} tool={tool} />;
          }
          return null;
        })}
      </div>
      {showRecover && onRecover && <RecoverBanner onRecover={onRecover} />}
      {!message.streaming && blocks.some((b) => b.type === "text") && (
        <div className="hyo-message-actions">
          <CopyButton getText={getTextContent} />
        </div>
      )}
    </div>
  );
}
