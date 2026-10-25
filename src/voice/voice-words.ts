/**
 * Plain words for what Claude is doing, for the voice's silent progress
 * notes ("The backend agent is reading Today. No result yet.") and for a
 * permission ask on screen, so the voice never hears raw tool names like
 * mcp__claude_ai_Circle_MCP__list_posts.
 */

function base(p: unknown): string {
  const s = String(p || "").replace(/[\\/]+$/, "");
  const last = s.split(/[\\/]/).pop() || s;
  return last.replace(/\.(md|markdown|txt)$/i, "");
}

function clip(s: string, n = 60): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** Tools that are Claude's own bookkeeping — nothing to tell the user. */
const SILENT_TOOLS = new Set(["toolsearch", "taskoutput", "enterplanmode", "exitplanmode", "askuserquestion", "killshell", "bashoutput"]);

/**
 * Plain words for a step Claude is taking, for the voice: "reading Today",
 * "searching for 'due: 2026-10-22'", "running a sub-agent: Fetch overdue
 * tasks". Null for bookkeeping that isn't worth mentioning.
 */
export function describeStep(name: string, input: any): string | null {
  const raw = name || "";
  const n = raw.toLowerCase();
  if (SILENT_TOOLS.has(n)) return null;
  if (n === "todowrite") {
    const todos: any[] = Array.isArray(input?.todos) ? input.todos : [];
    const now = todos.find((t) => t?.status === "in_progress");
    const label = now?.activeForm || now?.content;
    return label ? lowerFirst(clip(String(label))) : null;
  }
  if (n === "agent" || n === "task") {
    const d = String(input?.description || "").trim();
    return d ? `working on ${lowerFirst(clip(d))}` : "working through it";
  }
  if (n === "skill") {
    const s = String(input?.skill || input?.name || "").trim();
    return s ? `using the ${s.split(":").pop()} skill` : "using a skill";
  }
  if (n === "read") return input?.file_path ? `reading ${clip(base(input.file_path), 40)}` : "reading a file";
  if (n === "grep") return input?.pattern ? `searching for "${clip(String(input.pattern), 40)}"` : "searching through files";
  if (n === "glob" || n === "ls") return "looking through files";
  if (n === "edit" || n === "multiedit") return input?.file_path ? `editing ${clip(base(input.file_path), 40)}` : "changing a file";
  if (n === "write") return input?.file_path ? `writing ${clip(base(input.file_path), 40)}` : "writing a file";
  if (n === "notebookedit") return "editing a notebook";
  if (n === "websearch") return input?.query ? `searching the web for "${clip(String(input.query), 40)}"` : "searching the web";
  if (n === "webfetch") {
    try {
      return `reading ${new URL(String(input?.url)).hostname.replace(/^www\./, "")}`;
    } catch {
      return "reading a web page";
    }
  }
  if (n === "bash") {
    const d = String(input?.description || "").trim();
    return d ? `running a command to ${lowerFirst(clip(d.replace(/\.$/, "")))}` : "running a command";
  }
  if (n.startsWith("mcp__")) {
    const parts = raw.split("__");
    const tool = (parts[2] || "").replace(/[_-]+/g, " ").trim();
    if (/calendar/i.test(raw)) return "checking the calendar";
    if (/gmail|mail/i.test(raw)) return "checking email";
    if (/qmd|search|query/i.test(raw)) return "searching your notes";
    return tool ? `using ${clip(tool, 40)}` : "using a connected tool";
  }
  if (n.includes("calendar")) return "checking the calendar";
  if (n.includes("gmail") || n.includes("mail")) return "checking email";
  if (n.includes("search")) return "searching";
  return "working";
}

/** Something on screen needs the user, said as the agent would say it. */
export function attentionLine(kind: "permission" | "question", toolName = "", input: any = null): string {
  if (kind === "question") return "I've put a question on screen for the user. Ask them to answer it there.";
  const what = describeStep(toolName, input) || "the next step";
  return `I need the user's OK on screen before I go ahead with ${what}. Ask them to allow it there.`;
}
