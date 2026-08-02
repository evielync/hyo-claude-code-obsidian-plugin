import React from "react";
import { MarkdownBlock } from "./MarkdownBlock";
import { sectionsSince } from "../changelog";

interface ReleaseCardProps {
  /** Version whose card was last acknowledged. */
  sinceVersion: string;
  /** Version now installed. */
  version: string;
  onDismiss: () => void;
  onOpenNotes: () => void;
}

/**
 * The "what's new" card, pinned above the message list after an update.
 *
 * Deliberately not styled as an assistant message: Claude speaking before the
 * user has said anything reads as broken. This is the plugin talking — hence
 * the label, the version stamp and the dismiss control.
 *
 * Shows everything since the last card was seen, not just the newest release.
 * Updates are easy to skip — someone who was away for two releases still needs
 * to find out what landed in both.
 */
export function ReleaseCard({
  sinceVersion,
  version,
  onDismiss,
  onOpenNotes,
}: ReleaseCardProps) {
  const sections = sectionsSince(sinceVersion, version);

  // No changelog entry at all still gets a card rather than nothing — a missing
  // entry shouldn't look like a broken update.
  const heading =
    sections.length === 0
      ? "Hyo has been updated"
      : sections.length === 1
        ? sections[0].heading || "Hyo has been updated"
        : `What you missed in ${sections.length} updates`;

  return (
    <div className="hyo-release-card">
      <div className="hyo-release-card-head">
        <span className="hyo-release-card-badge">What's new</span>
        <span className="hyo-release-card-version">{version}</span>
        <button
          className="hyo-release-card-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ×
        </button>
      </div>

      <div className="hyo-release-card-title">{heading}</div>

      <div className="hyo-release-card-body">
        {sections.map((section, i) => (
          <div key={section.version} className="hyo-release-card-section">
            {/* With one release the card title already says it. With several,
                each needs its own so the bullets don't run together. */}
            {sections.length > 1 && (
              <div className="hyo-release-card-section-head">
                <span className="hyo-release-card-section-version">
                  {section.version}
                </span>
                {section.heading && (
                  <span className="hyo-release-card-section-title">
                    {section.heading}
                  </span>
                )}
              </div>
            )}
            {section.body && <MarkdownBlock content={section.body} />}
          </div>
        ))}
      </div>

      <div className="hyo-release-card-actions">
        <button className="hyo-release-card-btn" onClick={onOpenNotes}>
          Full release notes
        </button>
      </div>
    </div>
  );
}
