import React, { useEffect, useRef } from "react";

interface VoiceWaveformProps {
  /** Returns `bars` normalised amplitudes (0..1) off the live mic input. */
  getWaveform: (bars: number) => number[];
  bars?: number;
}

/**
 * Live recording waveform. Mounted only while listening, so its animation
 * loop starts and stops with the recording. It reads the mic amplitudes each
 * frame and writes bar heights straight to the DOM — no React re-render per
 * frame. A trust signal: you can see it's actually hearing you.
 */
export function VoiceWaveform({ getWaveform, bars = 28 }: VoiceWaveformProps) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const values = getWaveform(bars);
      for (let i = 0; i < barsRef.current.length; i++) {
        const el = barsRef.current[i];
        if (!el) continue;
        // Floor keeps a faint idle line so it never looks dead; ceiling keeps
        // loud peaks inside the strip.
        const v = Math.max(0.06, Math.min(1, values[i] ?? 0));
        el.style.transform = `scaleY(${v})`;
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [getWaveform, bars]);

  return (
    <div className="hyo-listening-strip" role="status" aria-live="polite">
      <div className="hyo-waveform" aria-hidden="true">
        {Array.from({ length: bars }).map((_, i) => (
          <span
            key={i}
            className="hyo-waveform-bar"
            ref={(el) => {
              barsRef.current[i] = el;
            }}
          />
        ))}
      </div>
      <span className="hyo-listening-label">Listening…</span>
    </div>
  );
}
