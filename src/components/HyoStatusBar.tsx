import React, { useState, useRef, useCallback, useEffect } from "react";
import type { EngineId } from "../agent-transport";
import { fetchCodexModels } from "../codex-models";
import { useUsage, scopedLimit } from "../hooks/useUsage";
import { useAgents } from "../hooks/useAgents";
import {
  modelsForEngine,
  effortsForEngine,
  type ModelOption,
  DEFAULT_EFFORT,
  getContextLimit,
} from "../models";

interface HyoStatusBarProps {
  /** Which engine this vault runs, so the picker offers that engine's models. */
  engine?: EngineId;
  /** Path to the engine's CLI, used to ask it what models it can run. */
  engineCliPath?: string;
  /** Plan consumption as the engine reports it. Codex only. */
  engineRateLimits?: {
    primaryUsedPercent?: number;
    secondaryUsedPercent?: number;
    resetsAt?: number;
    planType?: string;
  } | null;
  model: string;
  effort: string;
  permissionMode: string;
  agent: string;
  inputTokens: number;
  contextWindow?: number;
  voiceMode: boolean;
  hasVoiceApiKey: boolean;
  customModels: string[];
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onAddCustomModel: (id: string) => void;
  onPermissionModeChange: (mode: string) => void;
  onAgentChange: (agent: string) => void;
  onVoiceModeToggle: () => void;
  onCompact: () => void;
}

const PERMISSION_MODES = [
  {
    id: "manual",
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

function formatTokens(n: number): string {
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(n);
}

export function HyoStatusBar({
  engine,
  engineCliPath,
  engineRateLimits,
  model,
  effort,
  permissionMode,
  agent,
  inputTokens,
  contextWindow,
  voiceMode,
  hasVoiceApiKey,
  customModels,
  onModelChange,
  onEffortChange,
  onAddCustomModel,
  onPermissionModeChange,
  onAgentChange,
  onVoiceModeToggle,
  onCompact,
}: HyoStatusBarProps) {
  const agents = useAgents();
  const activeAgent = agents.find((a) => a.name === agent) || agents[0];
  const {
    usage,
    sessionPct,
    weeklyPct,
    fablePct,
    sessionPacePct,
    weeklyPacePct,
    lastUpdated,
    stale,
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

  const selectEffort = useCallback(
    (id: string) => {
      onEffortChange(id);
      setPopup(null);
    },
    [onEffortChange]
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

  // Codex serves its own model list, so ask it rather than shipping one that
  // goes stale. Claude's is a fixed list and needs no round trip.
  const [liveModels, setLiveModels] = useState<ModelOption[] | null>(null);
  useEffect(() => {
    if (engine !== "codex" || !engineCliPath) {
      setLiveModels(null);
      return;
    }
    let cancelled = false;
    void fetchCodexModels(engineCliPath).then((m) => {
      if (!cancelled) setLiveModels(m);
    });
    return () => {
      cancelled = true;
    };
  }, [engine, engineCliPath]);

  const engineModels = liveModels ?? modelsForEngine(engine || "claude");
  const engineEfforts = effortsForEngine(engine || "claude");

  // Built-in models plus any the user added via the custom field. Custom
  // entries show their raw ID (no friendly name / context label) and are
  // filtered so a custom ID that matches a built-in never double-lists.
  const customOpts = customModels
    .filter((id) => !engineModels.some((m) => m.id === id))
    .map((id) => ({ id, name: id, context: "" }));
  const allModelOpts = [...engineModels, ...customOpts];

  const modelOpt = allModelOpts.find((m) => m.id === model);
  const modelName = modelOpt
    ? `${modelOpt.name} ${modelOpt.context}`.trim()
    : model;
  const permName =
    PERMISSION_MODES.find((m) => m.id === permissionMode)?.name ||
    permissionMode;

  // Effort falls back to the default rather than echoing an unknown value —
  // the CLI silently ignores anything outside EFFORT_OPTIONS, so showing a
  // stray value would claim a level that isn't actually in effect.
  const effortOpt =
    engineEfforts.find((e) => e.id === effort) ||
    engineEfforts.find((e) => e.id === DEFAULT_EFFORT)!;

  // The CLI sometimes under-reports contextWindow early in a fresh session
  // (--session-id) versus a resumed one (--resume) — same model, same
  // account, different number. Never let the displayed/auto-compact ceiling
  // drop below what's already known to be true for the model, so a
  // conservative early report can't trigger premature compaction.
  const contextLimit = Math.max(contextWindow ?? 0, getContextLimit(model));
  const contextPct = inputTokens > 0 ? Math.min(100, (inputTokens / contextLimit) * 100) : 0;
  const contextBarClass = contextPct > 80 ? "danger" : contextPct > 50 ? "warning" : "";

  const fableBarClass =
    (fablePct ?? 0) > 80 ? "danger" : (fablePct ?? 0) > 50 ? "warning" : "";
  const fableResetsAt = scopedLimit(usage, "Fable")?.resets_at;

  // Claude's figures come from Anthropic's usage API; Codex reports its own
  // over the transport. Showing one engine's plan usage while the other is
  // answering would be worse than showing nothing.
  const onCodex = engine === "codex";
  const shownSessionPct = onCodex ? engineRateLimits?.primaryUsedPercent ?? 0 : sessionPct;
  const shownWeeklyPct = onCodex ? engineRateLimits?.secondaryUsedPercent ?? 0 : weeklyPct;
  const showPace = !onCodex;

  const sessionBarClass =
    shownSessionPct > 80 ? "danger" : shownSessionPct > 50 ? "warning" : "";
  const weeklyBarClass =
    shownWeeklyPct > 80 ? "danger" : shownWeeklyPct > 50 ? "warning" : "";

  return (
    <div className="hyo-status-bar" ref={statusBarRef}>
      <div
        ref={usageRef}
        className={`hyo-usage-bars-group${!onCodex && stale ? " stale" : ""}`}
        title={
          onCodex
            ? `Codex plan usage${engineRateLimits?.planType ? ` (${engineRateLimits.planType})` : ""}`
            : stale
              ? "Usage data may be outdated — click to refresh"
              : "Usage"
        }
        onClick={() => openPopup("usage")}
      >
        <span className="hyo-usage-bar-label">5HR</span>
        <span className="hyo-usage-bar-track-wrap">
          <span className="hyo-usage-bar-track">
            <span
              className={`hyo-usage-bar-fill ${sessionBarClass}`}
              style={{ width: shownSessionPct + "%" }}
            />
          </span>
          {showPace && sessionPacePct !== null && (
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
              style={{ width: shownWeeklyPct + "%" }}
            />
          </span>
          {showPace && weeklyPacePct !== null && (
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

      <button
        className={`hyo-voice-toggle${voiceMode ? " active" : ""}${!hasVoiceApiKey ? " disabled" : ""}`}
        title={
          !hasVoiceApiKey
            ? "Set up voice in Hyo settings"
            : voiceMode
            ? "Voice mode on"
            : "Voice mode off"
        }
        onClick={() => {
          if (hasVoiceApiKey) onVoiceModeToggle();
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
        <span>Voice</span>
      </button>

      {/* Agents are a Claude Code feature. Codex has no equivalent, so the
          picker is absent there rather than offering a control that does
          nothing. */}
      {!onCodex && agents.length > 1 && (
        <button
          ref={agentRef}
          className="hyo-agent-selector"
          title={activeAgent?.description || "Switch agent"}
          onClick={() => openPopup("agent")}
          style={{ "--agent-color": activeAgent?.color } as React.CSSProperties}
        >
          <span className="hyo-agent-dot" />
          <span className="hyo-agent-name">{activeAgent?.name || "Default"}</span>
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
        title="Switch model or effort"
        onClick={() => openPopup("model")}
      >
        <span className="hyo-model-selector-name">{modelName}</span>
        <span className="hyo-model-selector-effort">{effortOpt.name}</span>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 6l4 4 4-4z" />
        </svg>
      </button>

      {popup === "usage" && (
        <div className="hyo-usage-popup" style={{ position: "fixed", bottom: popupBottom, left: 12 }}>
          <div className="hyo-usage-popup-title">USAGE</div>
          <div className="hyo-usage-divider" />
          <div className="hyo-usage-row">
            <span className="hyo-usage-label">
              {onCodex ? "Current window" : "5hr window"}
            </span>
            <span className="hyo-usage-value">
              {Math.round(shownSessionPct)}% used
            </span>
          </div>
          <div className="hyo-usage-bar-inline-wrap">
            <div className="hyo-usage-bar-inline">
              <div
                className={`hyo-usage-bar-inline-fill ${sessionBarClass}`}
                style={{ width: shownSessionPct + "%" }}
              />
            </div>
            {showPace && sessionPacePct !== null && (
              <span
                className="hyo-usage-bar-pace"
                style={{ left: sessionPacePct + "%" }}
              />
            )}
          </div>
          {onCodex && engineRateLimits?.resetsAt && (
            <div className="hyo-usage-row small">
              <span className="hyo-usage-label">Resets in</span>
              <span className="hyo-usage-value">
                {formatResetTime(new Date(engineRateLimits.resetsAt * 1000).toISOString())}
              </span>
            </div>
          )}
          {!onCodex && usage?.five_hour?.resets_at && (
            <div className="hyo-usage-row small">
              <span className="hyo-usage-label">Resets in</span>
              <span className="hyo-usage-value">
                {formatResetTime(usage.five_hour.resets_at)}
              </span>
            </div>
          )}
          <div className="hyo-usage-divider" />
          <div className="hyo-usage-row">
            <span className="hyo-usage-label">
              {onCodex ? "Longer window" : "Weekly (all models)"}
            </span>
            <span className="hyo-usage-value">
              {Math.round(shownWeeklyPct)}% used
            </span>
          </div>
          <div className="hyo-usage-bar-inline-wrap">
            <div className="hyo-usage-bar-inline">
              <div
                className={`hyo-usage-bar-inline-fill ${weeklyBarClass}`}
                style={{ width: shownWeeklyPct + "%" }}
              />
            </div>
            {showPace && weeklyPacePct !== null && (
              <span
                className="hyo-usage-bar-pace"
                style={{ left: weeklyPacePct + "%" }}
              />
            )}
          </div>
          {!onCodex && usage?.seven_day?.resets_at && (
            <div className="hyo-usage-row small">
              <span className="hyo-usage-label">Resets in</span>
              <span className="hyo-usage-value">
                {formatResetTime(usage.seven_day.resets_at)}
              </span>
            </div>
          )}
          {!onCodex && fablePct !== null && (
            <>
              <div className="hyo-usage-divider" />
              <div className="hyo-usage-row">
                <span className="hyo-usage-label">Weekly (Fable)</span>
                <span className="hyo-usage-value">{Math.round(fablePct)}% used</span>
              </div>
              <div className="hyo-usage-bar-inline-wrap">
                <div className="hyo-usage-bar-inline">
                  <div
                    className={`hyo-usage-bar-inline-fill ${fableBarClass}`}
                    style={{ width: fablePct + "%" }}
                  />
                </div>
              </div>
              {fableResetsAt && (
                <div className="hyo-usage-row small">
                  <span className="hyo-usage-label">Resets in</span>
                  <span className="hyo-usage-value">
                    {formatResetTime(fableResetsAt)}
                  </span>
                </div>
              )}
            </>
          )}
          <div className="hyo-usage-divider" />
          {stale && (
            <div className="hyo-usage-stale-notice">
              ⚠ Waiting for credentials — start a conversation or click Refresh.
            </div>
          )}
          <button className="hyo-usage-refresh-btn" onClick={refresh}>
            Refresh · Last updated{" "}
            {lastUpdated ? formatTimeAgo(lastUpdated) : "never"}
          </button>
        </div>
      )}

      {popup === "model" && (
        <div className="hyo-model-popup" style={{ position: "fixed", bottom: popupBottom, right: 12 }}>
          {allModelOpts.map((opt) => (
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
          <div
            className="hyo-model-popup-item hyo-effort-row"
            onClick={() => setPopup("effort")}
          >
            <span className="hyo-model-check" />
            <span className="hyo-model-popup-name">Effort</span>
            <span className="hyo-effort-row-value">{effortOpt.name}</span>
            <span className="hyo-effort-row-chevron">›</span>
          </div>
          <div className="hyo-model-popup-divider" />
          <form
            className="hyo-model-custom-row"
            onSubmit={(e) => {
              e.preventDefault();
              const id = customModel.trim();
              // Persist the model into the list (managed/removed in Settings)
              // and select it, rather than using it once and forgetting it.
              if (id) { onAddCustomModel(id); setCustomModel(""); setPopup(null); }
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

      {popup === "effort" && (
        <div className="hyo-model-popup hyo-effort-popup" style={{ position: "fixed", bottom: popupBottom, right: 12 }}>
          <div className="hyo-effort-popup-header">
            Higher effort means more thorough responses, but takes longer and
            uses your limits faster.
          </div>
          {engineEfforts.map((opt) => (
            <div
              key={opt.id}
              className={`hyo-model-popup-item ${opt.id === effortOpt.id ? "active" : ""}`}
              onClick={() => selectEffort(opt.id)}
            >
              <span className="hyo-model-check">
                {opt.id === effortOpt.id ? "✓" : ""}
              </span>
              <span className="hyo-model-popup-name">
                {opt.name}
                {opt.id === DEFAULT_EFFORT && (
                  <span className="hyo-effort-default-badge">Default</span>
                )}
              </span>
              <span className="hyo-effort-desc">{opt.desc}</span>
            </div>
          ))}
          <div className="hyo-model-popup-divider" />
          <div
            className="hyo-model-popup-item hyo-effort-row"
            onClick={() => setPopup("model")}
          >
            <span className="hyo-model-check">‹</span>
            <span className="hyo-model-popup-name">Back to models</span>
          </div>
        </div>
      )}

      {popup === "agent" && !onCodex && (
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
                  {a.name || "Default"}
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
