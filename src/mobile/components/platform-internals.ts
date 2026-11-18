// Narrow types for the few things the phone UI reaches for that aren't in
// Obsidian's public API or the DOM's standard typings. Each declares exactly
// what Hyo uses and nothing more. The Obsidian ones are shared with the rest
// of the plugin (obsidian-internals.ts).
export { openPluginSettings } from "../../obsidian-internals";

/** Older iOS WebKit only has the prefixed AudioContext. */
interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/** The AudioContext constructor this webview offers, if any. */
export function audioContextClass(): typeof AudioContext | undefined {
  return window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext;
}

/** What Capacitor's Keyboard plugin hands keyboard listeners. */
export interface KeyboardInfo {
  keyboardHeight?: number;
}

/** A listener registration. Capacitor returns it directly or as a promise, by version. */
interface ListenerHandle {
  remove?(): void | Promise<void>;
}

export type ListenerRegistration = ListenerHandle | Promise<ListenerHandle> | undefined;

export interface CapacitorKeyboard {
  addListener(event: "keyboardWillShow", listener: (info: KeyboardInfo | undefined) => void): ListenerRegistration;
  addListener(event: "keyboardWillHide", listener: () => void): ListenerRegistration;
}

/** Removes a Capacitor listener, whichever form its registration came back in. */
export function removeListener(registration: ListenerRegistration): void {
  if (!registration) return;
  if (registration instanceof Promise) {
    registration
      .then((handle) => handle.remove?.())
      .catch((err: unknown) => console.error("[hyo] Couldn't remove keyboard listener", err));
    return;
  }
  void registration.remove?.();
}

interface WindowWithCapacitor extends Window {
  Capacitor?: { Plugins?: { Keyboard?: Partial<CapacitorKeyboard> } };
}

/** Capacitor's Keyboard plugin (Obsidian mobile is a Capacitor app), when present. */
export function capacitorKeyboard(): CapacitorKeyboard | undefined {
  const kb = (window as WindowWithCapacitor).Capacitor?.Plugins?.Keyboard;
  return typeof kb?.addListener === "function" ? (kb as CapacitorKeyboard) : undefined;
}
