import React from "react";
import type { PermissionRequestData } from "../hooks/useChatEngine";
import { permissionAskerLine } from "../background-jobs";
import { inputString } from "./tool-input";

interface PermissionRequestProps {
  request: PermissionRequestData;
  onRespond: (requestId: string, behavior: "allow" | "allow_always" | "deny") => void;
}

export function PermissionRequest({ request, onRespond }: PermissionRequestProps) {
  const { requestId, toolName, asker } = request;
  const summary = getPermissionSummary(toolName, request.input);

  return (
    <div className="hyo-permission">
      {/* A background job's ask says which job, so it isn't mistaken for
          the chat asking about something you just said. */}
      {asker && <div className="hyo-permission-asker">{permissionAskerLine(asker)}</div>}
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

function getPermissionSummary(toolName: string, input: unknown): string {
  if (!input) return "";

  switch (toolName) {
    case "Edit":
      return shortPath(inputString(input, "file_path"));
    case "Write":
      return shortPath(inputString(input, "file_path"));
    case "Read":
      return shortPath(inputString(input, "file_path"));
    case "Bash":
      return truncate(inputString(input, "command") || inputString(input, "description") || "", 80);
    case "Glob":
      return inputString(input, "pattern") || "";
    case "Grep":
      return `"${inputString(input, "pattern") || ""}"`;
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
