// Unit tests for Hyo's pure modules. Each test/*.test.ts is bundled with
// esbuild (the same compiler the plugin uses) and run with Node's built-in
// test runner. Tests must only import modules that don't touch Obsidian.
import esbuild from "esbuild";
import { readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const dir = "test";

// src/platform/node.ts loads Node modules through Electron's window.require,
// which plain Node doesn't have; tests get a stand-in that uses require().
const desktopLoaderStub = {
  name: "desktop-loader-stub",
  setup(build) {
    build.onResolve({ filter: /(^|\/)platform\/node$/ }, (args) =>
      args.importer.includes(`${join("test", "stubs")}`)
        ? undefined
        : { path: join(process.cwd(), "test", "stubs", "node.ts") },
    );
  },
};
const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"));
const out = mkdtempSync(join(tmpdir(), "hyo-tests-"));
const built = [];
for (const f of files) {
  const outfile = join(out, f.replace(/\.tsx?$/, ".cjs"));
  await esbuild.build({
    entryPoints: [join(dir, f)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "error",
    plugins: [desktopLoaderStub],
    // Plugin code uses window.setTimeout and friends (popout-window safe);
    // in plain Node the global object stands in for window.
    banner: { js: "globalThis.window ??= globalThis;" },
    // Obsidian isn't available outside the app; a small stub stands in.
    // Tests that drive the real session-manager hooks (*.hooks.test.ts) get
    // a tiny React that runs a hook without a DOM.
    alias: f.includes(".hooks.test.")
      ? { obsidian: "./test/stubs/obsidian.ts", react: "./test/stubs/mini-react.ts" }
      : { obsidian: "./test/stubs/obsidian.ts" },
  });
  built.push(outfile);
}
const r = spawnSync(process.execPath, ["--test", ...built], { stdio: "inherit" });
process.exit(r.status ?? 1);
