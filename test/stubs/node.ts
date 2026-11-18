// Tests run in plain Node, so the desktop-only loader hands back the real
// modules. Mirrors src/platform/node.ts; run-tests.mjs swaps it in.
/* eslint-disable @typescript-eslint/no-require-imports -- test-only stand-in for window.require */
import type { ElectronApi } from "../../src/platform/node";

export class DesktopOnlyError extends Error {}
export const hasNode = (): boolean => true;
export const nodeFs = (): typeof import("fs") => require("fs") as typeof import("fs");
export const nodePath = (): typeof import("path") => require("path") as typeof import("path");
export const nodeOs = (): typeof import("os") => require("os") as typeof import("os");
export const nodeChildProcess = (): typeof import("child_process") =>
  require("child_process") as typeof import("child_process");
export const nodeCrypto = (): typeof import("crypto") => require("crypto") as typeof import("crypto");
export const nodeNet = (): typeof import("net") => require("net") as typeof import("net");
export const nodeUtil = (): typeof import("util") => require("util") as typeof import("util");
export const electron = (): ElectronApi => {
  throw new DesktopOnlyError("electron isn't available in tests");
};
export type { ElectronApi, OpenDialogResult } from "../../src/platform/node";
