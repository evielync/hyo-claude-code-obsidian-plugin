// A view drops any approval, question or plan Claude is no longer waiting on.
import test from "node:test";
import assert from "node:assert/strict";
import { asksHeld } from "../src/held-asks";

const msgs = () => [
  { role: "assistant", permissionRequests: [{ requestId: "r-old" }, { requestId: "r-done", resolved: "allowed" }, { requestId: "r-live" }] },
  { role: "assistant", planReview: { requestId: "p-old" }, askQuestion: { id: "q-old" } },
  { role: "assistant", askQuestion: { id: "toolu_123" } },
];

test("cards for asks that are over go; answered ones and live ones stay", () => {
  const out = asksHeld(msgs(), { ids: ["r-live"] });
  assert.deepEqual(out[0].permissionRequests, [{ requestId: "r-done", resolved: "allowed" }, { requestId: "r-live" }]);
  assert.equal(out[1].planReview, null);
  assert.equal(out[1].askQuestion, null);
});

test("a question still waiting for its request stays mid-turn, and goes once the turn is over", () => {
  assert.deepEqual(asksHeld(msgs(), { ids: [] })[2].askQuestion, { id: "toolu_123" });
  assert.equal(asksHeld(msgs(), { ids: [], turnOver: true })[2].askQuestion, null);
});

test("nothing to drop: the same messages back, so nothing re-renders", () => {
  const m = [{ role: "assistant", permissionRequests: [{ requestId: "a" }] }];
  assert.equal(asksHeld(m, { ids: ["a"] }), m);
});
