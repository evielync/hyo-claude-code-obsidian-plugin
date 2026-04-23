import { useEffect, useState } from "react";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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
        description: "Standard Claude without a specific agent",
        color: "var(--text-muted)",
      });

      setAgents(loaded);
    } catch (e) {
      console.warn("[hyo] Failed to load agents:", e);
    }
  }, []);

  return agents;
}
