import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { ClaudeTransport } from "../../src/claude-transport";

/**
 * The live bank: scripted GPT-Live calls against OpenAI with synthesised
 * speech (macOS `say`, rendered to a file, never played), through a build's
 * real call code on the WebSocket path. The same scenarios run on the v2
 * build (v2.ts) and on 0.6.10 (release.ts) so the two can be compared.
 *
 * Nothing is played aloud. Real-Claude calls run in the chad sandbox in plan
 * mode (read-only); their session files are removed afterwards.
 */

export const HOME = os.homedir();
export const SANDBOX = path.join(HOME, "Dropbox/chad");
export const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "../../data.json"), "utf8"));
const AUDIO_CACHE = path.join(HOME, ".cache/hyo-call-bank/audio");
const RATE = 24000;
const CHUNK_MS = 20;
const CHUNK = (RATE * 2 * CHUNK_MS) / 1000;
const SILENCE = Buffer.alloc(CHUNK);
const VOICE_RMS = 0.01;

(globalThis as any).window = globalThis;

export function openAiKey(): string {
  return execFileSync("security", ["find-generic-password", "-s", "openai-api-key", "-w"]).toString().trim();
}

export interface Clip {
  pcm: Buffer;
  text: string;
}

export function clipFor(text: string): Clip {
  fs.mkdirSync(AUDIO_CACHE, { recursive: true });
  const h = createHash("sha1").update(text).digest("hex").slice(0, 16);
  const wav = path.join(AUDIO_CACHE, `${h}.wav`);
  if (!fs.existsSync(wav)) {
    const aiff = path.join(AUDIO_CACHE, `${h}.aiff`);
    execFileSync("say", ["-v", "Flo (English (UK))", "-r", "175", "-o", aiff, text]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wav]);
    fs.unlinkSync(aiff);
  }
  const b = fs.readFileSync(wav);
  const i = b.indexOf("data");
  return { pcm: b.subarray(i + 8, i + 8 + b.readUInt32LE(i + 4)), text };
}

function rms(pcm: Buffer): number {
  let s = 0;
  const n = Math.floor(pcm.length / 2);
  for (let k = 0; k < n; k++) s += (pcm.readInt16LE(k * 2) / 32768) ** 2;
  return Math.sqrt(s / Math.max(1, n));
}

// ---------------------------------------------------------------------------
// Her microphone: speech clips streamed in real time, silence between
// ---------------------------------------------------------------------------

export class Mic {
  private clip: { pcm: Buffer; pos: number; done: () => void } | null = null;
  private timer: any = null;
  private t0 = 0;
  private sent = 0;
  start(send: (b64: string) => void): () => void {
    this.t0 = Date.now();
    this.sent = 0;
    this.timer = setInterval(() => {
      const due = Math.floor((Date.now() - this.t0) / CHUNK_MS);
      while (this.sent < due) {
        this.sent++;
        let c = SILENCE;
        if (this.clip) {
          c = this.clip.pcm.subarray(this.clip.pos, this.clip.pos + CHUNK);
          this.clip.pos += CHUNK;
          if (c.length < CHUNK) c = Buffer.concat([c, Buffer.alloc(CHUNK - c.length)]);
          if (this.clip.pos >= this.clip.pcm.length) {
            const d = this.clip.done;
            this.clip = null;
            d();
          }
        }
        send(c.toString("base64"));
      }
    }, CHUNK_MS);
    return () => clearInterval(this.timer);
  }
  speak(clip: Clip): Promise<void> {
    return new Promise((done) => (this.clip = { pcm: clip.pcm, pos: 0, done }));
  }
  get speaking(): boolean {
    return !!this.clip;
  }
}

// ---------------------------------------------------------------------------
// Claude's side: real (sandbox, read-only) or scripted
// ---------------------------------------------------------------------------

export interface ClaudeHooks {
  onReply: (markdown: string) => void;
  onStep: (name: string, input: any) => void;
  onPermission: (tool: string, input: any) => void;
  log: (line: string) => void;
}

export interface StubReply {
  match: RegExp;
  reply: string;
  ms?: number;
  steps?: Array<[string, any]>;
  permission?: { tool: string; input: any };
}

export interface ClaudeSide {
  send(prompt: string): void;
  approve(): void;
  stop(): void;
  busy(): boolean;
  sessionId?: string;
}

/** Jobs go one at a time, in order (Hyo's send queue). */
export class StubClaude implements ClaudeSide {
  private queue: string[] = [];
  private running = false;
  private waiting: (() => void) | null = null;
  private stopped = false;
  constructor(private replies: StubReply[], private hooks: ClaudeHooks) {}
  send(prompt: string) {
    this.queue.push(prompt);
    void this.next();
  }
  approve() {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }
  stop() {
    this.stopped = true;
  }
  busy() {
    return this.running || this.queue.length > 0;
  }
  private async next() {
    if (this.running || this.stopped) return;
    const p = this.queue.shift();
    if (p === undefined) return;
    this.running = true;
    const r = this.replies.find((x) => x.match.test(p)) || { match: /./, reply: "Done. Nothing else needed.", ms: 5000 };
    const ms = r.ms ?? 6000;
    const steps = r.steps ?? [];
    const gap = ms / (steps.length + 2);
    for (const [name, input] of steps) {
      await sleep(gap);
      this.hooks.onStep(name, input);
    }
    if (r.permission) {
      await sleep(gap);
      this.hooks.onPermission(r.permission.tool, r.permission.input);
      await new Promise<void>((res) => (this.waiting = res));
    }
    await sleep(gap);
    this.running = false;
    this.hooks.onReply(r.reply);
    void this.next();
  }
}

export class RealClaude implements ClaudeSide {
  private t: ClaudeTransport;
  private queue: string[] = [];
  private current = false;
  private text: string[] = [];
  sessionId: string;
  constructor(persona: string, private hooks: ClaudeHooks) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    this.sessionId = require("crypto").randomUUID();
    this.t = new ClaudeTransport({
      cliPath: DATA.cliPath || "claude",
      cwd: SANDBOX,
      model: DATA.model || "claude-sonnet-5-5",
      effort: DATA.effortLevel,
      permissionMode: "plan", // read-only: the bank never changes anything
      agent: DATA.defaultAgent || "chad",
      sessionId: this.sessionId,
      appendSystemPrompt: persona,
      onMessage: (m: any) => this.onMessage(m),
      onError: (e: any) => this.hooks.log(`claude stderr: ${String(e).slice(0, 200)}`),
      onClose: (code: any) => this.hooks.log(`claude closed ${code}`),
    } as any);
    this.t.spawn();
  }
  send(prompt: string) {
    this.queue.push(prompt);
    this.next();
  }
  approve() {}
  busy() {
    return this.current || this.queue.length > 0;
  }
  stop() {
    this.t.stop();
  }
  private next() {
    if (this.current) return;
    const p = this.queue.shift();
    if (p === undefined) return;
    this.current = true;
    this.text = [];
    this.t.sendUserMessage(p);
  }
  private onMessage(m: any) {
    if (m.type === "assistant") {
      for (const b of m.message?.content || []) {
        if (b.type === "text" && b.text) this.text.push(b.text);
        if (b.type === "tool_use") this.hooks.onStep(b.name, b.input);
      }
    } else if (m.type === "control_request" && m.request?.subtype === "can_use_tool") {
      this.t.sendPermissionResponse(m.request_id, "deny");
    } else if (m.type === "result") {
      this.current = false;
      // Hyo shows (and hands the voice) the turn's text: all its text blocks.
      const reply = this.text.length ? this.text.join("\n\n") : String(m.result || "");
      this.hooks.onReply(reply);
      this.next();
    }
  }
}

export function removeSandboxSession(id: string | undefined) {
  if (!id) return;
  const dir = path.join(HOME, ".claude/projects", SANDBOX.replace(/[/.]/g, "-"));
  for (const f of [`${id}.jsonl`]) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {}
  }
  try {
    fs.rmSync(path.join(dir, id), { recursive: true, force: true });
  } catch {}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// One call
// ---------------------------------------------------------------------------

export type Step =
  | { say: string }
  | { wait: number }
  | { waitAnswer: number } // until the latest job's result has been spoken (or timeout)
  | { waitJob: number }
  | { approve: true }
  | { hangUp: true };

export interface Scenario {
  name: string;
  about: string;
  claude: "real" | "stub";
  stubs?: StubReply[];
  steps: Step[];
  jobs: [number, number];
  /** After hanging up, wait for Claude's reply (it should still post to the chat). */
  expectReplyAfterHangUp?: boolean;
  /** What Claude must have been given, across the jobs (her words, word for word). */
  expectSaid?: RegExp[];
}

/** What a build gives the bank: its own call code, wrapped. */
export interface BuildCall {
  start(): Promise<void>;
  hangUp(): void;
  claudeReply(markdown: string): void;
  claudeStep(name: string, input: any): void;
  permissionAsked(tool: string, input: any): void;
  permissionAnswered(allowed: boolean): void;
  /** v2 only: the call's record at the end. */
  record?: () => any;
}

export interface BuildHooks {
  headless: { start: (send: (b64: string) => void) => () => void; onOutput?: (b64: string) => void };
  /** A job for Claude. */
  job: (prompt: string, said: string) => void;
  onLive: () => void;
  onEnded: (record: any, reason: string) => void;
  onError: (msg: string) => void;
  onTurn: (side: string, text: string) => void;
}

export type MakeBuild = (key: string, hooks: BuildHooks) => BuildCall;

export interface CallResult {
  scenario: string;
  build: string;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
  transcript: string;
  jobs: number;
  spokenResults: number;
}

export async function runCall(build: string, sc: Scenario, make: MakeBuild, persona: string, outDir: string): Promise<CallResult> {
  const key = openAiKey();
  const T0 = Date.now();
  const at = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + "s";
  const lines: string[] = [];
  const log = (l: string) => lines.push(`${at()} ${l}`);
  const mic = new Mic();
  const errors: string[] = [];
  const jobs: Array<{ at: number; said: string; prompt: string }> = [];
  const results: Array<{ at: number; text: string; spokeAt?: number }> = [];
  let liveAt = 0;
  let ended: { record: any; reason: string } | null = null;
  let hungUpAt = 0;
  const replies: Array<{ at: number; text: string }> = [];
  let firstInput = "";
  let inputDone = false;
  let lastVoiceAudioAt = 0;
  let voiceOut = "";
  const voiceLines: Array<{ at: number; text: string }> = [];
  let curVoice: { at: number; text: string } | null = null;
  let firstVoiceAudioAfter: Array<{ ref: string; since: number; got?: number }> = [];

  (globalThis as any).__liveTap = {
    onIn: (ev: any) => {
      const t = Date.now();
      switch (ev.type) {
        case "session.output_audio.delta": {
          const pcm = Buffer.from(ev.delta, "base64");
          if (rms(pcm) > VOICE_RMS) {
            lastVoiceAudioAt = t;
            for (const w of firstVoiceAudioAfter) if (!w.got && t > w.since) w.got = t;
          }
          return;
        }
        case "session.input_transcript.delta":
          if (!inputDone) firstInput += ev.delta;
          return;
        case "session.output_transcript.delta":
          voiceOut += ev.delta;
          if (!curVoice || t - curVoice.at > 2500 + curVoice.text.length * 60) {
            curVoice = { at: t, text: "" };
            voiceLines.push(curVoice);
          }
          curVoice.text += ev.delta;
          for (const r of results) if (!r.spokeAt && t > r.at) r.spokeAt = t;
          return;
        case "session.delegation.created":
          log(`   [delegation ${ev.delegation?.id?.slice(-6)}]`);
          return;
        case "error":
          log(`   !! error ${JSON.stringify(ev.error).slice(0, 200)}`);
          return;
        case "session.started":
          log(`   [session started]`);
          return;
        case "session.closed":
          log(`   [session closed ${ev.reason}]`);
          return;
        default:
          return;
      }
    },
    onOut: (ev: any) => {
      if (ev.type === "session.input_audio.append") return;
      if (ev.type === "session.commentary.append") {
        log(`   -> say (${ev.delegation_id ? "job " + String(ev.delegation_id).slice(-6) : "general"}): ${String(ev.content).slice(0, 300)}`);
        if (ev.delegation_id) results.push({ at: Date.now(), text: ev.content });
        firstVoiceAudioAfter.push({ ref: "say", since: Date.now() });
      } else if (ev.type === "session.thinking.append") {
        log(`   -> know: ${String(ev.content).slice(0, 200)}`);
      } else if (ev.type === "session.instructions.append") {
        log(`   -> instruct: ${String(ev.content).slice(0, 200)}`);
      } else if (ev.type === "session.start") {
        log(`   -> session.start (instructions ${String(ev.session?.instructions || "").length} chars, history ${(ev.session?.input || []).length})`);
      }
    },
  };

  let claude: ClaudeSide;
  let call: BuildCall;
  const hooks: ClaudeHooks = {
    onReply: (md) => {
      replies.push({ at: Date.now(), text: md });
      log(`   <- Claude replied${hungUpAt ? " (after hang-up: posts to the chat)" : ""}: ${md.replace(/\s+/g, " ").slice(0, 400)}`);
      call.claudeReply(md);
    },
    onStep: (name, input) => call.claudeStep(name, input),
    onPermission: (tool, input) => {
      log(`   <- Claude asks permission: ${tool}`);
      call.permissionAsked(tool, input);
    },
    log: (l) => log(`   ${l}`),
  };
  claude = sc.claude === "real" ? new RealClaude(persona, hooks) : new StubClaude(sc.stubs || [], hooks);

  call = make(key, {
    headless: { start: (send) => mic.start(send) },
    job: (prompt, said) => {
      jobs.push({ at: Date.now(), said, prompt });
      log(`   => JOB ${jobs.length}: "${said}"`);
      claude.send(prompt);
    },
    onLive: () => {
      liveAt = Date.now();
      log(`   [live: chime]`);
    },
    onEnded: (record, reason) => {
      ended = { record, reason };
      log(`   [call ended: ${reason}]`);
    },
    onError: (m) => {
      errors.push(m);
      log(`   !! notice: ${m}`);
    },
    onTurn: (side, text) => {
      if (side === "user" && !inputDone) inputDone = true;
      log(`${side === "user" ? "SHE  " : "VOICE"}: ${text}`);
    },
  });

  const watchdog = setTimeout(() => {
    log("!! watchdog: call took too long");
    try {
      call.hangUp();
    } catch {}
  }, 6 * 60 * 1000);

  await call.start();
  const t1 = Date.now();
  while (!liveAt && Date.now() - t1 < 15000) await sleep(50);
  // She starts talking straight after the chime.
  await sleep(300);
  let speechEnds: number[] = [];
  for (const st of sc.steps) {
    if (ended) break;
    if ("say" in st) {
      log(`(she says) "${st.say}"`);
      await mic.speak(clipFor(st.say));
      speechEnds.push(Date.now());
      firstVoiceAudioAfter.push({ ref: "her", since: Date.now() });
    } else if ("wait" in st) {
      await sleep(st.wait);
    } else if ("waitJob" in st) {
      const n = jobs.length;
      const t = Date.now();
      while (jobs.length === n && Date.now() - t < st.waitJob) await sleep(100);
    } else if ("waitAnswer" in st) {
      const n = results.length;
      const t = Date.now();
      // The result is sent, then spoken, then the line goes quiet.
      while (Date.now() - t < st.waitAnswer) {
        const spoke = results.length > n && results[results.length - 1].spokeAt;
        if (spoke && Date.now() - lastVoiceAudioAt > 2500) break;
        await sleep(200);
      }
    } else if ("approve" in st) {
      log(`(she clicks Allow on screen)`);
      claude.approve();
      call.permissionAnswered(true);
    } else if ("hangUp" in st) {
      log(`(she hangs up)`);
      hungUpAt = Date.now();
      call.hangUp();
    }
  }
  if (!ended) {
    hungUpAt = hungUpAt || Date.now();
    call.hangUp();
  }
  const t2 = Date.now();
  while (!ended && Date.now() - t2 < 8000) await sleep(100);
  await sleep(1500); // let a late "ended early" notice surface
  if (sc.expectReplyAfterHangUp) {
    const t3 = Date.now();
    while (claude.busy() && Date.now() - t3 < 180000) await sleep(500);
  }
  clearTimeout(watchdog);
  claude.stop();
  removeSandboxSession(claude.sessionId);

  // ---- Checks
  const checks: CallResult["checks"] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const firstSay = (sc.steps.find((s) => "say" in s) as any)?.say || "";
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const firstTwo = norm(firstSay).split(" ").slice(0, 2).join(" ");
  add("hears her from the first second", norm(firstInput).startsWith(firstTwo), `first words heard: "${firstInput.trim().slice(0, 60)}" (live ${liveAt ? ((liveAt - T0) / 1000).toFixed(1) + "s" : "never"})`);
  add("jobs in range", jobs.length >= sc.jobs[0] && jobs.length <= sc.jobs[1], `${jobs.length} job(s), expected ${sc.jobs[0]}–${sc.jobs[1]}`);
  const spokenResults = results.length;
  add("one spoken result per job at most", spokenResults <= Math.max(1, jobs.length), `${spokenResults} spoken result(s) for ${jobs.length} job(s)`);
  add("no 'ended before the session finalised' notice", !errors.some((e) => /finalis|ended/i.test(e)), errors.join(" | ") || "none");
  if (sc.expectSaid) {
    const all = jobs.map((j) => j.said).join(" | ");
    for (const re of sc.expectSaid) add(`Claude got ${re}`, re.test(all), all.slice(0, 200));
  }
  if (sc.expectReplyAfterHangUp) {
    const after = replies.filter((r) => r.at > hungUpAt);
    add("hang-up mid-job: the reply still posts to the chat", after.length >= 1, `${after.length} reply after hang-up`);
    const rec = call.record?.();
    if (rec) add("the record marks it finishing in the chat", !!rec.handoffs?.some((h: any) => h.afterCall), JSON.stringify(rec.handoffs?.map((h: any) => ({ req: h.request.slice(0, 40), afterCall: h.afterCall }))));
  }
  const lat = speechEnds.map((e) => {
    const w = firstVoiceAudioAfter.find((x) => x.ref === "her" && x.since === e);
    return w?.got ? w.got - e : null;
  });
  const resultLat = firstVoiceAudioAfter.filter((x) => x.ref === "say").map((x) => (x.got ? x.got - x.since : null));

  const transcript = [
    `# ${sc.name} — ${build}`,
    sc.about,
    "",
    ...lines,
    "",
    "## Checks",
    ...checks.map((c) => `- ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`),
    `- her speech end → voice audio (s): ${lat.map((x) => (x === null ? "–" : (x / 1000).toFixed(2))).join(", ")}`,
    `- result sent → voice audio (s): ${resultLat.map((x) => (x === null ? "–" : (x / 1000).toFixed(2))).join(", ")}`,
    "",
    "## Voice lines",
    ...voiceLines.map((v) => `${((v.at - T0) / 1000).toFixed(1)}s ${v.text.trim()}`),
    "",
    "## Jobs Claude got (full prompts)",
    ...jobs.map((j, i) => `### ${i + 1}\n${j.prompt}`),
    "",
    "## Claude's replies",
    ...replies.map((r, i) => `### ${i + 1}\n${r.text}`),
  ].join("\n");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${sc.name}.md`), transcript);
  return { scenario: sc.name, build, checks, transcript, jobs: jobs.length, spokenResults };
}

export async function runBank(build: string, scenarios: Scenario[], make: MakeBuild, persona: string) {
  const only = (process.env.ONLY || "").split(",").filter(Boolean);
  const list = only.length ? scenarios.filter((s) => only.includes(s.name)) : scenarios;
  const outDir = path.join(__dirname, "../../.live-bank", `${new Date().toISOString().slice(0, 16).replace(/:/g, "-")}-${build}`);
  const out: CallResult[] = [];
  for (const sc of list) {
    console.log(`--- ${build}: ${sc.name}`);
    try {
      const r = await runCall(build, sc, make, persona, outDir);
      out.push(r);
      for (const c of r.checks) console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
    } catch (e) {
      console.log(`  ERROR ${e instanceof Error ? e.stack : String(e)}`);
    }
  }
  console.log(`results in ${outDir}`);
  setTimeout(() => process.exit(0), 500);
}
