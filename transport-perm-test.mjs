// Regression test for the "approved tool calls run with empty input" bug.
//
// Drives the REAL compiled ClaudeTransport (not a reimplementation) through a
// full permission round trip and asserts the approved tool kept its arguments.
//
//   npx esbuild src/claude-transport.ts --bundle --platform=node \
//     --format=esm --external:obsidian --outfile=/tmp/transport.mjs
//   node transport-perm-test.mjs
//
// The bug: sendPermissionResponse sent `updatedInput: updatedInput || {}`, and
// the main allow path (useSessionManager.ts:860) passes no input — so every
// approved call executed with its arguments stripped.
import { ClaudeTransport } from "/tmp/transport.mjs";
import { readFileSync, unlinkSync } from "node:fs";

const TARGET = `/tmp/hyo-transport-check-${process.pid}.txt`;
const SENTINEL = "transport-round-trip-ok";

let sawPerm = false;
let toolResults = "";
let approvedTool = "";

const transport = new ClaudeTransport({
  cliPath: "/usr/local/bin/claude",
  // A clean dir with no .claude/settings.local.json, so an argument-bearing
  // tool actually prompts. EV-HQ blanket-allows Write, which would suppress
  // the approval path entirely and make this test vacuously pass.
  cwd: "/tmp/hyo-test-vault",
  model: "claude-sonnet-5",
  permissionMode: "default",
  onMessage: (ev) => {
    if (ev.type === "control_request" && ev.request?.subtype === "can_use_tool") {
      sawPerm = true;
      approvedTool = ev.request.tool_name;
      console.log(`← permission request: ${approvedTool}`);
      console.log(`  CLI sent input: ${JSON.stringify(ev.request.input)}`);
      // Exactly how the UI's Allow button calls it: no updatedInput argument.
      transport.sendPermissionResponse(ev.request_id, "allow", approvedTool);
      console.log("  → sendPermissionResponse(requestId, 'allow', toolName)");
    }

    if (ev.type === "user") {
      for (const c of ev.message?.content || []) {
        if (c.type === "tool_result") {
          toolResults += typeof c.content === "string" ? c.content : JSON.stringify(c.content);
        }
      }
    }

    if (ev.type === "result") {
      console.log("\n─── tool result ───");
      console.log(toolResults.slice(0, 160) || "(empty)");
      console.log("───────────────────\n");

      let onDisk = null;
      try { onDisk = readFileSync(TARGET, "utf8"); } catch { /* absent */ }

      if (!sawPerm) {
        console.log("INCONCLUSIVE — no permission prompt fired.");
        transport.stop(); process.exit(2);
      }
      if (onDisk?.includes(SENTINEL)) {
        unlinkSync(TARGET);
        console.log(`PASSED ✓ — ${approvedTool} approved and kept its real input; file on disk.`);
        transport.stop(); process.exit(0);
      }
      console.log(`FAILED ✗ — approved tool lost its input; ${TARGET} never created.`);
      transport.stop(); process.exit(1);
    }
  },
  onError: (e) => { if (!/^\s*$/.test(e)) process.stderr.write(`err: ${e.slice(0, 120)}\n`); },
  onClose: () => {},
});

transport.spawn();
transport.sendUserMessage(
  `Use the Write tool to create the file ${TARGET} containing exactly the single line: ${SENTINEL}\nDo not use any other tool. Do not read anything first.`
);

setTimeout(() => { console.log("timeout"); transport.stop(); process.exit(1); }, 120000);
