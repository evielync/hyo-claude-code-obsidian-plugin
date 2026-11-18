// Narrow helpers for the few things the desktop UI reaches for that aren't in
// Obsidian's public API or the DOM's standard typings. Each declares exactly
// what Hyo uses and nothing more. The Obsidian ones are shared with the rest
// of the plugin (obsidian-internals.ts).
export { openPluginSettings, vaultBasePath } from "../obsidian-internals";

/** Older WebKit only has the prefixed AudioContext. */
interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/** The AudioContext constructor this window offers, if any. */
export function audioContextClass(): typeof AudioContext | undefined {
  return window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext;
}
