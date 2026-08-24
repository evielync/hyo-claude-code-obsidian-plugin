// Desktop spawned a one-shot `claude --print ... --model haiku` process to
// name a conversation. On mobile that becomes a gateway RPC — the server
// runs the same one-shot CLI call (see generateTitle in hyo-gateway.mjs)
// and hands back a cleaned title, or null on failure/timeout.

import { GatewayClient } from "./gateway-client";

interface TitleGenOptions {
  gatewayUrl: string;
  userMessage: string;
  assistantMessage: string;
}

/**
 * Generate a conversation title via the gateway.
 * Returns null on any failure — caller should keep the existing title.
 */
export async function generateConversationTitle(options: TitleGenOptions): Promise<string | null> {
  const { gatewayUrl, userMessage, assistantMessage } = options;
  try {
    return await GatewayClient.get(gatewayUrl).generateTitle(userMessage, assistantMessage);
  } catch (e) {
    console.error("[hyo][title] Generation failed:", e);
    return null;
  }
}
