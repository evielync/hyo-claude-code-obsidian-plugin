import React from "react";
import { ToolCall } from "./ToolCall";
import { PermissionRequest } from "./PermissionRequest";
import { AskQuestion } from "./AskQuestion";
import { MarkdownBlock } from "./MarkdownBlock";
import type { Message } from "../hooks/useChatEngine";
import { HIDDEN_TOOLS } from "../hooks/useChatEngine";

interface StreamingMessageProps {
  message: Message;
  onPermissionResponse: (requestId: string, behavior: "allow" | "allow_always" | "deny") => void;
  onQuestionAnswer: (questionId: string, answer: string) => void;
}

export function StreamingMessage({
  message,
  onPermissionResponse,
  onQuestionAnswer,
}: StreamingMessageProps) {
  if (message.isCompaction) {
    return (
      <div className="hyo-compaction-line">
        <span className="hyo-compaction-rule" />
        <span className="hyo-compaction-label">
          <span className="hyo-thinking-dot" />
          <span className="hyo-thinking-dot" />
          <span className="hyo-thinking-dot" />
          {" "}Compacting…
        </span>
        <span className="hyo-compaction-rule" />
      </div>
    );
  }

  const blocks = message.orderedBlocks || [];
  const toolCalls = message.toolCalls || [];
  const activityLabel = getActivityLabel(message);

  // Hide text blocks at the same turn index as any Skill tool call.
  const skillTurnIndices = new Set(
    blocks
      .filter((b) => b.type === "tool" && toolCalls.find((t) => t.id === b.toolId)?.name === "Skill")
      .map((b) => b.turnIndex)
  );

  return (
    <div className="hyo-message hyo-message-assistant hyo-streaming">
      <div className="hyo-message-content">
        {blocks.map((block, i) => {
          if (block.type === "thinking") {
            return (
              <details key={i} open className="hyo-thinking-block">
                <summary>Thinking...</summary>
                <div className="hyo-thinking-content">
                  {block.content?.slice(-500)}
                </div>
              </details>
            );
          }
          if (block.type === "text") {
            if (block.isSkillOutput || skillTurnIndices.has(block.turnIndex)) return null;
            const isLast = !blocks.slice(i + 1).some((b) => b.type === "text" && !b.isSkillOutput && !skillTurnIndices.has(b.turnIndex));
            return (
              <span key={i}>
                <MarkdownBlock content={block.content || ""} />
                {isLast && <span className="hyo-streaming-cursor" />}
              </span>
            );
          }
          if (block.type === "tool") {
            const tool = toolCalls.find((t) => t.id === block.toolId);
            if (!tool || HIDDEN_TOOLS.has(tool.name)) return null;
            return <ToolCall key={i} tool={tool} />;
          }
          return null;
        })}

        {message.permissionRequest &&
          !message.permissionRequest.resolved && (
            <PermissionRequest
              request={message.permissionRequest}
              onRespond={onPermissionResponse}
            />
          )}

        {message.askQuestion && (
          <AskQuestion
            question={message.askQuestion}
            onAnswer={onQuestionAnswer}
          />
        )}

        {activityLabel && (
          <div className="hyo-activity-indicator">
            <span className="hyo-thinking-dot" />
            <span className="hyo-thinking-dot" />
            <span className="hyo-thinking-dot" />
            {" "}
            {activityLabel}
          </div>
        )}
      </div>
    </div>
  );
}

function getActivityLabel(message: Message): string | null {
  const {
    toolCalls = [],
    orderedBlocks = [],
    content,
    permissionRequest,
    askQuestion,
  } = message;

  if (permissionRequest && !permissionRequest.resolved) return null;
  if (askQuestion) return null;

  const pendingAgent = toolCalls.find(
    (t) => (t.name === "Agent" || t.name === "Task") && !t.result
  );
  if (pendingAgent) return "Sub-agent running...";

  const pendingWeb = toolCalls.find(
    (t) => t.name === "WebSearch" && !t.result
  );
  if (pendingWeb) return "Searching the web...";

  if (!content && toolCalls.length === 0 && orderedBlocks.length === 0) {
    return "Thinking...";
  }

  const hasUnfinishedTool = toolCalls.some((t) => !t.result);
  if (hasUnfinishedTool) return "Working...";

  return null;
}
