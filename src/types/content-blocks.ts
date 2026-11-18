/**
 * The content blocks a message to Claude is sent with when it carries more
 * than text: the words, plus any images or PDFs attached. They go to the
 * CLI's stream-json stdin verbatim (Anthropic's Messages API block shapes).
 */

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface Base64Source {
  type: "base64";
  media_type: string;
  data: string;
}

export interface ImageContentBlock {
  type: "image";
  source: Base64Source;
}

export interface DocumentContentBlock {
  type: "document";
  source: Base64Source;
}

export type PromptContentBlock = TextContentBlock | ImageContentBlock | DocumentContentBlock;

/** A message to Claude: plain text, or blocks when files go with it. */
export type UserContent = string | PromptContentBlock[];

/**
 * The block for an attached image or PDF, or null when the file hasn't been
 * read (no media type or data), so a half-read file is never sent.
 */
export function fileBlock(
  type: "image" | "document",
  mediaType: string | undefined,
  data: string | undefined,
): ImageContentBlock | DocumentContentBlock | null {
  if (!mediaType || !data) return null;
  return { type, source: { type: "base64", media_type: mediaType, data } };
}
