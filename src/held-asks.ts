// Which approvals, questions and plans a conversation is really waiting on.
//
// A card stays up in a view until it hears the ask was answered. But an ask
// can also end without an answer: the turn was stopped, Claude moved on, the
// process was restarted or exited. Then the card would sit there for good and
// the conversation would show as waiting on you when it isn't. The session
// owner holds the truth (the asks Claude is still blocked on) and sends it as
// `hyo_asks_open` whenever that can have changed; each view drops any card it
// shows that isn't in it.

interface HeldMsg {
  permissionRequests?: { requestId: string; resolved?: string }[];
  planReview?: { requestId: string; resolved?: string } | null;
  askQuestion?: { id: string } | null;
}

/**
 * Keep only the asks Claude is still waiting on. A question shown straight
 * from Claude's message carries the tool's id (`toolu_…`) until its request
 * arrives, so it only goes once the turn is over.
 */
export function asksHeld<M extends HeldMsg>(messages: M[], open: { ids: string[]; turnOver?: boolean }): M[] {
  const held = new Set(open.ids || []);
  let changed = false;
  const out = messages.map((m) => {
    let next = m;
    if (m.permissionRequests?.some((r) => !r.resolved && !held.has(r.requestId))) {
      next = { ...next, permissionRequests: m.permissionRequests.filter((r) => r.resolved || held.has(r.requestId)) };
    }
    if (m.planReview && !m.planReview.resolved && !held.has(m.planReview.requestId)) {
      next = { ...next, planReview: null };
    }
    if (m.askQuestion && !held.has(m.askQuestion.id) && (open.turnOver || !m.askQuestion.id.startsWith("toolu_"))) {
      next = { ...next, askQuestion: null };
    }
    if (next !== m) changed = true;
    return next;
  });
  return changed ? out : messages;
}
