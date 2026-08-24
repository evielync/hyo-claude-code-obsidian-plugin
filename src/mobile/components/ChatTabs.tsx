import React, { useState, useRef, useEffect } from "react";
import type { TabSession } from "../hooks/useSessionManager";
import type { PastSession } from "../session-parser";
import type { TaskMeta } from "../../settings";
import { buildTaskList } from "../task-state";
import { GatewayClient, type ConnectionStatus } from "../gateway-client";

// The gateway connection status, surfaced as a small dot at the left of the
// bottom tab bar (green = connected, amber = (re)connecting, red =
// disconnected). This is the only trace of connection health left in the
// UI now that the separate status strip is gone.
function useGatewayStatus(gatewayUrl: string): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");

  useEffect(() => {
    const client = GatewayClient.get(gatewayUrl);
    setStatus(client.getStatus());
    return client.onStatusChange(setStatus);
  }, [gatewayUrl]);

  return status;
}

// A tab is "waiting on you" when Claude is blocked on the user: an unresolved
// permission request, an open question, or a plan awaiting approval. These are
// the same conditions the chat surface uses to render its blocked prompts, so
// the tab dot stays in lockstep with what's actually on screen.
function tabAwaitingInput(tab: TabSession): boolean {
  for (const m of tab.messages) {
    if (m.role !== "assistant") continue;
    if (m.permissionRequests?.some((r) => !r.resolved)) return true;
    if (m.askQuestion) return true;
    if (m.planReview && !m.planReview.resolved) return true;
  }
  return false;
}

interface ChatTabsProps {
  tabs: TabSession[];
  activeTabId: string;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
  pastSessions: PastSession[];
  tasks: Record<string, TaskMeta>;
  onOpenTaskScreen: () => void;
  taskMode?: boolean;
  onRefreshPastSessions: () => void;
  onNewTab: () => void;
  gatewayUrl: string;
}

export function ChatTabs({
  tabs,
  activeTabId,
  onSwitch,
  onClose,
  onRename,
  pastSessions,
  tasks,
  onOpenTaskScreen,
  taskMode,
  onRefreshPastSessions,
  onNewTab,
  gatewayUrl,
}: ChatTabsProps) {
  const connectionStatus = useGatewayStatus(gatewayUrl);
  // Badge only the loud state — something is actually blocked on you.
  const needsYouCount = buildTaskList(tabs, pastSessions, tasks).filter(
    (t) => t.state === "needs-attention"
  ).length;
  const connectionLabel =
    connectionStatus === "connected"
      ? "Connected"
      : connectionStatus === "connecting"
      ? "Connecting…"
      : connectionStatus === "reconnecting"
      ? "Reconnecting…"
      : "Disconnected";
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renamingId]);

  const handleDoubleClick = (tab: TabSession) => {
    setRenamingId(tab.id);
    setRenameValue(tab.title);
  };

  const handleRenameBlur = () => {
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      setRenamingId(null);
    }
  };

  return (
    <div className="hyo-tabs">
      <span
        className={`hyo-conn-dot hyo-conn-dot-${connectionStatus}`}
        title={`Gateway: ${connectionLabel}`}
      />
      <div className="hyo-tabs-left">
        {tabs.map((tab) => {
          const awaiting = tabAwaitingInput(tab);
          return (
          <div
            key={tab.id}
            className={`hyo-tab ${tab.id === activeTabId ? "hyo-tab-active" : ""}`}
            onClick={() => onSwitch(tab.id)}
            onDoubleClick={() => handleDoubleClick(tab)}
          >
            {renamingId === tab.id ? (
              <input
                ref={inputRef}
                className="hyo-tab-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={handleRenameBlur}
                onKeyDown={handleRenameKeyDown}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                {awaiting ? (
                  <span
                    className="hyo-tab-dot hyo-tab-dot-waiting"
                    title="Waiting for you"
                  />
                ) : tab.generating ? (
                  <span className="hyo-tab-dot" title="Working…" />
                ) : null}
                <span className="hyo-tab-title">{tab.title}</span>
                <button
                  className="hyo-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                >×</button>
              </>
            )}
          </div>
          );
        })}
      </div>

      <div className="hyo-tabs-actions">
        <button
          className="hyo-action-btn hyo-history-btn"
          onClick={onOpenTaskScreen}
          title={taskMode ? "Back to conversation" : "History — manage your conversations as tasks"}
        >
          {taskMode ? (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 9.5a2 2 0 0 1-2 2H6l-3.5 2.5V4a2 2 0 0 1 2-2h7.5a2 2 0 0 1 2 2z" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 5v3l2 2" />
            </svg>
          )}
          {!taskMode && needsYouCount > 0 && (
            <span className="hyo-history-badge">{needsYouCount}</span>
          )}
        </button>
        <button
          className="hyo-action-btn"
          onClick={onNewTab}
          title="New conversation"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="8" y1="3" x2="8" y2="13" />
            <line x1="3" y1="8" x2="13" y2="8" />
          </svg>
        </button>
      </div>
    </div>
  );
}
