// Desktop scans the skills folders with fs to power the "/" slash menu. Mobile
// has no fs, so it asks the gateway (which runs on the Mac and can read them)
// via the list_skills RPC, then folds in the skills the CLI itself bundles —
// the same list desktop shows. Empty until the gateway answers; the built-in
// commands (/compact, /context) live in ChatPanel and need no gateway.
import { useEffect, useState } from "react";
import { GatewayClient } from "../gateway-client";
import { withBundledSkills } from "../../bundled-skills";

export interface Skill {
  name: string;
  description: string;
  content: string;
}

export function useSkills(gatewayUrl?: string): Skill[] {
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    if (!gatewayUrl) return;
    let cancelled = false;
    GatewayClient.get(gatewayUrl)
      .listSkills()
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return;
        setSkills(
          withBundledSkills(
            list.map((s: any) => ({
              name: String(s.name || ""),
              description: s.description || "",
              content: "",
            })).filter((s: Skill) => s.name)
          )
        );
      })
      .catch(() => {
        /* stay empty until the gateway answers */
      });
    return () => {
      cancelled = true;
    };
  }, [gatewayUrl]);
  return skills;
}
