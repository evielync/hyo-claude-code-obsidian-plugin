import React, { useState } from "react";
import type { ToolCallData } from "../hooks/useChatEngine";

interface ToolCallProps {
  tool: ToolCallData;
}

export function ToolCall({ tool }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolSummary(tool);

  return (
    <div className="hyo-tool-call">
      <div
        className="hyo-tool-call-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="hyo-tool-call-arrow">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span className="hyo-tool-call-name">{tool.name}</span>
        {summary && <span className="hyo-tool-call-summary">{summary}</span>}
      </div>
      {expanded && (
        <pre className="hyo-tool-call-body">
          {JSON.stringify(tool.input, null, 2)}
          {tool.result && `\n\n--- Result ---\n${tool.result}`}
        </pre>
      )}
    </div>
  );
}

function getToolSummary(tool: ToolCallData): string {
  const { name, input } = tool;
  if (!input) return "";

  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return getFilename(input.file_path);
    case "Grep":
      return `"${input.pattern}"`;
    case "Glob":
      return input.pattern || "";
    case "Bash":
      return (input.command || "").slice(0, 60);
    case "Task":
      return input.description || "";
    default:
      return "";
  }
}

function getFilename(path: string | undefined): string {
  if (!path) return "";
  return path.split("/").pop() || "";
}
