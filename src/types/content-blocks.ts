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
