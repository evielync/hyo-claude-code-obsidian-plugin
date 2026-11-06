import { debug } from "./debug";
import { Platform } from "obsidian";
// Node built-ins are desktop-only; deferred so this module loads on mobile.
const spawn: typeof import("child_process").spawn = Platform.isMobile ? (undefined as any) : require("child_process").spawn;
const os: typeof import("os") = Platform.isMobile ? (undefined as any) : require("os");
const path: typeof import("path") = Platform.isMobile ? (undefined as any) : require("path");

interface TitleGenOptions {
  cliPath: string;
  userMessage: string;
  assistantMessage: string;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function buildPrompt(userMsg: string, assistantMsg: string): string {
  const u = truncate(userMsg.trim(), 300);
  const a = truncate(assistantMsg.trim(), 300);
  return [
    "TASK: Generate a short title (3-6 words) that describes what this conversation is about.",
    "RULES: Output ONLY the title. No quotes. No explanation. No preamble. Just the title words.",
    "",
    "CONVERSATION:",
    `<user>${u}</user>`,
    `<assistant>${a}</assistant>`,
    "",
    "TITLE:",
  ].join("\n");
}

function cleanTitle(raw: string): string | null {
  let title = raw.trim();

  // Strip surrounding quotes
  if (
    (title.startsWith('"') && title.endsWith('"')) ||
    (title.startsWith("'") && title.endsWith("'"))
  ) {
    title = title.slice(1, -1).trim();
  }

  // Strip common LLM prefixes
  title = title.replace(/^title:\s*/i, "");
  title = title.replace(/^conversation title:\s*/i, "");

  // Cap length
  if (title.length > 60) {
    title = title.slice(0, 60);
  }

  return title.length > 0 ? title : null;
}

/**
 * Where the one-shot title call runs, and the PATH it sees. The folder is the
 * system temp folder (on Windows "/tmp" doesn't exist, and spawn fails with an
 * ENOENT that names claude.exe rather than the missing folder). The extra
 * directories are Mac and Linux install locations; Windows keeps the PATH it
 * inherited, which already covers npm and winget installs.
 */
export function titleSpawnOptions(
  platform: NodeJS.Platform = process.platform,
  baseEnv: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): { cwd: string; env: NodeJS.ProcessEnv } {
  const env = { ...baseEnv };
  if (platform !== "win32") {
    env.PATH = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      path.join(home, ".bun", "bin"),
      baseEnv.PATH || "",
    ].join(path.delimiter);
  }
  return { cwd: os.tmpdir(), env };
}

/**
 * Generate a conversation title using Claude Haiku in --print mode.
 * Returns null on any failure — caller should keep the existing title.
 */
export async function generateConversationTitle(
  options: TitleGenOptions,
): Promise<string | null> {
  const { cliPath, userMessage, assistantMessage } = options;
  const prompt = buildPrompt(userMessage, assistantMessage);

  return new Promise((resolve) => {
    const args = [
      "--print",
      prompt,
      "--model",
      "haiku",
      "--no-session-persistence",
    ];

    debug("[hyo][title] Spawning CLI for title generation...");

    const proc = spawn(cliPath, args, {
      ...titleSpawnOptions(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      console.warn("[hyo][title] Timed out after 30s");
      proc.kill("SIGTERM");
      resolve(null);
    }, 30_000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      console.error("[hyo][title] Spawn error:", err.message);
      resolve(null);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        console.error(
          "[hyo][title] CLI exited with code",
          code,
          "| stderr:",
          stderr.slice(0, 300),
        );
        resolve(null);
        return;
      }

      const title = cleanTitle(stdout);
      if (title) {
        debug("[hyo][title] Generated:", title);
      } else {
        console.warn("[hyo][title] CLI returned empty response");
      }
      resolve(title);
    });
  });
}
