import React, { useState, useEffect, useRef } from "react";
import { mainChatOn } from "../../main-chat";
import type { App } from "obsidian";
import type HyoPlugin from "../../main";
import { ChatPanel } from "./ChatPanel";
import { useSessionManager } from "../hooks/useSessionManager";
import { capacitorKeyboard, removeListener } from "./platform-internals";

interface HyoAppProps {
  app: App;
  plugin: HyoPlugin;
  /** Whether the panel can be seen right now (HyoView), for unread replies. */
  isShown?: () => boolean;
}

export function HyoApp({ app, plugin, isShown }: HyoAppProps) {
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
    // The lift is a runtime height, so it rides on a custom property; the
    // class turns the padding on (styles.css), and off again to measure.
    const clearLift = () => el.removeClass("hyo-keyboard-lifted");
    const setLift = (px: number) => {
      el.setCssProps({ "--hyo-keyboard-lift": `${px}px` });
      el.addClass("hyo-keyboard-lifted");
    };
    const lift = (px: number) => {
      if (px > 4) setLift(px);
      else clearLift();
    };
    // Lift by the ACTUAL overlap between the input card and the keyboard top,
    // not the full keyboard height (there's chrome below the card, so the full
    // height overshoots). Clear padding first to measure the resting position.
    const liftForKeyboard = (kbHeight: number) => {
      clearLift();
      // A hardware/external keyboard (iPad Magic Keyboard, Bluetooth) still
      // fires keyboardWillShow, but with a 0 or accessory-bar-sized height —
      // there's no on-screen keyboard eating real estate, so lifting the panel
      // is wrong (it floats up as if a software keyboard were open). Only lift
      // for a genuine software keyboard, which is always well over 140px tall.
      if (!kbHeight || kbHeight < 140) return;
      const kbTop = window.innerHeight - kbHeight;
      const card = el.querySelector<HTMLElement>(".hyo-input-card");
      const cardBottom = card
        ? card.getBoundingClientRect().bottom
        : window.innerHeight;
      const overlap = Math.round(cardBottom - kbTop + 8); // 8px breathing room
      if (overlap > 4) setLift(overlap);
    };
    const KB = capacitorKeyboard();

    if (KB) {
      // Use the reported height verbatim — do NOT fabricate a fallback when
      // it's 0/absent. A fabricated height was the external-keyboard bug: a
      // hardware keyboard reports 0, and `0 || innerHeight*0.4` lifted by 40%
      // for no reason. liftForKeyboard's own threshold ignores small heights.
      const show = KB.addListener("keyboardWillShow", (info) =>
        liftForKeyboard(info?.keyboardHeight ?? 0),
      );
      const hide = KB.addListener("keyboardWillHide", () => lift(0));
      return () => {
        removeListener(show);
        removeListener(hide);
        clearLift();
      };
    }

    // Fallback: focus/blur on the message textarea, estimated height.
    const isInput = (t: EventTarget | null) => t instanceof HTMLElement && t.classList.contains("hyo-input");
    const onIn = (e: FocusEvent) => {
      if (isInput(e.target)) {
        liftForKeyboard(Math.min(Math.round(window.innerHeight * 0.42), 360));
      }
    };
    const onOut = (e: FocusEvent) => {
      if (isInput(e.target)) lift(0);
    };
    el.addEventListener("focusin", onIn);
    el.addEventListener("focusout", onOut);
    return () => {
      el.removeEventListener("focusin", onIn);
      el.removeEventListener("focusout", onOut);
      clearLift();
    };
  }, []);

  // There's no local CLI to detect on mobile — the gateway (running on the
  // Mac) owns the Claude process. Connection health is surfaced inline in
  // the status bar rather than gating the whole panel behind an
  // install-Claude-Code onboarding screen, which doesn't apply here.
  // The main chat's conversation id is kept in the synced settings, so the
  // phone and the computer carry on the same one.
  const onMainChatSession = React.useCallback(
    (sessionId: string) => {
      if (plugin.settings.mainChatSessionId === sessionId) return;
      plugin.settings.mainChatSessionId = sessionId;
      void plugin.saveSettings();
    },
    [plugin]
  );
  const sessionManager = useSessionManager({
    gatewayUrl: plugin.settings.gatewayUrl,
    model: plugin.settings.model,
    agent: plugin.settings.defaultAgent,
    autoGenerateTitles: plugin.settings.autoGenerateTitles,
    askFirst: plugin.settings.askFirst,
    permissionMode: plugin.settings.permissionMode,
    settingsVersion,
    mainChat: mainChatOn(plugin.settings),
    mainChatSessionId: plugin.settings.mainChatSessionId || "",
    onMainChatSession,
  });

  return (
    <div className="hyo-app" ref={rootRef}>
      <ChatPanel sessionManager={sessionManager} plugin={plugin} app={app} isShown={isShown} />
    </div>
  );
}
