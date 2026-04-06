import { useState, useCallback, useRef, useEffect } from "react";
import { ClaudeTransport } from "../claude-transport";
import type {
  Message,
  ToolCallData,
  OrderedBlock,
  AskQuestionData,
} from "./useChatEngine";
import { listPastSessions, loadSessionHistory, saveCustomTitle, type PastSession } from "../session-parser";

// Re-export for convenience
export type { PastSession };

// ------- types -------

interface StreamState {
  toolCalls: ToolCallData[];
  orderedBlocks: OrderedBlock[];
  turnIndex: number;
  toolResultSinceLastText: boolean;
}

export interface TabSession {
  id: string;
  cliSessionId: string | null;
  title: string;
  messages: Message[];
  generating: boolean;
  model: string;
  permissionMode: string;
}

interface SessionState {
  tabs: TabSession[];
  activeTabId: string;
}

interface SessionManagerOptions {
  cliPath: string;
  cwd: string;
  model: string;
  permissionMode: string;
}

// ------- utilities -------

function genId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function processContentBlocks(contentArr: any[], ss: StreamState) {
  for (const block of contentArr) {
    if (block.type === "text") {
      if (ss.toolResultSinceLastText && ss.orderedBlocks.length > 0)
        ss.turnIndex++;
      const existing = ss.orderedBlocks.find(
        (b) => b.type === "text" && b.turnIndex === ss.turnIndex
      );
      if (existing) existing.content = block.text || "";
      else
        ss.orderedBlocks.push({
          type: "text",
          content: block.text || "",
          turnIndex: ss.turnIndex,
        });
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
      }
      ss.toolResultSinceLastText = true;
    }
  }
}

function buildSnapshot(ss: StreamState) {
  return {
    content: ss.orderedBlocks
      .filter((b) => b.type === "text")
      .map((b) => b.content)
      .join(""),
    thinking: ss.orderedBlocks
      .filter((b) => b.type === "thinking")
      .map((b) => b.content)
      .join(""),
    toolCalls: [...ss.toolCalls],
    orderedBlocks: [...ss.orderedBlocks.map((b) => ({ ...b }))],
  };
}

// ------- hook -------

export function useSessionManager(options: SessionManagerOptions) {
  const [state, setState] = useState<SessionState>(() => {
    const id = genId();
    return {
      tabs: [
        {
          id,
          cliSessionId: null,
          title: "New conversation",
          messages: [],
          generating: false,
          model: options.model,
          permissionMode: options.permissionMode,
        },
      ],
      activeTabId: id,
    };
  });

  const [pastSessions, setPastSessions] = useState<PastSession[]>([]);

  const transportsRef = useRef<Record<string, ClaudeTransport>>({});
  const streamStatesRef = useRef<Record<string, StreamState>>({});
  const scrollRef = useRef({ nearBottom: true });
  const stateRef = useRef(state);
  stateRef.current = state;

  // Cleanup transports on unmount
  useEffect(() => {
    return () => {
      for (const id of Object.keys(transportsRef.current)) {
        transportsRef.current[id]?.stop();
      }
    };
  }, []);

  // ------- internal helpers -------

  const updateTabLastAssistant = useCallback(
    (tabId: string, updater: (msg: Message) => Partial<Message>) => {
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => {
          if (tab.id !== tabId) return tab;
          const msgs = [...tab.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant") {
              msgs[i] = { ...msgs[i], ...updater(msgs[i]) };
              break;
            }
          }
          return { ...tab, messages: msgs };
        }),
      }));
    },
    []
  );

  const makeProcessEvent = useCallback(
    (tabId: string) => {
      return (event: any) => {
        if (event.type === "stream_event") {
          const evt = event.event || event;
          if (evt.type !== "content_block_delta") {
            console.log("[hyo] event:", event.type, evt.type);
          }
        } else {
          console.log(
            "[hyo] event:",
            event.type,
            event.subtype || event.request?.subtype || ""
          );
        }

        const ss = streamStatesRef.current[tabId];
        if (!ss) return;

        // System init
        if (event.type === "system" && event.subtype === "init") {
          if (event.session_id) {
            setState((prev) => ({
              ...prev,
              tabs: prev.tabs.map((tab) =>
                tab.id === tabId
                  ? { ...tab, cliSessionId: event.session_id }
                  : tab
              ),
            }));
          }
          return;
        }

        if (event.type === "system") return;

        // Permission request
        if (event.type === "control_request") {
          const req = event.request || {};
          const toolName = req.tool_name || "";
          const requestId = event.request_id || "";

          if (toolName === "AskUserQuestion") {
            transportsRef.current[tabId]?.sendPermissionResponse(
              requestId,
              true
            );
            const input = req.input || {};
            const askQuestion: AskQuestionData = {
              id: requestId,
              questions: input.questions || [{ question: input.question }],
              answers: {},
            };
            updateTabLastAssistant(tabId, () => ({ askQuestion }));
            return;
          }

          updateTabLastAssistant(tabId, () => ({
            permissionRequest: { requestId, toolName, input: req.input },
          }));
          return;
        }

        // Result — turn complete
        if (event.type === "result") {
          updateTabLastAssistant(tabId, () => ({ streaming: false }));
          setState((prev) => ({
            ...prev,
            tabs: prev.tabs.map((tab) =>
              tab.id === tabId ? { ...tab, generating: false } : tab
            ),
          }));
          return;
        }

        // User event (tool results)
        if (event.type === "user") {
          const contentArr = event.message?.content || [];
          processContentBlocks(contentArr, ss);
          updateTabLastAssistant(tabId, () => buildSnapshot(ss));
          return;
        }

        // Assistant message (complete)
        if (event.type === "assistant") {
          const contentArr = event.message?.content || [];
          processContentBlocks(contentArr, ss);
          updateTabLastAssistant(tabId, () => buildSnapshot(ss));
          return;
        }

        // Stream event (incremental deltas)
        if (event.type === "stream_event") {
          const evt = event.event || event;

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
            if (!ss.toolCalls.find((t) => t.id === tool.id)) {
              ss.toolCalls.push(tool);
              ss.orderedBlocks.push({
                type: "tool",
                toolId: tool.id,
                turnIndex: ss.turnIndex,
              });
              updateTabLastAssistant(tabId, () => buildSnapshot(ss));
            }
          }

          if (evt.type === "content_block_stop") {
            const lastBlock = ss.orderedBlocks[ss.orderedBlocks.length - 1];
            if (lastBlock?.type === "tool") {
              ss.toolResultSinceLastText = true;
            }
          }

          if (evt.type === "message_stop" || evt.type === "message_delta") {
            return;
          }

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
                // partial
              }
            }
          }

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
                ss.orderedBlocks.push({
                  type: "text",
                  content: delta.text,
                  turnIndex: ss.turnIndex,
                });
              }
              ss.toolResultSinceLastText = false;
              updateTabLastAssistant(tabId, () => buildSnapshot(ss));
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
              updateTabLastAssistant(tabId, () => buildSnapshot(ss));
            }
          }
          return;
        }
      };
    },
    [updateTabLastAssistant]
  );

  // ------- tab management -------

  const newTab = useCallback(() => {
    const id = genId();
    setState((prev) => {
      const activeTab = prev.tabs.find((t) => t.id === prev.activeTabId);
      return {
        tabs: [
          ...prev.tabs,
          {
            id,
            cliSessionId: null,
            title: "New conversation",
            messages: [],
            generating: false,
            model: activeTab?.model || options.model,
            permissionMode: activeTab?.permissionMode || options.permissionMode,
          },
        ],
        activeTabId: id,
      };
    });
  }, [options.model, options.permissionMode]);

  const closeTab = useCallback((tabIdToClose: string) => {
    transportsRef.current[tabIdToClose]?.stop();
    delete transportsRef.current[tabIdToClose];
    delete streamStatesRef.current[tabIdToClose];

    setState((prev) => {
      const remaining = prev.tabs.filter((t) => t.id !== tabIdToClose);

      if (remaining.length === 0) {
        const newId = genId();
        return {
          tabs: [
            {
              id: newId,
              cliSessionId: null,
              title: "New conversation",
              messages: [],
              generating: false,
              model: options.model,
              permissionMode: options.permissionMode,
            },
          ],
          activeTabId: newId,
        };
      }

      let activeTabId = prev.activeTabId;
      if (prev.activeTabId === tabIdToClose) {
        const idx = prev.tabs.findIndex((t) => t.id === tabIdToClose);
        const newIdx = Math.min(idx, remaining.length - 1);
        activeTabId = remaining[newIdx].id;
      }

      return { tabs: remaining, activeTabId };
    });
  }, []);

  const switchTab = useCallback((id: string) => {
    setState((prev) => ({ ...prev, activeTabId: id }));
    scrollRef.current.nearBottom = true;
  }, []);

  const renameTab = useCallback((id: string, title: string) => {
    setState((prev) => {
      const tab = prev.tabs.find((t) => t.id === id);

      // If this tab has a persisted session, save the custom title and refresh dropdown
      if (tab?.cliSessionId) {
        saveCustomTitle(options.cwd, tab.cliSessionId, title);
        // Refresh past sessions to update dropdown
        setTimeout(() => refreshPastSessions(), 0);
      }

      return {
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.id === id ? { ...t, title } : t
        ),
      };
    });
  }, [options.cwd, refreshPastSessions]);

  // ------- messaging -------

  const sendMessage = useCallback(
    (content: string | any[], meta?: { displayText?: string; attachedFileNames?: string[] }) => {
      const tabId = stateRef.current.activeTabId;

      // For display, use the typed text; for arrays (image messages) use displayText or placeholder
      const displayContent = typeof content === "string"
        ? (meta?.displayText ?? content)
        : (meta?.displayText ?? "");

      const userMsg: Message = {
        role: "user",
        content: displayContent,
        displayText: meta?.displayText,
        attachments: meta?.attachedFileNames?.map((name) => ({ type: "file", name })),
      };
      const assistantMsg: Message = {
        role: "assistant",
        content: "",
        thinking: "",
        toolCalls: [],
        orderedBlocks: [],
        streaming: true,
      };

      streamStatesRef.current[tabId] = {
        toolCalls: [],
        orderedBlocks: [],
        turnIndex: 0,
        toolResultSinceLastText: false,
      };

      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => {
          if (tab.id !== tabId) return tab;
          const titleText = meta?.displayText ?? (typeof content === "string" ? content : "");
          const title =
            tab.messages.length === 0 && tab.title === "New conversation"
              ? titleText.slice(0, 40) + (titleText.length > 40 ? "..." : "")
              : tab.title;
          return {
            ...tab,
            title,
            messages: [...tab.messages, userMsg, assistantMsg],
            generating: true,
          };
        }),
      }));
      scrollRef.current.nearBottom = true;

      if (
        !transportsRef.current[tabId] ||
        !transportsRef.current[tabId].isRunning()
      ) {
        const currentTab = stateRef.current.tabs.find(
          (t) => t.id === tabId
        );
        const cliSessionId = currentTab?.cliSessionId;

        const transport = new ClaudeTransport({
          cliPath: options.cliPath,
          cwd: options.cwd,
          model: currentTab?.model || options.model,
          permissionMode: currentTab?.permissionMode || options.permissionMode,
          sessionId: cliSessionId || undefined,
          resume: !!cliSessionId,
          onMessage: makeProcessEvent(tabId),
          onError: (error) => console.error("[hyo] CLI error:", error),
          onClose: (code) => {
            const wasGenerating = stateRef.current.tabs.find(
              (t) => t.id === tabId
            )?.generating;
            setState((prev) => ({
              ...prev,
              tabs: prev.tabs.map((tab) =>
                tab.id === tabId ? { ...tab, generating: false } : tab
              ),
            }));
            updateTabLastAssistant(tabId, () => ({ streaming: false }));
            // If process exited with error while generating, show error message
            if (code !== 0 && code !== null && wasGenerating) {
              const errorMsg: Message = {
                role: "assistant",
                content: `_Claude process exited unexpectedly (code ${code}). Start a new conversation to continue._`,
                thinking: "",
                toolCalls: [],
                orderedBlocks: [],
                streaming: false,
              };
              setState((prev) => ({
                ...prev,
                tabs: prev.tabs.map((tab) =>
                  tab.id === tabId
                    ? { ...tab, messages: [...tab.messages, errorMsg] }
                    : tab
                ),
              }));
            }
            delete transportsRef.current[tabId];
          },
        });
        transport.spawn();
        transportsRef.current[tabId] = transport;
      }

      transportsRef.current[tabId].sendUserMessage(content);
    },
    [options, makeProcessEvent, updateTabLastAssistant]
  );

  const sendPermissionResponse = useCallback(
    (requestId: string, allowed: boolean) => {
      const tabId = stateRef.current.activeTabId;
      transportsRef.current[tabId]?.sendPermissionResponse(requestId, allowed);
      updateTabLastAssistant(tabId, (msg) => ({
        permissionRequest: msg.permissionRequest
          ? {
              ...msg.permissionRequest,
              resolved: allowed ? ("allowed" as const) : ("denied" as const),
            }
          : null,
      }));
    },
    [updateTabLastAssistant]
  );

  const sendQuestionAnswer = useCallback(
    (questionId: string, answer: string) => {
      const tabId = stateRef.current.activeTabId;

      streamStatesRef.current[tabId] = {
        toolCalls: [],
        orderedBlocks: [],
        turnIndex: 0,
        toolResultSinceLastText: false,
      };

      updateTabLastAssistant(tabId, () => ({
        askQuestion: null,
        streaming: false,
      }));
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id !== tabId
            ? tab
            : {
                ...tab,
                messages: [
                  ...tab.messages,
                  {
                    role: "assistant" as const,
                    content: "",
                    thinking: "",
                    toolCalls: [],
                    orderedBlocks: [],
                    streaming: true,
                  },
                ],
                generating: true,
              }
        ),
      }));

      transportsRef.current[tabId]?.sendUserMessage(answer);
    },
    [updateTabLastAssistant]
  );

  const stopGeneration = useCallback(() => {
    const tabId = stateRef.current.activeTabId;
    transportsRef.current[tabId]?.sendInterrupt();
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, generating: false } : tab
      ),
    }));
    updateTabLastAssistant(tabId, () => ({ streaming: false }));
  }, [updateTabLastAssistant]);

  const setTabModel = useCallback((model: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === prev.activeTabId ? { ...tab, model } : tab
      ),
    }));
  }, []);

  const setTabPermissionMode = useCallback((permissionMode: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === prev.activeTabId ? { ...tab, permissionMode } : tab
      ),
    }));
  }, []);

  // ------- past sessions -------

  const refreshPastSessions = useCallback(() => {
    try {
      const sessions = listPastSessions(options.cwd);
      setPastSessions(sessions);
    } catch (e) {
      console.error("[hyo] Failed to list past sessions:", e);
    }
  }, [options.cwd]);

  useEffect(() => {
    refreshPastSessions();
  }, [refreshPastSessions]);

  const openPastSession = useCallback((pastSession: PastSession) => {
    const existing = stateRef.current.tabs.find(
      (t) => t.cliSessionId === pastSession.id
    );
    if (existing) {
      setState((prev) => ({ ...prev, activeTabId: existing.id }));
      return;
    }

    // Load conversation history from JSONL
    const history = loadSessionHistory(options.cwd, pastSession.id);
    const messages: Message[] = history.map((m) => ({
      role: m.role,
      content: m.content,
      thinking: m.thinking || "",
      toolCalls: m.toolCalls || [],
      orderedBlocks: m.orderedBlocks || [],
      streaming: false,
    }));

    const id = genId();
    setState((prev) => {
      const activeTab = prev.tabs.find((t) => t.id === prev.activeTabId);
      return {
        tabs: [
          ...prev.tabs,
          {
            id,
            cliSessionId: pastSession.id,
            title: pastSession.title,
            messages,
            generating: false,
            model: activeTab?.model || options.model,
            permissionMode: activeTab?.permissionMode || options.permissionMode,
          },
        ],
        activeTabId: id,
      };
    });
  }, [options.cwd, options.model, options.permissionMode]);

  // ------- return -------

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeMessages: activeTab?.messages || [],
    activeGenerating: activeTab?.generating || false,
    activeModel: activeTab?.model || options.model,
    activePermissionMode: activeTab?.permissionMode || options.permissionMode,
    newTab,
    closeTab,
    switchTab,
    renameTab,
    setTabModel,
    setTabPermissionMode,
    sendMessage,
    sendPermissionResponse,
    sendQuestionAnswer,
    stopGeneration,
    pastSessions,
    openPastSession,
    refreshPastSessions,
    scrollRef,
  };
}
