import React, { useState, useSyncExternalStore } from "react";
import type { ToolCallData, OrderedBlock } from "../hooks/useChatEngine";
import { ToolCall } from "./ToolCall";

// ── The "Show every tool call" setting ─────────────────────────────────────
// Off (the default): each run of tool calls between pieces of text folds into
// one summary line, the way Claude Desktop's Normal view does. On: one row per
// tool call. main.ts pushes the saved value in on load and on every save, so
// open chats re-render the moment the toggle changes. Shared by the desktop
// and mobile chat views.

let showAll = false;
const listeners = new Set<() => void>();

export function setShowAllToolCalls(value: boolean): void {
  if (value === showAll) return;
  showAll = value;
  listeners.forEach((l) => l());
}

export function useShowAllToolCalls(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => showAll
  );
}

// ── Rendering a tool block inside a message ───────────────────────────────
// Called from the message render loops in place of a bare <ToolCall>.
// `isShown(block)` tells it which non-tool blocks are visible on screen: only
// those break a run, so hidden skill text or empty thinking doesn't split one
// summary line into two.

export function renderToolBlock(
  blocks: OrderedBlock[],
  i: number,
  toolCalls: ToolCallData[],
  hiddenTools: Set<string>,
  showAllTools: boolean,
  isShown: (block: OrderedBlock) => boolean
): React.ReactNode {
  const toolAt = (j: number) => {
    const b = blocks[j];
    if (b.type !== "tool") return null;
    const t = toolCalls.find((t) => t.id === b.toolId);
    return t && !hiddenTools.has(t.name) ? t : null;
  };

  const tool = toolAt(i);
  if (!tool) return null;
  if (showAllTools) return <ToolCall key={i} tool={tool} />;

  // Only the first tool of a run renders; the rest belong to its summary.
  for (let j = i - 1; j >= 0; j--) {
    if (blocks[j].type === "tool") {
      if (toolAt(j)) return null;
      continue;
    }
    if (isShown(blocks[j])) break;
  }

  const run: ToolCallData[] = [];
  for (let j = i; j < blocks.length; j++) {
    if (blocks[j].type === "tool") {
      const t = toolAt(j);
      if (t) run.push(t);
      continue;
    }
    if (isShown(blocks[j])) break;
  }

  return <ToolCallRun key={i} tools={run} />;
}

function ToolCallRun({ tools }: { tools: ToolCallData[] }) {
  const [expanded, setExpanded] = useState(false);
  const running = tools.some((t) => !t.result);

  return (
    <div className="hyo-tool-run">
      <div className="hyo-tool-run-header" onClick={() => setExpanded(!expanded)}>
        <span className="hyo-tool-call-arrow">{expanded ? "▼" : "▶"}</span>
        <span className={`hyo-tool-run-summary${running ? " is-running" : ""}`}>
          {summariseRun(tools)}
        </span>
      </div>
      {expanded && (
        <div className="hyo-tool-run-body">
          {tools.map((t) => (
            <ToolCall key={t.id} tool={t} />
          ))}
        </div>
      )}
    </div>
  );
}

// "Read 3 files, ran 2 commands, used the writing skill"
function summariseRun(tools: ToolCallData[]): string {
  const counts = new Map<string, number>();
  const skills: string[] = [];
  const bump = (k: string) => counts.set(k, (counts.get(k) || 0) + 1);

  for (const t of tools) {
    switch (t.name) {
      case "Read":
        bump("read");
        break;
      case "Write":
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit":
        bump("edit");
        break;
      case "Bash":
        bump("bash");
        break;
      case "Grep":
      case "Glob":
        bump("search");
        break;
      case "WebSearch":
        bump("web");
        break;
      case "WebFetch":
        bump("fetch");
        break;
      case "Agent":
      case "Task":
        bump("agent");
        break;
      case "Skill": {
        const name = t.input?.skill || t.input?.name;
        if (name) skills.push(name);
        else bump("other");
        break;
      }
      default:
        bump("other");
    }
  }

  const n = (k: string) => counts.get(k) || 0;
  const plural = (count: number, one: string, many: string) =>
    count === 1 ? one : `${count} ${many}`;

  const parts: string[] = [];
  if (n("read")) parts.push(`read ${plural(n("read"), "a file", "files")}`);
  if (n("edit")) parts.push(`edited ${plural(n("edit"), "a file", "files")}`);
  if (n("bash")) parts.push(`ran ${plural(n("bash"), "a command", "commands")}`);
  const times = (count: number) => (count > 1 ? ` ${count} times` : "");
  if (n("search")) parts.push(`searched the files${times(n("search"))}`);
  if (n("web")) parts.push(`searched the web${times(n("web"))}`);
  if (n("fetch")) parts.push(`read ${plural(n("fetch"), "a web page", "web pages")}`);
  if (n("agent")) parts.push(`ran ${plural(n("agent"), "a sub-agent", "sub-agents")}`);
  for (const s of skills) parts.push(`used the ${s} skill`);
  if (n("other")) {
    const others = n("other");
    const label = parts.length ? "other tool" : "tool";
    parts.push(`used ${others === 1 ? `a${parts.length ? "nother" : ""} tool` : `${others} ${label}s`}`);
  }

  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
