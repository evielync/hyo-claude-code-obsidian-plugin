import React, { useState, useRef, useEffect } from "react";
import type { TabSession } from "../hooks/useSessionManager";
import type { PastSession } from "../session-parser";
import type { TaskMeta } from "../settings";
import { buildTaskList } from "../task-state";

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
  onReorder: (draggedId: string, targetId: string, after: boolean) => void;
  pastSessions: PastSession[];
  tasks: Record<string, TaskMeta>;
  onOpenTaskScreen: () => void;
  taskMode?: boolean;
  onRefreshPastSessions: () => void;
  onNewTab: () => void;
}

export function ChatTabs({
  tabs,
  activeTabId,
  onSwitch,
  onClose,
  onRename,
  onReorder,
  pastSessions,
  tasks,
  onOpenTaskScreen,
  taskMode,
  onRefreshPastSessions,
  onNewTab,
}: ChatTabsProps) {
  // Badge only the loud state — something is actually blocked on you. Waiting-on-
  // response is a backlog, not an alert, so it doesn't earn a badge.
  const needsYouCount = buildTaskList(tabs, pastSessions, tasks).filter(
    (t) => t.state === "needs-attention"
  ).length;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renamingId]);

  // A mouse wheel only reports vertical movement, so the tab strip translates it
  // into horizontal scrolling — the same way VS Code lets you wheel through tabs.
  // Registered natively rather than via onWheel because React's wheel listener is
  // passive, which would make preventDefault a no-op and let the scroll leak out
  // to whatever is behind the tab bar.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;

    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey) return; // shift+wheel is already horizontal
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) return;
      if (strip.scrollWidth <= strip.clientWidth) return; // nothing to scroll
      strip.scrollLeft += delta;
      e.preventDefault();
    };

    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

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

  // Which side of the hovered tab the dragged tab will land on, so the drop
  // indicator sits where the tab is actually going.
  const dropSide = (e: React.DragEvent, id: string) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    setDropTarget((prev) =>
      prev && prev.id === id && prev.after === after ? prev : { id, after }
    );
  };

  const endDrag = () => {
    setDraggingId(null);
    setDropTarget(null);
  };

  return (
    <div className="hyo-tabs">
      <div className="hyo-tabs-left" ref={stripRef}>
        {tabs.map((tab) => {
          const awaiting = tabAwaitingInput(tab);
          const indicator =
            dropTarget?.id === tab.id && draggingId && draggingId !== tab.id
              ? dropTarget.after
                ? " hyo-tab-drop-after"
                : " hyo-tab-drop-before"
              : "";
          return (
          <div
            key={tab.id}
            className={`hyo-tab ${tab.id === activeTabId ? "hyo-tab-active" : ""}${
              draggingId === tab.id ? " hyo-tab-dragging" : ""
            }${indicator}`}
            draggable={renamingId !== tab.id}
            onDragStart={(e) => {
              e.stopPropagation();
              setDraggingId(tab.id);
              e.dataTransfer.effectAllowed = "move";
              // Firefox refuses to start a drag without payload; the id also
              // marks this as a tab drag rather than a file drop.
              e.dataTransfer.setData("application/x-hyo-tab", tab.id);
            }}
            onDragOver={(e) => {
              if (!draggingId) return; // let file drops fall through to the panel
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              dropSide(e, tab.id);
            }}
            onDrop={(e) => {
              if (!draggingId) return;
              e.preventDefault();
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onReorder(draggingId, tab.id, e.clientX > rect.left + rect.width / 2);
              endDrag();
            }}
            onDragEnd={endDrag}
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
            // Chat bubble — click to return to the conversation.
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 9.5a2 2 0 0 1-2 2H6l-3.5 2.5V4a2 2 0 0 1 2-2h7.5a2 2 0 0 1 2 2z" />
            </svg>
          ) : (
            // Clock — click to open history.
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
