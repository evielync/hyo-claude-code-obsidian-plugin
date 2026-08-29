import { Platform } from "obsidian";

const fs: typeof import("fs") = Platform.isMobile ? (undefined as any) : require("fs");
const path: typeof import("path") = Platform.isMobile ? (undefined as any) : require("path");
const os: typeof import("os") = Platform.isMobile ? (undefined as any) : require("os");

/**
 * Agents are a Claude Code feature: markdown files in `~/.claude/agents` that
 * the CLI loads by name via `--agent`. Claude Code owns the format and the
 * location; Hyo only lists them so they can be picked.
 *
 * Codex has no equivalent — its `agents` command browses sessions, and
 * AGENTS.md is project instructions. So there is nothing here to read on that
 * engine, and Hyo does not invent one.
 */
export function agentDirs(): string[] {
  return [path.join(os.homedir(), ".claude", "agents")];
}

export function findAgentFile(
  agentName: string,
  dirs: string[] = agentDirs(),
): string | null {
  if (!agentName) return null;
  for (const dir of dirs) {
    for (const candidate of [
      path.join(dir, `${agentName}.md`),
      path.join(dir, `${agentName.toLowerCase()}.md`),
    ]) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export interface AgentFile {
  name: string;
  description: string;
  path: string;
}

function parseFrontmatter(text: string): { name: string; description: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "" };
  const fm = match[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : "",
    description: descMatch ? descMatch[1].trim() : "",
  };
}

/** Every agent across all known directories, first definition of a name winning. */
export function listAgentFiles(): AgentFile[] {
  const seen = new Set<string>();
  const found: AgentFile[] = [];

  for (const dir of agentDirs()) {
    let files: string[];
    try {
      if (!fs.existsSync(dir)) continue;
      files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".md"))
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const file of files) {
      const full = path.join(dir, file);
      let content: string;
      try {
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const { name, description } = parseFrontmatter(content);
      const agentName = (name || file.replace(/\.md$/, "")).toLowerCase();
      if (seen.has(agentName)) continue;
      seen.add(agentName);
      found.push({ name: agentName, description: description || "", path: full });
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}
