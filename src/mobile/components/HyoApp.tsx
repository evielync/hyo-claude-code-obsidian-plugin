import React, { useState, useEffect, useRef } from "react";
import type { App } from "obsidian";
import type HyoPlugin from "../../main";
import { ChatPanel } from "./ChatPanel";
import { useSessionManager } from "../hooks/useSessionManager";

interface HyoAppProps {
  app: App;
  plugin: HyoPlugin;
}

export function HyoApp({ app, plugin }: HyoAppProps) {
  const [settingsVersion, setSettingsVersion] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = () => setSettingsVersion((v) => v + 1);
    window.addEventListener("hyo-settings-changed", handler);
    return () => window.removeEventListener("hyo-settings-changed", handler);
  }, []);

  // Keyboard avoidance (iOS Obsidian). Confirmed on-device: the keyboard
  // OVERLAYS the webview and is INVISIBLE to visualViewport/innerHeight
  // (both stay full-height with the keyboard open). So we can't use the
  // viewport. Two signals instead, best-first:
  //   1. Capacitor Keyboard events (Obsidian is a Capacitor app) — give the
  //      real keyboardHeight. Lift the panel by that height via padding-bottom.
  //   2. Fallback: when the textarea gains focus, lift by an estimate.
  // padding-bottom on .hyo-app pushes the bottom-anchored input up above the
  // keyboard; cleared on hide so it's a no-op otherwise.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const lift = (px: number) => {
      el.style.paddingBottom = px > 4 ? `${px}px` : "";
    };
    // Lift by the ACTUAL overlap between the input card and the keyboard top,
    // not the full keyboard height (there's chrome below the card, so the full
    // height overshoots). Clear padding first to measure the resting position.
    const liftForKeyboard = (kbHeight: number) => {
      el.style.paddingBottom = "";
      // A hardware/external keyboard (iPad Magic Keyboard, Bluetooth) still
      // fires keyboardWillShow, but with a 0 or accessory-bar-sized height —
      // there's no on-screen keyboard eating real estate, so lifting the panel
      // is wrong (it floats up as if a software keyboard were open). Only lift
      // for a genuine software keyboard, which is always well over 140px tall.
      if (!kbHeight || kbHeight < 140) return;
      const kbTop = window.innerHeight - kbHeight;
      const card = el.querySelector(".hyo-input-card") as HTMLElement | null;
      const cardBottom = card
        ? card.getBoundingClientRect().bottom
        : window.innerHeight;
      const overlap = Math.round(cardBottom - kbTop + 8); // 8px breathing room
      if (overlap > 4) el.style.paddingBottom = `${overlap}px`;
    };
    const KB = (window as any).Capacitor?.Plugins?.Keyboard;
    const hasCap = typeof KB?.addListener === "function";

    if (hasCap) {
      // Use the reported height verbatim — do NOT fabricate a fallback when
      // it's 0/absent. A fabricated height was the external-keyboard bug: a
      // hardware keyboard reports 0, and `0 || innerHeight*0.4` lifted by 40%
      // for no reason. liftForKeyboard's own threshold ignores small heights.
      const show = KB.addListener("keyboardWillShow", (info: any) =>
        liftForKeyboard(info?.keyboardHeight ?? 0),
      );
      const hide = KB.addListener("keyboardWillHide", () => lift(0));
      return () => {
        show?.remove?.();
        hide?.remove?.();
        el.style.paddingBottom = "";
      };
    }

    // Fallback: focus/blur on the message textarea, estimated height.
    const onIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.classList?.contains("hyo-input")) {
        liftForKeyboard(Math.min(Math.round(window.innerHeight * 0.42), 360));
      }
    };
    const onOut = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.classList?.contains("hyo-input")) lift(0);
    };
    el.addEventListener("focusin", onIn);
    el.addEventListener("focusout", onOut);
    return () => {
      el.removeEventListener("focusin", onIn);
      el.removeEventListener("focusout", onOut);
      el.style.paddingBottom = "";
    };
  }, []);

  // There's no local CLI to detect on mobile — the gateway (running on the
  // Mac) owns the Claude process. Connection health is surfaced inline in
  // the status bar rather than gating the whole panel behind an
  // install-Claude-Code onboarding screen, which doesn't apply here.
  const sessionManager = useSessionManager({
    gatewayUrl: plugin.settings.gatewayUrl,
    model: plugin.settings.model,
    agent: plugin.settings.defaultAgent,
    autoGenerateTitles: plugin.settings.autoGenerateTitles,
    askFirst: plugin.settings.askFirst,
    settingsVersion,
  });

  return (
    <div className="hyo-app" ref={rootRef}>
      <ChatPanel sessionManager={sessionManager} plugin={plugin} app={app} />
    </div>
  );
}
