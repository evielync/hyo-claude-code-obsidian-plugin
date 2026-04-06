import React from "react";
import type { PermissionRequestData } from "../hooks/useChatEngine";

interface PermissionRequestProps {
  request: PermissionRequestData;
  onRespond: (requestId: string, allowed: boolean) => void;
}

export function PermissionRequest({ request, onRespond }: PermissionRequestProps) {
  const { requestId, toolName } = request;

  return (
    <div className="hyo-permission">
      <div className="hyo-permission-tool">{toolName}</div>
      <div className="hyo-permission-buttons">
        <button
          className="hyo-permission-deny"
          onClick={() => onRespond(requestId, false)}
        >
          Deny
        </button>
        <button
          className="hyo-permission-allow"
          onClick={() => onRespond(requestId, true)}
        >
          Allow once
        </button>
      </div>
    </div>
  );
}
