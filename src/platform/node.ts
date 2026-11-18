/**
 * Desktop-only access to Node.js and Electron modules.
 *
 * Hyo drives the Claude Code CLI, so on desktop it needs the filesystem,
 * child processes, sockets and so on. None of that exists on mobile, where
 * importing these modules at the top of a file would crash the plugin on
 * load. Every Node module is therefore loaded here, on demand, behind a
 * `Platform.isDesktop` check, and nowhere else.
 *
 * Electron's renderer exposes Node's `require` on `window`. Types come from
 * `import type`, which TypeScript erases, so nothing here loads on mobile.
 */
import { Platform } from "obsidian";

// Types only: `typeof import()` is erased at build, so declaring them here
// loads nothing. Other modules take Node types from this file too, so no file
// but this one names a Node module.
type NodeChildProcess = typeof import("child_process");
type NodeCrypto = typeof import("crypto");
type NodeFs = typeof import("fs");
type NodeNet = typeof import("net");
type NodeOs = typeof import("os");
type NodePath = typeof import("path");
type NodeUtil = typeof import("util");
export type ChildProcess = import("child_process").ChildProcess;
export type FsStats = import("fs").Stats;
export type FsDirent = import("fs").Dirent;

declare global {
  interface Window {
    require?: (id: string) => unknown;
  }
}

export class DesktopOnlyError extends Error {
  constructor(moduleName: string) {
    super(`"${moduleName}" is only available in the Obsidian desktop app.`);
    this.name = "DesktopOnlyError";
  }
}

/** True when Node modules can be loaded (the desktop app). */
export function hasNode(): boolean {
  return Platform.isDesktop && typeof window.require === "function";
}

export function nodeFs(): NodeFs {
  if (!Platform.isDesktop) throw new DesktopOnlyError("fs");
  return window.require?.("fs") as NodeFs;
}

export function nodePath(): NodePath {
  if (!Platform.isDesktop) throw new DesktopOnlyError("path");
  return window.require?.("path") as NodePath;
}

export function nodeOs(): NodeOs {
  if (!Platform.isDesktop) throw new DesktopOnlyError("os");
  return window.require?.("os") as NodeOs;
}

export function nodeChildProcess(): NodeChildProcess {
  if (!Platform.isDesktop) throw new DesktopOnlyError("child_process");
  return window.require?.("child_process") as NodeChildProcess;
}

export function nodeCrypto(): NodeCrypto {
  if (!Platform.isDesktop) throw new DesktopOnlyError("crypto");
  return window.require?.("crypto") as NodeCrypto;
}

export function nodeNet(): NodeNet {
  if (!Platform.isDesktop) throw new DesktopOnlyError("net");
  return window.require?.("net") as NodeNet;
}

export function nodeUtil(): NodeUtil {
  if (!Platform.isDesktop) throw new DesktopOnlyError("util");
  return window.require?.("util") as NodeUtil;
}

/** The parts of Electron Hyo uses. Electron's own types aren't a dependency. */
export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface ElectronApi {
  shell: { openExternal(url: string): Promise<void> };
  /** `remote` is only present in Obsidian versions that still expose it. */
  remote?: {
    dialog: {
      showOpenDialog(options: {
        properties: Array<"openFile" | "openDirectory">;
        defaultPath?: string;
      }): Promise<OpenDialogResult>;
    };
  };
}

export function electron(): ElectronApi {
  if (!Platform.isDesktop) throw new DesktopOnlyError("electron");
  return window.require?.("electron") as ElectronApi;
}
