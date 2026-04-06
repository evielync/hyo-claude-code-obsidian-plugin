import React, { useState, useRef, useEffect } from "react";
import type { TabSession } from "../hooks/useSessionManager";
import type { PastSession } from "../session-parser";
import { SessionDropdown } from "./SessionDropdown";

interface ChatTabsProps {
  tabs: TabSession[];
  activeTabId: string;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
  pastSessions: PastSession[];
  onOpenPastSession: (session: PastSession) => void;
  onRefreshPastSessions: () => void;
  onNewTab: () => void;
}

export function ChatTabs({
  tabs,
  activeTabId,
  onSwitch,
  onClose,
  onRename,
  pastSessions,
  onOpenPastSession,
  onRefreshPastSessions,
  onNewTab,
}: ChatTabsProps) {
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
      <div className="hyo-tabs-left">
        {tabs.map((tab) => (
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
                {tab.generating && <span className="hyo-tab-dot" />}
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
        ))}
      </div>

      <div className="hyo-tabs-actions">
        <SessionDropdown
          pastSessions={pastSessions}
          onOpen={onOpenPastSession}
          onRefresh={onRefreshPastSessions}
        />
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
