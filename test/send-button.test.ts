import test from "node:test";
import assert from "node:assert/strict";
import { sendButtonMode } from "../src/components/SendButton";

test("one button: call when the box is empty, send once there's text, stop while answering", () => {
  assert.equal(sendButtonMode({ generating: false, hasContent: false, inCall: false }), "call");
  assert.equal(sendButtonMode({ generating: false, hasContent: true, inCall: false }), "send", "typing swaps it to send");
  assert.equal(sendButtonMode({ generating: true, hasContent: true, inCall: false }), "stop");
  assert.equal(sendButtonMode({ generating: true, hasContent: false, inCall: false }), "stop");
  assert.equal(sendButtonMode({ generating: false, hasContent: false, inCall: true }), "send", "during a call the call bar is the control");
});
