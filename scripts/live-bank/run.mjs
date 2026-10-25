// Builds and runs the live bank: `node scripts/live-bank/run.mjs v2|release`.
// ONLY=name1,name2 picks scenarios. Results go to .live-bank/.
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const which = process.argv[2] || "v2";
const releaseTree = process.env.RELEASE_TREE || "/tmp/hyo-0610";
mkdirSync(".live-bank/build", { recursive: true });
const out = `.live-bank/build/${which}.cjs`;
await esbuild.build({
  entryPoints: [`scripts/live-bank/${which}.ts`],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "error",
  alias: {
    obsidian: "./scripts/live-bank/obsidian-stub.ts",
    ws: "./scripts/live-bank/ws-tap.cjs",
    "@release": path.join(releaseTree, "src"),
  },
  nodePaths: [path.resolve("node_modules")],
});
const r = spawnSync(process.execPath, [out], { stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
