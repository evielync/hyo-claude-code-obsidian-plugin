import { debug } from "./debug";
import { spawn } from "child_process";
import * as os from "os";

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

    const home = os.homedir();
    const env = { ...process.env };
    env.PATH = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      `${home}/.npm-global/bin`,
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      `${home}/.bun/bin`,
      process.env.PATH || "",
    ].join(":");

    debug("[hyo][title] Spawning CLI for title generation...");

    const proc = spawn(cliPath, args, {
      cwd: "/tmp",
      env,
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
