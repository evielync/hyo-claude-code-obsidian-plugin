import React from "react";
import { ToolCall } from "./ToolCall";
import { PermissionRequest } from "./PermissionRequest";
import { AskQuestion } from "./AskQuestion";
import { PlanReview } from "./PlanReview";
import { MarkdownBlock } from "./MarkdownBlock";
import type { Message } from "../hooks/useChatEngine";
import { HIDDEN_TOOLS } from "../hooks/useChatEngine";

interface StreamingMessageProps {
  message: Message;
  engine?: string;
  onPermissionResponse: (requestId: string, behavior: "allow" | "allow_always" | "deny") => void;
  onQuestionAnswer: (questionId: string, answers: Record<string, string>) => void;
}

export function StreamingMessage({
  message,
  engine,
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
            // Opus 4.7+ / Sonnet 5 default thinking display to "omitted", so
            // the block still arrives but its text is empty. Rendering it
            // anyway produced a chevron that expanded to nothing, which reads
            // as broken — so only render when there's something to show. The
            // separate "Thinking…" activity indicator still covers the
            // in-progress state.
            if (!block.content?.trim()) return null;
            return (
              <details key={i} open className="hyo-thinking-block">
                <summary>Thinking...</summary>
                <div className="hyo-thinking-content">
                  {block.content.slice(-500)}
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

        {message.permissionRequests
          ?.filter((r) => !r.resolved)
          .map((request) => (
            <PermissionRequest
              engine={engine}
              key={request.requestId}
              request={request}
              onRespond={onPermissionResponse}
            />
          ))}

        {message.askQuestion && (
          <AskQuestion
            question={message.askQuestion}
            onAnswer={onQuestionAnswer}
          />
        )}

        {message.planReview && !message.planReview.resolved && (
          <PlanReview
            review={message.planReview}
            onRespond={onPermissionResponse}
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
    permissionRequests,
    askQuestion,
  } = message;

  if (permissionRequests?.some((r) => !r.resolved)) return null;
  if (askQuestion) return null;

  const planReview = message.planReview;
  if (planReview && !planReview.resolved) return null;

  const pendingAgent = toolCalls.find(
    (t) => (t.name === "Agent" || t.name === "Task") && !t.result
  );
  if (pendingAgent) return "Sub-agent running...";

  const pendingWeb = toolCalls.find(
    (t) => t.name === "WebSearch" && !t.result
  );
  if (pendingWeb) return "Searching the web...";

  // Thinking blocks with no text (Opus 4.7+ / Sonnet 5 omit the summary) are
  // not rendered, so they must not count as visible output either — otherwise
  // the indicator switches off and the message shows nothing at all while the
  // model is still thinking.
  const visibleBlocks = orderedBlocks.filter(
    (b) => !(b.type === "thinking" && !b.content?.trim())
  );

  if (!content && toolCalls.length === 0 && visibleBlocks.length === 0) {
    return "Thinking...";
  }

  const hasUnfinishedTool = toolCalls.some((t) => !t.result);
  if (hasUnfinishedTool) return "Working...";

  return null;
}
