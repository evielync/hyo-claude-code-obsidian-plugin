import { useState, useEffect, useCallback } from "react";
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
}

interface OAuthCreds {
  accessToken: string;
  refreshToken?: string;
}

/**
 * Read OAuth credentials from macOS Keychain (async — does not block UI)
 */
const CACHE_DIR = require("path").join(require("os").homedir(), ".hyo");
const CACHE_PATH = require("path").join(CACHE_DIR, "oauth-cache.json");

function cacheOAuthCreds(oauth: OAuthCreds): void {
  try {
    const fs = require("fs");
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(oauth), { mode: 0o600 });
  } catch {
    // Non-critical — cache is best-effort
  }
}

function readCachedOAuthCreds(): OAuthCreds | null {
  try {
    const fs = require("fs");
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    const oauth = JSON.parse(raw);
    if (oauth?.accessToken) return oauth;
  } catch {
    // No cache yet
  }
  return null;
}

async function getOAuthCreds(): Promise<OAuthCreds | null> {
  const fs = require("fs");
  const path = require("path");
  const home = require("os").homedir();

  // Try 1: Claude Code's credentials file (full data, exists while CLI runs)
  try {
    const credsPath = path.join(home, ".claude", ".credentials.json");
    const raw = fs.readFileSync(credsPath, "utf-8");
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (oauth?.accessToken) {
      cacheOAuthCreds(oauth);
      console.log("[hyo][usage] Creds from: credentials file | hasRefresh:", !!oauth.refreshToken);
      return oauth;
    }
  } catch {
    // File may not exist — fall through
  }

  // Try 2: Our own cache (persists across sessions)
  const cached = readCachedOAuthCreds();
  if (cached) {
    console.log("[hyo][usage] Creds from: cache | hasRefresh:", !!cached.refreshToken);
    return cached;
  }

  // Try 3: macOS keychain (truncated fallback — may lack refreshToken)
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
    const raw = stdout.trim();

    try {
      const creds = JSON.parse(raw);
      const oauth = creds?.claudeAiOauth;
      if (oauth?.accessToken) {
        cacheOAuthCreds(oauth);
        console.log("[hyo][usage] Creds from: keychain (full parse) | hasRefresh:", !!oauth.refreshToken);
        return oauth;
      }
    } catch {
      console.warn("[hyo][usage] Keychain truncated (", raw.length, "bytes) — claudeAiOauth not reachable");
    }
  } catch {
    // Keychain not available (Linux/Windows)
  }

  console.warn("[hyo][usage] No credentials found from any source");
  return null;
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
 * Fetch usage from Anthropic API with automatic token refresh
 */
async function fetchUsage(): Promise<UsageData | null> {
  const creds = await getOAuthCreds();
  if (!creds?.accessToken) {
    console.warn("[hyo][usage] No credentials available");
    return null;
  }

  try {
    // Try with current token
    let result = await fetchUsageWithToken(creds.accessToken);

    // If expired, refresh and retry
    if (result.status === 401) {
      console.log("[hyo][usage] Got 401 — refreshToken?", !!creds.refreshToken, "type:", typeof creds.refreshToken, "len:", creds.refreshToken?.length);
      if (creds.refreshToken) {
        console.log("[hyo][usage] Attempting token refresh...");
        const newToken = await refreshOAuthToken(creds.refreshToken);
        if (newToken) {
          console.log("[hyo][usage] Refresh succeeded, retrying...");
          // Update cache with new access token
          cacheOAuthCreds({ ...creds, accessToken: newToken });
          result = await fetchUsageWithToken(newToken);
        } else {
          console.warn("[hyo][usage] Refresh returned null");
        }
      }
    }

    if (result.data) {
      console.log("[hyo][usage] Fetch OK — 5hr:", result.data.five_hour?.utilization, "7d:", result.data.seven_day?.utilization);
    }

    return result.data;
  } catch (e: any) {
    console.warn("[hyo][usage] fetchUsage error:", e?.message || e);
    return null;
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
export function useUsage() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);

  const poll = useCallback(async () => {
    try {
      const data = await fetchUsage();
      if (data) {
        setUsage(data);
        setLastUpdated(new Date());
        setStale(false);
      } else {
        setStale(true);
        console.warn("[hyo] Usage fetch returned null — check keychain or token");
      }
    } catch (e) {
      setStale(true);
      console.error("[hyo] Usage fetch failed:", e);
    }
  }, []);

  useEffect(() => {
    poll();
    // Poll every 5 minutes when healthy, every 15 seconds when stale
    const interval = setInterval(poll, stale ? 15_000 : 300_000);
    return () => clearInterval(interval);
  }, [poll, stale]);

  // Re-poll when window regains visibility (catches stale token after long idle)
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [poll]);

  const sessionPct = usage?.five_hour
    ? Math.min(100, Math.max(0, usage.five_hour.utilization || 0))
    : 0;
  const weeklyPct = usage?.seven_day
    ? Math.min(100, Math.max(0, usage.seven_day.utilization || 0))
    : 0;

  const sessionPacePct = calcPacePct(usage?.five_hour?.resets_at, 5 * 60);
  const weeklyPacePct = calcWeeklyPacePct(usage?.seven_day?.resets_at);

  return {
    usage,
    sessionPct,
    weeklyPct,
    sessionPacePct,
    weeklyPacePct,
    lastUpdated,
    stale,
    refresh: poll,
  };
}
