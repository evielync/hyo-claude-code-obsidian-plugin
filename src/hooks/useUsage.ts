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
async function getOAuthCreds(): Promise<OAuthCreds | null> {
  const fs = require("fs");
  const path = require("path");
  const home = require("os").homedir();

  // Try 1: Read from Claude Code's credentials file (full data, no truncation)
  try {
    const credsPath = path.join(home, ".claude", ".credentials.json");
    const raw = fs.readFileSync(credsPath, "utf-8");
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (oauth?.accessToken) return oauth;
  } catch {
    // File may not exist when Claude Code isn't running — fall through
  }

  // Try 2: Read from macOS keychain via security CLI
  // Note: security -w truncates at ~2KB — refreshToken may be missing
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
      if (oauth?.accessToken) return oauth;
    } catch {
      // JSON truncated — extract what we can via regex
      const accessMatch = raw.match(/"accessToken"\s*:\s*"([^"]+)"/);
      const refreshMatch = raw.match(/"refreshToken"\s*:\s*"([^"]+)"/);
      if (accessMatch) {
        return {
          accessToken: accessMatch[1],
          refreshToken: refreshMatch?.[1] || undefined,
        };
      }
    }
  } catch {
    // Keychain not available (Linux/Windows) — that's OK
  }

  console.warn("[hyo][usage] No credentials found");
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
    const interval = setInterval(poll, 300000); // 5 minutes
    return () => clearInterval(interval);
  }, [poll]);

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
