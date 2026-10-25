/**
 * The call's two sounds, as Grok Bot does it: a short rising two-note chime
 * the moment the line is live (instead of a spoken greeting), and a softer
 * falling one on hang-up. Synthesised with Web Audio — nothing to ship.
 */

export interface ChimeNote {
  freq: number; // Hz
  at: number; // seconds from start
  dur: number; // seconds
}

export interface Chime {
  notes: ChimeNote[];
  /** Peak gain, 0–1. */
  peak: number;
}

/** Connected and listening: a soft rising fifth (C6 → G6). */
export const CONNECT_CHIME: Chime = {
  notes: [
    { freq: 1046.5, at: 0, dur: 0.16 },
    { freq: 1568.0, at: 0.12, dur: 0.22 },
  ],
  peak: 0.12,
};

/** Hung up: the same two notes falling, quieter. */
export const HANGUP_CHIME: Chime = {
  notes: [
    { freq: 1568.0, at: 0, dur: 0.14 },
    { freq: 1046.5, at: 0.11, dur: 0.2 },
  ],
  peak: 0.07,
};

/** How long a chime lasts, in seconds. */
export function chimeLength(c: Chime): number {
  return Math.max(...c.notes.map((n) => n.at + n.dur));
}

/** Schedule a chime on any AudioContext-like target (real or offline). */
export function scheduleChime(ctx: BaseAudioContext, c: Chime, start = ctx.currentTime): void {
  for (const n of c.notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = n.freq;
    const t0 = start + n.at;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(c.peak, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + n.dur + 0.02);
  }
}

/** Play a chime now. Silent if audio isn't available. */
export function playChime(c: Chime): void {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = new Ctx();
    void ctx.resume?.(); // iOS starts a fresh context suspended
    scheduleChime(ctx, c);
    setTimeout(() => void ctx.close().catch(() => {}), (chimeLength(c) + 0.3) * 1000);
  } catch {
    /* no audio — nothing to play */
  }
}
