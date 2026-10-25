import { runBank, DATA, type MakeBuild } from "./harness";
import { SCENARIOS } from "./scenarios";
// 0.6.10, from a worktree of the tag (RELEASE_TREE, default /tmp/hyo-0610),
// with only a headless-audio patch so it runs here.
import { GptLiveSession, buildLiveInstructions, readAgentIdentity, describeToolForVoice } from "@release/voice/gpt-live";
import { LIVE_BACKEND_PERSONA, HANDOFF_NOTE, parseVoiceResponse } from "@release/voice/voice-persona";
import { resolveLiveVoice } from "../../src/voice/live-voice";

/**
 * 0.6.10's call logic, as useVoiceMode.ts and ChatPanel.tsx ran it: greet on
 * connect, the latest user turn as the request (with the unseen voice turns
 * in front), a "started" note, a 25 s "still working", progress notes on each
 * tool, the spoken part of the reply as one commentary, superseded results
 * kept silent. The same custom voice is used for a fair comparison.
 */
const make: MakeBuild = (key, h) => {
  const v = resolveLiveVoice(DATA.gptLiveVoice, DATA.gptLiveCustomVoices);
  let session: any = null;
  let liveDelegation: string | null = null;
  const queue: string[] = [];
  let pendingVoice: string[] = [];
  let nudge: any = null;
  let live = false;
  session = new GptLiveSession({
    transport: "ws",
    greet: true,
    apiKey: key,
    voice: v.voice as any,
    instructions: buildLiveInstructions(DATA.voicePersonality || "", readAgentIdentity(DATA.defaultAgent || "chad")),
    history: [],
    headless: h.headless,
    onState: (s: string) => {
      if (s === "closed") h.onEnded(null, "closed");
      else if (s !== "connecting" && !live) {
        live = true;
        h.onLive();
      }
    },
    onTurn: (side: any, text: string) => {
      pendingVoice.push(`${side === "user" ? "User" : "You (voice)"}: ${text}`);
      h.onTurn(side, text);
    },
    onLevel: () => {},
    onDelegation: (id: string, text: string) => {
      liveDelegation = id;
      if (!text) {
        session.appendThinking("No request text was heard for this hand-off; ask the user to say it again.", id);
        return;
      }
      queue.push(id);
      const prefix = pendingVoice.length
        ? `[Said on a voice call just now — your voice model handled these turns; you haven't seen them yet]\n${pendingVoice.join("\n")}\n[End of voice call excerpt]`
        : "";
      pendingVoice = [];
      const content = `${text}\n\n${HANDOFF_NOTE}`;
      h.job(prefix ? `${prefix}\n\n${content}` : content, text);
      session.appendThinking("The backend agent has started on this. No result yet.", id);
      if (nudge) clearTimeout(nudge);
      nudge = setTimeout(() => {
        nudge = null;
        if (queue.includes(id)) session.appendCommentary("Still working on it; it's taking a little longer than usual.", id);
      }, 25000);
    },
    onError: (m: string) => h.onError(m),
  } as any);
  const finishHandoff = (spoken: string) => {
    const id = queue.shift() ?? liveDelegation;
    if (nudge) clearTimeout(nudge);
    nudge = null;
    if (queue.length > 0) {
      session.appendThinking(`Earlier result, now superseded: ${spoken}`, id);
      return;
    }
    session.appendCommentary(spoken, id);
    liveDelegation = null;
  };
  let ended = false;
  return {
    start: () => session.start(),
    hangUp: () => {
      if (ended) return;
      ended = true;
      if (nudge) clearTimeout(nudge);
      session.stop();
      setTimeout(() => h.onEnded(null, "hung-up"), 0);
    },
    claudeReply: (md) => {
      if (ended) return;
      const parsed = parseVoiceResponse(md || "");
      const spoken = parsed.spoken.trim();
      finishHandoff(spoken || (parsed.screens.length ? "It's on screen now." : "Done."));
    },
    claudeStep: (name, input) => {
      if (ended) return;
      session.appendThinking(`The backend agent is ${describeToolForVoice(name, input)}. No result yet.`, queue[0] ?? liveDelegation);
    },
    permissionAsked: (tool, input) => {
      if (ended) return;
      const cmd = input?.command;
      const desc = tool === "Bash" && cmd ? `Hyo wants to run: ${cmd}` : `Hyo wants to use ${tool}.`;
      session.appendThinking(`A permission ask is on the user's screen: ${desc} Tell them to allow or deny it on screen.`, liveDelegation);
    },
    permissionAnswered: () => {},
  };
};

void runBank("release-0.6.10", SCENARIOS, make, LIVE_BACKEND_PERSONA);
