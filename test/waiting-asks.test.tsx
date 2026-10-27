import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessages } from "../src/components/ChatMessages";
import { ChatMessages as PhoneChatMessages } from "../src/mobile/components/ChatMessages";
import { waitingAsks, asksEnded, endedJobs, applyJobEvent } from "../src/background-jobs";

const ask = { requestId: "req-7", toolName: "Bash", input: { command: "gmail search" }, asker: "Check Gmail", jobId: "bg-1" };
const thread = (resolved?: "allowed") => [
  { role: "user", content: "check my email" },
  { role: "assistant", content: "On it, a background job is checking.", permissionRequests: [{ ...ask, ...(resolved ? { resolved } : {}) }] },
];

test("a background job's ask on a finished reply shows as a card at the bottom, labelled with the job (desktop and phone)", () => {
  for (const List of [ChatMessages, PhoneChatMessages] as any[]) {
    const props = { scrollRef: { current: { nearBottom: true } }, onPermissionResponse: () => {}, onQuestionAnswer: () => {} };
    const html = renderToStaticMarkup(<List {...props} messages={thread()} />);
    assert.match(html, /Background job: Check Gmail/);
    assert.match(html, /hyo-permission/);
    assert.ok(html.lastIndexOf("Background job: Check Gmail") > html.indexOf("On it, a background job"), "below the reply");
    const answered = renderToStaticMarkup(<List {...props} messages={thread("allowed")} />);
    assert.doesNotMatch(answered, /Background job: Check Gmail/, "answered: no card");
  }
});

test("asks go when their job ends, or all of them when the process ends", () => {
  const jobs = applyJobEvent({}, { type: "system", subtype: "task_started", task_id: "bg-1", description: "Check Gmail" })!;
  const after = applyJobEvent(jobs, { type: "system", subtype: "task_notification", task_id: "bg-1", status: "completed" })!;
  const ended = endedJobs(jobs, after);
  assert.deepEqual([...ended], ["bg-1"]);
  const msgs: any[] = thread();
  msgs[1].permissionRequests.push({ requestId: "req-8", toolName: "Read", jobId: "bg-2" }, { requestId: "req-9", toolName: "Edit" });
  const left = asksEnded(msgs, ended);
  assert.deepEqual(waitingAsks(left).map((r: any) => r.requestId), ["req-8", "req-9"], "only that job's ask goes");
  assert.deepEqual(waitingAsks(asksEnded(left, null)), [], "the process ended: nothing can answer any");
  assert.equal(asksEnded(msgs, new Set(["other"])), msgs, "unchanged when nothing goes");
  // A reply still being written shows its own cards; it isn't doubled at the bottom.
  assert.deepEqual(waitingAsks([{ role: "assistant", streaming: true, permissionRequests: [ask] }]), []);
});
