/**
 * The open tabs a Hyo view keeps in localStorage between launches (its
 * "desk"): which conversations were open, and the one in view.
 */

import { isObject } from "./json";

export interface SavedDesk {
  sessions: { id: string; title: string }[];
  activeId?: string | null;
}

/** The desk as stored, or null if there's none or it isn't one (written by hand, or by a broken build). */
export function parseSavedDesk(stored: string | null): SavedDesk | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stored || "null");
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions.flatMap((s: unknown) =>
        isObject(s) && typeof s.id === "string" && s.id ? [{ id: s.id, title: typeof s.title === "string" ? s.title : "" }] : []
      )
    : [];
  const activeId = typeof raw.activeId === "string" ? raw.activeId : null;
  return { sessions, activeId };
}
