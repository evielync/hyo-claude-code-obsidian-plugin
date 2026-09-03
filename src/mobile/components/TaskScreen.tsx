import React, { useState, useEffect } from "react";
import type { TabSession } from "../hooks/useSessionManager";
import type { PastSession } from "../session-parser";
import type { TaskMeta } from "../../settings";
import {
  buildTaskList,
  groupTasks,
  type BoardTask,
  type TaskState,
} from "../task-state";
import { GatewayClient, type ConnectionStatus } from "../gateway-client";

interface TaskScreenProps {
  tabs: TabSession[];
  pastSessions: PastSession[];
  tasks: Record<string, TaskMeta>;
  onOpenTask: (task: BoardTask) => void;
  onCloseTask: (task: BoardTask) => void;
  onTogglePin: (task: BoardTask) => void;
  onRenameTask: (task: BoardTask, title: string) => void;
  // Full-text search: session id → the matched line. Debounced by the screen.
  onSearchText?: (query: string) => Promise<Record<string, string>>;
  // Re-ask the gateway for the session list. Sessions started on the desktop
  // only appear on the phone once the list is fetched again.
  onRefresh?: () => void;
  // Search and refresh both go through the gateway, so the bar only shows
  // while it's connected.
  gatewayUrl?: string;
}

function useGatewayStatus(gatewayUrl: string | undefined): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  useEffect(() => {
    if (!gatewayUrl) {
      setStatus("disconnected");
      return;
    }
    const client = GatewayClient.get(gatewayUrl);
    setStatus(client.getStatus());
    return client.onStatusChange(setStatus);
  }, [gatewayUrl]);
  return status;
}

// A search matches on the title and the peek instantly; with full text on, a
// hit inside the conversation also counts and its line replaces the peek.
function matchesQuery(
  task: BoardTask,
  needle: string,
  textHits: Record<string, string>
): boolean {
  if (!needle) return true;
  if (task.title.toLowerCase().includes(needle)) return true;
  if (task.peek.toLowerCase().includes(needle)) return true;
  return !!(task.cliSessionId && textHits[task.cliSessionId]);
}

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </svg>
);
const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M13.5 2.5v3h-3" />
  </svg>
);

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
  onTogglePin,
  onRenameTask,
  onSearchText,
  onRefresh,
  gatewayUrl,
}: TaskScreenProps) {
  const [filter, setFilter] = useState<TaskState | "all">("all");
  const [visible, setVisible] = useState(PAGE);
  const [query, setQuery] = useState("");
  const [fullText, setFullText] = useState(false);
  const [textHits, setTextHits] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const showSearch = useGatewayStatus(gatewayUrl) === "connected";
  const needle = query.trim().toLowerCase();

  // Full-text search runs after typing pauses, and a stale answer never lands
  // over a newer query.
  useEffect(() => {
    if (!fullText || !needle || !onSearchText) {
      setTextHits({});
      setSearching(false);
      return;
    }
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      onSearchText(query)
        .then((hits) => {
          if (!live) return;
          setTextHits(hits || {});
          setSearching(false);
        })
        .catch((e) => {
          console.error("[hyo] history search failed:", e);
          if (!live) return;
          setTextHits({});
          setSearching(false);
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, needle, fullText, onSearchText]);

  // The list fetch has no completion signal, so the spinner runs for a beat —
  // long enough to show the tap landed.
  const handleRefresh = () => {
    if (!onRefresh) return;
    setRefreshing(true);
    onRefresh();
    setTimeout(() => setRefreshing(false), 800);
  };

  const allTasks = buildTaskList(tabs, pastSessions, tasks);
  // While searching, a hit's matched line stands in for the peek so you can
  // see why it matched. Searching also reaches closed conversations.
  const all = needle
    ? allTasks
        .filter((t) => matchesQuery(t, needle, textHits))
        .map((t) => {
          const hit = t.cliSessionId ? textHits[t.cliSessionId] : "";
          return hit && !t.title.toLowerCase().includes(needle) ? { ...t, peek: hit } : t;
        })
    : allTasks;
  const count = (s: TaskState) => all.filter((t) => t.state === s).length;
  // "All" means current — closed conversations only show under the Closed
  // filter, unless a search is on, when everything that matches is shown.
  const current = needle ? all : all.filter((t) => t.state !== "closed");

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

  return (
    <div className="hyo-ts-screen">
      {showSearch && (
        <div className="hyo-ts-search">
          <label className="hyo-ts-search-field">
            <SearchIcon />
            <input
              className="hyo-ts-search-input"
              type="text"
              placeholder={fullText ? "Search conversations…" : "Search titles…"}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setVisible(PAGE);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
            />
            {query && (
              <button
                className="hyo-ts-search-clear"
                title="Clear"
                onClick={() => setQuery("")}
              >
                ×
              </button>
            )}
          </label>
          {onSearchText && (
            <span
              className={`hyo-ts-search-mode${fullText ? " hyo-ts-search-mode-on" : ""}`}
              title={fullText ? "Searching inside conversations" : "Titles only — switch on to search inside conversations"}
              onClick={() => setFullText((v) => !v)}
            >
              <span>Full text</span>
              <div className={`checkbox-container${fullText ? " is-enabled" : ""}`}>
                <input type="checkbox" checked={fullText} readOnly tabIndex={-1} />
              </div>
            </span>
          )}
          {onRefresh && (
            <button
              className={`hyo-ts-refresh${refreshing ? " hyo-ts-refresh-busy" : ""}`}
              title="Refresh — pick up conversations started on the desktop"
              onClick={handleRefresh}
            >
              <RefreshIcon />
            </button>
          )}
        </div>
      )}
      {searching && <div className="hyo-ts-searching">Searching inside conversations…</div>}
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
      <div className="hyo-ts-list">
        {filtered.length === 0 ? (
          <div className="hyo-ts-empty">
            {needle
              ? fullText
                ? searching
                  ? "Searching…"
                  : "No conversations mention that."
                : "No titles match. Try Full text to search inside conversations."
              : "Nothing here."}
          </div>
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
