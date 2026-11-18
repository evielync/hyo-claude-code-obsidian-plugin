import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
  ],
  format: "cjs",
  target: "es2020",
  // `ws` ships a browser stub that throws on construction; esbuild's default
  // browser resolution picks it, which silently killed the gateway host. The
  // real Node implementation is what runs (desktop-only, behind Platform
  // guards), so resolve `ws` to its Node entry explicitly.
  alias: { ws: "./node_modules/ws/index.js" },
  // CHANGELOG.md is inlined as a string so the release card and the in-app
  // notes view work offline — no fetch, no extra release asset to ship.
  loader: { ".md": "text" },
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
