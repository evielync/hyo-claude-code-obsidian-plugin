/**
 * What a conversation's background agents are doing right now.
 *
 * Claude Code runs a background agent inside the same CLI process as the chat
 * and reports on it through system messages on the stream (captured from
 * 2.1.280, test/fixtures/two-background-agents.jsonl):
 *
 *   task_started        { task_id, tool_use_id, description, subagent_type, is_backgrounded, task_type }
 *   task_progress       { task_id, description: what it's doing now ("Fetching https://example.com"), last_tool_name }
 *   task_updated        { task_id, patch: { status: "completed" | … } }
 *   task_notification   { task_id, status, summary }  — finished; Claude starts a turn to report it
 *   background_tasks_changed { tasks: [{ task_id, description, task_type }] }  — the full list still running
 *
 * Permission prompts from a background agent arrive as ordinary
 * `can_use_tool` control requests carrying `agent_id`, which is the task id.
 *
 * Pure, shared by the desktop and phone session managers and the gateway.
 */

export interface BackgroundJob {
  id: string;
  /** The job as Claude named it when it started ("Check personal Gmail for Westpac"). */
  title: string;
  /** What it's doing right now, in the CLI's words ("Searching Gmail"). Empty until it reports. */
  activity: string;
  /** Which agent type runs it ("general-purpose", "Explore", "chad"); drives the avatar letter. */
  agentType: string;
  startedAt: number;
}

export type JobMap = Record<string, BackgroundJob>;

const DONE = new Set(["completed", "failed", "killed", "stopped", "cancelled", "error"]);

/**
 * Fold one stream event into the jobs. Returns the new map, or null when the
 * event doesn't change anything (so callers can skip a re-render).
 */
export function applyJobEvent(jobs: JobMap, event: any, now: number = Date.now()): JobMap | null {
  if (!event || event.type !== "system") return null;
  const id = typeof event.task_id === "string" ? event.task_id : "";
  switch (event.subtype) {
    case "task_started": {
      if (!id) return null;
      const prev = jobs[id];
      return {
        ...jobs,
        [id]: {
          id,
          title: clean(event.description) || prev?.title || "Background job",
          activity: prev?.activity || "",
          agentType: String(event.subagent_type || prev?.agentType || ""),
          startedAt: prev?.startedAt || now,
        },
      };
    }
    case "task_progress": {
      if (!id) return null;
      const prev = jobs[id];
      const activity = activityWords(event.description);
      if (!prev) {
        // Missed the start (Hyo reconnected mid-job): track it from here.
        return { ...jobs, [id]: { id, title: activity || "Background job", activity, agentType: String(event.subagent_type || ""), startedAt: now } };
      }
      if (!activity || activity === prev.activity) return null;
      return { ...jobs, [id]: { ...prev, activity } };
    }
    case "task_updated": {
      const status = event.patch?.status;
      if (!id || !jobs[id] || !DONE.has(String(status))) return null;
      return without(jobs, id);
    }
    case "task_notification": {
      if (!id || !jobs[id]) return null;
      return without(jobs, id);
    }
    case "background_tasks_changed": {
      const list: any[] = Array.isArray(event.tasks) ? event.tasks : [];
      const live = new Set(list.map((t) => t?.task_id).filter(Boolean));
      let changed = false;
      const next: JobMap = {};
      for (const [k, j] of Object.entries(jobs)) {
        if (live.has(k)) next[k] = j;
        else changed = true;
      }
      for (const t of list) {
        if (!t?.task_id || next[t.task_id]) continue;
        next[t.task_id] = { id: t.task_id, title: clean(t.description) || "Background job", activity: "", agentType: "", startedAt: now };
        changed = true;
      }
      return changed ? next : null;
    }
  }
  return null;
}

/** Running jobs, oldest first — the order their status lines show in. */
export function jobList(jobs: JobMap | undefined): BackgroundJob[] {
  return Object.values(jobs || {}).sort((a, b) => a.startedAt - b.startedAt);
}

export function hasRunningJobs(jobs: JobMap | undefined): boolean {
  return !!jobs && Object.keys(jobs).length > 0;
}

/** The line a job shows above the composer: what it's doing now, else its name. */
export function jobLine(job: BackgroundJob): string {
  return job.activity || job.title;
}

/**
 * Which job a permission prompt comes from, by the request's `agent_id`.
 * Null for the chat's own prompts.
 */
export function jobAsking(jobs: JobMap | undefined, request: any): BackgroundJob | null {
  const id = request?.agent_id;
  if (!id || !jobs) return null;
  return jobs[id] || null;
}

/** The line on a permission card from a background job. */
export function permissionAskerLine(asker: string): string {
  return `Background job: ${asker}`;
}

/** The avatar letter for a job's agent: "general-purpose" → "G". */
export function jobInitial(job: BackgroundJob): string {
  const s = (job.agentType || job.title || "A").replace(/[^A-Za-z]/g, "");
  return (s.charAt(0) || "A").toUpperCase();
}

// The CLI's progress text is already plain ("Fetching https://example.com",
// "Reading SKILL.md"). A shell step reads "Running <what the command is for>",
// which is clearer without the "Running".
function activityWords(raw: unknown): string {
  const s = clean(raw);
  if (!s) return "";
  const m = /^Running (.+)$/.exec(s);
  const out = m ? m[1] : s;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function clean(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

function without(jobs: JobMap, id: string): JobMap {
  const next = { ...jobs };
  delete next[id];
  return next;
}

/**
 * Background agents run inside the chat's Claude process, so stopping that
 * process stops them. Anything that has to restart it (a new system prompt
 * for a voice call, a fresh Claude after an update or sign-in) waits here
 * until the jobs are done, then runs.
 */
export class IdleGate {
  private waiting: (() => void)[] = [];
  private busy = false;

  /** The latest jobs; runs whatever was waiting once there are none. */
  update(jobs: JobMap | undefined): void {
    this.busy = hasRunningJobs(jobs);
    if (this.busy) return;
    const run = this.waiting;
    this.waiting = [];
    for (const fn of run) fn();
  }

  /** Run now if nothing's running, else once the last job finishes. Returns whether it ran now. */
  whenIdle(fn: () => void): boolean {
    if (!this.busy) {
      fn();
      return true;
    }
    this.waiting.push(fn);
    return false;
  }

  get pending(): number {
    return this.waiting.length;
  }
}

/**
 * Whether a send may swap the tab's process for one with a different system
 * prompt (a call starting or ending). Never mid-turn, and never while
 * background jobs are running in it; the next send after they finish swaps.
 */
export function maySwapProcess(o: { running: boolean; midTurn: boolean; jobs: JobMap | undefined; promptChanged: boolean }): boolean {
  return o.running && o.promptChanged && !o.midTurn && !hasRunningJobs(o.jobs);
}
