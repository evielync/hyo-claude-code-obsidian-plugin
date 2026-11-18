/**
 * Plain words for what Claude is doing, for the voice's silent progress
 * notes ("The backend agent is reading Today. No result yet.") and for a
 * permission ask on screen, so the voice never hears raw tool names like
 * mcp__claude_ai_Circle_MCP__list_posts.
 */

/** A tool's input, as an object of unknown fields (anything else reads as empty). */
function fieldsOf(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** A tool input field as text: strings and numbers as themselves, anything else as "". */
function text(v: unknown): string {
  if (typeof v === "string") return v;
  return typeof v === "number" ? String(v) : "";
}

function base(p: unknown): string {
  const s = text(p).replace(/[\\/]+$/, "");
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
export function describeStep(name: string, input: unknown): string | null {
  const raw = name || "";
  const n = raw.toLowerCase();
  if (SILENT_TOOLS.has(n)) return null;
  const f = fieldsOf(input);
  if (n === "todowrite") {
    const todos: unknown[] = Array.isArray(f.todos) ? f.todos : [];
    const now = todos.map(fieldsOf).find((t) => t.status === "in_progress");
    const label = now ? text(now.activeForm) || text(now.content) : "";
    return label ? lowerFirst(clip(label)) : null;
  }
  if (n === "agent" || n === "task") {
    const d = text(f.description).trim();
    return d ? `working on ${lowerFirst(clip(d))}` : "working through it";
  }
  if (n === "skill") {
    const s = (text(f.skill) || text(f.name)).trim();
    return s ? `using the ${s.split(":").pop()} skill` : "using a skill";
  }
  const filePath = text(f.file_path);
  if (n === "read") return filePath ? `reading ${clip(base(filePath), 40)}` : "reading a file";
  if (n === "grep") return text(f.pattern) ? `searching for "${clip(text(f.pattern), 40)}"` : "searching through files";
  if (n === "glob" || n === "ls") return "looking through files";
  if (n === "edit" || n === "multiedit") return filePath ? `editing ${clip(base(filePath), 40)}` : "changing a file";
  if (n === "write") return filePath ? `writing ${clip(base(filePath), 40)}` : "writing a file";
  if (n === "notebookedit") return "editing a notebook";
  if (n === "websearch") return text(f.query) ? `searching the web for "${clip(text(f.query), 40)}"` : "searching the web";
  if (n === "webfetch") {
    try {
      return `reading ${new URL(text(f.url)).hostname.replace(/^www\./, "")}`;
    } catch {
      return "reading a web page";
    }
  }
  if (n === "bash") {
    const d = text(f.description).trim();
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
export function attentionLine(kind: "permission" | "question", toolName = "", input: unknown = null): string {
  if (kind === "question") return "I've put a question on screen for the user. Ask them to answer it there.";
  const what = describeStep(toolName, input) || "the next step";
  return `I need the user's OK on screen before I go ahead with ${what}. Ask them to allow it there.`;
}
