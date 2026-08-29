import { useEffect, useState } from "react";
import { listAgentFiles } from "../agents";

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

export function useAgents(): Agent[] {
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    try {
      const loaded: Agent[] = listAgentFiles().map((a) => ({
        name: a.name,
        description: a.description,
        color: colorFromName(a.name),
      }));

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
