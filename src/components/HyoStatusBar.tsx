import React, { useState, useRef, useCallback, useEffect } from "react";
import { useUsage } from "../hooks/useUsage";
import { useAgents } from "../hooks/useAgents";

interface HyoStatusBarProps {
  model: string;
  permissionMode: string;
  agent: string;
  inputTokens: number;
  onModelChange: (model: string) => void;
  onPermissionModeChange: (mode: string) => void;
  onAgentChange: (agent: string) => void;
  onCompact: () => void;
}

const MODEL_OPTIONS = [
  { id: "claude-opus-4-7", name: "Opus 4.7", context: "200K" },
  { id: "claude-opus-4-6[1m]", name: "Opus 4.6", context: "1M" },
  { id: "claude-opus-4-6", name: "Opus 4.6", context: "200K" },
  { id: "claude-sonnet-4-6[1m]", name: "Sonnet 4.6", context: "1M" },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6", context: "200K" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", context: "200K" },
];

const PERMISSION_MODES = [
  {
    id: "default",
    name: "Ask first",
    desc: "Asks before tools not in your allow list",
  },
  {
    id: "acceptEdits",
    name: "Auto-edit",
    desc: "Also auto-approves file writes and edits",
  },
  {
    id: "bypassPermissions",
    name: "Never ask",
    desc: "All tools run automatically — no prompts",
  },
];

function formatTimeAgo(date: Date): string {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  return `${mins} mins ago`;
}

function formatResetTime(isoString: string): string {
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms < 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs >= 24) {
    const days = Math.floor(hrs / 24);
    const remHrs = hrs % 24;
    return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
  }
  return `${hrs}h ${rem}m`;
}

function getContextLimit(modelId: string): number {
  return modelId.includes("[1m]") ? 1_048_576 : 200_000;
}

function formatTokens(n: number): string {
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(n);
}

export function HyoStatusBar({
  model,
  permissionMode,
  agent,
  inputTokens,
  onModelChange,
  onPermissionModeChange,
  onAgentChange,
  onCompact,
}: HyoStatusBarProps) {
  const agents = useAgents();
  const activeAgent = agents.find((a) => a.name === agent) || agents[0];
  const {
    usage,
    sessionPct,
    weeklyPct,
    sessionPacePct,
    weeklyPacePct,
    lastUpdated,
    refresh,
  } = useUsage();

  const [popup, setPopup] = useState<string | null>(null);
  const [popupBottom, setPopupBottom] = useState(0);
  const [customModel, setCustomModel] = useState("");

  const statusBarRef = useRef<HTMLDivElement>(null);
  const usageRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const permRef = useRef<HTMLButtonElement>(null);
  const agentRef = useRef<HTMLButtonElement>(null);

  // Compute fixed position whenever a popup opens
  const openPopup = useCallback((name: string) => {
    setPopup((prev) => {
      if (prev === name) return null;
      if (statusBarRef.current) {
        const rect = statusBarRef.current.getBoundingClientRect();
        setPopupBottom(window.innerHeight - rect.top + 6);
      }
      return name;
    });
  }, []);

  // Close popup on click outside — clicks pass through to their real target
  useEffect(() => {
    if (!popup) return;
    const handler = (e: MouseEvent) => {
      if (statusBarRef.current && !statusBarRef.current.contains(e.target as Node)) {
        setPopup(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [popup]);

  const togglePopup = useCallback((name: string) => {
    setPopup((prev) => (prev === name ? null : name));
  }, []);

  const closePopup = useCallback(() => setPopup(null), []);

  const selectModel = useCallback(
    (id: string) => {
      onModelChange(id);
      setPopup(null);
    },
    [onModelChange]
  );

  const selectAgent = useCallback(
    (name: string) => {
      onAgentChange(name);
      setPopup(null);
    },
    [onAgentChange]
  );

  const selectPermission = useCallback(
    (id: string) => {
      onPermissionModeChange(id);
      setPopup(null);
    },
    [onPermissionModeChange]
  );

  const modelOpt = MODEL_OPTIONS.find((m) => m.id === model);
  const modelName = modelOpt
    ? `${modelOpt.name} ${modelOpt.context}`
    : model;
  const permName =
    PERMISSION_MODES.find((m) => m.id === permissionMode)?.name ||
    permissionMode;

  const contextLimit = getContextLimit(model);
  const contextPct = inputTokens > 0 ? Math.min(100, (inputTokens / contextLimit) * 100) : 0;
  const contextBarClass = contextPct > 80 ? "danger" : contextPct > 50 ? "warning" : "";

  const sonnetPct = usage?.seven_day_sonnet
    ? Math.min(100, Math.max(0, usage.seven_day_sonnet.utilization || 0))
    : null;
  const sonnetBarClass =
    (sonnetPct ?? 0) > 80 ? "danger" : (sonnetPct ?? 0) > 50 ? "warning" : "";

  const sessionBarClass =
    sessionPct > 80 ? "danger" : sessionPct > 50 ? "warning" : "";
  const weeklyBarClass =
    weeklyPct > 80 ? "danger" : weeklyPct > 50 ? "warning" : "";

  return (
    <div className="hyo-status-bar" ref={statusBarRef}>
      <div
        ref={usageRef}
        className="hyo-usage-bars-group"
        title="Usage"
        onClick={() => openPopup("usage")}
      >
        <span className="hyo-usage-bar-label">5HR</span>
        <span className="hyo-usage-bar-track-wrap">
          <span className="hyo-usage-bar-track">
            <span
              className={`hyo-usage-bar-fill ${sessionBarClass}`}
              style={{ width: sessionPct + "%" }}
            />
          </span>
          {sessionPacePct !== null && (
            <span
              className="hyo-usage-bar-pace"
              style={{ left: sessionPacePct + "%" }}
            />
          )}
        </span>
        <span className="hyo-usage-bar-label">7D</span>
        <span className="hyo-usage-bar-track-wrap">
          <span className="hyo-usage-bar-track">
            <span
              className={`hyo-usage-bar-fill ${weeklyBarClass}`}
              style={{ width: weeklyPct + "%" }}
            />
          </span>
          {weeklyPacePct !== null && (
            <span
              className="hyo-usage-bar-pace"
              style={{ left: weeklyPacePct + "%" }}
            />
          )}
        </span>
      </div>

      {inputTokens > 0 && (
        <ContextRing
          pct={contextPct}
          barClass={contextBarClass}
          inputTokens={inputTokens}
          contextLimit={contextLimit}
          open={popup === "context"}
          popupBottom={popupBottom}
          onToggle={() => openPopup("context")}
          onCompact={() => { onCompact(); setPopup(null); }}
        />
      )}

      <span style={{ flex: 1 }} />

      {agents.length > 1 && (
        <button
          ref={agentRef}
          className="hyo-agent-selector"
          title={activeAgent?.description || "Switch agent"}
          onClick={() => openPopup("agent")}
          style={{ "--agent-color": activeAgent?.color } as React.CSSProperties}
        >
          <span className="hyo-agent-dot" />
          <span className="hyo-agent-name">{activeAgent?.name || agent}</span>
        </button>
      )}

      <button
        ref={permRef}
        className="hyo-permission-mode-selector"
        title="Permission mode"
        onClick={() => openPopup("permission")}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0L2 3v5c0 3.5 2.5 6.5 6 7 3.5-.5 6-3.5 6-7V3L8 0z" />
        </svg>
        <span className="hyo-permission-mode-name">{permName}</span>
      </button>

      <button
        ref={modelRef}
        className="hyo-model-selector"
        title="Switch model"
        onClick={() => openPopup("model")}
      >
        <span className="hyo-model-selector-name">{modelName}</span>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 6l4 4 4-4z" />
        </svg>
      </button>

      {popup === "usage" && (
        <div className="hyo-usage-popup" style={{ position: "fixed", bottom: popupBottom, left: 12 }}>
          <div className="hyo-usage-popup-title">USAGE</div>
          <div className="hyo-usage-divider" />
          <div className="hyo-usage-row">
            <span className="hyo-usage-label">5hr window</span>
            <span className="hyo-usage-value">
              {Math.round(sessionPct)}% used
            </span>
          </div>
          <div className="hyo-usage-bar-inline-wrap">
            <div className="hyo-usage-bar-inline">
              <div
                className={`hyo-usage-bar-inline-fill ${sessionBarClass}`}
                style={{ width: sessionPct + "%" }}
              />
            </div>
            {sessionPacePct !== null && (
              <span
                className="hyo-usage-bar-pace"
                style={{ left: sessionPacePct + "%" }}
              />
            )}
          </div>
          {usage?.five_hour?.resets_at && (
            <div className="hyo-usage-row small">
              <span className="hyo-usage-label">Resets in</span>
              <span className="hyo-usage-value">
                {formatResetTime(usage.five_hour.resets_at)}
              </span>
            </div>
          )}
          <div className="hyo-usage-divider" />
          <div className="hyo-usage-row">
            <span className="hyo-usage-label">Weekly (all models)</span>
            <span className="hyo-usage-value">
              {Math.round(weeklyPct)}% used
            </span>
          </div>
          <div className="hyo-usage-bar-inline-wrap">
            <div className="hyo-usage-bar-inline">
              <div
                className={`hyo-usage-bar-inline-fill ${weeklyBarClass}`}
                style={{ width: weeklyPct + "%" }}
              />
            </div>
            {weeklyPacePct !== null && (
              <span
                className="hyo-usage-bar-pace"
                style={{ left: weeklyPacePct + "%" }}
              />
            )}
          </div>
          {usage?.seven_day?.resets_at && (
            <div className="hyo-usage-row small">
              <span className="hyo-usage-label">Resets in</span>
              <span className="hyo-usage-value">
                {formatResetTime(usage.seven_day.resets_at)}
              </span>
            </div>
          )}
          {sonnetPct !== null && (
            <>
              <div className="hyo-usage-divider" />
              <div className="hyo-usage-row">
                <span className="hyo-usage-label">Weekly (Sonnet)</span>
                <span className="hyo-usage-value">{Math.round(sonnetPct)}% used</span>
              </div>
              <div className="hyo-usage-bar-inline-wrap">
                <div className="hyo-usage-bar-inline">
                  <div
                    className={`hyo-usage-bar-inline-fill ${sonnetBarClass}`}
                    style={{ width: sonnetPct + "%" }}
                  />
                </div>
              </div>
              {usage?.seven_day_sonnet?.resets_at && (
                <div className="hyo-usage-row small">
                  <span className="hyo-usage-label">Resets in</span>
                  <span className="hyo-usage-value">
                    {formatResetTime(usage.seven_day_sonnet.resets_at)}
                  </span>
                </div>
              )}
            </>
          )}
          <div className="hyo-usage-divider" />
          <button className="hyo-usage-refresh-btn" onClick={refresh}>
            Refresh · Last updated{" "}
            {lastUpdated ? formatTimeAgo(lastUpdated) : "never"}
          </button>
        </div>
      )}

      {popup === "model" && (
        <div className="hyo-model-popup" style={{ position: "fixed", bottom: popupBottom, right: 12 }}>
          {MODEL_OPTIONS.map((opt) => (
            <div
              key={opt.id}
              className={`hyo-model-popup-item ${opt.id === model ? "active" : ""}`}
              onClick={() => selectModel(opt.id)}
            >
              <span className="hyo-model-check">
                {opt.id === model ? "✓" : ""}
              </span>
              <span className="hyo-model-popup-name">{opt.name}</span>
              <span className="hyo-model-popup-context">{opt.context}</span>
            </div>
          ))}
          <div className="hyo-model-popup-divider" />
          <form
            className="hyo-model-custom-row"
            onSubmit={(e) => {
              e.preventDefault();
              const id = customModel.trim();
              if (id) { selectModel(id); setCustomModel(""); }
            }}
          >
            <input
              className="hyo-model-custom-input"
              placeholder="Custom model ID…"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
            />
            <button type="submit" className="hyo-model-custom-btn" disabled={!customModel.trim()}>Use</button>
          </form>
        </div>
      )}

      {popup === "agent" && (
        <div
          className="hyo-agent-popup"
          style={{ position: "fixed", bottom: popupBottom, right: 120 }}
        >
          {agents.map((a) => (
            <div
              key={a.name}
              className={`hyo-agent-popup-item ${a.name === agent ? "active" : ""}`}
              onClick={() => selectAgent(a.name)}
            >
              <span
                className="hyo-agent-popup-dot"
                style={{ background: a.color }}
              />
              <div className="hyo-agent-popup-text">
                <div className="hyo-agent-popup-name">
                  {a.name}
                  {a.isDefault && <span className="hyo-agent-popup-default"> · default</span>}
                </div>
                {a.description && (
                  <div className="hyo-agent-popup-desc">{a.description}</div>
                )}
              </div>
              {a.name === agent && <span className="hyo-agent-popup-check">✓</span>}
            </div>
          ))}
        </div>
      )}

      {popup === "permission" && (
        <div className="hyo-perm-popup" style={{ position: "fixed", bottom: popupBottom, right: 60 }}>
          {PERMISSION_MODES.map((opt) => (
            <div
              key={opt.id}
              className={`hyo-perm-popup-item ${opt.id === permissionMode ? "active" : ""}`}
              onClick={() => selectPermission(opt.id)}
            >
              <div className="hyo-perm-popup-item-name">
                {opt.name}
                {opt.id === permissionMode && (
                  <span className="hyo-perm-popup-check">✓</span>
                )}
              </div>
              <div className="hyo-perm-popup-item-desc">{opt.desc}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ContextRingProps {
  pct: number;
  barClass: string;
  inputTokens: number;
  contextLimit: number;
  open: boolean;
  popupBottom: number;
  onToggle: () => void;
  onCompact: () => void;
}

function ContextRing({ pct, barClass, inputTokens, contextLimit, open, popupBottom, onToggle, onCompact }: ContextRingProps) {
  const r = 6;
  const circ = 2 * Math.PI * r;
  const dash = circ * (pct / 100);
  const ringColor = barClass === "danger" ? "#e74c3c" : barClass === "warning" ? "#f39c12" : "var(--text-muted)";
  const remaining = Math.max(0, 100 - Math.round(pct));

  return (
    <>
      <button
        className="hyo-context-ring-btn"
        title={`Context: ${formatTokens(inputTokens)} / ${formatTokens(contextLimit)}`}
        onClick={onToggle}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" style={{ display: "block" }}>
          <circle cx="8" cy="8" r={r} fill="none" stroke="var(--background-modifier-border)" strokeWidth="2" />
          <circle
            cx="8" cy="8" r={r}
            fill="none"
            stroke={ringColor}
            strokeWidth="2"
            strokeDasharray={`${dash} ${circ}`}
            strokeLinecap="round"
            transform="rotate(-90 8 8)"
          />
        </svg>
      </button>
      {open && (
        <div className="hyo-context-popup" style={{ position: "fixed", bottom: popupBottom, left: 12 }}>
          <div className="hyo-usage-popup-title">CONTEXT WINDOW</div>
          <div className="hyo-usage-divider" />
          <div className="hyo-usage-row">
            <span className="hyo-usage-label">Used</span>
            <span className="hyo-usage-value">{formatTokens(inputTokens)} / {formatTokens(contextLimit)}</span>
          </div>
          <div className="hyo-usage-bar-inline-wrap">
            <div className="hyo-usage-bar-inline">
              <div className={`hyo-usage-bar-inline-fill ${barClass}`} style={{ width: pct + "%" }} />
            </div>
          </div>
          <div className="hyo-usage-row small">
            <span className="hyo-usage-label">Remaining until auto-compact</span>
            <span className="hyo-usage-value">{remaining}%</span>
          </div>
          <div className="hyo-usage-divider" />
          <button className="hyo-compact-now-btn" onClick={onCompact}>
            Compact now
          </button>
        </div>
      )}
    </>
  );
}
