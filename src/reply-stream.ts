/**
 * Turning Claude's stream into chat replies, one reply per turn.
 *
 * Hyo writes the reply being streamed into the last reply in the chat, using
 * a per-tab stream state that collects the turn's text, thinking and tool
 * calls. A turn normally starts with a message from the person: sending it
 * adds the reply and a fresh stream state.
 *
 * Claude also starts turns on its own, with nobody sending anything: a
 * background agent or command finishing (a task notification), a message from
 * another session, a scheduled prompt. The CLI ends the previous turn with
 * `result`, then streams the new one exactly like any other turn. The
 * handlers call `startsTurnOfItsOwn` before taking any content in: once a
 * turn's result has landed, the next main-chain content opens a new reply
 * below with a fresh stream state (`openReply`), so the reply before it stays
 * as it was.
 *
 * Reopening a conversation follows the same rule: the prompt the CLI recorded
 * for a turn it started itself (`isSelfStartedPrompt`) is not the person's
 * message, so it doesn't show, and the reply after it starts a new message.
 *
 * Pure: shared by the desktop and phone session managers and both history
 * parsers.
 */

import type { ToolCallData, OrderedBlock } from "./hooks/useChatEngine";

export interface StreamState {
  toolCalls: ToolCallData[];
  orderedBlocks: OrderedBlock[];
  turnIndex: number;
  toolResultSinceLastText: boolean;
  skillResultPending: boolean; // true after Skill tool_result, until next text block is consumed
  /** The turn's main-chain `result` has landed. More content means Claude started a new turn. */
  turnDone: boolean;
}

export function newStreamState(): StreamState {
  return {
    toolCalls: [],
    orderedBlocks: [],
    turnIndex: 0,
    toolResultSinceLastText: false,
    skillResultPending: false,
    turnDone: false,
  };
}

/** A sub-agent's events carry these; its `result` doesn't end the main turn. */
export function isSidechainEvent(event: any): boolean {
  return !!(event?.isSidechain || event?.parent_tool_use_id);
}

/** An event that adds to the main reply: Claude's messages, tool results, streamed blocks. */
function isMainChainContent(event: any): boolean {
  if (!event || isSidechainEvent(event)) return false;
  if (event.type === "assistant" || event.type === "user") return true;
  if (event.type === "stream_event") {
    const t = (event.event || event).type;
    return t === "content_block_start" || t === "content_block_delta";
  }
  return false;
}

/** The main turn's result: from here on, content belongs to a turn Claude starts itself. */
export function endTurn(ss: StreamState, event: any): void {
  if (!isSidechainEvent(event)) ss.turnDone = true;
}

/**
 * Content arriving after the turn ended: Claude started a turn of its own.
 * Resets the stream state in place, so the caller's `ss` is the new turn's.
 */
export function startsTurnOfItsOwn(ss: StreamState, event: any): boolean {
  if (!ss.turnDone || !isMainChainContent(event)) return false;
  Object.assign(ss, newStreamState());
  return true;
}

/** The new turn's reply, added below everything; whatever was still marked streaming is finished. */
export function openReply<M extends { role: string; streaming?: boolean; voice?: boolean }>(messages: M[], reply: M): M[] {
  return [...messages.map((m) => (m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m)), reply];
}

/**
 * A prompt the CLI wrote for a turn it started itself, not one the person
 * sent: a task notification, a peer session's message, a scheduled prompt.
 * Newer CLIs mark these `promptSource: "system"`; older ones only have the
 * notification text.
 */
export function isSelfStartedPrompt(entry: any): boolean {
  if (entry?.type !== "user") return false;
  if (entry.promptSource === "system") return true;
  if (entry.origin?.kind === "task-notification") return true;
  const c = entry.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((b: any) => b?.type === "text")?.text || "" : "";
  return /^\s*<task-notification>/.test(text);
}

export function processContentBlocks(contentArr: any[], ss: StreamState, source: "user" | "assistant") {
  for (const block of contentArr) {
    if (block.type === "text") {
      if (ss.toolResultSinceLastText && ss.orderedBlocks.length > 0)
        ss.turnIndex++;
      const existing = ss.orderedBlocks.find(
        (b) => b.type === "text" && b.turnIndex === ss.turnIndex
      );
      if (existing) {
        existing.content = block.text || "";
        // When Claude's assistant event updates a previously suppressed block, unsuppress it
        if (source === "assistant") existing.isSkillOutput = false;
      } else {
        // Text arriving in a user event immediately after a Skill tool_result is a system message — hide it
        const isSkillOutput = source === "user" && ss.skillResultPending;
        ss.skillResultPending = false;
        ss.orderedBlocks.push({
          type: "text",
          content: block.text || "",
          turnIndex: ss.turnIndex,
          isSkillOutput,
        });
      }
      ss.toolResultSinceLastText = false;
    } else if (block.type === "thinking") {
      const existing = ss.orderedBlocks.find(
        (b) => b.type === "thinking" && b.turnIndex === ss.turnIndex
      );
      if (existing) existing.content = block.thinking || "";
      else
        ss.orderedBlocks.push({
          type: "thinking",
          content: block.thinking || "",
          turnIndex: ss.turnIndex,
        });
    } else if (block.type === "tool_use") {
      const tool: ToolCallData = {
        id: block.id,
        name: block.name,
        input: block.input,
        result: null,
      };
      if (!ss.toolCalls.find((t) => t.id === tool.id)) {
        ss.toolCalls.push(tool);
        ss.orderedBlocks.push({
          type: "tool",
          toolId: tool.id,
          turnIndex: ss.turnIndex,
        });
        // Immediately suppress text at this turn if it's a Skill call
        if (tool.name === "Skill") {
          for (const b of ss.orderedBlocks) {
            if (b.type === "text" && b.turnIndex === ss.turnIndex) {
              b.isSkillOutput = true;
            }
          }
        }
      }
    } else if (block.type === "tool_result") {
      const tool = ss.toolCalls.find((t) => t.id === block.tool_use_id);
      if (tool) {
        tool.result =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
        if (tool.name === "Skill") {
          ss.skillResultPending = true;
          // Retroactively suppress text at the same turn as the Skill tool block
          const skillBlock = ss.orderedBlocks.find(
            (b) => b.type === "tool" && b.toolId === tool.id
          );
          if (skillBlock) {
            for (const b of ss.orderedBlocks) {
              if (b.type === "text" && b.turnIndex === skillBlock.turnIndex) {
                b.isSkillOutput = true;
              }
            }
          }
        }
      }
      ss.toolResultSinceLastText = true;
    }
  }
}

export function buildSnapshot(ss: StreamState) {
  return {
    content: ss.orderedBlocks
      .filter((b) => b.type === "text")
      .map((b) => b.content)
      .join(""),
    thinking: ss.orderedBlocks
      .filter((b) => b.type === "thinking")
      .map((b) => b.content)
      .join(""),
    toolCalls: [...ss.toolCalls],
    orderedBlocks: [...ss.orderedBlocks.map((b) => ({ ...b }))],
  };
}
