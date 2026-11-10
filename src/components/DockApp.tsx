import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { App } from "obsidian";
import type HyoPlugin from "../main";
import { ChatPanel } from "./ChatPanel";
import { useSessionManager } from "../hooks/useSessionManager";
import { resolveWorkingDirectory } from "../working-directory";
import { DEFAULT_EFFORT } from "../models";
import { mainChatOn } from "../main-chat";
import { dockItems, overallState, type DockItem } from "../dock-state";

interface DockAppProps {
  app: App;
  plugin: HyoPlugin;
}

// The dock (see dock.ts): the open conversations down the edge of the window,
// each with a dot for its state, and a pop-up to carry one on over whatever
// note is open. It's one more view of the same conversations the side panel
// and the phone show: it has its own session manager, like a second panel,
// and every view of a conversation hears every message (session-owner.ts).
export function DockApp({ app, plugin }: DockAppProps) {
  const [settingsVersion, setSettingsVersion] = useState(0);
  useEffect(() => {
    const handler = () => setSettingsVersion((v) => v + 1);
    window.addEventListener("hyo-settings-changed", handler);
    return () => window.removeEventListener("hyo-settings-changed", handler);
  }, []);

  const s = plugin.settings;
  const vaultPath = (app.vault.adapter as any).basePath as string;
  const cwd = resolveWorkingDirectory(s.workingDirectory, vaultPath);

  const onMainChatSession = useCallback(
    (sessionId: string) => {
      if (plugin.settings.mainChatSessionId === sessionId) return;
      plugin.settings.mainChatSessionId = sessionId;
      void plugin.saveSettings();
    },
    [plugin]
  );

  const sm = useSessionManager({
    cliPath: s.cliPath,
    cwd,
    model: s.model,
    effort: s.effortLevel || DEFAULT_EFFORT,
    permissionMode: s.permissionMode,
    defaultAgent: s.defaultAgent || "",
    maxOutputTokens: s.maxOutputTokens,
    autoGenerateTitles: s.autoGenerateTitles,
    settingsVersion,
    voiceEngine: s.voiceEngine,
    mainChat: mainChatOn(s),
    mainChatSessionId: s.mainChatSessionId || "",
    onMainChatSession,
    deskKey: `hyo-dock-tabs:${cwd}`,
  });

  const [open, setOpen] = useState(false);
  const items = useMemo(() => dockItems(sm.tabs, open ? sm.activeTabId : null), [sm.tabs, sm.activeTabId, open]);
  const active = items.find((i) => i.tabId === sm.activeTabId) || null;
  const side = s.dockSide === "left" ? "left" : "right";
  const collapsed = !!s.dockCollapsed;

  const popRef = useRef<HTMLDivElement>(null);
  // Escape tucks the pop-up away when you're in it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && popRef.current?.contains(e.target as Node)) {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  // The open conversation went away (closed in the panel or on the phone).
  useEffect(() => {
    if (open && !active) setOpen(false);
  }, [open, active]);

  const choose = (item: DockItem) => {
    if (open && sm.activeTabId === item.tabId) {
      setOpen(false);
      return;
    }
    sm.switchTab(item.tabId);
    setOpen(true);
  };

  const startNew = () => {
    // Reuse a blank chat already waiting here rather than piling them up.
    const blank = sm.tabs.find((t) => !t.isMain && !t.cliSessionId && t.messages.length === 0);
    if (blank) sm.switchTab(blank.id);
    else sm.newTab();
    setOpen(true);
  };

  const setCollapsed = async (value: boolean) => {
    plugin.settings.dockCollapsed = value;
    if (value) setOpen(false);
    await plugin.saveSettings();
  };

  const openInPanel = () => {
    if (!active?.sessionId) return;
    setOpen(false);
    void plugin.openInPanel(active.sessionId);
  };

  if (!s.cliPath) return null;

  if (collapsed) {
    const overall = overallState(items);
    return (
      <div className={`hyo-dock hyo-dock-${side} hyo-dock-collapsed`}>
        <button
          className="hyo-dock-handle"
          aria-label="Show the dock"
          onClick={() => void setCollapsed(false)}
        >
          <Chevron pointing={side === "right" ? "left" : "right"} />
          {overall !== "idle" && <span className={`hyo-dock-dot hyo-dock-dot-${overall}`} />}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className={`hyo-dock hyo-dock-${side}`}>
        {items.map((item) => (
          <button
            key={item.tabId}
            className={`hyo-dock-item hyo-dock-tone-${item.tone}${open && item.tabId === sm.activeTabId ? " is-active" : ""}`}
            onClick={() => choose(item)}
          >
            {item.letter}
            {item.state !== "idle" && <span className={`hyo-dock-dot hyo-dock-dot-${item.state}`} />}
            <span className="hyo-dock-tip">
              <span className="hyo-dock-tip-title">{item.title}</span>
              {item.status && <span className={`hyo-dock-tip-status hyo-dock-tip-${item.state}`}>{item.status}</span>}
            </span>
          </button>
        ))}
        {items.length > 0 && <span className="hyo-dock-sep" />}
        <button className="hyo-dock-icon" onClick={startNew}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span className="hyo-dock-tip">
            <span className="hyo-dock-tip-title">New conversation</span>
          </span>
        </button>
        <button className="hyo-dock-icon hyo-dock-tuck" onClick={() => void setCollapsed(true)}>
          <Chevron pointing={side} />
          <span className="hyo-dock-tip">
            <span className="hyo-dock-tip-title">Hide the dock</span>
          </span>
        </button>
      </div>

      {/* Kept mounted while hidden, so a half-written message survives closing it. */}
      {active && (
        <div className={`hyo-dock-pop hyo-dock-pop-${side}${open ? "" : " is-hidden"}`} ref={popRef}>
          <div className="hyo-dock-pop-head">
            <span className={`hyo-dock-item hyo-dock-pop-icon hyo-dock-tone-${active.tone}`}>{active.letter}</span>
            <div className="hyo-dock-pop-who">
              <div className="hyo-dock-pop-title">{active.title}</div>
              {active.status && <div className={`hyo-dock-pop-status hyo-dock-tip-${active.state}`}>{active.status}</div>}
            </div>
            {active.sessionId && (
              <button className="hyo-dock-icon" onClick={openInPanel} aria-label="Open in the Hyo panel">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="M15 4v16" />
                </svg>
              </button>
            )}
            <button className="hyo-dock-icon" onClick={() => setOpen(false)} aria-label="Close">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div className="hyo-plugin hyo-dock-pop-body">
            <div className="hyo-app">
              <ChatPanel sessionManager={sm} plugin={plugin} app={app} variant="popup" />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Chevron({ pointing }: { pointing: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d={pointing === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}
