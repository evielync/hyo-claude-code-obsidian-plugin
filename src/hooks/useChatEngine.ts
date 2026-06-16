import { useState, useCallback, useRef } from "react";
import { ClaudeTransport } from "../claude-transport";

const HIDDEN_TOOLS = new Set([
  "TodoWrite",
  "TaskOutput",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
]);

export { HIDDEN_TOOLS };

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  displayText?: string; // user's typed text for display (excludes injected file blocks)
  thinking?: string;
  toolCalls?: ToolCallData[];
  orderedBlocks?: OrderedBlock[];
  streaming?: boolean;
  permissionRequest?: PermissionRequestData | null;
  askQuestion?: AskQuestionData | null;
  planReview?: PlanReviewData | null;
  isCompaction?: boolean;
  attachments?: { type: string; name: string; preview?: string }[];
}

export interface ToolCallData {
  id: string;
  name: string;
  input: any;
  result: string | null;
  _inputJson?: string;
}

export interface OrderedBlock {
  type: "text" | "thinking" | "tool";
  content?: string;
  toolId?: string;
  turnIndex: number;
  isSkillOutput?: boolean; // suppress text block emitted by Skill tool result
}

export interface PermissionRequestData {
  requestId: string;
  toolName: string;
  input?: any;
  resolved?: "allowed" | "denied";
}

export interface AskQuestionData {
  id: string;
  questions: { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[];
  answers: Record<string, string>;
}

export interface PlanReviewData {
  requestId: string;
  planContent: string | null;
  allowedPrompts: { tool: string; prompt: string }[];
  resolved?: "approved" | "rejected";
}

interface StreamState {
  toolCalls: ToolCallData[];
  orderedBlocks: OrderedBlock[];
  turnIndex: number;
  toolResultSinceLastText: boolean;
  suppressNextTextBlock: boolean; // set after Skill tool_result to hide content dump
}

interface ChatEngineOptions {
  cliPath: string;
  cwd: string;
  model: string;
  permissionMode: string;
  maxOutputTokens?: number;
}

function readPlanFile(cwd: string): string | null {
  try {
    const fs = require("fs");
    const path = require("path");
    const candidates = [
      path.join(cwd, ".claude", "plan.md"),
      path.join(cwd, "plan.md"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, "utf-8");
      }
    }
  } catch {
    // File system not available or file not found
  }
  return null;
}

export function useChatEngine(options: ChatEngineOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [generating, setGenerating] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const transportRef = useRef<ClaudeTransport | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const streamRef = useRef<StreamState>({
    toolCalls: [],
    orderedBlocks: [],
    turnIndex: 0,
    toolResultSinceLastText: false,
    suppressNextTextBlock: false,
  });
  const scrollRef = useRef({ nearBottom: true });
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  const updateLastAssistant = useCallback(
    (updater: (msg: Message) => Partial<Message>) => {
      setMessages((prev) => {
        const msgs = [...prev];
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "assistant") {
            msgs[i] = { ...msgs[i], ...updater(msgs[i]) };
            break;
          }
        }
        return msgs;
      });
    },
    []
  );

  const processEvent = useCallback(
    (event: any) => {
      // Log every event for debugging
      if (event.type === "stream_event") {
        const evt = event.event || event;
        if (evt.type !== "content_block_delta") {
          console.log("[hyo] event:", event.type, evt.type);
        }
      } else {
        console.log("[hyo] event:", event.type, event.subtype || event.request?.subtype || "");
      }

      const ss = streamRef.current;

      // System init
      if (event.type === "system" && event.subtype === "init") {
        if (event.session_id) {
          setSessionId(event.session_id);
        }
        return;
      }

      // Compaction
      if (event.type === "system" && event.subtype === "status") {
        return;
      }

      // Permission request (control_request with can_use_tool)
      if (event.type === "control_request") {
        const req = event.request || {};
        const toolName = req.tool_name || "";
        const requestId = event.request_id || "";
        console.log("[hyo][ask] control_request:", toolName, "requestId:", requestId);

        // AskUserQuestion — hold the control_request. DON'T respond.
        // The CLI blocks waiting for our control_response.
        // The question UI was set by the assistant event handler.
        // Update the id to the requestId so sendQuestionAnswer can
        // send the control_response when the user answers.
        if (toolName === "AskUserQuestion") {
          console.log("[hyo][ask] Holding AskUserQuestion control_request (NOT auto-approving). requestId:", requestId);
          const input = req.input || {};
          updateLastAssistant((msg) => ({
            askQuestion: msg.askQuestion
              ? { ...msg.askQuestion, id: requestId }
              : {
                  id: requestId,
                  questions: input.questions || [{ question: input.question }],
                  answers: {},
                },
          }));
          return;
        }

        // EnterPlanMode — auto-approve silently. No user gate needed.
        if (toolName === "EnterPlanMode") {
          transportRef.current?.sendPermissionResponse(requestId, "allow");
          return;
        }

        // ExitPlanMode — show plan review UI with plan content.
        // Claude is blocked until the user approves or rejects the plan.
        if (toolName === "ExitPlanMode") {
          const cwd = optionsRef.current.cwd;
          const planContent = readPlanFile(cwd);
          const allowedPrompts = req.input?.allowedPrompts || [];
          updateLastAssistant(() => ({
            planReview: {
              requestId,
              planContent,
              allowedPrompts,
            },
          }));
          return;
        }

        updateLastAssistant(() => ({
          permissionRequest: {
            requestId,
            toolName,
            input: req.input,
          },
        }));
        return;
      }

      // Result — turn complete
      if (event.type === "result") {
        updateLastAssistant(() => ({ streaming: false }));
        setGenerating(false);
        return;
      }

      // User event (tool results sent back by the system)
      if (event.type === "user") {
        const contentArr = event.message?.content || [];
        const toolResults = contentArr.filter((b: any) => b.type === "tool_result");
        console.log("[hyo][ask] user event blocks:", contentArr.map((b: any) => b.type));
        for (const tr of toolResults) {
          const matchedTool = ss.toolCalls.find((t) => t.id === tr.tool_use_id);
          console.log("[hyo][ask] tool_result for:", matchedTool?.name || "unknown", "tool_use_id:", tr.tool_use_id);
        }
        processContentBlocks(contentArr, ss);
        updateStreamingFromState(ss, updateLastAssistant);
        return;
      }

      // Assistant message (complete)
      if (event.type === "assistant") {
        const contentArr = event.message?.content || [];
        console.log("[hyo] assistant event blocks:", contentArr.map((b: any) => ({ type: b.type, name: b.name, textPreview: b.type === "text" ? (b.text || "").slice(0, 80) : undefined })));
        processContentBlocks(contentArr, ss);
        updateStreamingFromState(ss, updateLastAssistant);

        // Eagerly detect AskUserQuestion from the complete assistant event.
        // The control_request arrives AFTER this, so we set the question UI
        // now. The control_request handler will update the id to the requestId.
        const askTool = ss.toolCalls.find(
          (t) => t.name === "AskUserQuestion" && !t.result && t.input?.questions
        );
        if (askTool) {
          console.log("[hyo][ask] Detected AskUserQuestion in assistant event. Questions:", askTool.input.questions.length);
          updateLastAssistant(() => ({
            askQuestion: {
              id: askTool.id,
              questions: askTool.input.questions,
              answers: {},
            },
          }));
        }
        return;
      }

      // Stream event (incremental deltas)
      if (event.type === "stream_event") {
        const evt = event.event || event;

        // Tool use block start
        if (
          evt.type === "content_block_start" &&
          evt.content_block?.type === "tool_use"
        ) {
          const tool: ToolCallData = {
            id: evt.content_block.id,
            name: evt.content_block.name,
            input: {},
            result: null,
          };
          console.log("[hyo][ask] tool_use START:", tool.name, tool.id);
          if (!ss.toolCalls.find((t) => t.id === tool.id)) {
            ss.toolCalls.push(tool);
            ss.orderedBlocks.push({
              type: "tool",
              toolId: tool.id,
              turnIndex: ss.turnIndex,
            });
            // Suppress text blocks in the same turn immediately when a Skill call starts.
            // Skill content may have already streamed as text before this event arrives.
            if (tool.name === "Skill") {
              for (const b of ss.orderedBlocks) {
                if (b.type === "text" && b.turnIndex === ss.turnIndex) {
                  b.isSkillOutput = true;
                }
              }
            }
            updateStreamingFromState(ss, updateLastAssistant);
          }
        }

        // Content block stop
        if (evt.type === "content_block_stop") {
          const lastBlock = ss.orderedBlocks[ss.orderedBlocks.length - 1];
          console.log("[hyo][ask] content_block_stop — lastBlock type:", lastBlock?.type, "toolId:", lastBlock?.toolId);
          if (lastBlock?.type === "tool") {
            ss.toolResultSinceLastText = true;

            const tool = ss.toolCalls[ss.toolCalls.length - 1];
            console.log("[hyo][ask] content_block_stop for tool:", tool?.name, "id:", tool?.id, "hasInput:", !!tool?.input, "hasQuestions:", !!tool?.input?.questions, "hasInputJson:", !!tool?._inputJson);

            if (tool?.name === "AskUserQuestion") {
              // Ensure input is fully parsed from accumulated JSON
              if (tool._inputJson && !tool.input?.questions) {
                try {
                  tool.input = JSON.parse(tool._inputJson);
                  console.log("[hyo][ask] Parsed _inputJson, questions:", !!tool.input?.questions);
                } catch (e) {
                  console.log("[hyo][ask] Failed to parse _inputJson:", (e as Error).message);
                }
              }
              if (tool.input?.questions) {
                console.log("[hyo][ask] ✓ Setting askQuestion and INTERRUPTING. Questions:", tool.input.questions.length);
                const askQuestion: AskQuestionData = {
                  id: tool.id,
                  questions: tool.input.questions,
                  answers: {},
                };
                updateLastAssistant(() => ({ askQuestion }));
                transportRef.current?.sendInterrupt();
              } else {
                console.log("[hyo][ask] ✗ AskUserQuestion but NO questions found. input:", JSON.stringify(tool.input).slice(0, 200));
              }
            }
          }
        }

        // Message stop/delta — let result handler finalize
        if (evt.type === "message_stop" || evt.type === "message_delta") {
          return;
        }

        // Tool input JSON accumulation
        if (
          evt.type === "content_block_delta" &&
          evt.delta?.type === "input_json_delta"
        ) {
          const lastTool = ss.toolCalls[ss.toolCalls.length - 1];
          if (lastTool) {
            if (!lastTool._inputJson) lastTool._inputJson = "";
            lastTool._inputJson += evt.delta.partial_json || "";
            try {
              lastTool.input = JSON.parse(lastTool._inputJson);
            } catch {
              // Partial JSON, wait for more
            }
          }
        }

        // Text and thinking deltas
        if (evt.type === "content_block_delta") {
          const delta = evt.delta;

          if (delta?.type === "text_delta" && delta.text) {
            if (ss.toolResultSinceLastText && ss.orderedBlocks.length > 0)
              ss.turnIndex++;
            const existing = ss.orderedBlocks.find(
              (b) => b.type === "text" && b.turnIndex === ss.turnIndex
            );
            if (existing) {
              existing.content = (existing.content || "") + delta.text;
            } else {
              const isSkillOutput = ss.suppressNextTextBlock;
              ss.suppressNextTextBlock = false;
              console.log("[hyo] stream text block created: turnIndex=", ss.turnIndex, "isSkillOutput=", isSkillOutput, "preview=", delta.text.slice(0, 60));
              ss.orderedBlocks.push({
                type: "text",
                content: delta.text,
                turnIndex: ss.turnIndex,
                isSkillOutput,
              });
            }
            ss.toolResultSinceLastText = false;
            updateStreamingFromState(ss, updateLastAssistant);
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            const existing = ss.orderedBlocks.find(
              (b) => b.type === "thinking" && b.turnIndex === ss.turnIndex
            );
            if (existing) {
              existing.content = (existing.content || "") + delta.thinking;
            } else {
              ss.orderedBlocks.push({
                type: "thinking",
                content: delta.thinking,
                turnIndex: ss.turnIndex,
              });
            }
            updateStreamingFromState(ss, updateLastAssistant);
          }
        }
        return;
      }
    },
    [updateLastAssistant]
  );

  const sendMessage = useCallback(
    (text: string) => {
      const userMsg: Message = { role: "user", content: text };
      const assistantMsg: Message = {
        role: "assistant",
        content: "",
        thinking: "",
        toolCalls: [],
        orderedBlocks: [],
        streaming: true,
      };

      // Reset stream state
      streamRef.current = {
        toolCalls: [],
        orderedBlocks: [],
        turnIndex: 0,
        toolResultSinceLastText: false,
        suppressNextTextBlock: false,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setGenerating(true);
      scrollRef.current.nearBottom = true;

      // If no transport, create one
      if (!transportRef.current || !transportRef.current.isRunning()) {
        const transport = new ClaudeTransport({
          cliPath: options.cliPath,
          cwd: options.cwd,
          model: options.model,
          permissionMode: options.permissionMode,
          sessionId: sessionId || undefined,
          resume: !!sessionId,
          maxOutputTokens: options.maxOutputTokens,
          onMessage: processEvent,
          onError: (error) => {
            console.error("[hyo] CLI error:", error);
          },
          onClose: (code) => {
            console.log("[hyo] CLI closed with code:", code);
            setGenerating(false);
            updateLastAssistant(() => ({ streaming: false }));
            transportRef.current = null;
          },
        });
        transport.spawn();
        transportRef.current = transport;
      }

      transportRef.current.sendUserMessage(text);
    },
    [options, sessionId, processEvent, updateLastAssistant]
  );

  const sendPermissionResponse = useCallback(
    (requestId: string, behavior: "allow" | "allow_always" | "deny") => {
      transportRef.current?.sendPermissionResponse(requestId, behavior);
      updateLastAssistant((msg) => {
        const updates: Partial<Message> = {};
        if (msg.permissionRequest) {
          updates.permissionRequest = {
            ...msg.permissionRequest,
            resolved: behavior === "deny" ? "denied" : "allowed",
          };
        }
        if (msg.planReview && msg.planReview.requestId === requestId) {
          updates.planReview = {
            ...msg.planReview,
            resolved: behavior === "deny" ? "rejected" : "approved",
          };
        }
        return updates;
      });
    },
    [updateLastAssistant]
  );

  const sendQuestionAnswer = useCallback(
    (questionId: string, answers: Record<string, string>) => {
      console.log("[hyo][ask] Sending question answer. requestId:", questionId, "answers:", JSON.stringify(answers));

      // Send control_response with answers as updatedInput.
      // The CLI was blocked on the control_request — this unblocks it.
      // Claude receives the answers as the tool's input and continues.
      transportRef.current?.sendPermissionResponse(questionId, "allow", undefined, {
        answers,
      });

      // Clear the question UI. The assistant message stays streaming —
      // Claude will continue and the result event will finalize it.
      updateLastAssistant(() => ({ askQuestion: null }));
    },
    [updateLastAssistant]
  );

  const stopGeneration = useCallback(() => {
    transportRef.current?.sendInterrupt();
    setGenerating(false);
    updateLastAssistant(() => ({ streaming: false }));
  }, [updateLastAssistant]);

  const newChat = useCallback(() => {
    // Kill existing transport
    transportRef.current?.stop();
    transportRef.current = null;
    setMessages([]);
    setGenerating(false);
    setSessionId(null);
    streamRef.current = {
      toolCalls: [],
      orderedBlocks: [],
      turnIndex: 0,
      toolResultSinceLastText: false,
      suppressNextTextBlock: false,
    };
  }, []);

  return {
    messages,
    generating,
    sessionId,
    sendMessage,
    sendPermissionResponse,
    sendQuestionAnswer,
    stopGeneration,
    newChat,
    scrollRef,
  };
}

function processContentBlocks(contentArr: any[], ss: StreamState) {
  for (const block of contentArr) {
    if (block.type === "text") {
      if (ss.toolResultSinceLastText && ss.orderedBlocks.length > 0)
        ss.turnIndex++;
      const isSkillOutput = ss.suppressNextTextBlock;
      ss.suppressNextTextBlock = false;
      const existing = ss.orderedBlocks.find(
        (b) => b.type === "text" && b.turnIndex === ss.turnIndex
      );
      if (existing) {
        console.log("[hyo] text block UPDATED: turnIndex=", ss.turnIndex, "isSkillOutput=", existing.isSkillOutput, "preview=", (block.text || "").slice(0, 60));
        existing.content = block.text || "";
      } else {
        console.log("[hyo] text block created: turnIndex=", ss.turnIndex, "isSkillOutput=", isSkillOutput, "preview=", (block.text || "").slice(0, 60));
        ss.orderedBlocks.push({
          type: "text",
          content: block.text || "",
          turnIndex: ss.turnIndex,
          isSkillOutput,
        });
      }
      ss.toolResultSinceLastText = false;
    } else if (block.type === "thinking") {
      const existing = ss.orderedBlocks.find(
        (b) => b.type === "thinking" && b.turnIndex === ss.turnIndex
      );
      if (existing) existing.content = block.thinking || "";
      else
        ss.orderedBlocks.push({
          type: "thinking",
          content: block.thinking || "",
          turnIndex: ss.turnIndex,
        });
    } else if (block.type === "tool_use") {
      const tool: ToolCallData = {
        id: block.id,
        name: block.name,
        input: block.input,
        result: null,
      };
      if (!ss.toolCalls.find((t) => t.id === tool.id)) {
        ss.toolCalls.push(tool);
        ss.orderedBlocks.push({
          type: "tool",
          toolId: tool.id,
          turnIndex: ss.turnIndex,
        });
      }
    } else if (block.type === "tool_result") {
      const tool = ss.toolCalls.find((t) => t.id === block.tool_use_id);
      if (tool) {
        tool.result =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
        if (tool.name === "Skill") {
          ss.suppressNextTextBlock = true;
          // Retroactively suppress text blocks emitted in the same turn as the Skill call.
          // The skill content arrives as text deltas before the tool_result event fires.
          const skillBlock = ss.orderedBlocks.find(
            (b) => b.type === "tool" && b.toolId === tool.id
          );
          if (skillBlock) {
            for (const b of ss.orderedBlocks) {
              if (b.type === "text" && b.turnIndex === skillBlock.turnIndex) {
                b.isSkillOutput = true;
              }
            }
          }
        }
      }
      ss.toolResultSinceLastText = true;
    }
  }
}

function updateStreamingFromState(
  ss: StreamState,
  updateLastAssistant: (updater: (msg: Message) => Partial<Message>) => void
) {
  const textContent = ss.orderedBlocks
    .filter((b) => b.type === "text")
    .map((b) => b.content)
    .join("");
  const thinkingContent = ss.orderedBlocks
    .filter((b) => b.type === "thinking")
    .map((b) => b.content)
    .join("");

  updateLastAssistant(() => ({
    content: textContent,
    thinking: thinkingContent,
    toolCalls: [...ss.toolCalls],
    orderedBlocks: [...ss.orderedBlocks.map((b) => ({ ...b }))],
  }));
}
