import React, { useState, useRef, useEffect, useCallback } from "react";
import { hasRunningJobs, type JobMap } from "../background-jobs";
import { HistoryList, relativeTime, type HistoryTask } from "./HistoryList";
import { ChevronIcon, CloseIcon, PencilIcon, PinIcon, PlusIcon } from "./switcher-icons";

// The conversation bar and its panel, shared by desktop and phone.
//
// The bar is one button: the conversation you're in, how many are open, and a
// red dot when another one is waiting on you. Beside it, Close (the one
// you're in, unless it's pinned) and New conversation.
// Tapping the button opens a panel with two sides: Open (the conversations in
// play: Main chat first, then the pinned ones, then the rest) and History
// (everything else, searchable).
//
// A pinned conversation is always open, on every device, so its row has no
// close button: the filled pin sits there instead, and tapping it unpins
// (the conversation stays open, with its close button back).

// What the switcher reads from a task. Both platforms' BoardTask fit it.
export interface SwitcherTask extends HistoryTask {
  tabId: string | null;
  live: { isMain?: boolean; generating: boolean; jobs?: JobMap } | null;
}

type Dot = "working" | "waiting" | "idle";

// Waiting on you wins over working: the process is still technically running
// while it holds a question for you. Background jobs still running count as
// working, after the reply is in too.
function dotFor(task: SwitcherTask | undefined): Dot {
  if (!task) return "idle";
  if (task.state === "needs-attention") return "waiting";
  if (task.live && (task.live.generating || hasRunningJobs(task.live.jobs))) return "working";
  if (task.state === "working") return "working";
  return "idle";
}

interface ConversationSwitcherProps<T extends SwitcherTask> {
  // Every conversation, live and past (buildTaskList's output).
  tasks: T[];
  // The open conversations' tab ids, in tab order. Main chat is first.
  tabIds: string[];
  activeTabId: string;
  // Desktop has the bar at the top of the view, the phone at the bottom, and
  // the panel opens from that edge.
  placement: "top" | "bottom";
  // Drawn at the left of the bar (the phone's gateway connection dot).
  leading?: React.ReactNode;
  // Swipe an Open row left to close it (phone).
  swipeToClose?: boolean;
  onSwitch: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onRename: (tabId: string, title: string) => void;
  onNew: () => void;
  onOpenTask: (task: T) => void;
  // Pin or unpin an Open row.
  onTogglePin: (task: T) => void;
  // Runs each time the panel opens, so History is fresh.
  onPanelOpen?: () => void;
  onSearchText?: (query: string) => Promise<Record<string, string>>;
  onRefresh?: () => void;
  refreshTitle?: string;
  searchAvailable?: boolean;
}

export function ConversationSwitcher<T extends SwitcherTask>({
  tasks,
  tabIds,
  activeTabId,
  placement,
  leading,
  swipeToClose = false,
  onSwitch,
  onClose,
  onRename,
  onNew,
  onOpenTask,
  onTogglePin,
  onPanelOpen,
  onSearchText,
  onRefresh,
  refreshTitle,
  searchAvailable,
}: ConversationSwitcherProps<T>) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [side, setSide] = useState<"open" | "history">("open");
  const closeTimer = useRef<number | null>(null);

  const byTab = new Map<string, T>();
  for (const t of tasks) if (t.tabId) byTab.set(t.tabId, t);
  const openTasks = tabIds.map((id) => byTab.get(id)).filter((t): t is T => !!t);
  const current = byTab.get(activeTabId);
  const waitingElsewhere = tasks.some((t) => t.tabId !== activeTabId && t.state === "needs-attention");
  const historyWaiting = tasks.filter((t) => !t.isOpen && t.state === "needs-attention").length;

  const openPanel = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setClosing(false);
    setSide("open");
    setPanelOpen(true);
    onPanelOpen?.();
  };

  // The panel slides away before it unmounts.
  const closePanel = useCallback(() => {
    if (closeTimer.current !== null) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setPanelOpen(false);
      setClosing(false);
    }, 180);
  }, []);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    []
  );

  // Escape closes the panel (inputs inside it handle their own Escape first).
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelOpen, closePanel]);

  const currentDot = dotFor(current);
  const currentTitle = current?.title || "New conversation";
  const openCount = openTasks.length;

  return (
    <>
      <div className={`hyo-cs-bar hyo-cs-bar-${placement}`}>
        {leading}
        <button
          className="hyo-cs-current"
          onClick={() => (panelOpen ? closePanel() : openPanel())}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          title="Your conversations"
        >
          <span className={`hyo-cs-dot hyo-cs-dot-${currentDot}`} />
          <span className="hyo-cs-current-title">{currentTitle}</span>
          <span
            className="hyo-cs-count"
            title={
              waitingElsewhere
                ? `${openCount} open · another conversation is waiting on you`
                : `${openCount} open`
            }
          >
            {waitingElsewhere && <span className="hyo-cs-dot hyo-cs-dot-waiting" />}
            {openCount}
          </span>
          <span className="hyo-cs-chevron">
            <ChevronIcon up={placement === "bottom"} />
          </span>
        </button>
        {current && !current.live?.isMain && !current.pinned && (
          <button
            className="hyo-cs-iconbtn hyo-cs-close-current"
            onClick={() => onClose(current.tabId!)}
            title="Close this conversation"
            aria-label="Close this conversation"
          >
            <CloseIcon />
          </button>
        )}
        <button className="hyo-cs-iconbtn hyo-cs-new" onClick={onNew} title="New conversation" aria-label="New conversation">
          <PlusIcon />
        </button>
      </div>

      {panelOpen && (
        <div className={`hyo-cs-overlay hyo-cs-overlay-${placement}${closing ? " hyo-cs-closing" : ""}`}>
          <div className="hyo-cs-scrim" onClick={closePanel} />
          <div className={`hyo-cs-sheet hyo-cs-sheet-${side}`} role="dialog" aria-label="Conversations">
            {placement === "bottom" && <div className="hyo-cs-grab" />}
            <div className="hyo-cs-seg-row">
              <div className="hyo-cs-seg" role="tablist">
                <button
                  role="tab"
                  aria-selected={side === "open"}
                  className={`hyo-cs-seg-btn${side === "open" ? " is-on" : ""}`}
                  onClick={() => setSide("open")}
                >
                  Open <span className="hyo-cs-n">{openCount}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={side === "history"}
                  className={`hyo-cs-seg-btn${side === "history" ? " is-on" : ""}`}
                  onClick={() => setSide("history")}
                >
                  History
                  {historyWaiting > 0 && <span className="hyo-cs-n hyo-cs-n-red">{historyWaiting}</span>}
                </button>
              </div>
              <button className="hyo-cs-done" onClick={closePanel}>
                Done
              </button>
            </div>

            {side === "open" ? (
              <div className="hyo-cs-view">
                <div className="hyo-cs-list">
                  {openTasks.map((task) => (
                    <OpenRow
                      key={task.tabId!}
                      task={task}
                      active={task.tabId === activeTabId}
                      swipeToClose={swipeToClose}
                      onSelect={() => {
                        onSwitch(task.tabId!);
                        closePanel();
                      }}
                      onClose={() => onClose(task.tabId!)}
                      onRename={(title) => onRename(task.tabId!, title)}
                      onTogglePin={() => onTogglePin(task)}
                    />
                  ))}
                </div>
                <div className="hyo-cs-foot">
                  <button
                    className="hyo-cs-newbtn"
                    onClick={() => {
                      onNew();
                      closePanel();
                    }}
                  >
                    + New conversation
                  </button>
                </div>
              </div>
            ) : (
              <div className="hyo-cs-view">
                <HistoryList
                  tasks={tasks}
                  onOpenTask={(task) => {
                    onOpenTask(task);
                    closePanel();
                  }}
                  onSearchText={onSearchText}
                  onRefresh={onRefresh}
                  refreshTitle={refreshTitle}
                  searchAvailable={searchAvailable}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// How far a row has to travel left before letting go closes it.
const SWIPE_CLOSE_PX = 70;

function OpenRow({
  task,
  active,
  swipeToClose,
  onSelect,
  onClose,
  onRename,
  onTogglePin,
}: {
  task: SwitcherTask;
  active: boolean;
  swipeToClose: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
  onTogglePin: () => void;
}) {
  const isMain = !!task.live?.isMain;
  const pinned = !isMain && task.pinned;
  // Pinning is kept with the conversation, so a new one can be pinned once
  // it has started.
  const canPin = !isMain && !!task.cliSessionId;
  const dot = dotFor(task);
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(task.title);
  const cancelRename = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) {
      // Without preventScroll the browser scrolls the clipped panel to show
      // the box, which shifts the whole view up.
      inputRef.current.focus({ preventScroll: true });
      inputRef.current.select();
    }
  }, [renaming]);

  const startRename = () => {
    cancelRename.current = false;
    setValue(task.title);
    setRenaming(true);
  };

  // Enter and blur commit, Escape drops the edit.
  const commitRename = () => {
    if (!cancelRename.current) {
      const v = value.trim();
      if (v && v !== task.title) onRename(v);
    }
    cancelRename.current = false;
    setRenaming(false);
  };

  // Swipe left to close. Only a clearly sideways drag counts, so scrolling
  // the list never closes anything; the click a swipe ends with is dropped.
  const [dx, setDx] = useState(0);
  const [settling, setSettling] = useState(false);
  const drag = useRef<{ x: number; y: number; id: number; sideways: boolean } | null>(null);
  const swallowClick = useRef(false);
  const canSwipe = swipeToClose && !isMain && !pinned && !renaming;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canSwipe || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, sideways: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (!d.sideways) {
      if (Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) {
        d.sideways = true;
        setSettling(false);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* capture is a nicety; the drag still works without it */
        }
      } else if (Math.abs(my) > 8) {
        drag.current = null;
        return;
      } else return;
    }
    setDx(Math.min(0, mx));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.sideways) return;
    swallowClick.current = true;
    window.setTimeout(() => (swallowClick.current = false), 0);
    setSettling(true);
    const width = e.currentTarget.offsetWidth || 400;
    if (dx < -SWIPE_CLOSE_PX && e.type === "pointerup") {
      setDx(-width);
      // If closing is called off (background jobs still running), the row
      // slides back.
      window.setTimeout(() => {
        onClose();
        setDx(0);
      }, 180);
    } else {
      setDx(0);
    }
  };

  const meta =
    dot === "waiting" ? (
      <>
        <b className="hyo-cs-meta-waiting">Waiting on you</b> · {relativeTime(task.lastActive)}
      </>
    ) : dot === "working" ? (
      <>
        <span className="hyo-cs-meta-working">Working</span> · {relativeTime(task.lastActive)}
      </>
    ) : (
      relativeTime(task.lastActive)
    );

  return (
    <div className="hyo-cs-row-wrap">
      {canSwipe && dx < 0 && <div className="hyo-cs-row-del">Close</div>}
      <div
        className={`hyo-cs-row${active ? " is-active" : ""}${pinned ? " is-pinned" : ""}${settling ? " is-settling" : ""}${canSwipe ? " can-swipe" : ""}`}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        onClick={() => {
          if (swallowClick.current || renaming) return;
          onSelect();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // While a row is being dragged sideways, Obsidian's drawer swipe
        // shouldn't also see the gesture.
        onTouchMove={(e) => {
          if (drag.current?.sideways) e.stopPropagation();
        }}
        aria-current={active ? "true" : undefined}
      >
        <span className="hyo-cs-row-dot">
          <span className={`hyo-cs-dot hyo-cs-dot-${dot}`} />
        </span>
        <div className="hyo-cs-row-body">
          {renaming ? (
            <input
              ref={inputRef}
              className="hyo-cs-rename-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelRename.current = true;
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          ) : (
            <div className="hyo-cs-row-title">{task.title}</div>
          )}
          {task.peek && <div className="hyo-cs-row-peek">{task.peek}</div>}
          <div className="hyo-cs-row-meta">{meta}</div>
        </div>
        {!isMain && (
          <div className="hyo-cs-row-actions">
            {canPin && !pinned && (
              <button
                className="hyo-cs-iconbtn hyo-cs-row-btn hyo-cs-pin"
                title="Pin: keep it open and at the top"
                aria-label="Pin"
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                }}
              >
                <PinIcon size={16} />
              </button>
            )}
            <button
              className="hyo-cs-iconbtn hyo-cs-row-btn"
              title="Rename"
              aria-label="Rename"
              onClick={(e) => {
                e.stopPropagation();
                if (renaming) inputRef.current?.blur();
                else startRename();
              }}
              // Keep the input focused when the pencil is pressed again, so
              // the blur doesn't commit and reopen in one go.
              onPointerDown={(e) => {
                if (renaming) e.preventDefault();
              }}
            >
              <PencilIcon />
            </button>
            {pinned ? (
              <button
                className="hyo-cs-iconbtn hyo-cs-row-btn hyo-cs-pin is-on"
                title="Unpin"
                aria-label="Unpin"
                aria-pressed="true"
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                }}
              >
                <PinIcon filled size={16} />
              </button>
            ) : (
              <button
                className="hyo-cs-iconbtn hyo-cs-row-btn"
                title="Close"
                aria-label="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
              >
                <CloseIcon />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
