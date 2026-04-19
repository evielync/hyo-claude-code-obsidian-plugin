import { useEffect, useState } from "react";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface Agent {
  name: string;
  description: string;
  color: string;
  isDefault: boolean;
}

// Predefined colors for known agents, hash-based for new ones
const AGENT_COLORS: Record<string, string> = {
  chad: "#D4956A",      // Warm tan
  stella: "#9B6BA6",    // Purple
  ivy: "#6BA69B",       // Teal
  content: "#A69B6B",   // Olive
};

function colorFromName(name: string): string {
  // Use predefined color if available
  if (AGENT_COLORS[name]) return AGENT_COLORS[name];

  // Otherwise generate from hash with better distribution
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  // Use golden ratio for better color distribution
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

export const DEFAULT_AGENT = "";

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
            isDefault: agentName === DEFAULT_AGENT,
          });
        }
      }

      // Only add chad fallback if at least one other agent was found
      if (loaded.length > 0 && !loaded.find((a) => a.name === DEFAULT_AGENT)) {
        loaded.push({
          name: DEFAULT_AGENT,
          description: "Default — Ev's Chief of Staff",
          color: AGENT_COLORS[DEFAULT_AGENT],
          isDefault: true,
        });
      }

      loaded.sort((a, b) => {
        if (a.isDefault) return -1;
        if (b.isDefault) return 1;
        return a.name.localeCompare(b.name);
      });
      setAgents(loaded);
    } catch (e) {
      console.warn("[hyo] Failed to load agents:", e);
    }
  }, []);

  return agents;
}
