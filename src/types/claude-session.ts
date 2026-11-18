/**
 * What Claude Code writes, as Hyo reads it: a conversation's transcript
 * (~/.claude/projects/<project>/<session id>.jsonl, one JSON record per line)
 * and the stream-json events its process prints. The two share a shape: a
 * record has a `type` ("user", "assistant", "system", "result", "attachment",
 * "stream_event", "control_request", …) and, for "user" and "assistant", a
 * `message` whose `content` is a string or a list of content blocks.
 *
 * Neither is Hyo's to vouch for (another CLI version, a half-written line), so
 * records stay `unknown` until checked, and a content block is read through
 * `readBlock`, which checks the fields Hyo uses.
 */

import { asObject, str, type JsonObject } from "./json";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  /** The tool's arguments, as Claude wrote them. */
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  /** A string, or a list of content blocks. */
  content: unknown;
}

/** A file attached the way Claude Code's desktop app does it. */
export interface DocumentBlock {
  type: "document";
  title: string;
}

export interface ImageBlock {
  type: "image";
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | DocumentBlock | ImageBlock;

/**
 * A content block as Hyo uses it, or null for anything else (a block type
 * Hyo doesn't show, or something that isn't a block at all). A string field
 * that's missing or isn't a string reads as "".
 */
export function readBlock(v: unknown): ContentBlock | null {
  const b = asObject(v);
  if (!b) return null;
  switch (b.type) {
    case "text":
      return { type: "text", text: str(b.text) ?? "" };
    case "thinking":
      return { type: "thinking", thinking: str(b.thinking) ?? "" };
    case "tool_use":
      return { type: "tool_use", id: str(b.id) ?? "", name: str(b.name) ?? "", input: b.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: str(b.tool_use_id) ?? "", content: b.content };
    case "document":
      return { type: "document", title: str(b.title) ?? "" };
    case "image":
      return { type: "image" };
  }
  return null;
}

/** Is this a list of blocks (an array), rather than string content? */
export function isBlockList(content: unknown): content is unknown[] {
  return Array.isArray(content);
}

/** A message's content blocks Hyo uses, in order (none for string content). */
export function readBlocks(content: unknown): ContentBlock[] {
  if (!isBlockList(content)) return [];
  const out: ContentBlock[] = [];
  for (const v of content) {
    const b = readBlock(v);
    if (b) out.push(b);
  }
  return out;
}

/** The text of each text block, in order (one with no text gives ""). */
export function blockTexts(content: unknown): string[] {
  return readBlocks(content).flatMap((b) => (b.type === "text" ? [b.text] : []));
}

/** A block's `type`, without reading anything else (unknown block types included). */
export function blockType(v: unknown): unknown {
  return asObject(v)?.type;
}

/** A user or assistant record's `message`, if it has one. */
export function messageOf(record: JsonObject | null): JsonObject | null {
  return asObject(record?.message);
}

/** The `content` of a record's message: a string, a list of blocks, or anything else it holds. */
export function contentOf(record: JsonObject | null): unknown {
  return messageOf(record)?.content;
}

/**
 * The person's message, rebuilt from a record that isn't a user record (a
 * message sent mid-reply, see `steerAsUserEntry` in reply-stream.ts). Read
 * back exactly like the user records Claude writes.
 */
export type UserRecord = {
  type: "user";
  uuid: unknown;
  message: { role: "user"; content: unknown[] };
};
