import React from "react";
import { MarkdownBlock } from "./MarkdownBlock";
import { fullChangelog } from "../changelog";

interface ReleaseNotesProps {
  onClose: () => void;
}

/**
 * Every release, rendered inside Hyo.
 *
 * Members work in Obsidian; sending them to a git host to read what changed in
 * a tool they use inside Obsidian isn't worth the click. The changelog is
 * bundled at build time, so this works with no connection.
 */
export function ReleaseNotes({ onClose }: ReleaseNotesProps) {
  return (
    <div className="hyo-release-notes">
      <div className="hyo-release-notes-head">
        <span className="hyo-release-notes-title">What's new in Hyo</span>
        <button
          className="hyo-release-notes-close"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          ×
        </button>
      </div>
      <div className="hyo-release-notes-body">
        <MarkdownBlock content={fullChangelog()} />
      </div>
    </div>
  );
}
