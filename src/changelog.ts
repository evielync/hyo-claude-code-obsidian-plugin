// The changelog is bundled into the plugin at build time rather than fetched,
// so the release card and the notes view both work with no network and no
// dependency on GitHub being reachable. esbuild inlines this via a `text`
// loader — see esbuild.config.mjs.
import CHANGELOG from "../CHANGELOG.md";

export interface ReleaseSection {
  version: string;
  /** The bold line under the version — "The one where…". */
  heading: string;
  /** Markdown body: the bullets, and any subheadings on older entries. */
  body: string;
}

/**
 * Split CHANGELOG.md into per-version sections, newest first.
 *
 * Entries look like:
 *
 *   ## 0.3.25
 *
 *   **The one where we add Fable 5, and tabs that move**
 *
 *   - **Fable 5 now available:** …
 *
 * Older entries have no bold heading and group bullets under `### Fixes` etc.
 * Those parse fine — `heading` just comes back empty and the whole thing lands
 * in `body`.
 */
export function parseChangelog(raw: string = CHANGELOG): ReleaseSection[] {
  const sections: ReleaseSection[] = [];
  // Split on level-2 headings only; `###` subheadings inside an entry must stay
  // with their section.
  const parts = raw.split(/^## (?=\S)/m).slice(1);

  for (const part of parts) {
    const newline = part.indexOf("\n");
    const version = (newline === -1 ? part : part.slice(0, newline)).trim();
    let rest = newline === -1 ? "" : part.slice(newline + 1).trim();

    let heading = "";
    const boldFirstLine = rest.match(/^\*\*(.+?)\*\*\s*$/m);
    if (boldFirstLine && rest.startsWith("**")) {
      heading = boldFirstLine[1].trim();
      rest = rest.slice(boldFirstLine[0].length).trim();
    }

    sections.push({ version, heading, body: rest });
  }

  return sections;
}

/** The section for a given version, or null if the changelog has no entry. */
export function sectionForVersion(version: string): ReleaseSection | null {
  return parseChangelog().find((s) => s.version === version) ?? null;
}

/**
 * Every section newer than `sinceVersion`, newest first.
 *
 * Someone who skips a release must still find out what was in it — if they were
 * on 0.3.24, closed Obsidian for a fortnight and came back on 0.3.26, showing
 * only 0.3.26 would silently bury everything 0.3.25 added.
 *
 * Sections are already newest-first in the file, so "newer than X" is just
 * everything above X. When `sinceVersion` isn't in the changelog at all — a very
 * old install, or a version whose entry was never written — fall back to the
 * current release alone rather than dumping the entire history into a card.
 */
export function sectionsSince(
  sinceVersion: string,
  currentVersion: string
): ReleaseSection[] {
  const sections = parseChangelog();
  const sinceIdx = sections.findIndex((s) => s.version === sinceVersion);

  if (sinceIdx === -1) {
    const current = sections.find((s) => s.version === currentVersion);
    return current ? [current] : [];
  }

  return sections.slice(0, sinceIdx);
}

/** The whole changelog as markdown, for the notes view. */
export function fullChangelog(): string {
  return CHANGELOG;
}
