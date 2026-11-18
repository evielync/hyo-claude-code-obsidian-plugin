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
import type * as NodeChildProcess from "child_process";
import type * as NodeCrypto from "crypto";
import type * as NodeFs from "fs";
import type * as NodeNet from "net";
import type * as NodeOs from "os";
import type * as NodePath from "path";
import type * as NodeUtil from "util";

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

export function nodeFs(): typeof NodeFs {
  if (!Platform.isDesktop) throw new DesktopOnlyError("fs");
  return window.require?.("fs") as typeof NodeFs;
}

export function nodePath(): typeof NodePath {
  if (!Platform.isDesktop) throw new DesktopOnlyError("path");
  return window.require?.("path") as typeof NodePath;
}

export function nodeOs(): typeof NodeOs {
  if (!Platform.isDesktop) throw new DesktopOnlyError("os");
  return window.require?.("os") as typeof NodeOs;
}

export function nodeChildProcess(): typeof NodeChildProcess {
  if (!Platform.isDesktop) throw new DesktopOnlyError("child_process");
  return window.require?.("child_process") as typeof NodeChildProcess;
}

export function nodeCrypto(): typeof NodeCrypto {
  if (!Platform.isDesktop) throw new DesktopOnlyError("crypto");
  return window.require?.("crypto") as typeof NodeCrypto;
}

export function nodeNet(): typeof NodeNet {
  if (!Platform.isDesktop) throw new DesktopOnlyError("net");
  return window.require?.("net") as typeof NodeNet;
}

export function nodeUtil(): typeof NodeUtil {
  if (!Platform.isDesktop) throw new DesktopOnlyError("util");
  return window.require?.("util") as typeof NodeUtil;
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
