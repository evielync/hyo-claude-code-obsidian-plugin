import test from "node:test";
import assert from "node:assert/strict";
import { isInjectedContext } from "../src/reply-stream";
import { parseSessionEntries } from "../src/session-parser";
import { parseSessionLines } from "../src/mobile/session-parser";

// Ev, 26 Oct: a conversation started on the phone loaded the
// cok-workshop-design skill. Reopened on the laptop, the skill's whole
// instructions showed as a grey message under "Used the … skill". These are
// the entries from that conversation file (712f87e4…), text shortened.
const entries = [
  {
    type: "user",
    isSidechain: false,
    promptSource: "sdk",
    message: { role: "user", content: [{ type: "text", text: "Let's start chatting about this weeks workshop for cok" }] },
  },
  {
    type: "assistant",
    isSidechain: false,
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      content: [
        {
          type: "tool_use",
          id: "toolu_01FZpp6CKdFjeo9oDr2bibJK",
          name: "Skill",
          input: { skill: "cok-workshop-design", args: "Your AI-Powered Business Operating System — Thursday 29 Oct" },
        },
      ],
    },
  },
  {
    type: "user",
    isSidechain: false,
    promptId: "c9364d0f-5979-4c49-91af-df28ae1c192d",
    sourceToolAssistantUUID: "90bb6d2a-fc69-4af6-ace7-a68b8b09f870",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_01FZpp6CKdFjeo9oDr2bibJK", content: "Launching skill: cok-workshop-design" }],
    },
  },
  {
    type: "user",
    isSidechain: false,
    promptId: "c9364d0f-5979-4c49-91af-df28ae1c192d",
    isMeta: true,
    turnCompanion: true,
    sourceToolUseID: "toolu_01FZpp6CKdFjeo9oDr2bibJK",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "Base directory for this skill: /Users/evielynchapman/Dropbox/EV-HQ/.claude/skills/cok-workshop-design\n\n# CoK Workshop Design Companion\n\nHelp Ev think through and shape College of Knowledge workshops…",
        },
      ],
    },
  },
  {
    type: "assistant",
    isSidechain: false,
    message: { id: "msg_2", model: "claude-opus-5-5", content: [{ type: "text", text: "Where do you want to start with Thursday's workshop?" }] },
  },
];

test("the skill's injected instructions are recognised", () => {
  assert.equal(isInjectedContext(entries[3]), true);
  assert.equal(isInjectedContext(entries[0]), false);
  assert.equal(isInjectedContext(entries[2]), false);
});

for (const [name, parse] of [
  ["desktop", parseSessionEntries],
  ["phone", parseSessionLines],
] as const) {
  test(`${name}: a reopened conversation keeps the skill line and drops its instructions`, () => {
    const msgs = parse(entries as any[]);
    const all = JSON.stringify(msgs);
    assert.ok(!all.includes("Base directory for this skill"), "the skill text must not show");
    assert.deepEqual(
      msgs.map((m) => m.role),
      ["user", "assistant"],
      "Ev's message, then one reply holding the skill call and the answer"
    );
    const reply = msgs[1];
    assert.equal(reply.toolCalls?.[0]?.name, "Skill");
    assert.equal(reply.toolCalls?.[0]?.result, "Launching skill: cok-workshop-design");
    assert.ok(reply.content.includes("Where do you want to start"));
  });
}

// The live stream sends the same text as a user event marked isSynthetic,
// straight after the Skill tool's result (captured from CLI 2.1.280).
test("live: the skill's instructions in the stream are recognised too", () => {
  const live = {
    type: "user",
    parent_tool_use_id: null,
    isSynthetic: true,
    message: { role: "user", content: [{ type: "text", text: "Invoke the `content-ideas` skill (defined in `skills/content-ideas/SKILL.md`)…" }] },
  };
  const toolResult = {
    type: "user",
    parent_tool_use_id: null,
    tool_use_result: { success: true, commandName: "content-ideas" },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_013S9ZtaLmJasLLfPYfsuCD8", content: "Launching skill: content-ideas" }] },
  };
  assert.equal(isInjectedContext(live), true);
  assert.equal(isInjectedContext(toolResult), false);
});
