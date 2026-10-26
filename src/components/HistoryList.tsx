import React, { useState, useEffect } from "react";
import { groupTasks, type TaskState } from "../task-state";
import { RefreshIcon, SearchIcon } from "./switcher-icons";

// The History side of the conversation panel, shared by desktop and phone.
// History is everything that isn't open right now. A search reaches open
// conversations too (marked "Open"), so one search box finds anything.
// Pinned conversations are always open, so they only show here in a search.

// The fields History reads from a task. Both platforms' BoardTask fit it.
export interface HistoryTask {
  key: string;
  cliSessionId: string | null;
  title: string;
  peek: string;
  state: TaskState;
  isOpen: boolean;
  pinned: boolean;
  lastActive: number;
}

interface HistoryListProps<T extends HistoryTask> {
  tasks: T[];
  onOpenTask: (task: T) => void;
  // Full-text search: session id → the matched line. Debounced here.
  onSearchText?: (query: string) => Promise<Record<string, string>>;
  // Re-read past sessions, to pick up conversations started elsewhere.
  onRefresh?: () => void;
  refreshTitle?: string;
  // The phone searches and refreshes through the gateway, so it hides the
  // search bar while the gateway is down.
  searchAvailable?: boolean;
}

const PAGE = 30;

// A search matches on the title and the peek instantly; with full text on, a
// hit inside the conversation also counts and its line replaces the peek.
function matchesQuery(task: HistoryTask, needle: string, textHits: Record<string, string>): boolean {
  if (!needle) return true;
  if (task.title.toLowerCase().includes(needle)) return true;
  if (task.peek.toLowerCase().includes(needle)) return true;
  return !!(task.cliSessionId && textHits[task.cliSessionId]);
}

export function relativeTime(ms: number): string {
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

export function HistoryList<T extends HistoryTask>({
  tasks,
  onOpenTask,
  onSearchText,
  onRefresh,
  refreshTitle = "Refresh — pick up conversations started elsewhere",
  searchAvailable = true,
}: HistoryListProps<T>) {
  const [visible, setVisible] = useState(PAGE);
  const [query, setQuery] = useState("");
  const [fullText, setFullText] = useState(false);
  const [textHits, setTextHits] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const needle = query.trim().toLowerCase();

  // The list fetch has no completion signal, so the spinner runs for a beat —
  // long enough to show the tap landed.
  const handleRefresh = () => {
    if (!onRefresh) return;
    setRefreshing(true);
    onRefresh();
    setTimeout(() => setRefreshing(false), 800);
  };

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

  // Without a search, History is only what isn't open. While searching, a
  // hit's matched line stands in for the peek so you can see why it matched.
  const filtered: T[] = needle
    ? tasks
        .filter((t) => matchesQuery(t, needle, textHits))
        .map((t) => {
          const hit = t.cliSessionId ? textHits[t.cliSessionId] : "";
          return hit && !t.title.toLowerCase().includes(needle) ? { ...t, peek: hit } : t;
        })
    : tasks.filter((t) => !t.isOpen);
  const shown = filtered.slice(0, visible);
  const groups = groupTasks(shown, Date.now(), { pinnedGroup: false });
  const hasMore = filtered.length > visible;

  return (
    <div className="hyo-ts-screen">
      {searchAvailable && (
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
                if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
            />
            {query && (
              <button className="hyo-ts-search-clear" title="Clear" onClick={() => setQuery("")}>
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
              title={refreshTitle}
              aria-label="Refresh"
              onClick={handleRefresh}
            >
              <RefreshIcon />
            </button>
          )}
        </div>
      )}
      {searching && <div className="hyo-ts-searching">Searching inside conversations…</div>}
      <div className="hyo-ts-list">
        {filtered.length === 0 ? (
          <div className="hyo-ts-empty">
            {needle
              ? fullText
                ? searching
                  ? "Searching…"
                  : "No conversations mention that."
                : "No titles match. Try Full text to search inside conversations."
              : "No past conversations yet. Ones you close show up here."}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="hyo-ts-group-block">
              <div className="hyo-ts-group">{group.label}</div>
              {group.tasks.map((task) => (
                <HistoryCard key={task.key} task={task} onOpen={() => onOpenTask(task)} />
              ))}
            </div>
          ))
        )}

        {hasMore && (
          <button className="hyo-ts-loadmore" onClick={() => setVisible((v) => v + PAGE)}>
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

// One past conversation: tap to open it.
function HistoryCard({ task, onOpen }: { task: HistoryTask; onOpen: () => void }) {
  return (
    <div
      className="hyo-ts-card"
      onClick={onOpen}
      title={task.isOpen ? "Switch to this conversation" : "Open this conversation"}
    >
      <div className="hyo-ts-title">
        <span className="hyo-ts-title-text">{task.title}</span>
      </div>

      {task.peek && <div className="hyo-ts-peek">{task.peek}</div>}

      <div className="hyo-ts-card-foot">
        <span className="hyo-ts-time">
          {task.isOpen && <span className="hyo-ts-openmark">Open</span>}
          {relativeTime(task.lastActive)}
        </span>
      </div>
    </div>
  );
}
