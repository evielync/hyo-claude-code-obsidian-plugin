import type { Scenario, StubReply } from "./harness";

const TODAY: StubReply = {
  match: /today|on for|calendar|agenda/i,
  reply:
    "You've got four on today: the CoK check-in at ten, recording the newsletter, outlining the November workshop, and a call with Dani at three. The check-in is the one with a time on it.\n[SCREEN]\n- **CoK check-in** — 10am\n- **Record the newsletter**\n- **Outline the November workshop** — due 6 Nov\n- **Call with Dani** — 3pm\n[/SCREEN]",
  ms: 8000,
  steps: [["Read", { file_path: "/v/Today.md" }], ["mcp__claude_ai_Google_Calendar__list_events", {}]],
};
const POOL: StubReply = {
  match: /pool|priorit/i,
  reply: "There are six in the pool for the next two weeks that aren't in today. The priority is the workshop outline, then the Momentum checkout copy. The full list is on screen.\n[SCREEN]\n1. Workshop outline\n2. Momentum checkout copy\n3. Newsletter draft\n4. Dani invoice\n5. Office hours prep\n6. Hub fix\n[/SCREEN]",
  ms: 9000,
  steps: [["Grep", { pattern: "due:" }], ["Read", { file_path: "/v/Pool.md" }]],
};
const COMMUNITY: StubReply = {
  match: /community/i,
  reply: "Nothing in the community needs you. Two new posts since this morning, both already answered by members.",
  ms: 9000,
  steps: [["mcp__claude_ai_Circle_MCP__list_posts", {}]],
  permission: { tool: "mcp__claude_ai_Circle_MCP__list_posts", input: {} },
};
const EMAIL: StubReply = {
  match: /email/i,
  reply: "Three emails need a reply: one from Dani about the invoice, one from a podcast host, and one from Stripe support.",
  ms: 7000,
  steps: [["mcp__claude_ai_Gmail__search_threads", {}]],
};

export const SCENARIOS: Scenario[] = [
  {
    name: "real-whats-on-today",
    about: "She asks what's on today. Real Claude in the sandbox (read-only). One job, one spoken answer with real specifics; then a follow-up about the answer; then bye.",
    claude: "real",
    steps: [
      { say: "Hey Chad, what's on for today?" },
      { waitAnswer: 200000 },
      { say: "Okay. Tell me a bit more about the first one." },
      { waitAnswer: 150000 },
      { say: "Great, thanks. Bye." },
      { wait: 4000 },
      { hangUp: true },
    ],
    jobs: [1, 2],
  },
  {
    name: "real-hang-up-mid-job",
    about: "She asks for something slow and hangs up while Claude works. The reply must still land in the chat, with no 'ended early' notice.",
    claude: "real",
    steps: [
      { say: "Can you go through my overdue tasks and tell me which ones matter most?" },
      { waitJob: 20000 },
      { wait: 8000 },
      { hangUp: true },
    ],
    jobs: [1, 1],
    expectReplyAfterHangUp: true,
  },
  {
    name: "permission-then-done",
    about: "Ev's 00:25 call: the job hits a permission, she allows it on screen and says 'Done'. One job, one answer.",
    claude: "stub",
    stubs: [COMMUNITY],
    steps: [
      { say: "Can you check the community for anything that needs me?" },
      { waitJob: 20000 },
      { wait: 7000 },
      { approve: true },
      { say: "Done." },
      { waitAnswer: 60000 },
      { hangUp: true },
    ],
    jobs: [1, 1],
  },
  {
    name: "rambling-with-correction",
    about: "A long question with a correction in the middle. Claude must get all of it, word for word, in one job.",
    claude: "stub",
    stubs: [POOL],
    steps: [
      { say: "So, um, I want to know what's in the pool of tasks this week that isn't already in today. Actually no, not this week, the next two weeks. And what our priorities are." },
      { waitAnswer: 60000 },
      { hangUp: true },
    ],
    jobs: [1, 1],
    expectSaid: [/next two weeks/i, /priorities/i, /pool/i],
  },
  {
    name: "small-talk",
    about: "Small talk only. No job.",
    claude: "stub",
    steps: [
      { say: "Hey, how's it going?" },
      { wait: 7000 },
      { say: "Pretty good. Just having a coffee before I get started." },
      { wait: 7000 },
      { hangUp: true },
    ],
    jobs: [0, 0],
  },
  {
    name: "today-then-follow-up",
    about: "What's on today (scripted answer with the detail on screen), then a follow-up the spoken answer covers.",
    claude: "stub",
    stubs: [TODAY, EMAIL],
    steps: [
      { say: "What's on today?" },
      { waitAnswer: 60000 },
      { say: "What time's the call with Dani?" },
      { wait: 9000 },
      { waitAnswer: 30000 },
      { hangUp: true },
    ],
    jobs: [1, 2],
  },
  {
    name: "two-asks-back-to-back",
    about: "Two different asks, one straight after the other.",
    claude: "stub",
    stubs: [TODAY, EMAIL],
    steps: [
      { say: "What's on my calendar today?" },
      { wait: 2500 },
      { say: "Oh, and how many emails need replies?" },
      { waitAnswer: 60000 },
      { waitAnswer: 30000 },
      { hangUp: true },
    ],
    jobs: [1, 2],
    expectSaid: [/calendar/i, /email/i],
  },
];
