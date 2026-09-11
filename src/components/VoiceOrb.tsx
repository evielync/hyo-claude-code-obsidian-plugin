import React, { useEffect, useRef } from "react";

/**
 * The orb for a GPT-Live call: a glass sphere with the Aurora colours
 * (emerald, violet, hot pink) turning inside it and a glow around it. Which
 * colour leads says who's talking; the level (0–1, from the real audio)
 * sets how fast it turns and how far it blooms. Quiet: the full family,
 * slow. Working: slower still. Connecting: dim.
 *
 * Shared by desktop and mobile. Draws on a canvas at device pixel ratio.
 * Chosen by Ev on 11 Sep 2026 from the mock-ups in chad/assets
 * (hyo-voice-orb-colours.html → "Aurora"; hyo-voice-aurora-light.html → A/B).
 */

export interface VoiceOrbProps {
  side: "user" | "agent" | null;
  level: number;
  working: boolean;
  connecting: boolean;
  size?: number; // css px, default 220
}

const AURORA = ["#16c47f", "#7c3aed", "#ff0260"];
const LEAD_USER = [0, 1, 2];
const LEAD_AGENT = [2, 1, 0];

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function VoiceOrb({ side, level, working, connecting, size = 220 }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Props change ~12×/s; the loop reads them through a ref every frame and
  // smooths the level so the motion follows speech rather than jumping.
  const propsRef = useRef({ side, level, working, connecting });
  propsRef.current = { side, level, working, connecting };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = size * dpr;
    const H = size * dpr;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let t = 0;
    let lv = 0;
    const draw = () => {
      const p = propsRef.current;
      lv += (p.level - lv) * 0.12;
      const sp = p.connecting ? 0.3 : p.working ? 0.35 : p.side ? 1 + lv * 1.6 : 0.5;
      t += 0.45;
      const idx = p.side === "user" ? LEAD_USER : p.side === "agent" ? LEAD_AGENT : [0, 1, 2];
      const cols = idx.map((i) => AURORA[i]);
      const cx = W / 2;
      const cy = H / 2;
      // Connecting: the same colours, softer and breathing slowly, so the
      // orb reads as "waking up" rather than switched off.
      const breathe = p.connecting ? 0.97 + 0.03 * Math.sin(t / 28) : 1;
      const r = (size * 0.31 + lv * size * 0.035) * dpr * breathe;
      const dim = p.connecting ? 0.5 : 1;

      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = p.connecting ? 0.62 : 1;

      // Glow, close to the orb.
      const ring = ctx.createRadialGradient(cx, cy, r * 0.98, cx, cy, r * 1.5);
      ring.addColorStop(0, rgba(cols[0], 0.85 * dim));
      ring.addColorStop(0.45, rgba(cols[1], 0.4 * dim));
      ring.addColorStop(1, rgba(cols[1], 0));
      ctx.fillStyle = ring;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      // Solid colour base.
      const base = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      base.addColorStop(0, cols[0]);
      base.addColorStop(0.5, cols[1]);
      base.addColorStop(1, cols[2]);
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, W, H);
      // Colour clouds turning inside.
      ctx.filter = `blur(${18 * dpr}px)`;
      cols.forEach((c, i) => {
        const a = t / (60 / sp) + i * 2.1;
        const x = cx + Math.cos(a) * r * 0.45;
        const y = cy + Math.sin(a * 0.8) * r * 0.45;
        const rad = r * (0.8 + lv * 0.25);
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, c);
        g.addColorStop(0.7, rgba(c, 0.6));
        g.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.filter = "none";
      // Glass highlight.
      const hi = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.42, 0, cx - r * 0.38, cy - r * 0.42, r * 0.55);
      hi.addColorStop(0, "rgba(255,255,255,0.45)");
      hi.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = hi;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, r - dpr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className="hyo-orb"
      style={{ width: size, height: size, display: "block" }}
      aria-hidden="true"
    />
  );
}
