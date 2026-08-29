import { debug } from "../debug";
import { useState, useEffect, useCallback, useRef } from "react";
import { requestUrl } from "obsidian";

// Type definitions for the usage API response
export interface UsageData {
  five_hour?: {
    utilization: number;
    resets_at: string;
  };
  seven_day?: {
    utilization: number;
    resets_at: string;
  };
  seven_day_opus?: {
    utilization: number;
    resets_at: string;
  };
  seven_day_sonnet?: {
    utilization: number;
    resets_at: string;
  };
  extra_usage?: {
    is_enabled: boolean;
    utilization: number;
    resets_at?: string;
  };
  // Per-model limits live here, not in their own top-level fields.
  // `seven_day_opus` / `seven_day_sonnet` still appear in the response but now
  // return null — model-scoped limits moved into this array.
  limits?: LimitEntry[];
}

export interface LimitEntry {
  kind: string; // "session" | "weekly_all" | "weekly_scoped"
  group?: string;
  percent: number;
  severity?: string;
  resets_at?: string;
  is_active?: boolean;
  scope?: {
    model?: { id: string | null; display_name?: string };
    surface?: string | null;
  } | null;
}

/**
 * A model-scoped weekly limit, or null when the account doesn't have one.
 *
 * Matches on `display_name` because `scope.model.id` comes back null — the
 * display name is the only identifier the response carries. If Anthropic
 * renames or drops it this returns null, and the caller hides the bar rather
 * than rendering a confidently wrong number.
 */
export function scopedLimit(
  usage: UsageData | null,
  displayName: string
): LimitEntry | null {
  const entry = usage?.limits?.find(
    (l) =>
      l.kind === "weekly_scoped" &&
      l.scope?.model?.display_name?.toLowerCase() === displayName.toLowerCase()
  );
  return entry && typeof entry.percent === "number" ? entry : null;
}

interface OAuthCreds {
  accessToken: string;
  refreshToken?: string;
  /** Epoch millis. Read before every request so we can refresh a dead token. */
  expiresAt?: number;
}

import { Platform } from "obsidian";

/**
 * Read Claude Code's OAuth credentials from wherever it stores them on this
 * platform. Hyo never writes or caches these — Claude Code owns the token and
 * keeps it current, so we always read the live source and copy nothing. Copies
 * are what went stale and shadowed the real token every time this broke before.
 *
 * macOS: the keychain is Claude Code's live store; the `~/.claude` file is a
 * leftover that goes stale, so the keychain is read first and the file is only
 * a fallback for when the keychain can't be read. Everywhere else there is no
 * keychain, so the file is the live store.
 */
async function getOAuthCreds(): Promise<OAuthCreds | null> {
  // Mobile has no filesystem or keychain access — usage isn't available there.
  if (Platform.isMobile) return null;

  const readFile = (): OAuthCreds | null => {
    try {
      const fs = require("fs");
      const path = require("path");
      const home = require("os").homedir();
      const credsPath = path.join(home, ".claude", ".credentials.json");
      const oauth = JSON.parse(fs.readFileSync(credsPath, "utf-8"))?.claudeAiOauth;
      return oauth?.accessToken ? oauth : null;
    } catch {
      return null;
    }
  };

  const readKeychain = async (): Promise<OAuthCreds | null> => {
    try {
      const { execFile } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFile);
      const username: string = require("os").userInfo().username;
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-a", username, "-w"],
        { timeout: 5000, maxBuffer: 1024 * 1024 }
      );
      const oauth = JSON.parse(stdout.trim())?.claudeAiOauth;
      return oauth?.accessToken ? oauth : null;
    } catch {
      // Keychain missing (non-mac) or unreadable/truncated — caller falls back.
      return null;
    }
  };

  if (Platform.isMacOS) {
    const fromKeychain = await readKeychain();
    const creds = fromKeychain ?? readFile();
    if (creds) debug("[hyo][usage] Creds from:", fromKeychain ? "keychain" : "file", "| hasRefresh:", !!creds.refreshToken);
    else console.warn("[hyo][usage] No credentials in keychain or file");
    return creds;
  }

  const creds = readFile();
  if (!creds) console.warn("[hyo][usage] No credentials file found");
  return creds;
}

/**
 * Treat a token as expired slightly early so we refresh before a request can
 * fail on it. A token with no expiry date is assumed live.
 */
function isExpired(creds: OAuthCreds): boolean {
  const EXPIRY_SKEW_MS = 60_000;
  return typeof creds.expiresAt === "number" && creds.expiresAt <= Date.now() + EXPIRY_SKEW_MS;
}

/**
 * Refresh the OAuth access token using Obsidian's requestUrl
 */
async function refreshOAuthToken(
  refreshToken: string
): Promise<string | null> {
  try {
    const res = await requestUrl({
      url: "https://claude.ai/api/oauth/token",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "claude-code",
      }),
      throw: false,
    });
    if (res.status !== 200) {
      console.warn("[hyo][usage] Token refresh failed:", res.status);
      return null;
    }
    return res.json?.access_token || null;
  } catch (e: any) {
    console.warn("[hyo][usage] Token refresh error:", e?.message || e);
    return null;
  }
}

/**
 * Fetch usage data from the Anthropic API using Obsidian's requestUrl
 */
async function fetchUsageWithToken(
  token: string
): Promise<{ status: number; data: UsageData | null }> {
  try {
    const res = await requestUrl({
      url: "https://api.anthropic.com/api/oauth/usage",
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      throw: false,
    });
    if (res.status !== 200) {
      console.warn("[hyo][usage] API returned status:", res.status);
      return { status: res.status, data: null };
    }
    return { status: 200, data: res.json };
  } catch (e: any) {
    console.warn("[hyo][usage] API request error:", e?.message || e);
    return { status: 0, data: null };
  }
}

/**
 * Fetch usage from the Anthropic API.
 *
 * The flow that ends the recurring breakage: read the live token, check its
 * expiry date, refresh it with the refresh token if it's dead, then use it.
 * The refreshed token is used in memory only — nothing is written back, so no
 * copy can go stale and shadow the real one. Returns the HTTP status too, so
 * the caller can back off on rate limits instead of hammering.
 */
async function fetchUsage(): Promise<{ status: number; data: UsageData | null }> {
  const creds = await getOAuthCreds();
  if (!creds?.accessToken) {
    console.warn("[hyo][usage] No credentials available");
    return { status: 0, data: null };
  }

  try {
    // Check the date first. If the token is dead (or nearly), refresh before
    // spending a request on it. Use whatever we have if refresh fails.
    let token = creds.accessToken;
    if (isExpired(creds) && creds.refreshToken) {
      debug("[hyo][usage] Token expired/near expiry — refreshing before request");
      const newToken = await refreshOAuthToken(creds.refreshToken);
      if (newToken) token = newToken;
      else console.warn("[hyo][usage] Proactive refresh failed — using stored token");
    }

    let result = await fetchUsageWithToken(token);

    // Safety net: server still says unauthorised (clock skew, early rotation).
    // Refresh once and retry.
    if (result.status === 401 && creds.refreshToken) {
      debug("[hyo][usage] 401 — refreshing and retrying once");
      const newToken = await refreshOAuthToken(creds.refreshToken);
      if (newToken) result = await fetchUsageWithToken(newToken);
    }

    if (result.data) {
      debug("[hyo][usage] Fetch OK — 5hr:", result.data.five_hour?.utilization, "7d:", result.data.seven_day?.utilization);
    }

    return result;
  } catch (e: any) {
    console.warn("[hyo][usage] fetchUsage error:", e?.message || e);
    return { status: 0, data: null };
  }
}

/**
 * Calculate pace percentage (how far through the time window we are)
 */
function calcPacePct(resetsAt: string | undefined, totalMinutes: number): number | null {
  if (!resetsAt) return null;
  const msRemaining = new Date(resetsAt).getTime() - Date.now();
  const minutesRemaining = msRemaining / 60000;
  const minutesElapsed = totalMinutes - minutesRemaining;
  return Math.min(100, Math.max(0, (minutesElapsed / totalMinutes) * 100));
}

/**
 * Calculate weekly pace percentage (which day of the week we're on)
 */
function calcWeeklyPacePct(resetsAt: string | undefined): number | null {
  if (!resetsAt) return null;
  const msRemaining = new Date(resetsAt).getTime() - Date.now();
  const hoursElapsed = (7 * 24 * 60 * 60 * 1000 - msRemaining) / 3600000;
  const currentDay = Math.floor(hoursElapsed / 24) + 1;
  return Math.min(100, Math.max(0, (currentDay / 7) * 100));
}

/**
 * Hook for managing Claude usage data
 * Polls the Anthropic API every 5 minutes for usage stats
 */
/**
 * Claude plan consumption, from Anthropic's usage API.
 *
 * `enabled` is false when the vault runs another engine — otherwise Hyo keeps
 * polling Anthropic, and reading Claude credentials, for numbers it isn't
 * showing.
 */
export function useUsage(enabled = true) {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  // Consecutive failures, in a ref so the scheduler can read it without a
  // re-render. Drives exponential backoff so a failing fetch can't hammer the
  // API — hammering a dead token is what got us rate-limited and kept us stuck.
  const failuresRef = useRef(0);

  const poll = useCallback(async () => {
    if (!enabled) return;
    try {
      const { status, data } = await fetchUsage();
      if (data) {
        setUsage(data);
        setLastUpdated(new Date());
        setStale(false);
        failuresRef.current = 0;
      } else {
        setStale(true);
        failuresRef.current += 1;
        console.warn(`[hyo] Usage fetch failed (status ${status}, attempt ${failuresRef.current})`);
      }
    } catch (e) {
      setStale(true);
      failuresRef.current += 1;
      console.error("[hyo] Usage fetch failed:", e);
    }
  }, [enabled]);

  // Self-scheduling loop: 5 min when healthy; on failure, back off from 30s up
  // to a 5 min cap (30s, 60s, 120s, 240s, 300s...) instead of a fixed 15s hammer.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      await poll();
      if (cancelled) return;
      const n = failuresRef.current;
      const delay = n === 0 ? 300_000 : Math.min(300_000, 30_000 * 2 ** (n - 1));
      timer = setTimeout(run, delay);
    };
    run();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [poll, enabled]);

  // Re-poll when window regains visibility (catches stale token after long idle)
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => { if (document.visibilityState === "visible") poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [poll, enabled]);

  const sessionPct = usage?.five_hour
    ? Math.min(100, Math.max(0, usage.five_hour.utilization || 0))
    : 0;
  const weeklyPct = usage?.seven_day
    ? Math.min(100, Math.max(0, usage.seven_day.utilization || 0))
    : 0;

  // Fable draws from its own slice of the weekly allowance and burns it faster,
  // so it gets its own row in the usage popup. Null when the account has no
  // Fable limit — the row is then hidden rather than shown at zero. It stays
  // out of the compact status bar, which is kept to the two limits that apply
  // to every conversation.
  const fableLimit = scopedLimit(usage, "Fable");
  const fablePct = fableLimit
    ? Math.min(100, Math.max(0, fableLimit.percent || 0))
    : null;

  const sessionPacePct = calcPacePct(usage?.five_hour?.resets_at, 5 * 60);
  const weeklyPacePct = calcWeeklyPacePct(usage?.seven_day?.resets_at);

  return {
    usage,
    sessionPct,
    weeklyPct,
    fablePct,
    sessionPacePct,
    weeklyPacePct,
    lastUpdated,
    stale,
    refresh: poll,
  };
}
