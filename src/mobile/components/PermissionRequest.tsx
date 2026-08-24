import React from "react";
import type { PermissionRequestData } from "../hooks/useChatEngine";

interface PermissionRequestProps {
  request: PermissionRequestData;
  onRespond: (requestId: string, behavior: "allow" | "allow_always" | "deny") => void;
}

export function PermissionRequest({ request, onRespond }: PermissionRequestProps) {
  const { requestId, toolName, input } = request;
  const summary = getPermissionSummary(toolName, input);

  return (
    <div className="hyo-permission">
      <div className="hyo-permission-tool">{toolName}</div>
      {summary && <div className="hyo-permission-summary">{summary}</div>}
      <div className="hyo-permission-buttons">
        <button
          className="hyo-permission-deny"
          onClick={() => onRespond(requestId, "deny")}
        >
          Deny
        </button>
        <button
          className="hyo-permission-allow"
          onClick={() => onRespond(requestId, "allow")}
        >
          Allow once
        </button>
        <button
          className="hyo-permission-allow-always"
          onClick={() => onRespond(requestId, "allow_always")}
        >
          Always allow
        </button>
      </div>
    </div>
  );
}

function getPermissionSummary(toolName: string, input: any): string {
  if (!input) return "";

  switch (toolName) {
    case "Edit":
      return shortPath(input.file_path);
    case "Write":
      return shortPath(input.file_path);
    case "Read":
      return shortPath(input.file_path);
    case "Bash":
      return truncate(input.command || input.description || "", 80);
    case "Glob":
      return input.pattern || "";
    case "Grep":
      return `"${input.pattern || ""}"`;
    default:
      if (toolName.startsWith("mcp__")) {
        return toolName.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
      }
      return "";
  }
}

function shortPath(p: string | undefined): string {
  if (!p) return "";
  // Show last 2 path segments to give enough context without full path
  const parts = p.replace(/^\/Users\/[^/]+/, "~").split("/");
  return parts.slice(-2).join("/");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
