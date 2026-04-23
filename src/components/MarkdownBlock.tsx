import React, { useRef, useEffect } from "react";
import { MarkdownRenderer, Component } from "obsidian";

interface MarkdownBlockProps {
  content: string;
  sourcePath?: string;
}

// Claude 4.7's adaptive thinking sometimes emits <thinking>...</thinking>
// tags inline in text responses instead of using extended thinking blocks.
// Strip them so they don't leak into the rendered message.
export function stripInlineThinkingTags(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "")
    .replace(/<thinking>[\s\S]*$/, "");
}

export function MarkdownBlock({ content, sourcePath = "" }: MarkdownBlockProps) {
  const ref = useRef<HTMLDivElement>(null);
  const componentRef = useRef<Component | null>(null);

  useEffect(() => {
    componentRef.current = new Component();
    componentRef.current.load();
    return () => {
      componentRef.current?.unload();
    };
  }, []);

  useEffect(() => {
    if (ref.current && content && componentRef.current) {
      ref.current.empty();
      MarkdownRenderer.render(
        app,
        stripInlineThinkingTags(content),
        ref.current,
        sourcePath,
        componentRef.current
      );
    }
  }, [content, sourcePath]);

  return <div ref={ref} className="hyo-markdown-body" />;
}
