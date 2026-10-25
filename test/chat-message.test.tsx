import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessage } from "../src/components/ChatMessage";
import { ChatMessage as PhoneChatMessage } from "../src/mobile/components/ChatMessage";

// Ev, 22 Oct: during a call the chat shows the work, not what she said.
test("a request handed over on a call doesn't show in the chat; a typed message does (desktop and phone)", () => {
  for (const Msg of [ChatMessage, PhoneChatMessage] as any[]) {
    const spoken = renderToStaticMarkup(<Msg message={{ role: "user", content: "Hey, um, can you let me know what's on the plate", displayText: "Hey, um, can you let me know what's on the plate", handoff: true }} />);
    assert.equal(spoken, "");
    const typed = renderToStaticMarkup(<Msg message={{ role: "user", content: "Close the check-in tasks" }} />);
    assert.match(typed, /Close the check-in tasks/);
  }
});
