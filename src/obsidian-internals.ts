// Narrow types for the parts of Obsidian Hyo uses that aren't in the public
// API. Each interface declares exactly what Hyo touches and nothing more, so a
// change on Obsidian's side shows up here rather than as a silent `any`.
import { FileSystemAdapter, type App, type Plugin } from "obsidian";

/**
 * The vault's folder on disk. Desktop vaults use a FileSystemAdapter; any
 * other adapter has no folder on disk, so this is "".
 */
export function vaultBasePath(app: App): string {
  const adapter = app.vault.adapter;
  return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
}

/** Obsidian's settings modal (`app.setting`). */
interface SettingModal {
  open(): void;
  openTabById?(id: string): void;
}

/** The community plugin registry (`app.plugins`). */
interface PluginRegistry {
  enabledPlugins?: Set<string>;
  plugins?: Record<string, Plugin | undefined>;
}

interface AppInternals extends App {
  setting?: SettingModal;
  plugins?: PluginRegistry;
  /** The vault's id, used to namespace localStorage keys on older Obsidian. */
  appId?: string;
}

/** Opens Obsidian's settings on the given plugin's tab, where supported. */
export function openPluginSettings(app: App, pluginId: string): void {
  const setting = (app as AppInternals).setting;
  if (!setting) return;
  setting.open();
  setting.openTabById?.(pluginId);
}

/** True when the community plugin with this id is enabled. */
export function isPluginEnabled(app: App, pluginId: string): boolean {
  return (app as AppInternals).plugins?.enabledPlugins?.has(pluginId) ?? false;
}

/** The loaded community plugin with this id, if it's running. */
export function loadedPlugin(app: App, pluginId: string): Plugin | undefined {
  return (app as AppInternals).plugins?.plugins?.[pluginId];
}

/** The vault's id (`app.appId`), when Obsidian exposes it. */
export function vaultAppId(app: App): string | undefined {
  return (app as AppInternals).appId;
}
