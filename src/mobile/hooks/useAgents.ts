// Desktop lists agent files in ~/.claude/agents via fs. Mobile has no fs, so
// it asks the gateway (which runs on the Mac and can read them) via the
// list_agents RPC. Falls back to a single default entry until the list loads.
import { useEffect, useState } from "react";
import { GatewayClient } from "../gateway-client";

export interface Agent {
  name: string;
  description: string;
  color: string;
}

// Empty until the gateway answers list_agents with this Mac's real agents.
// No hardcoded default — a stranger's Mac has its own agents, not "chad".
const DEFAULT_AGENTS: Agent[] = [];

export function useAgents(gatewayUrl?: string): Agent[] {
  const [agents, setAgents] = useState<Agent[]>(DEFAULT_AGENTS);
  useEffect(() => {
    if (!gatewayUrl) return;
    let cancelled = false;
    GatewayClient.get(gatewayUrl)
      .listAgents()
      .then((list) => {
        if (cancelled || !Array.isArray(list) || list.length === 0) return;
        setAgents(
          list.map((a: any) => ({
            name: a.name,
            description: a.description || "",
            color: "var(--text-accent)",
          }))
        );
      })
      .catch(() => {
        /* keep the default until the gateway answers */
      });
    return () => {
      cancelled = true;
    };
  }, [gatewayUrl]);
  return agents;
}
