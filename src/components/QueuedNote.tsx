import React from "react";

/**
 * The line under a message waiting for Claude's reply to finish, on the
 * desktop and the phone. Where Claude's process can take a message mid-reply,
 * "Send now" sends it straight away to steer the reply under way
 * (session-owner.ts). Once pressed, on any device, it says the message is on
 * its way until Claude takes it in.
 */
export function QueuedNote({
  qid,
  steerable,
  steering,
  onSendNow,
}: {
  qid: string;
  steerable?: boolean;
  steering?: boolean;
  onSendNow?: (qid: string) => void;
}) {
  if (steering) {
    return <div className="hyo-message-queued">Sent now: Claude reads it at its next step</div>;
  }
  return (
    <div className="hyo-message-queued">
      <span>Queued: sends when the current reply finishes</span>
      {steerable && onSendNow && (
        <button className="hyo-queued-send-now" onClick={() => onSendNow(qid)}>
          Send now
        </button>
      )}
    </div>
  );
}
