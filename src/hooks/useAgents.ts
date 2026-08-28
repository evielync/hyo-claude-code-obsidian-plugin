import { useEffect, useState } from "react";
import { Platform } from "obsidian";
// Node built-ins are desktop-only; deferred so this module loads on mobile.
const fs: typeof import("fs") = Platform.isMobile ? (undefined as any) : require("fs");
const path: typeof import("path") = Platform.isMobile ? (undefined as any) : require("path");
const os: typeof import("os") = Platform.isMobile ? (undefined as any) : require("os");

export interface Agent {
  name: string;
  description: string;
  color: string;
}

function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  const hue = (Math.abs(hash) * 137.508) % 360;
  return `hsl(${hue}, 55%, 55%)`;
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

/**
 * The system prompt an agent file defines, with its frontmatter removed.
 *
 * Claude Code loads these itself from `--agent <name>`. Codex has no agent
 * concept, so its transport reads the same file and passes the body as the
 * thread's developer instructions — which means one agent definition works on
 * both engines rather than being a Claude-only feature.
 */
export function loadAgentPrompt(agentName: string): string | null {
  if (!agentName) return null;
  try {
    const dir = path.join(os.homedir(), ".claude", "agents");
    const candidates = [
      path.join(dir, `${agentName}.md`),
      path.join(dir, `${agentName.toLowerCase()}.md`),
    ];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
      return body || null;
    }
  } catch {
    // No agent file — the engine runs without one.
  }
  return null;
}

export function useAgents(): Agent[] {
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    try {
      const dir = path.join(os.homedir(), ".claude", "agents");
      const loaded: Agent[] = [];

      if (fs.existsSync(dir)) {
        const files = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isFile() && d.name.endsWith(".md"))
          .map((d) => d.name);

        for (const file of files) {
          const full = path.join(dir, file);
          const content = fs.readFileSync(full, "utf8");
          const { name, description } = parseFrontmatter(content);
          const agentName = (name || file.replace(/\.md$/, "")).toLowerCase();
          loaded.push({
            name: agentName,
            description: description || "",
            color: colorFromName(agentName),
          });
        }
      }

      loaded.sort((a, b) => a.name.localeCompare(b.name));

      // Always prepend the generic "no agent" default
      loaded.unshift({
        name: "",
        description: "No agent — just the model on its own",
        color: "var(--text-muted)",
      });

      setAgents(loaded);
    } catch (e) {
      console.warn("[hyo] Failed to load agents:", e);
    }
  }, []);

  return agents;
}
