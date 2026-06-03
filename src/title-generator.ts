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
  const u = truncate(userMsg.trim(), 500);
  const a = truncate(assistantMsg.trim(), 500);
  return [
    "Generate a concise, descriptive title (maximum 6 words) for this conversation.",
    "Return ONLY the title text — no quotes, no prefix, no formatting.",
    "",
    `User: ${u}`,
    "",
    `Assistant: ${a}`,
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

    console.log("[hyo] Generating conversation title...");

    const proc = spawn(cliPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      console.log("[hyo] Title generation timed out after 10s");
      proc.kill("SIGTERM");
      resolve(null);
    }, 10_000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      console.error("[hyo] Title generation spawn error:", err.message);
      resolve(null);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        console.error(
          "[hyo] Title generation failed (code",
          code,
          "):",
          stderr.slice(0, 200),
        );
        resolve(null);
        return;
      }

      const title = cleanTitle(stdout);
      if (title) {
        console.log("[hyo] Generated title:", title);
      } else {
        console.log("[hyo] Title generation returned empty response");
      }
      resolve(title);
    });
  });
}
