import React, { useRef, useEffect } from "react";
import { MarkdownRenderer, Component } from "obsidian";

interface MarkdownBlockProps {
  content: string;
  sourcePath?: string;
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
        content,
        ref.current,
        sourcePath,
        componentRef.current
      );
    }
  }, [content, sourcePath]);

  return <div ref={ref} className="hyo-markdown-body" />;
}
