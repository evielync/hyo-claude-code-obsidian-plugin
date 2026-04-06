import { useState, useEffect, useCallback } from "react";

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
  try {
    const { exec } = require("child_process");
    const { promisify } = require("util");
    const execAsync = promisify(exec);
    const username: string = require("os").userInfo().username;
    const { stdout } = await execAsync(
      `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w`,
      { timeout: 5000, maxBuffer: 1024 * 1024 }
    );
    const raw = stdout.trim();

    // Try normal JSON parse first
    try {
      const creds = JSON.parse(raw);
      return creds?.claudeAiOauth || null;
    } catch {
      // Keychain value may be truncated — extract OAuth tokens via regex
      const accessMatch = raw.match(/"accessToken"\s*:\s*"([^"]+)"/);
      const refreshMatch = raw.match(/"refreshToken"\s*:\s*"([^"]+)"/);
      if (accessMatch) {
        return {
          accessToken: accessMatch[1],
          refreshToken: refreshMatch?.[1] || undefined,
        };
      }
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Make an HTTPS request using Node's https module (avoids CORS in Obsidian renderer)
 */
function httpsRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res: any) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Refresh the OAuth access token
 */
async function refreshOAuthToken(
  refreshToken: string
): Promise<string | null> {
  try {
    const body = JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "claude-code",
    });
    const res = await httpsRequest("https://claude.ai/api/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    return data.access_token || null;
  } catch {
    return null;
  }
}

/**
 * Fetch usage data from the Anthropic API
 */
async function fetchUsageWithToken(
  token: string
): Promise<{ status: number; data: UsageData | null }> {
  try {
    const res = await httpsRequest("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (res.status !== 200) return { status: res.status, data: null };
    return { status: 200, data: JSON.parse(res.body) };
  } catch {
    return { status: 0, data: null };
  }
}

/**
 * Fetch usage from Anthropic API with automatic token refresh
 */
async function fetchUsage(): Promise<UsageData | null> {
  const creds = await getOAuthCreds();
  if (!creds?.accessToken) return null;

  try {
    // Try with current token
    let result = await fetchUsageWithToken(creds.accessToken);

    // If expired, refresh and retry
    if (result.status === 401 && creds.refreshToken) {
      const newToken = await refreshOAuthToken(creds.refreshToken);
      if (newToken) {
        result = await fetchUsageWithToken(newToken);
      }
    }

    return result.data;
  } catch {
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

  const poll = useCallback(async () => {
    try {
      const data = await fetchUsage();
      if (data) {
        setUsage(data);
        setLastUpdated(new Date());
      } else {
        console.warn("[hyo] Usage fetch returned null — check keychain or token");
      }
    } catch (e) {
      console.error("[hyo] Usage fetch failed:", e);
    }
  }, []);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, 300000); // 5 minutes
    return () => clearInterval(interval);
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
    refresh: poll,
  };
}
