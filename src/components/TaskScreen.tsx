import React, { useState } from "react";
import type { TabSession } from "../hooks/useSessionManager";
import type { PastSession } from "../session-parser";
import type { TaskMeta } from "../settings";
import {
  buildTaskList,
  groupTasks,
  type BoardTask,
  type TaskState,
} from "../task-state";

interface TaskScreenProps {
  tabs: TabSession[];
  pastSessions: PastSession[];
  tasks: Record<string, TaskMeta>;
  onOpenTask: (task: BoardTask) => void;
  onCloseTask: (task: BoardTask) => void;
  onCloseAllTasks: (tasks: BoardTask[]) => void;
  onTogglePin: (task: BoardTask) => void;
  onRenameTask: (task: BoardTask, title: string) => void;
}

const PILL_LABEL: Partial<Record<TaskState, string>> = {
  working: "Working",
  "needs-attention": "Needs attention",
  "needs-response": "Waiting on response",
  closed: "Closed",
};

const PAGE = 30;

function relativeTime(ms: number): string {
  if (!ms || Number.isNaN(ms)) return "";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// A real pin (Lucide "pin").
const PinIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </svg>
);
const DoneIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="6" />
    <path d="M5.5 8l1.8 1.8L11 6" />
  </svg>
);

function TaskCard({
  task,
  onOpen,
  onClose,
  onPin,
  onRename,
}: {
  task: BoardTask;
  onOpen: () => void;
  onClose: () => void;
  onPin: () => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);

  const commit = () => {
    const v = value.trim();
    if (v && v !== task.title) onRename(v);
    setEditing(false);
  };

  return (
    <div
      className={`hyo-ts-card hyo-ts-${task.state}${task.pinned ? " hyo-ts-pinned" : ""}`}
      onClick={() => !editing && onOpen()}
      title={task.isOpen ? "Switch to this conversation" : "Open as a tab"}
    >
      <div className="hyo-ts-card-top">
        <div className="hyo-ts-title">
          {task.pinned && (
            <span className="hyo-ts-pin-mark">
              <PinIcon />
            </span>
          )}
          {editing ? (
            <input
              className="hyo-ts-rename"
              value={value}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setValue(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                else if (e.key === "Escape") {
                  setValue(task.title);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span
              className="hyo-ts-title-text"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setValue(task.title);
                setEditing(true);
              }}
              title="Double-click to rename"
            >
              {task.title}
            </span>
          )}
        </div>
        {PILL_LABEL[task.state] && (
          <span className={`hyo-ts-pill hyo-ts-pill-${task.state}`}>
            {task.state === "working" && <span className="hyo-ts-livedot" />}
            {PILL_LABEL[task.state]}
          </span>
        )}
      </div>

      {task.peek && <div className="hyo-ts-peek">{task.peek}</div>}

      <div className="hyo-ts-card-foot">
        <span className="hyo-ts-time">
          {task.isOpen && <span className="hyo-ts-openmark">Open</span>}
          {relativeTime(task.lastActive)}
        </span>
      </div>

      <span className="hyo-ts-actions">
        <button
          className={`hyo-ts-act${task.pinned ? " hyo-ts-act-on" : ""}`}
          title={task.pinned ? "Unpin" : "Pin to top"}
          onClick={(e) => {
            e.stopPropagation();
            onPin();
          }}
        >
          <PinIcon />
        </button>
        {!task.closed && (
          <button
            className="hyo-ts-act"
            title="Mark done — keeps it in the list"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            <DoneIcon />
          </button>
        )}
      </span>
    </div>
  );
}

export function TaskScreen({
  tabs,
  pastSessions,
  tasks,
  onOpenTask,
  onCloseTask,
  onCloseAllTasks,
  onTogglePin,
  onRenameTask,
}: TaskScreenProps) {
  const [filter, setFilter] = useState<TaskState | "all">("all");
  const [visible, setVisible] = useState(PAGE);
  // Closing a whole board at once asks for the click twice, since it touches
  // conversations that are scrolled out of sight.
  const [confirmingCloseAll, setConfirmingCloseAll] = useState(false);

  const all = buildTaskList(tabs, pastSessions, tasks);
  const count = (s: TaskState) => all.filter((t) => t.state === s).length;
  // "All" means current — closed conversations only show under the Closed filter.
  const current = all.filter((t) => t.state !== "closed");

  // Always show every filter, even at zero — a stable, predictable bar.
  const FILTERS: { key: TaskState; label: string }[] = [
    { key: "needs-attention", label: "Needs attention" },
    { key: "needs-response", label: "Waiting on response" },
    { key: "working", label: "Working" },
    { key: "closed", label: "Closed" },
  ];

  const filtered =
    filter === "all"
      ? current
      : filter === "closed"
      ? all.filter((t) => t.state === "closed")
      : current.filter((t) => t.state === filter);
  const shown = filtered.slice(0, visible);
  const groups = groupTasks(shown);
  const hasMore = filtered.length > visible;
  // "Close all" acts on what the current filter is showing, not just the page
  // that's been scrolled into view. Nothing to close under the Closed filter.
  const closable = filter === "closed" ? [] : filtered;

  return (
    <div className="hyo-ts-screen">
      <div className="hyo-ts-filters">
        <button
          className={`hyo-ts-filter${filter === "all" ? " hyo-ts-filter-on" : ""}`}
          onClick={() => {
            setFilter("all");
            setVisible(PAGE);
          }}
        >
          All
        </button>
        {FILTERS.map((f) => {
          const n = count(f.key);
          return (
            <button
              key={f.key}
              className={`hyo-ts-filter hyo-ts-filter-${f.key}${filter === f.key ? " hyo-ts-filter-on" : ""}${n === 0 ? " hyo-ts-filter-empty" : ""}`}
              onClick={() => {
                setFilter(f.key);
                setVisible(PAGE);
              }}
            >
              {f.label}
              <span className="hyo-ts-filter-count">{n}</span>
            </button>
          );
        })}
      </div>
      {closable.length > 0 && (
        // Its own row rather than a chip in the filter bar, which scrolls
        // sideways — on a narrow panel this is the one control that has to be
        // visible without hunting for it.
        <div className="hyo-ts-bulk">
          <button
            className={`hyo-ts-closeall${confirmingCloseAll ? " hyo-ts-closeall-confirm" : ""}`}
            onClick={() => {
              if (!confirmingCloseAll) {
                setConfirmingCloseAll(true);
                return;
              }
              onCloseAllTasks(closable);
              setConfirmingCloseAll(false);
            }}
            onBlur={() => setConfirmingCloseAll(false)}
          >
            {confirmingCloseAll
              ? `Close ${closable.length}? Tap again`
              : "Close all"}
          </button>
        </div>
      )}
      <div className="hyo-ts-list">
        {filtered.length === 0 ? (
          <div className="hyo-ts-empty">Nothing here.</div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="hyo-ts-group-block">
              <div className="hyo-ts-group">{group.label}</div>
              {group.tasks.map((task) => (
                <TaskCard
                  key={task.key}
                  task={task}
                  onOpen={() => onOpenTask(task)}
                  onClose={() => onCloseTask(task)}
                  onPin={() => onTogglePin(task)}
                  onRename={(title) => onRenameTask(task, title)}
                />
              ))}
            </div>
          ))
        )}

        {hasMore && (
          <button
            className="hyo-ts-loadmore"
            onClick={() => setVisible((v) => v + PAGE)}
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
