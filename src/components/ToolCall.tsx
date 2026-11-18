import React, { useState } from "react";
import type { ToolCallData } from "../hooks/useChatEngine";
import { inputField, inputString } from "./tool-input";

interface ToolCallProps {
  tool: ToolCallData;
}

export function ToolCall({ tool }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolSummary(tool);
  const isSkill = tool.name === "Skill";

  return (
    <div className="hyo-tool-call">
      <div
        className={isSkill ? "hyo-tool-call-header hyo-tool-call-header-static" : "hyo-tool-call-header"}
        onClick={() => !isSkill && setExpanded(!expanded)}
      >
        <span className="hyo-tool-call-arrow">{isSkill ? "◆" : expanded ? "\u25BC" : "\u25B6"}</span>
        <span className="hyo-tool-call-name">{isSkill ? "Skill" : tool.name}</span>
        {summary && <span className="hyo-tool-call-summary">{summary}</span>}
      </div>
      {!isSkill && expanded && (
        <pre className="hyo-tool-call-body">
          {JSON.stringify(tool.input, null, 2)}
          {tool.result && `\n\n--- Result ---\n${tool.result}`}
        </pre>
      )}
    </div>
  );
}

function getToolSummary(tool: ToolCallData): string {
  const name = tool.name;
  const input: unknown = tool.input;
  if (!input) return "";

  switch (name) {
    case "Skill":
      return inputString(input, "name") || inputString(input, "skill") || "";
    case "Read":
    case "Write":
    case "Edit":
      return getFilename(inputString(input, "file_path"));
    case "Grep":
      return `"${String(inputField(input, "pattern"))}"`;
    case "Glob":
      return inputString(input, "pattern") || "";
    case "Bash":
      return (inputString(input, "command") || "").slice(0, 60);
    case "Task":
      return inputString(input, "description") || "";
    default:
      return "";
  }
}

function getFilename(path: string | undefined): string {
  if (!path) return "";
  return path.split("/").pop() || "";
}
